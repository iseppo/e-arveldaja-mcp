import { createConnectionScopedBundleStore } from "./connection-scoped-bundle-store.js";
import { lookupEmtaKmkrCached, normalizeEstonianVatNumber, type EmtaKmkrDeps, type EmtaKmkrFailureCode, type EmtaKmkrOutcome, type EmtaKmkrRegistration } from "./emta-kmkr.js";
import type { CompanyVatInfo } from "./types/api.js";

/**
 * The company's VAT status for every VAT-treatment decision.
 *
 * `/vat_info` only carries `vat_number` (verified live 2026-11-04: no
 * limited-taxpayer field), and e-arveldaja shows a limited taxpayer's
 * (piiratud maksukohustuslane, KMS § 21) new number there at once, so a
 * number alone does not say `full`. Resolution:
 * 1. an owner decision (`limited_vat` mode `set_status`) made for the current
 *    VAT number wins;
 * 2. otherwise a number is looked up in EMTA's public KMKR query
 *    (`src/emta-kmkr.ts`): the one active registration says `limited` or
 *    `full` (source `emta_lookup`), reused per number for 7 days;
 * 3. EMTA's latest evidence per number is stored (one record: a registration
 *    or a contradiction — no row, deleted only, several active, or an
 *    unreadable page with registration content), written only over older
 *    evidence; the status always derives from the newest record. A
 *    contradiction is `unknown` (fail closed) until EMTA answers or the owner
 *    confirms the status; an unavailable lookup (network, timeout, HTTP, an
 *    unexpected page without registration content) is never stored and
 *    falls back to an expired answer only when that is the newest record;
 * 4. no number is `none`.
 * Only `full` is VAT-registered.
 */
export type CompanyVatStatus = "none" | "limited" | "full";

export const COMPANY_VAT_STATUSES = ["none", "limited", "full"] as const;

/**
 * The resolved status: a stored, looked-up or derived `CompanyVatStatus`, or
 * `unknown` when the status store cannot be read (or holds an invalid
 * setting), or when the VAT number's registration type cannot be established.
 * `unknown` is never treated as `full` or `none`: VAT decisions refuse with
 * the reason code.
 */
export type ResolvedVatStatus = CompanyVatStatus | "unknown";

export const COMPANY_VAT_STATUS_UNKNOWN = "company_vat_status_unknown";
export const COMPANY_VAT_STATUS_LOOKUP_UNAVAILABLE = "company_vat_status_lookup_unavailable";
export const COMPANY_VAT_STATUS_LOOKUP_AMBIGUOUS = "company_vat_status_lookup_ambiguous";

/** Why the status is `unknown`: an unreadable store, an unavailable EMTA lookup, or an inconclusive one. */
export type CompanyVatStatusUnknownReason =
  | typeof COMPANY_VAT_STATUS_UNKNOWN
  | typeof COMPANY_VAT_STATUS_LOOKUP_UNAVAILABLE
  | typeof COMPANY_VAT_STATUS_LOOKUP_AMBIGUOUS;

/** A stored successful lookup is reused for this long before EMTA is asked again. */
export const EMTA_LOOKUP_MAX_AGE_MS = 7 * 86_400_000;

const numberText = (vatNumber: string | null | undefined) => (vatNumber ? `VAT number ${vatNumber}` : "no VAT number");

/** The explanation of an `unknown` status: English for the agent, then Estonian for the owner. */
export function companyVatStatusUnknownMessage(
  resolved: Pick<ResolvedCompanyVatStatus, "reason" | "store_error" | "vat_number" | "decision_status" | "decision_vat_number" | "lookup_error" | "store_available">,
): string {
  if (resolved.reason !== COMPANY_VAT_STATUS_LOOKUP_UNAVAILABLE && resolved.reason !== COMPANY_VAT_STATUS_LOOKUP_AMBIGUOUS) {
    return `${COMPANY_VAT_STATUS_UNKNOWN}: the company VAT status cannot be read from limited-vat.json (${resolved.store_error ?? "invalid setting"}), so VAT treatment cannot be decided. Nothing was written. Repair or restore the file in the accounting-rules bundle, then retry.`;
  }
  const number = resolved.vat_number ?? "";
  const why = resolved.reason === COMPANY_VAT_STATUS_LOOKUP_UNAVAILABLE
    ? `could not be checked in EMTA's public KMKR query (${resolved.lookup_error ?? "no answer"})`
    : `is not settled by EMTA's public KMKR query (${resolved.lookup_error ?? "no single active registration"})`;
  const whyEt = resolved.reason === COMPANY_VAT_STATUS_LOOKUP_UNAVAILABLE
    ? "EMTA avalikust KMKR päringust ei õnnestunud seda kontrollida"
    : "EMTA avalik KMKR päring ei näita selle numbri kohta täpselt üht kehtivat registreeringut";
  const earlier = resolved.decision_status
    ? ` The earlier owner decision "${resolved.decision_status}" was made for ${numberText(resolved.decision_vat_number)}, so it no longer applies.`
    : "";
  const earlierEt = resolved.decision_status
    ? ` Varasem omaniku otsus "${resolved.decision_status}" tehti, kui ${resolved.decision_vat_number ? `KMKR number oli ${resolved.decision_vat_number}` : "KMKR numbrit ei olnud"}, seega see enam ei kehti.`
    : "";
  const fix = resolved.store_available === false
    ? `Retry when EMTA answers; single-file rules mode (EARVELDAJA_RULES_FILE) cannot store an owner decision, so use the bundle storage (EARVELDAJA_RULES_DIR) to confirm it with limited_vat mode "set_status".`
    : `Retry later, or ask the owner and confirm once with limited_vat mode "set_status": status "full" (fully VAT-registered) or status "limited" with effective_from (limited taxpayer); mode "guide" explains the difference.`;
  const fixEt = resolved.store_available === false
    ? "Proovi hiljem uuesti."
    : `Proovi hiljem uuesti või kinnita staatus üks kord: limited_vat mode "set_status" status "full" (täielik käibemaksukohustuslane) või status "limited" koos effective_from kuupäevaga (piiratud maksukohustuslane); vahet selgitab limited_vat mode "guide".`;
  return `${resolved.reason}: e-arveldaja shows ${numberText(resolved.vat_number)} for the company, but whether it is a full VAT registration or a limited taxpayer (piiratud maksukohustuslane, KMS § 21) ${why}, so VAT treatment cannot be decided. Nothing was written.${earlier} ${fix} ` +
    `Omanikule: e-arveldajas on ettevõttel KMKR number ${number}, kuid kas see on täielik käibemaksukohustuslase registreering või piiratud maksukohustuslane, ${whyEt}.${earlierEt} ${fixEt}`;
}

/** Thrown at a VAT decision when the status is `unknown`; `code` is the reason. */
export class CompanyVatStatusUnknownError extends Error {
  readonly code: CompanyVatStatusUnknownReason;
  constructor(resolved: ResolvedCompanyVatStatus) {
    super(companyVatStatusUnknownMessage(resolved));
    this.code = resolved.reason ?? COMPANY_VAT_STATUS_UNKNOWN;
    this.name = "CompanyVatStatusUnknownError";
  }
}

/** One owner-approved status setting. */
export interface CompanyVatStatusRecord {
  kind: "status";
  key: "company_vat_status";
  status: CompanyVatStatus;
  /** First day the status applies (YYYY-MM-DD). */
  effective_from: string;
  set_at: string;
  /**
   * The VAT number (`/vat_info` `vat_number`) the decision was made for; null
   * = the company had no number. Absent only in a record saved before numbers
   * were bound: such a record is bound to the current number on first read.
   */
  vat_number?: string | null;
}

/** Why EMTA's answer leaves no single active registration of the number. */
export type EmtaContradictionReason = "not_found" | "deleted" | "ambiguous" | "contradictory_page";

const CONTRADICTION_CODES: Record<EmtaContradictionReason, EmtaKmkrFailureCode> = {
  not_found: "emta_registration_not_found",
  deleted: "emta_registration_deleted",
  ambiguous: "emta_registration_ambiguous",
  contradictory_page: "emta_response_contradictory",
};

/**
 * EMTA's latest evidence about one VAT number: its single active
 * registration, or a contradiction. An unavailable lookup is never stored.
 */
export interface CompanyVatLookupRecord {
  kind: "emta_lookup";
  /** `emta_lookup:<EE…>` */
  key: string;
  vat_number: string;
  looked_up_at: string;
  evidence:
    | { kind: "success"; registration: EmtaKmkrRegistration }
    | { kind: "contradiction"; reason: EmtaContradictionReason; detail: string };
}

/** An owner classification of a foreign supplier for the monthly limited-VAT run. */
export interface LimitedVatSupplierRecord {
  kind: "supplier";
  key: string;
  clients_id: number;
  classification: "counts" | "excluded";
  set_at: string;
}

/** One booked monthly limited-VAT journal (main or correction delta). */
export interface LimitedVatBookingRecord {
  kind: "booking";
  key: string;
  month: string;
  document_number: string;
  journal_id: number;
  /** The approved effective date (YYYY-MM-DD); absent in older records = the month's last day. */
  effective_date?: string;
  invoice_ids: number[];
  /** Canonical postings "account|dimension|side|cents", sorted. */
  postings: string[];
  booked_at: string;
}

export type LimitedVatStoreRecord = CompanyVatStatusRecord | CompanyVatLookupRecord | LimitedVatSupplierRecord | LimitedVatBookingRecord;

export const LIMITED_VAT_STORE_FILE = "limited-vat.json";

export const limitedVatStore = createConnectionScopedBundleStore<LimitedVatStoreRecord>({
  fileName: LIMITED_VAT_STORE_FILE,
  label: "Limited-VAT settings (limited-vat.json)",
  maxEntries: 5000,
  keyOf: record => record.key,
});

export const supplierRecordKey = (clientsId: number) => `supplier:${clientsId}`;
export const bookingRecordKey = (documentNumber: string) => `booking:${documentNumber}`;
export const lookupRecordKey = (vatNumber: string) => `emta_lookup:${vatNumber}`;

/** The EMTA facts behind a status of source `emta_lookup`. */
export interface CompanyVatLookupView {
  registration: EmtaKmkrRegistration;
  looked_up_at: string;
  /** True when the cached lookup is older than 7 days and EMTA could not be asked again. */
  stale: boolean;
  /** Why the re-lookup of a stale result failed. */
  refresh_error?: string;
}

export interface ResolvedCompanyVatStatus {
  status: ResolvedVatStatus;
  /**
   * `setting` = owner decision; `emta_lookup` = EMTA's KMKR query; `derived` =
   * no number (or single-file mode without an answer); `store_error` = store
   * unreadable or invalid.
   */
  source: "setting" | "emta_lookup" | "derived" | "store_error";
  vat_number: string | null;
  effective_from: string | null;
  /** False in single-file rules mode: no setting can be stored (so set_status is unavailable). */
  store_available: boolean;
  /** The store exists but could not be read (status `unknown`). */
  store_error?: string;
  /** Why the status is `unknown` (only then). */
  reason?: CompanyVatStatusUnknownReason;
  /** The owner's stored decision when a valid record exists (also when it no longer applies). */
  decision_status?: CompanyVatStatus;
  /** The VAT number that decision was made for (null = no number); present with `decision_status`. */
  decision_vat_number?: string | null;
  /** Source `emta_lookup`: the registration and when it was looked up. */
  lookup?: CompanyVatLookupView;
  /** Why the lookup failed (status `unknown` for a lookup reason). */
  lookup_error?: string;
  lookup_error_code?: EmtaKmkrFailureCode;
}

/**
 * The stored records of this connection, re-read from disk (another process
 * may have written since); null = store unavailable (single-file mode).
 */
export function readLimitedVatRecords(): LimitedVatStoreRecord[] | null {
  limitedVatStore.reset();
  return limitedVatStore.read();
}

/** The `/vat_info` number as shown (trimmed), or null. */
export function companyVatNumber(vatInfo: CompanyVatInfo | undefined): string | null {
  return vatInfo?.vat_number?.trim() || null;
}

/** Two VAT numbers are the same registration when equal ignoring case and whitespace. */
export function sameVatNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, "").toUpperCase();
  return normalize(a) === normalize(b);
}

/** The lookup result the pure derivation gets: a usable registration, or the failure. */
export type CompanyVatLookupInput =
  | { ok: true; view: CompanyVatLookupView }
  | { ok: false; code: EmtaKmkrFailureCode; detail: string };

function lookupFailureReason(code: EmtaKmkrFailureCode): CompanyVatStatusUnknownReason {
  return code === "emta_lookup_unavailable" || code === "emta_response_invalid"
    ? COMPANY_VAT_STATUS_LOOKUP_UNAVAILABLE
    : COMPANY_VAT_STATUS_LOOKUP_AMBIGUOUS;
}

/** The owner decision of these records, or an invalid-record marker. */
function ownerSetting(records: readonly LimitedVatStoreRecord[] | null): CompanyVatStatusRecord | "invalid" | undefined {
  const setting = records?.find((record): record is CompanyVatStatusRecord => record.kind === "status");
  if (!setting) return undefined;
  const storedNumber: unknown = setting.vat_number;
  if (!(COMPANY_VAT_STATUSES as readonly string[]).includes(setting.status) || typeof setting.effective_from !== "string" ||
      !(storedNumber === undefined || storedNumber === null || typeof storedNumber === "string")) {
    return "invalid";
  }
  return setting;
}

/**
 * Pure status derivation. `lookup` is the EMTA result for the current number
 * (omitted when none was needed or made).
 */
export function deriveCompanyVatStatus(
  vatInfo: CompanyVatInfo | undefined,
  records: readonly LimitedVatStoreRecord[] | null,
  storeError?: string,
  lookup?: CompanyVatLookupInput,
): ResolvedCompanyVatStatus {
  const vatNumber = companyVatNumber(vatInfo);
  const base = { vat_number: vatNumber, store_available: records !== null };
  const storeFailure = (detail: string): ResolvedCompanyVatStatus =>
    ({ ...base, status: "unknown", source: "store_error", effective_from: null, store_error: detail, reason: COMPANY_VAT_STATUS_UNKNOWN });
  if (storeError !== undefined) return storeFailure(storeError);
  const setting = ownerSetting(records);
  if (setting === "invalid") return storeFailure("the stored status setting is invalid");
  let decision: { decision_status: CompanyVatStatus; decision_vat_number: string | null } | undefined;
  if (setting) {
    // A record saved before numbers were bound applies to the current number.
    const decisionNumber = setting.vat_number === undefined ? vatNumber : (setting.vat_number?.trim() || null);
    decision = { decision_status: setting.status, decision_vat_number: decisionNumber };
    if (sameVatNumber(decisionNumber, vatNumber)) {
      return { ...base, ...decision, status: setting.status, source: "setting", effective_from: setting.effective_from };
    }
  }
  if (!vatNumber) return { ...base, ...decision, status: "none", source: "derived", effective_from: null };
  if (lookup?.ok) {
    const { registration } = lookup.view;
    return { ...base, ...decision, status: registration.limited ? "limited" : "full", source: "emta_lookup", effective_from: registration.registered_on, lookup: lookup.view };
  }
  const failure = lookup ?? { code: "emta_lookup_unavailable" as const, detail: "not looked up" };
  return {
    ...base,
    ...decision,
    status: "unknown",
    source: "derived",
    effective_from: null,
    reason: lookupFailureReason(failure.code),
    lookup_error: failure.detail,
    lookup_error_code: failure.code,
  };
}

/** The status record saved before numbers were bound, if that is the stored one. */
function legacyStatusRecord(records: readonly LimitedVatStoreRecord[]): CompanyVatStatusRecord | undefined {
  const setting = records.find((record): record is CompanyVatStatusRecord => record.kind === "status");
  return setting && setting.vat_number === undefined ? setting : undefined;
}

/**
 * Binds a status record saved before numbers were bound to the current
 * number, under the store lock and only while that record is unchanged.
 * Returns false when another writer changed it first; throws when the store
 * cannot be written.
 */
function bindLegacyStatusRecord(legacy: CompanyVatStatusRecord, vatNumber: string | null): boolean {
  return limitedVatStore.upsertIf([{ ...legacy, vat_number: vatNumber }], own => {
    const current = legacyStatusRecord(own);
    return current !== undefined && current.status === legacy.status && current.effective_from === legacy.effective_from && current.set_at === legacy.set_at;
  });
}

export interface CompanyVatStatusDeps {
  emta?: EmtaKmkrDeps;
  now?: () => Date;
  /**
   * Read `/vat_info` past its 10-minute cache: for a decision that is saved
   * against the current number (set_status, the monthly limited-VAT journal).
   */
  freshVatInfo?: boolean;
}

function storedLookup(records: readonly LimitedVatStoreRecord[] | null, vatNumber: string): CompanyVatLookupRecord | undefined {
  const record = records?.find((entry): entry is CompanyVatLookupRecord => entry.kind === "emta_lookup" && entry.key === lookupRecordKey(vatNumber));
  if (!record || record.vat_number !== vatNumber || typeof record.looked_up_at !== "string" || Number.isNaN(Date.parse(record.looked_up_at))) return undefined;
  const evidence = record.evidence as Partial<CompanyVatLookupRecord["evidence"]> | undefined;
  if (evidence?.kind === "contradiction") {
    return Object.hasOwn(CONTRADICTION_CODES, evidence.reason ?? "") && typeof evidence.detail === "string" ? record : undefined;
  }
  const registration = evidence?.kind === "success" ? evidence.registration as Partial<EmtaKmkrRegistration> | undefined : undefined;
  if (!registration || registration.vat_number !== vatNumber || typeof registration.limited !== "boolean" || typeof registration.registered_on !== "string") return undefined;
  return record;
}

/** The record of an EMTA outcome, or undefined when EMTA was unavailable (never stored). */
function evidenceRecord(vatNumber: string, outcome: EmtaKmkrOutcome, at: number): CompanyVatLookupRecord | undefined {
  const base = { kind: "emta_lookup" as const, key: lookupRecordKey(vatNumber), vat_number: vatNumber, looked_up_at: new Date(at).toISOString() };
  if (outcome.ok) return { ...base, evidence: { kind: "success", registration: outcome.registration } };
  const reason = (Object.keys(CONTRADICTION_CODES) as EmtaContradictionReason[]).find(key => CONTRADICTION_CODES[key] === outcome.code);
  return reason ? { ...base, evidence: { kind: "contradiction", reason, detail: outcome.detail } } : undefined;
}

/**
 * The lookup the status derives from: the newer of the stored record and
 * this call's own evidence (the store wins a tie). A contradiction is a
 * failure; an expired success is `stale` (with `unavailable` as the reason
 * the re-check failed); no evidence at all is the unavailable outcome.
 */
function winningLookup(
  records: readonly LimitedVatStoreRecord[] | null,
  vatNumber: string,
  now: number,
  own?: CompanyVatLookupRecord,
  unavailable?: Extract<CompanyVatLookupInput, { ok: false }>,
): CompanyVatLookupInput {
  const stored = storedLookup(records, vatNumber);
  const winner = own && (!stored || Date.parse(stored.looked_up_at) < Date.parse(own.looked_up_at)) ? own : stored;
  if (!winner) return unavailable ?? { ok: false, code: "emta_lookup_unavailable", detail: "not looked up" };
  if (winner.evidence.kind === "contradiction") return { ok: false, code: CONTRADICTION_CODES[winner.evidence.reason], detail: winner.evidence.detail };
  const stale = now - Date.parse(winner.looked_up_at) >= EMTA_LOOKUP_MAX_AGE_MS;
  return {
    ok: true,
    view: { registration: winner.evidence.registration, looked_up_at: winner.looked_up_at, stale, ...(stale && unavailable ? { refresh_error: unavailable.detail } : {}) },
  };
}

/**
 * Reads the store and derives the status. An applicable owner decision saved
 * before numbers were bound is first bound to the current number under the
 * store lock; when that cannot be established durably the status is
 * `unknown`, so the decision cannot silently follow a later number.
 */
function readAndDerive(
  vatInfo: CompanyVatInfo | undefined,
  lookup?: (records: readonly LimitedVatStoreRecord[] | null) => CompanyVatLookupInput,
): { resolved: ResolvedCompanyVatStatus; records: LimitedVatStoreRecord[] | null } {
  let records: LimitedVatStoreRecord[] | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      records = readLimitedVatRecords();
    } catch (error) {
      return { resolved: deriveCompanyVatStatus(vatInfo, null, (error as Error).message), records: null };
    }
    const resolved = deriveCompanyVatStatus(vatInfo, records, undefined, lookup?.(records));
    const legacy = records !== null && resolved.source === "setting" ? legacyStatusRecord(records) : undefined;
    if (!legacy) return { resolved, records };
    try {
      if (bindLegacyStatusRecord(legacy, resolved.vat_number)) return { resolved, records };
    } catch (error) {
      return {
        resolved: deriveCompanyVatStatus(vatInfo, records, `the stored status setting could not be bound to ${numberText(resolved.vat_number)}: ${(error as Error).message}`),
        records,
      };
    }
    // Another writer changed the record first: derive again from what it wrote.
  }
  return { resolved: deriveCompanyVatStatus(vatInfo, records, "the stored status setting kept changing while it was bound to the current VAT number"), records };
}

/**
 * The single VAT-status decision used by every VAT-treatment site, read
 * fresh from the store each time. An unreadable store gives `unknown`
 * (never a derived `full`).
 */
export async function resolveCompanyVatStatus(
  api: { readonly: { getVatInfo(options?: { fresh?: boolean }): Promise<CompanyVatInfo> } },
  deps: CompanyVatStatusDeps = {},
): Promise<ResolvedCompanyVatStatus> {
  const vatInfo = deps.freshVatInfo ? await api.readonly.getVatInfo({ fresh: true }) : await api.readonly.getVatInfo();
  return companyVatStatusFromInfo(vatInfo, deps);
}

/**
 * The same decision for a caller that already read `/vat_info`. EMTA is
 * asked unless the newest stored record is a success younger than 7 days;
 * its evidence is written only over older evidence, under the store lock;
 * then the store is read again and the status derives from the newest
 * evidence and the owner decision as they are now.
 */
export async function companyVatStatusFromInfo(
  vatInfo: CompanyVatInfo | undefined,
  deps: CompanyVatStatusDeps = {},
): Promise<ResolvedCompanyVatStatus> {
  const now = () => (deps.now ?? (() => new Date()))().getTime();
  const first = readAndDerive(vatInfo);
  const withoutLookup = first.resolved;
  if (withoutLookup.status !== "unknown" || withoutLookup.source === "store_error" || !withoutLookup.vat_number) return withoutLookup;
  const vatNumber = normalizeEstonianVatNumber(withoutLookup.vat_number);
  if (!vatNumber) {
    return deriveCompanyVatStatus(vatInfo, first.records, undefined,
      { ok: false, code: "emta_registration_not_found", detail: `${withoutLookup.vat_number} is not an Estonian VAT number (EE + 9 digits)` });
  }
  const startedAt = now();
  const stored = storedLookup(first.records, vatNumber);
  if (stored?.evidence.kind === "success" && startedAt - Date.parse(stored.looked_up_at) < EMTA_LOOKUP_MAX_AGE_MS) {
    return deriveCompanyVatStatus(vatInfo, first.records, undefined, winningLookup(first.records, vatNumber, startedAt));
  }
  const { outcome, at } = await lookupEmtaKmkrCached(vatNumber, startedAt, deps.emta, stored ? Date.parse(stored.looked_up_at) : undefined);
  const own = evidenceRecord(vatNumber, outcome, at);
  if (own && first.records !== null) {
    try {
      limitedVatStore.upsertIf([own], current => {
        const newest = storedLookup(current, vatNumber);
        return !newest || Date.parse(newest.looked_up_at) < at;
      });
    } catch (error) {
      // An unstored contradiction would leave an older answer the newest record: say so.
      if (own.evidence.kind === "contradiction") {
        return deriveCompanyVatStatus(vatInfo, first.records, `EMTA's answer for ${vatNumber} could not be stored: ${(error as Error).message}`);
      }
      // An unstored success: this call still derives from it when it is the newest evidence.
    }
  }
  return readAndDerive(vatInfo, records => winningLookup(records, vatNumber, now(), own, own || outcome.ok ? undefined : outcome)).resolved;
}

/** The resolved status for a VAT decision; throws `CompanyVatStatusUnknownError` for `unknown`. */
export function requireKnownCompanyVatStatus(resolved: ResolvedCompanyVatStatus): CompanyVatStatus {
  if (resolved.status === "unknown") throw new CompanyVatStatusUnknownError(resolved);
  return resolved.status;
}

/**
 * True only for a fully VAT-registered company (`full`); `limited` and `none`
 * are not. Throws `CompanyVatStatusUnknownError` when the status is `unknown`
 * (unreadable store, or a VAT number whose registration type EMTA did not
 * settle and the owner has not confirmed), so no VAT treatment is decided on
 * a guess.
 */
export async function isCompanyVatRegistered(
  api: { readonly: { getVatInfo(options?: { fresh?: boolean }): Promise<CompanyVatInfo> } },
  deps: CompanyVatStatusDeps = {},
): Promise<boolean> {
  return requireKnownCompanyVatStatus(await resolveCompanyVatStatus(api, deps)) === "full";
}
