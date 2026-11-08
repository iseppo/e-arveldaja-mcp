import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { getGlobalConfigDir, writePrivateFile } from "./config.js";
import { isValidEstonianRegistryCode, lookupEmtaKmkrCached, normalizeEstonianVatNumber, type EmtaKmkrDeps } from "./emta-kmkr.js";
import { withBundleLock, type AccountingRulesCompany } from "./accounting-rules.js";
import type { ApiContext } from "./tools/crud-tools.js";
import { deriveOwnCompanyRegistryCode } from "./tools/receipt-inbox.js";
import { log } from "./logger.js";

/**
 * Which company a connection (API key) belongs to, from public registers:
 *
 *  1. The company's VAT number (`/vat_info`) → EMTA's public KMKR query → the
 *     registry code of its one active registration (check digit verified).
 *  2. No VAT number → the business register (äriregister) autocomplete by the
 *     company name (`/invoice_info.invoice_company_name`): accepted only when
 *     exactly one active company has exactly that name (names are unique
 *     among active companies), the company's own client record (if any) has
 *     the same registry code, and no other connection mapped to that code has
 *     a VAT number or another name.
 *  3. Anything else is unresolved: the connection keeps its per-key store.
 *     Never a guess.
 *
 * The result is persisted per connection fingerprint in
 * `<global config dir>/company-identity.json` (0600), so later starts and
 * offline reads need no network. Resolution runs at most once per connection
 * per process (an unresolved attempt is retried after an hour), at the start
 * of a tool call — never inside a rules read.
 */

export type CompanyIdentitySource = "emta_kmkr" | "ariregister_name";

export interface CompanyIdentityEntry {
  server: string;
  registry_code: string;
  source: CompanyIdentitySource;
  resolved_at: string;
  /** The connection's VAT number at resolution (EMTA path), else null. */
  vat_number?: string | null;
  /** The connection's company name at resolution (business-register path), else null. */
  company_name?: string | null;
}

export const COMPANY_IDENTITY_FILE = "company-identity.json";
const MAPPING_VERSION = 1;
const MAX_MAPPING_BYTES = 1024 * 1024;
/** An unresolved connection is not looked up again for this long. */
export const COMPANY_IDENTITY_RETRY_MS = 60 * 60_000;
const ARIREGISTER_AUTOCOMPLETE_URL = "https://ariregister.rik.ee/est/api/autocomplete";
const ARIREGISTER_TIMEOUT_MS = 10_000;
const ARIREGISTER_MAX_BYTES = 256 * 1024;

export function normalizeCompanyServer(server: string): string {
  return server.trim().replace(/\/+$/, "");
}

/**
 * sha256("company\0" + server + "\n" + registry code): the company store's key,
 * domain-separated from the per-key store hashes.
 */
export function companyKeyOf(server: string, registryCode: string): string {
  return createHash("sha256").update(`company\0${normalizeCompanyServer(server)}\n${registryCode}`).digest("hex");
}

/** Exact name comparison: case, Unicode form and whitespace only (legal forms count). */
export function exactCompanyName(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("et");
}

// ---------------------------------------------------------------------------
// Mapping file
// ---------------------------------------------------------------------------

type Mapping = Record<string, CompanyIdentityEntry>;
let mappingCache: { key: string; value: Mapping; problem: string | undefined } | undefined;
const reportedMappingProblems = new Set<string>();

function mappingPath(): string {
  return resolve(getGlobalConfigDir(), COMPANY_IDENTITY_FILE);
}

function isEntry(value: unknown): value is CompanyIdentityEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.server === "string" && entry.server !== ""
    && typeof entry.registry_code === "string" && isValidEstonianRegistryCode(entry.registry_code)
    && (entry.source === "emta_kmkr" || entry.source === "ariregister_name")
    && typeof entry.resolved_at === "string"
    && (entry.vat_number === undefined || entry.vat_number === null || typeof entry.vat_number === "string")
    && (entry.company_name === undefined || entry.company_name === null || typeof entry.company_name === "string");
}

function readMappingState(): { value: Mapping; problem: string | undefined } {
  const path = mappingPath();
  let stamp: string;
  try {
    if (!existsSync(path)) return { value: {}, problem: undefined };
    const info = statSync(path);
    if (info.size > MAX_MAPPING_BYTES) return { value: {}, problem: "file too large" };
    stamp = `${path}:${info.mtimeMs}:${info.size}`;
  } catch (error) {
    return { value: {}, problem: error instanceof Error ? error.message : String(error) };
  }
  if (mappingCache?.key === stamp) return mappingCache;
  const value: Mapping = {};
  let problem: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; entries?: unknown };
    const entries = parsed?.entries;
    if (parsed?.version !== MAPPING_VERSION || !entries || typeof entries !== "object" || Array.isArray(entries)) {
      problem = "unknown format";
    } else {
      for (const [fingerprint, entry] of Object.entries(entries as Record<string, unknown>)) {
        if (/^[0-9a-f]{64}$/.test(fingerprint) && isEntry(entry)) value[fingerprint] = entry;
        else problem = "invalid entry";
      }
    }
  } catch {
    problem = "not valid JSON";
  }
  if (problem && !reportedMappingProblems.has(stamp)) {
    reportedMappingProblems.add(stamp);
    log("warning", `${path} cannot be read (${problem}); it is left unchanged and no new company is recorded until it is fixed or removed.`);
  }
  mappingCache = { key: stamp, value, problem };
  return mappingCache;
}

/** The persisted mapping fingerprint → company; valid entries of a damaged file are still used (never throws). */
export function readCompanyIdentityMapping(): Mapping {
  return readMappingState().value;
}

/** Why the mapping file cannot be updated (damaged), if so. */
export function companyIdentityMappingProblem(): string | undefined {
  return readMappingState().problem;
}

/**
 * Add one entry under the mapping file's lock, re-reading it first. A damaged
 * file is never overwritten (throws). `check` may veto the write against the
 * fresh mapping by returning a reason (then nothing is written).
 */
export function recordCompanyIdentity(
  fingerprint: string,
  entry: CompanyIdentityEntry,
  check?: (mapping: Mapping) => string | undefined,
): string | undefined {
  return withBundleLock(mappingPath(), () => {
    mappingCache = undefined;
    const state = readMappingState();
    if (state.problem) throw new Error(`${COMPANY_IDENTITY_FILE} cannot be read (${state.problem}); not overwritten`);
    const veto = check?.(state.value);
    if (veto) return veto;
    const entries = { ...state.value, [fingerprint]: entry };
    writePrivateFile(mappingPath(), `${JSON.stringify({ version: MAPPING_VERSION, entries }, null, 2)}\n`);
    mappingCache = undefined;
    return undefined;
  });
}

/** The company the mapping ties this fingerprint to, with every fingerprint of that company. */
export function mappedCompany(fingerprint: string): (AccountingRulesCompany & { entry: CompanyIdentityEntry }) | undefined {
  const mapping = readCompanyIdentityMapping();
  const entry = mapping[fingerprint];
  if (!entry) return undefined;
  const server = normalizeCompanyServer(entry.server);
  const fingerprints = Object.entries(mapping)
    .filter(([, other]) => normalizeCompanyServer(other.server) === server && other.registry_code === entry.registry_code)
    .map(([fp]) => fp)
    .sort();
  return { key: companyKeyOf(server, entry.registry_code), fingerprints, entry };
}

// ---------------------------------------------------------------------------
// Adoption (what rules reads use) and resolution (network, per tool call)
// ---------------------------------------------------------------------------

/** The company each fingerprint uses in this process; changed only at the start of a tool call. */
const adopted = new Map<string, AccountingRulesCompany | null>();
const lastAttempt = new Map<string, number>();
const lastReason = new Map<string, string>();
const inFlight = new Map<string, Promise<void>>();

/** Per-process state is kept per config dir + fingerprint (the mapping lives in the config dir). */
function slot(fingerprint: string): string {
  return `${getGlobalConfigDir()}\0${fingerprint}`;
}

/** Test seam. */
export function resetCompanyIdentityState(): void {
  adopted.clear();
  lastAttempt.clear();
  lastReason.clear();
  inFlight.clear();
  mappingCache = undefined;
  reportedMappingProblems.clear();
}

/** Why this fingerprint's company is not resolved in this process (after an attempt), if known. */
export function unresolvedCompanyReason(fingerprint: string): string | undefined {
  return lastReason.get(slot(fingerprint));
}

function adopt(fingerprint: string): AccountingRulesCompany | null {
  const company = mappedCompany(fingerprint);
  const previous = adopted.get(slot(fingerprint));
  // Never downgrade or switch a company already adopted in this process (a
  // mapping file damaged or edited meanwhile): stores never change mid-process.
  if (previous && (!company || company.key !== previous.key)) return previous;
  const value = company ? { key: company.key, fingerprints: company.fingerprints } : null;
  adopted.set(slot(fingerprint), value);
  return value;
}

/**
 * The company rules reads use for this fingerprint: fixed for the process
 * until the next tool call re-adopts it, read from the mapping file on first
 * use (no network).
 */
export function adoptedCompany(fingerprint: string): AccountingRulesCompany | undefined {
  const value = adopted.has(slot(fingerprint)) ? adopted.get(slot(fingerprint))! : adopt(fingerprint);
  return value ?? undefined;
}

export type RegistryCodeResolution =
  | { ok: true; registry_code: string; source: CompanyIdentitySource; vat_number: string | null; company_name: string | null }
  | { ok: false; reason: string };

export interface CompanyIdentityDeps {
  emta?: EmtaKmkrDeps;
  /** Test seam for the business register request. */
  fetch?: typeof fetch;
  now?: () => number;
  /** false = only re-adopt from the mapping file (no request); default true. */
  network?: boolean;
}

async function ariregisterByName(name: string, fetchImpl: typeof fetch): Promise<unknown[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ARIREGISTER_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${ARIREGISTER_AUTOCOMPLETE_URL}?q=${encodeURIComponent(name)}`, { signal: controller.signal });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > ARIREGISTER_MAX_BYTES) return null;
    const payload = JSON.parse(text) as { data?: unknown };
    return Array.isArray(payload?.data) ? payload.data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** The company's registry code from public registers, or why there is none. */
export async function resolveRegistryCode(api: ApiContext, deps: CompanyIdentityDeps = {}): Promise<RegistryCodeResolution> {
  let vatNumber: string | undefined;
  try {
    vatNumber = (await api.readonly.getVatInfo({ excludeFromAuthBrake: true })).vat_number?.trim() || undefined;
  } catch {
    return { ok: false, reason: "vat_info_unavailable" };
  }
  if (vatNumber) {
    const normalized = normalizeEstonianVatNumber(vatNumber);
    if (!normalized) return { ok: false, reason: "vat_number_not_estonian" };
    const { outcome } = await lookupEmtaKmkrCached(normalized, (deps.now ?? Date.now)(), deps.emta ?? {});
    if (!outcome.ok) return { ok: false, reason: outcome.code };
    if (!outcome.registry_code) return { ok: false, reason: "emta_no_registry_code" };
    return { ok: true, registry_code: outcome.registry_code, source: "emta_kmkr", vat_number: normalized, company_name: null };
  }
  let name: string | undefined;
  try {
    name = (await api.readonly.getInvoiceInfo({ excludeFromAuthBrake: true })).invoice_company_name?.trim() || undefined;
  } catch {
    return { ok: false, reason: "invoice_info_unavailable" };
  }
  if (!name) return { ok: false, reason: "company_name_missing" };
  const entries = await ariregisterByName(name, deps.fetch ?? fetch);
  if (!entries) return { ok: false, reason: "ariregister_unavailable" };
  const target = exactCompanyName(name);
  const matches = entries.filter((candidate): candidate is Record<string, unknown> => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const entry = candidate as Record<string, unknown>;
    // Status: R registered, L in liquidation, N bankrupt, K deleted. Historical names never count.
    return typeof entry.name === "string" && exactCompanyName(entry.name) === target
      && typeof entry.status === "string" && /^[RLN]$/.test(entry.status.trim().toUpperCase());
  });
  if (matches.length !== 1) return { ok: false, reason: matches.length === 0 ? "ariregister_no_exact_match" : "ariregister_ambiguous" };
  const code = String(matches[0]!.reg_code ?? "");
  if (!isValidEstonianRegistryCode(code)) return { ok: false, reason: "ariregister_invalid_registry_code" };
  // The company's own client record, when it carries a registry code, must agree.
  let ownCode: string | undefined;
  try {
    ownCode = deriveOwnCompanyRegistryCode(await api.clients.listAll(), undefined, name)?.replace(/\s+/g, "");
  } catch {
    return { ok: false, reason: "client_record_unavailable" };
  }
  if (ownCode && ownCode !== code) return { ok: false, reason: "ariregister_client_record_mismatch" };
  return { ok: true, registry_code: code, source: "ariregister_name", vat_number: null, company_name: name };
}

/**
 * A name-based mapping is refused when another connection on the same server
 * is mapped to the same registry code with a VAT number (this company has
 * none) or with another company name.
 */
function nameMappingConflict(fingerprint: string, server: string, registryCode: string, name: string | null, mapping: Mapping): string | undefined {
  for (const [otherFingerprint, other] of Object.entries(mapping)) {
    if (otherFingerprint === fingerprint) continue;
    if (normalizeCompanyServer(other.server) !== server || other.registry_code !== registryCode) continue;
    if (other.vat_number) return "ariregister_conflicting_mapping";
    if (other.company_name && name && exactCompanyName(other.company_name) !== exactCompanyName(name)) return "ariregister_conflicting_mapping";
  }
  return undefined;
}

/**
 * At the start of a tool call: resolve the connection's company once per
 * process (mapping file first, then the network), then re-adopt it so the
 * whole call uses one store. Never throws; a failure keeps the per-key store.
 */
export async function ensureCompanyIdentity(
  fingerprint: string,
  server: string,
  api: ApiContext,
  deps: CompanyIdentityDeps = {},
): Promise<void> {
  const now = (deps.now ?? Date.now)();
  if (deps.network !== false && !readCompanyIdentityMapping()[fingerprint]) {
    const attempted = lastAttempt.get(slot(fingerprint));
    if (attempted === undefined || now - attempted >= COMPANY_IDENTITY_RETRY_MS) {
      let pending = inFlight.get(slot(fingerprint));
      if (!pending) {
        pending = (async () => {
          try {
            const resolution = await resolveRegistryCode(api, deps);
            if (resolution.ok) {
              const normalizedServer = normalizeCompanyServer(server);
              const veto = recordCompanyIdentity(fingerprint, {
                server: normalizedServer,
                registry_code: resolution.registry_code,
                source: resolution.source,
                resolved_at: new Date(now).toISOString(),
                vat_number: resolution.vat_number,
                company_name: resolution.company_name,
              }, mapping => resolution.source === "ariregister_name"
                ? nameMappingConflict(fingerprint, normalizedServer, resolution.registry_code, resolution.company_name, mapping)
                : undefined);
              if (veto) {
                lastReason.set(slot(fingerprint), veto);
                log("info", `Company registry code not resolved (${veto}); local rules stay in the per-key store.`);
              } else {
                lastReason.delete(slot(fingerprint));
              }
            } else {
              lastReason.set(slot(fingerprint), resolution.reason);
              log("info", `Company registry code not resolved (${resolution.reason}); local rules stay in the per-key store.`);
            }
          } catch (error) {
            lastReason.set(slot(fingerprint), companyIdentityMappingProblem() ? "company_identity_file_unreadable" : "resolution_failed");
            log("warning", `Company identity resolution failed: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            lastAttempt.set(slot(fingerprint), now);
            inFlight.delete(slot(fingerprint));
          }
        })();
        inFlight.set(slot(fingerprint), pending);
      }
      await pending;
    }
  }
  adopt(fingerprint);
}
