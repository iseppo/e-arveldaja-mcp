import { parseCSV } from "../csv.js";
import { todayInTallinn } from "../local-date.js";
import { isStrictDate } from "../strict-date.js";

/**
 * ECB euro foreign-exchange reference rates (Lightyear FX, plan WP-C C1).
 *
 * The only network call is a public, unauthenticated GET to the ECB data API:
 *
 *   https://data-api.ecb.europa.eu/service/data/EXR/D.{CCY}.EUR.SP00.A?startPeriod=…&endPeriod=…&format=csvdata
 *
 * `OBS_VALUE` is foreign currency units per 1 EUR (e.g. USD 1.1225), kept as the
 * published decimal string. Rule (owner Q9): the observation dated ON the
 * requested day; on a weekend or TARGET closing day the most recent earlier
 * observation within 7 calendar days. Today or later is never final
 * (`ecb_rate_not_final`). Nothing here guesses a rate: every failure is an
 * outcome the caller turns into a review row.
 *
 * Dry runs store every outcome they used (success AND failure) in the plan's
 * private payload (`FrozenFxOutcomes`); execute replays that map with
 * `replayFrozenFx` and never fetches.
 */

export const ECB_DATA_API_ORIGIN = "https://data-api.ecb.europa.eu";
const ECB_TIMEOUT_MS = 10_000;
const ECB_MAX_BODY_BYTES = 64 * 1024;
const ECB_LOOKBACK_DAYS = 7;
/** Days past the requested date fetched so a later observation can prove the rate final. */
const ECB_LOOKAHEAD_DAYS = 7;
const ECB_CACHE_MAX_ENTRIES = 512;
const CURRENCY_RE = /^[A-Z]{3}$/;
const RATE_RE = /^\d+(?:\.\d+)?$/;

export interface EcbRateRecord {
  source: "ecb";
  series: string;
  currency: string;
  /** Published decimal string, foreign units per 1 EUR. */
  rate: string;
  orientation: "foreign_per_eur";
  rate_date: string;
  requested_date: string;
  fetched_at: string;
  url: string;
}

export type FxFailureCode = "ecb_rate_unavailable" | "ecb_rate_not_final" | "ecb_response_invalid";

export type FxOutcome = { ok: true; rate: EcbRateRecord } | { ok: false; code: FxFailureCode };

/** `"<CCY>:<requested_date>"` → the outcome a dry run used. */
export type FrozenFxOutcomes = Record<string, FxOutcome>;

/** A replayed outcome; `fx_rate_unbound` = the plan never looked at this rate. */
export type ReplayedFxOutcome = FxOutcome | { ok: false; code: "fx_rate_unbound" };

export interface EcbFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type EcbFetch = (url: string, init: { signal: AbortSignal }) => Promise<EcbFetchResponse>;

interface CachedResolution {
  record: EcbRateRecord;
}

export interface EcbRateDeps {
  fetch?: EcbFetch;
  /** Europe/Tallinn calendar day (default todayInTallinn()). */
  today?: () => string;
  now?: () => Date;
  /** Final-resolution cache; defaults to the module cache. */
  cache?: Map<string, CachedResolution>;
}

// Public reference data, so the cache is not cleared on switch_connection.
const moduleCache = new Map<string, CachedResolution>();

/** Test seam: drop the module-level cache. */
export function resetEcbRateCache(): void {
  moduleCache.clear();
}

export function ecbSeries(currency: string): string {
  return `EXR.D.${currency}.EUR.SP00.A`;
}

export function fxOutcomeKey(currency: string, date: string): string {
  return `${currency}:${date}`;
}

export function ecbObservationsUrl(currency: string, startDate: string, endDate: string): string {
  return `${ECB_DATA_API_ORIGIN}/service/data/EXR/D.${currency}.EUR.SP00.A` +
    `?startPeriod=${startDate}&endPeriod=${endDate}&format=csvdata`;
}

function addDays(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

export interface EcbObservation {
  date: string;
  value: string;
}

export type EcbObservationsResult =
  | { ok: true; observations: EcbObservation[]; url: string }
  | { ok: false; code: "ecb_rate_unavailable" | "ecb_response_invalid" };

/** Parse an ECB `format=csvdata` body by header names; anything unexpected is invalid. */
export function parseEcbCsv(
  body: string,
  currency: string,
  startDate: string,
  endDate: string,
): EcbObservation[] | null {
  const rows = parseCSV(body).filter(row => row.some(field => field.trim() !== ""));
  if (rows.length === 0) return [];
  const header = rows[0]!.map(field => field.trim());
  const keyIndex = header.indexOf("KEY");
  const dateIndex = header.indexOf("TIME_PERIOD");
  const valueIndex = header.indexOf("OBS_VALUE");
  if (keyIndex < 0 || dateIndex < 0 || valueIndex < 0) return null;
  const series = ecbSeries(currency);
  const seen = new Set<string>();
  const observations: EcbObservation[] = [];
  for (const row of rows.slice(1)) {
    const key = row[keyIndex]?.trim();
    const date = row[dateIndex]?.trim() ?? "";
    const value = row[valueIndex]?.trim() ?? "";
    if (key !== series) return null;
    if (!isStrictDate(date) || date < startDate || date > endDate || seen.has(date)) return null;
    if (!RATE_RE.test(value) || !(Number(value) > 0) || !Number.isFinite(Number(value))) return null;
    seen.add(date);
    observations.push({ date, value });
  }
  return observations.sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchEcbObservations(
  currency: string,
  startDate: string,
  endDate: string,
  deps: EcbRateDeps = {},
): Promise<EcbObservationsResult> {
  if (!CURRENCY_RE.test(currency) || currency === "EUR" || !isStrictDate(startDate) || !isStrictDate(endDate)) {
    return { ok: false, code: "ecb_response_invalid" };
  }
  const url = ecbObservationsUrl(currency, startDate, endDate);
  const fetchImpl: EcbFetch = deps.fetch ?? ((target, init) => fetch(target, { ...init, credentials: "omit", redirect: "error" }));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ECB_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    // The ECB answers 404 "No results found" for an empty window.
    if (response.status === 404) return { ok: true, observations: [], url };
    if (!response.ok) return { ok: false, code: "ecb_rate_unavailable" };
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declared) || declared > ECB_MAX_BODY_BYTES) return { ok: false, code: "ecb_response_invalid" };
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > ECB_MAX_BODY_BYTES) return { ok: false, code: "ecb_response_invalid" };
    const observations = parseEcbCsv(body, currency, startDate, endDate);
    return observations === null ? { ok: false, code: "ecb_response_invalid" } : { ok: true, observations, url };
  } catch {
    return { ok: false, code: "ecb_rate_unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

function rememberFinal(cache: Map<string, CachedResolution>, key: string, record: EcbRateRecord): void {
  cache.delete(key);
  cache.set(key, { record });
  while (cache.size > ECB_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * The ECB reference rate for `date`. An observation is cached (as final) only
 * when the same response also holds a later day's observation: the ECB may
 * correct a rate until the next business day's rate is published, so a
 * provisional rate is refetched on the next resolve.
 */
export async function resolveEcbRate(currency: string, date: string, deps: EcbRateDeps = {}): Promise<FxOutcome> {
  const normalized = currency.trim().toUpperCase();
  if (!CURRENCY_RE.test(normalized) || normalized === "EUR" || !isStrictDate(date)) {
    return { ok: false, code: "ecb_response_invalid" };
  }
  const today = (deps.today ?? (() => todayInTallinn()))();
  if (date >= today) return { ok: false, code: "ecb_rate_not_final" };
  const cache = deps.cache ?? moduleCache;
  const key = fxOutcomeKey(normalized, date);
  const hit = cache.get(key);
  if (hit) return { ok: true, rate: hit.record };

  const start = addDays(date, -ECB_LOOKBACK_DAYS);
  const lookahead = addDays(date, ECB_LOOKAHEAD_DAYS);
  const end = lookahead < today ? lookahead : addDays(today, -1);
  const fetched = await fetchEcbObservations(normalized, start, end, deps);
  if (!fetched.ok) return fetched;
  const onOrBefore = fetched.observations.filter(observation => observation.date <= date);
  const selected = onOrBefore[onOrBefore.length - 1];
  if (!selected) return { ok: false, code: "ecb_rate_unavailable" };
  const record: EcbRateRecord = {
    source: "ecb",
    series: ecbSeries(normalized),
    currency: normalized,
    rate: selected.value,
    orientation: "foreign_per_eur",
    rate_date: selected.date,
    requested_date: date,
    fetched_at: (deps.now ?? (() => new Date()))().toISOString(),
    url: fetched.url,
  };
  if (fetched.observations.some(observation => observation.date > selected.date)) rememberFinal(cache, key, record);
  return { ok: true, rate: record };
}

/** Resolve every key once (dry run only) and return the map to freeze in the plan. */
export async function resolveFrozenFxOutcomes(keys: Iterable<string>, deps: EcbRateDeps = {}): Promise<FrozenFxOutcomes> {
  const outcomes: FrozenFxOutcomes = {};
  for (const key of [...new Set(keys)].sort()) {
    const [currency, date] = key.split(":");
    outcomes[key] = await resolveEcbRate(currency ?? "", date ?? "", deps);
  }
  return outcomes;
}

/** Execute-side lookup: never fetches; a key the plan never resolved is `fx_rate_unbound`. */
export function replayFrozenFx(map: FrozenFxOutcomes, currency: string, date: string): ReplayedFxOutcome {
  const outcome = Object.prototype.hasOwnProperty.call(map, fxOutcomeKey(currency, date))
    ? map[fxOutcomeKey(currency, date)]
    : undefined;
  return outcome ?? { ok: false, code: "fx_rate_unbound" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read `privatePayload.fx_outcomes` back from a stored plan; malformed entries are dropped (→ unbound). */
export function readFrozenFxOutcomes(privatePayload: unknown): FrozenFxOutcomes {
  if (!isRecord(privatePayload) || !isRecord(privatePayload.fx_outcomes)) return {};
  const out: FrozenFxOutcomes = {};
  for (const [key, value] of Object.entries(privatePayload.fx_outcomes)) {
    if (!isRecord(value)) continue;
    if (value.ok === false && (value.code === "ecb_rate_unavailable" || value.code === "ecb_rate_not_final" || value.code === "ecb_response_invalid")) {
      out[key] = { ok: false, code: value.code };
    } else if (value.ok === true && isRecord(value.rate) && value.rate.source === "ecb" &&
      typeof value.rate.rate === "string" && RATE_RE.test(value.rate.rate) &&
      typeof value.rate.rate_date === "string" && typeof value.rate.requested_date === "string") {
      out[key] = { ok: true, rate: value.rate as unknown as EcbRateRecord };
    }
  }
  return out;
}

/** Canonical provenance for fingerprints: the exact published string and its dates. */
export function ecbProvenanceFingerprint(record: EcbRateRecord): { source: "ecb"; rate: string; rate_date: string; requested_date: string; series: string } {
  return { source: "ecb", rate: record.rate, rate_date: record.rate_date, requested_date: record.requested_date, series: record.series };
}
