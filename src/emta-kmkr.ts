/**
 * EMTA's public KMKR (VAT number) query: is a VAT number a full VAT payer's
 * or a limited taxpayer's (piiratud maksukohustuslane, KMS § 21)?
 *
 * `/vat_info` in e-arveldaja has no such field (verified live 2026-11-04), and
 * the business register does not show it either. The only network calls are
 * two public, unauthenticated requests to a fixed HTTPS host (live-verified
 * 2026-11-04):
 *
 *   GET  https://apps.emta.ee/saqu/public/kmkrnr?lang=et   → form with a hidden CSRFToken + session cookie
 *   POST https://apps.emta.ee/saqu/public/kmkrnr/query     → personCode=<EE…>, p_submit=Otsi, CSRFToken
 *
 * The answer's one `<table class="grid">` has the header [Jrk,
 * Isikukood/registrikood, Nimi, Registreerimise kuupäev, Kustutamise kuupäev,
 * Otsuse kuupäev, Käibemaksukohustuslasena registreerimise number]; a limited
 * taxpayer's second cell carries `<span class="boldblock">Piiratud
 * käibemaksukohustuslane</span>` after the registry code. Nothing but the VAT
 * number is sent; anything unexpected is a failure the caller treats as
 * "status unknown", never a guess.
 */

export const EMTA_KMKR_ORIGIN = "https://apps.emta.ee";
export const EMTA_KMKR_FORM_URL = `${EMTA_KMKR_ORIGIN}/saqu/public/kmkrnr?lang=et`;
export const EMTA_KMKR_QUERY_URL = `${EMTA_KMKR_ORIGIN}/saqu/public/kmkrnr/query`;
const EMTA_TIMEOUT_MS = 10_000;
const EMTA_MAX_BODY_BYTES = 512 * 1024;
const VAT_NUMBER_RE = /^EE\d{9}$/;
const CSRF_TOKEN_RE = /^[A-Za-z0-9_\-+=/.:]{8,512}$/;
const LIMITED_MARK = "Piiratud käibemaksukohustuslane";
const EXPECTED_HEADER = [
  "Jrk",
  "Isikukood/registrikood",
  "Nimi",
  "Registreerimise kuupäev",
  "Kustutamise kuupäev",
  "Otsuse kuupäev",
  "Käibemaksukohustuslasena registreerimise number",
] as const;

/**
 * One active KMKR registration as EMTA shows it (dates YYYY-MM-DD). The name
 * and the registry or personal code are not kept.
 */
export interface EmtaKmkrRegistration {
  vat_number: string;
  limited: boolean;
  registered_on: string;
  decision_on: string | null;
}

export type EmtaKmkrFailureCode =
  /** Network, timeout, HTTP error or an oversized answer. */
  | "emta_lookup_unavailable"
  /** The answer does not have the expected shape. */
  | "emta_response_invalid"
  /** No registration row for the number. */
  | "emta_registration_not_found"
  /** Only deleted registrations for the number. */
  | "emta_registration_deleted"
  /** More than one active registration for the number. */
  | "emta_registration_ambiguous";

export type EmtaKmkrOutcome =
  | { ok: true; registration: EmtaKmkrRegistration }
  | { ok: false; code: EmtaKmkrFailureCode; detail: string };

export interface EmtaFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null; getSetCookie?(): string[] };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type EmtaFetch = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<EmtaFetchResponse>;

export interface EmtaKmkrDeps {
  fetch?: EmtaFetch;
}

/** The VAT number as EMTA expects it (EE + 9 digits, no spaces), or null. */
export function normalizeEstonianVatNumber(value: string): string | null {
  const normalized = value.replace(/\s+/g, "").toUpperCase();
  return VAT_NUMBER_RE.test(normalized) ? normalized : null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
  auml: "ä", Auml: "Ä", ouml: "ö", Ouml: "Ö", uuml: "ü", Uuml: "Ü", otilde: "õ", Otilde: "Õ",
  scaron: "š", Scaron: "Š", zcaron: "ž", Zcaron: "Ž",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function strictDate(value: string): string | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

function cellsOf(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map(match => match[2]!);
}

interface ParsedRow {
  limited: boolean;
  registered_on: string;
  deleted_on: string | null;
  decision_on: string | null;
  vat_number: string;
}

/**
 * The rows of the answer's one result table; null = unexpected shape. A page
 * without a result table is an empty list.
 */
export function parseEmtaKmkrTable(html: string): ParsedRow[] | null {
  const tables = [...html.matchAll(/<table\b[^>]*\bclass\s*=\s*"grid"[^>]*>([\s\S]*?)<\/table>/gi)];
  if (tables.length === 0) return /<table\b[^>]*\bclass\s*=\s*"grid"/i.test(html) ? null : [];
  if (tables.length > 1) return null;
  const rows = [...tables[0]![1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => match[1]!);
  if (rows.length === 0) return null;
  const header = cellsOf(rows[0]!).map(cellText);
  if (header.length !== EXPECTED_HEADER.length || header.some((cell, index) => cell !== EXPECTED_HEADER[index])) return null;
  const parsed: ParsedRow[] = [];
  for (const row of rows.slice(1)) {
    const cells = cellsOf(row);
    if (cells.length !== EXPECTED_HEADER.length) return null;
    const spans = [...cells[1]!.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)];
    const limitedSpan = spans.length === 1 && /\bclass\s*=\s*"boldblock"/i.test(spans[0]![0]) && cellText(spans[0]![1]!) === LIMITED_MARK;
    if (spans.length > 1 || (spans.length === 1 && !limitedSpan)) return null;
    const codeCell = cellText(cells[1]!);
    // A registry code (8 digits) or, for a sole proprietor, a personal code (11 digits).
    const codeMatch = limitedSpan ? new RegExp(`^(?:\\d{8}|\\d{11}) ${LIMITED_MARK}$`).test(codeCell) : /^(?:\d{8}|\d{11})$/.test(codeCell);
    const registered = strictDate(cellText(cells[3]!));
    const deletedText = cellText(cells[4]!);
    const deleted = deletedText === "" ? null : strictDate(deletedText);
    const decisionText = cellText(cells[5]!);
    const decision = decisionText === "" ? null : strictDate(decisionText);
    const vatNumber = cellText(cells[6]!);
    if (!codeMatch || !registered || (deletedText !== "" && !deleted) || (decisionText !== "" && !decision) || !VAT_NUMBER_RE.test(vatNumber)) return null;
    parsed.push({ limited: limitedSpan, registered_on: registered, deleted_on: deleted, decision_on: decision, vat_number: vatNumber });
  }
  return parsed;
}

/** The single active registration of `vatNumber` among the parsed rows. */
export function selectEmtaRegistration(rows: readonly ParsedRow[], vatNumber: string): EmtaKmkrOutcome {
  const matching = rows.filter(row => row.vat_number === vatNumber);
  const active = matching.filter(row => row.deleted_on === null);
  if (active.length === 1) {
    const { deleted_on: _deleted, ...registration } = active[0]!;
    return { ok: true, registration };
  }
  if (active.length > 1) return { ok: false, code: "emta_registration_ambiguous", detail: `EMTA shows ${active.length} active registrations for ${vatNumber}` };
  if (matching.length > 0) return { ok: false, code: "emta_registration_deleted", detail: `EMTA shows the registration of ${vatNumber} as deleted (${matching.map(row => row.deleted_on).join(", ")})` };
  return { ok: false, code: "emta_registration_not_found", detail: `EMTA shows no registration for ${vatNumber}` };
}

function charsetOf(contentType: string | null): string {
  const match = /charset\s*=\s*"?([A-Za-z0-9_.:-]+)"?/i.exec(contentType ?? "");
  return match ? match[1]!.toLowerCase() : "utf-8";
}

async function readBody(response: EmtaFetchResponse): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > EMTA_MAX_BODY_BYTES) return null;
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > EMTA_MAX_BODY_BYTES) return null;
  try {
    return new TextDecoder(charsetOf(response.headers.get("content-type"))).decode(bytes);
  } catch {
    return null;
  }
}

function cookieHeader(response: EmtaFetchResponse): string {
  const raw = response.headers.getSetCookie?.() ?? [];
  return raw
    .map(entry => entry.split(";", 1)[0]!.trim())
    .filter(pair => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[^;,\s]*$/.test(pair))
    .join("; ");
}

function csrfTokenOf(html: string): string | null {
  const inputs = [...html.matchAll(/<input\b[^>]*>/gi)].map(match => match[0]).filter(tag => /\bname\s*=\s*"CSRFToken"/i.test(tag));
  if (inputs.length !== 1) return null;
  const value = /\bvalue\s*=\s*"([^"]*)"/i.exec(inputs[0]!)?.[1];
  return value !== undefined && CSRF_TOKEN_RE.test(value) ? value : null;
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMTA_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

const defaultFetch: EmtaFetch = (url, init) =>
  fetch(url, { ...init, credentials: "omit", redirect: "error" }) as unknown as Promise<EmtaFetchResponse>;

/** Looks up one Estonian VAT number (EE + 9 digits) in EMTA's public KMKR query. */
export async function lookupEmtaKmkr(vatNumber: string, deps: EmtaKmkrDeps = {}): Promise<EmtaKmkrOutcome> {
  const normalized = normalizeEstonianVatNumber(vatNumber);
  if (!normalized) return { ok: false, code: "emta_registration_not_found", detail: `${vatNumber} is not an Estonian VAT number (EE + 9 digits)` };
  const fetchImpl = deps.fetch ?? defaultFetch;
  try {
    const form = await withTimeout(signal => fetchImpl(EMTA_KMKR_FORM_URL, { method: "GET", headers: { Accept: "text/html" }, signal }));
    if (!form.ok) return { ok: false, code: "emta_lookup_unavailable", detail: `EMTA form answered HTTP ${form.status}` };
    const formBody = await readBody(form);
    if (formBody === null) return { ok: false, code: "emta_response_invalid", detail: "EMTA form page is too large or undecodable" };
    const token = csrfTokenOf(formBody);
    if (!token) return { ok: false, code: "emta_response_invalid", detail: "EMTA form page has no CSRF token" };
    const cookie = cookieHeader(form);
    const body = new URLSearchParams({ personCode: normalized, p_submit: "Otsi", CSRFToken: token }).toString();
    const answer = await withTimeout(signal => fetchImpl(EMTA_KMKR_QUERY_URL, {
      method: "POST",
      headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
      body,
      signal,
    }));
    if (!answer.ok) return { ok: false, code: "emta_lookup_unavailable", detail: `EMTA query answered HTTP ${answer.status}` };
    const html = await readBody(answer);
    if (html === null) return { ok: false, code: "emta_response_invalid", detail: "EMTA answer is too large or undecodable" };
    const rows = parseEmtaKmkrTable(html);
    if (rows === null) return { ok: false, code: "emta_response_invalid", detail: "EMTA answer does not have the expected result table" };
    return selectEmtaRegistration(rows, normalized);
  } catch (error) {
    const aborted = (error as { name?: string }).name === "AbortError";
    return { ok: false, code: "emta_lookup_unavailable", detail: aborted ? "EMTA did not answer within 10 s" : "EMTA could not be reached" };
  }
}

/** A successful in-process lookup is reused this long (the caller's store record has the same window). */
const SUCCESS_REUSE_MS = 7 * 86_400_000;
/** A failed lookup is not retried within this window, so bookings do not each wait on EMTA. */
const FAILURE_RETRY_MS = 60_000;
const CACHE_MAX_ENTRIES = 256;

// EMTA's register is public data shared by every connection, so this cache
// survives switch_connection (like the ECB rates). It also serves single-file
// rules mode, where no lookup record can be stored.
const lookupCache = new Map<string, { outcome: EmtaKmkrOutcome; at: number }>();

/** Test seam: drop the in-process lookup cache. */
export function resetEmtaKmkrCache(): void {
  lookupCache.clear();
}

/** `lookupEmtaKmkr` behind the in-process cache; `at` = when the outcome was fetched (ms). */
export async function lookupEmtaKmkrCached(vatNumber: string, now: number, deps: EmtaKmkrDeps = {}): Promise<{ outcome: EmtaKmkrOutcome; at: number }> {
  const key = normalizeEstonianVatNumber(vatNumber) ?? vatNumber;
  const cached = lookupCache.get(key);
  if (cached && now - cached.at >= 0 && now - cached.at < (cached.outcome.ok ? SUCCESS_REUSE_MS : FAILURE_RETRY_MS)) return cached;
  const entry = { outcome: await lookupEmtaKmkr(vatNumber, deps), at: now };
  lookupCache.delete(key);
  lookupCache.set(key, entry);
  while (lookupCache.size > CACHE_MAX_ENTRIES) {
    const oldest = lookupCache.keys().next().value;
    if (oldest === undefined) break;
    lookupCache.delete(oldest);
  }
  return entry;
}
