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
  | {
      ok: false;
      code: EmtaKmkrFailureCode;
      detail: string;
      /** EMTA refused (HTTP 403/429) or did not answer in time: it may be throttling this host. */
      throttled?: boolean;
    };

export interface EmtaFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null; getSetCookie?(): string[] };
  body: ReadableStream<Uint8Array> | null;
}

export type EmtaFetch = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<EmtaFetchResponse>;

export interface EmtaKmkrDeps {
  fetch?: EmtaFetch;
  /** Test seam: the per-request deadline (headers and body), default 10 s. */
  timeoutMs?: number;
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

const TOKEN_RE = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][A-Za-z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const TABLE_SECTION_TAGS = new Set(["thead", "tbody", "tfoot"]);
const TABLE_STRUCTURE_TAGS = new Set(["table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "td", "th"]);

/** The class tokens of a tag's attribute text (double-, single- or unquoted). */
function classesOf(attributes: string): string[] {
  const match = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attributes);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").split(/\s+/).filter(Boolean);
}

/**
 * The cells (raw HTML) of each row of the table whose content starts at
 * `start`, walked tag by tag: every row and cell must be explicitly closed,
 * nothing but whitespace may sit outside a cell, and no table may be nested.
 * null = any other structure.
 */
function tableRows(html: string, start: number): string[][] | null {
  const rows: string[][] = [];
  let row: string[] | null = null;
  let cell: { tag: string; from: number } | null = null;
  let last = start;
  TOKEN_RE.lastIndex = start;
  for (let token = TOKEN_RE.exec(html); token; token = TOKEN_RE.exec(html)) {
    const between = html.slice(last, token.index);
    last = TOKEN_RE.lastIndex;
    if (cell === null && between.trim() !== "") return null;
    if (token[2] === undefined) continue; // a comment
    const closing = token[1] === "/";
    const tag = token[2].toLowerCase();
    if (cell !== null) {
      if (closing && tag === cell.tag) {
        row!.push(html.slice(cell.from, token.index));
        cell = null;
        continue;
      }
      if (TABLE_STRUCTURE_TAGS.has(tag)) return null;
      continue;
    }
    if (tag === "table") {
      if (!closing || row !== null) return null;
      return rows;
    }
    if (TABLE_SECTION_TAGS.has(tag)) {
      if (row !== null) return null;
      continue;
    }
    if (tag === "tr") {
      if (closing ? row === null : row !== null) return null;
      if (closing) rows.push(row!);
      row = closing ? null : [];
      continue;
    }
    if ((tag === "td" || tag === "th") && !closing && row !== null) {
      cell = { tag, from: TOKEN_RE.lastIndex };
      continue;
    }
    return null;
  }
  return null; // the table is never closed
}

interface ParsedRow {
  limited: boolean;
  registered_on: string;
  deleted_on: string | null;
  decision_on: string | null;
  vat_number: string;
}

/** How often the limited-taxpayer marker appears in the page's text (any case, entities decoded). */
function limitedMarkCount(html: string): number {
  return cellText(html).toLowerCase().split(LIMITED_MARK.toLowerCase()).length - 1;
}

/**
 * The rows of the answer's one result table; null = unexpected shape. A page
 * without a result table (and without a limited-taxpayer marker) is an empty
 * list. The table is walked structurally, every `table.grid` (any quoting)
 * counts, and the page must carry the limited marker exactly as often as
 * there are limited rows: a marker anywhere else is never read as `full`.
 */
export function parseEmtaKmkrTable(html: string): ParsedRow[] | null {
  const grids: number[] = [];
  TOKEN_RE.lastIndex = 0;
  for (let token = TOKEN_RE.exec(html); token; token = TOKEN_RE.exec(html)) {
    if (token[1] !== "/" && token[2]?.toLowerCase() === "table" && classesOf(token[3] ?? "").includes("grid")) grids.push(TOKEN_RE.lastIndex);
  }
  const marks = limitedMarkCount(html);
  if (grids.length === 0) return marks === 0 ? [] : null;
  if (grids.length > 1) return null;
  const rows = tableRows(html, grids[0]!);
  if (rows === null || rows.length === 0) return null;
  const header = rows[0]!.map(cellText);
  if (header.length !== EXPECTED_HEADER.length || header.some((cell, index) => cell !== EXPECTED_HEADER[index])) return null;
  const parsed: ParsedRow[] = [];
  for (const cells of rows.slice(1)) {
    if (cells.length !== EXPECTED_HEADER.length) return null;
    const spans = [...cells[1]!.matchAll(/<span\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/span>/gi)];
    const limitedSpan = spans.length === 1 && classesOf(spans[0]![1]!).includes("boldblock") && cellText(spans[0]![2]!) === LIMITED_MARK;
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
  if (marks !== parsed.filter(row => row.limited).length) return null;
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

/**
 * The body as text, read as a stream so an oversized answer is cut off at
 * the cap (declared or not); null = too large or undecodable.
 */
async function readBody(response: EmtaFetchResponse): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > EMTA_MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > EMTA_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
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

class EmtaTimeoutError extends Error {
  override readonly name = "AbortError";
}

/**
 * Runs one request (fetch and body) under one deadline: the signal aborts
 * the fetch and its body stream, and the race settles even when a body
 * ignores the abort.
 */
async function withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new EmtaTimeoutError("EMTA did not answer in time"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const throttledStatus = (status: number) => status === 403 || status === 429;

const defaultFetch: EmtaFetch = (url, init) =>
  fetch(url, { ...init, credentials: "omit", redirect: "error" }) as unknown as Promise<EmtaFetchResponse>;

/** Looks up one Estonian VAT number (EE + 9 digits) in EMTA's public KMKR query. */
export async function lookupEmtaKmkr(vatNumber: string, deps: EmtaKmkrDeps = {}): Promise<EmtaKmkrOutcome> {
  const normalized = normalizeEstonianVatNumber(vatNumber);
  if (!normalized) return { ok: false, code: "emta_registration_not_found", detail: `${vatNumber} is not an Estonian VAT number (EE + 9 digits)` };
  const fetchImpl = deps.fetch ?? defaultFetch;
  const timeoutMs = deps.timeoutMs ?? EMTA_TIMEOUT_MS;
  try {
    const form = await withTimeout(timeoutMs, async signal => {
      const response = await fetchImpl(EMTA_KMKR_FORM_URL, { method: "GET", headers: { Accept: "text/html" }, signal });
      return { response, body: response.ok ? await readBody(response) : null };
    });
    if (!form.response.ok) return { ok: false, code: "emta_lookup_unavailable", detail: `EMTA form answered HTTP ${form.response.status}`, ...(throttledStatus(form.response.status) ? { throttled: true } : {}) };
    if (form.body === null) return { ok: false, code: "emta_response_invalid", detail: "EMTA form page is too large or undecodable" };
    const token = csrfTokenOf(form.body);
    if (!token) return { ok: false, code: "emta_response_invalid", detail: "EMTA form page has no CSRF token" };
    const cookie = cookieHeader(form.response);
    const body = new URLSearchParams({ personCode: normalized, p_submit: "Otsi", CSRFToken: token }).toString();
    const answer = await withTimeout(timeoutMs, async signal => {
      const response = await fetchImpl(EMTA_KMKR_QUERY_URL, {
        method: "POST",
        headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
        body,
        signal,
      });
      return { response, html: response.ok ? await readBody(response) : null };
    });
    if (!answer.response.ok) return { ok: false, code: "emta_lookup_unavailable", detail: `EMTA query answered HTTP ${answer.response.status}`, ...(throttledStatus(answer.response.status) ? { throttled: true } : {}) };
    if (answer.html === null) return { ok: false, code: "emta_response_invalid", detail: "EMTA answer is too large or undecodable" };
    const rows = parseEmtaKmkrTable(answer.html);
    if (rows === null) return { ok: false, code: "emta_response_invalid", detail: "EMTA answer does not have the expected result table" };
    return selectEmtaRegistration(rows, normalized);
  } catch (error) {
    const aborted = (error as { name?: string }).name === "AbortError";
    return aborted
      ? { ok: false, code: "emta_lookup_unavailable", detail: `EMTA did not answer within ${timeoutMs / 1000} s`, throttled: true }
      : { ok: false, code: "emta_lookup_unavailable", detail: "EMTA could not be reached" };
  }
}

/** A successful in-process lookup is reused this long (the caller's store record has the same window). */
const SUCCESS_REUSE_MS = 7 * 86_400_000;
/** A failed lookup is not retried within this window, so bookings do not each wait on EMTA. */
const FAILURE_RETRY_MS = 60_000;
const CACHE_MAX_ENTRIES = 256;
/**
 * After EMTA refuses (403/429) or does not answer, nobody in this process
 * asks it again for this long: EMTA throttles a host after a few queries a
 * minute (403, then requests that hang for minutes), so other numbers must
 * not keep hitting it either.
 */
export const EMTA_THROTTLE_COOLDOWN_MS = 60_000;

type CachedLookup = { outcome: EmtaKmkrOutcome; at: number };

// EMTA's register is public data shared by every connection, so this cache
// survives switch_connection (like the ECB rates). It also serves single-file
// rules mode, where no lookup record can be stored.
const lookupCache = new Map<string, CachedLookup>();
/** One request per number at a time: concurrent callers share it. */
const inFlight = new Map<string, Promise<CachedLookup>>();
/** When EMTA disproved a registration (not found / deleted / ambiguous), per number (ms). */
const contradictedAt = new Map<string, number>();
let cooldownUntil = 0;

/** Test seam: drop the in-process lookup cache, the pending lookups and the cooldown. */
export function resetEmtaKmkrCache(): void {
  lookupCache.clear();
  inFlight.clear();
  contradictedAt.clear();
  cooldownUntil = 0;
}

/** EMTA answered, and the answer leaves no single active registration of the number. */
export function isContradictingEmtaFailure(code: EmtaKmkrFailureCode): boolean {
  return code === "emta_registration_not_found" || code === "emta_registration_deleted" || code === "emta_registration_ambiguous";
}

/** The latest time (ms) this process saw EMTA disprove a registration of the number, if any. */
export function emtaContradictedAt(vatNumber: string): number | undefined {
  return contradictedAt.get(normalizeEstonianVatNumber(vatNumber) ?? vatNumber);
}

function remember(key: string, entry: CachedLookup): CachedLookup {
  if (!entry.outcome.ok && isContradictingEmtaFailure(entry.outcome.code)) {
    contradictedAt.set(key, Math.max(contradictedAt.get(key) ?? entry.at, entry.at));
  }
  const existing = lookupCache.get(key);
  // Older evidence never replaces newer.
  if (existing && existing.at > entry.at) return existing;
  lookupCache.delete(key);
  lookupCache.set(key, entry);
  while (lookupCache.size > CACHE_MAX_ENTRIES) {
    const oldest = lookupCache.keys().next().value;
    if (oldest === undefined) break;
    lookupCache.delete(oldest);
  }
  return entry;
}

/**
 * `lookupEmtaKmkr` behind the in-process cache; `at` = when the outcome was
 * fetched (ms). Concurrent calls for one number share one request, and a
 * cooldown after a throttling answer answers "unavailable" without a request.
 */
export async function lookupEmtaKmkrCached(vatNumber: string, now: number, deps: EmtaKmkrDeps = {}): Promise<CachedLookup> {
  const key = normalizeEstonianVatNumber(vatNumber) ?? vatNumber;
  const cached = lookupCache.get(key);
  if (cached && now - cached.at >= 0 && now - cached.at < (cached.outcome.ok ? SUCCESS_REUSE_MS : FAILURE_RETRY_MS)) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;
  if (now < cooldownUntil) {
    return {
      outcome: { ok: false, code: "emta_lookup_unavailable", detail: `EMTA refused or did not answer a recent query; not asked again before ${new Date(cooldownUntil).toISOString()}`, throttled: true },
      at: now,
    };
  }
  const request = (async () => {
    try {
      const outcome = await lookupEmtaKmkr(vatNumber, deps);
      if (!outcome.ok && outcome.throttled) cooldownUntil = Math.max(cooldownUntil, now + EMTA_THROTTLE_COOLDOWN_MS);
      return remember(key, { outcome, at: now });
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, request);
  return request;
}
