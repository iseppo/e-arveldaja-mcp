import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { getGlobalConfigDir, writePrivateFile } from "./config.js";
import { isValidEstonianRegistryCode, lookupEmtaKmkrCached, normalizeEstonianVatNumber, type EmtaKmkrDeps } from "./emta-kmkr.js";
import type { AccountingRulesCompany } from "./accounting-rules.js";
import type { ApiContext } from "./tools/crud-tools.js";
import { log } from "./logger.js";

/**
 * Which company a connection (API key) belongs to, from public registers:
 *
 *  1. The company's VAT number (`/vat_info`) → EMTA's public KMKR query → the
 *     registry code of its one active registration (check digit verified).
 *  2. No VAT number → the business register (äriregister) autocomplete by the
 *     company name (`/invoice_info.invoice_company_name`): accepted only when
 *     exactly one not-deleted company has exactly that name (names are unique
 *     among registered companies).
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

/** sha256(server + registry code): the company store's key. */
export function companyKeyOf(server: string, registryCode: string): string {
  return createHash("sha256").update(`${normalizeCompanyServer(server)}\n${registryCode}`).digest("hex");
}

/** Exact name comparison: case, Unicode form and whitespace only (legal forms count). */
export function exactCompanyName(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("et");
}

// ---------------------------------------------------------------------------
// Mapping file
// ---------------------------------------------------------------------------

type Mapping = Record<string, CompanyIdentityEntry>;
let mappingCache: { key: string; value: Mapping } | undefined;

function mappingPath(): string {
  return resolve(getGlobalConfigDir(), COMPANY_IDENTITY_FILE);
}

function isEntry(value: unknown): value is CompanyIdentityEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.server === "string" && entry.server !== ""
    && typeof entry.registry_code === "string" && isValidEstonianRegistryCode(entry.registry_code)
    && (entry.source === "emta_kmkr" || entry.source === "ariregister_name")
    && typeof entry.resolved_at === "string";
}

/** The persisted mapping fingerprint → company; an absent or unreadable file is empty (never throws). */
export function readCompanyIdentityMapping(): Mapping {
  const path = mappingPath();
  let stamp: string;
  try {
    if (!existsSync(path)) return {};
    const info = statSync(path);
    if (info.size > MAX_MAPPING_BYTES) return {};
    stamp = `${path}:${info.mtimeMs}:${info.size}`;
  } catch {
    return {};
  }
  if (mappingCache?.key === stamp) return mappingCache.value;
  const value: Mapping = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown };
    const entries = parsed.entries;
    if (entries && typeof entries === "object") {
      for (const [fingerprint, entry] of Object.entries(entries as Record<string, unknown>)) {
        if (/^[0-9a-f]{64}$/.test(fingerprint) && isEntry(entry)) value[fingerprint] = entry;
      }
    }
  } catch {
    log("warning", `Could not read ${path}; companies are resolved again.`);
  }
  mappingCache = { key: stamp, value };
  return value;
}

export function recordCompanyIdentity(fingerprint: string, entry: CompanyIdentityEntry): void {
  const entries = { ...readCompanyIdentityMapping(), [fingerprint]: entry };
  writePrivateFile(mappingPath(), `${JSON.stringify({ version: MAPPING_VERSION, entries }, null, 2)}\n`);
  mappingCache = undefined;
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
}

/** Why this fingerprint's company is not resolved in this process (after an attempt), if known. */
export function unresolvedCompanyReason(fingerprint: string): string | undefined {
  return lastReason.get(slot(fingerprint));
}

function adopt(fingerprint: string): AccountingRulesCompany | null {
  const company = mappedCompany(fingerprint);
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
  | { ok: true; registry_code: string; source: CompanyIdentitySource }
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
    return { ok: true, registry_code: outcome.registry_code, source: "emta_kmkr" };
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
  return { ok: true, registry_code: code, source: "ariregister_name" };
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
              lastReason.delete(slot(fingerprint));
              recordCompanyIdentity(fingerprint, {
                server: normalizeCompanyServer(server),
                registry_code: resolution.registry_code,
                source: resolution.source,
                resolved_at: new Date(now).toISOString(),
              });
            } else {
              lastReason.set(slot(fingerprint), resolution.reason);
              log("info", `Company registry code not resolved (${resolution.reason}); local rules stay in the per-key store.`);
            }
          } catch (error) {
            lastReason.set(slot(fingerprint), "resolution_failed");
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
