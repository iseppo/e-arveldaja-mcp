import { createConnectionScopedBundleStore } from "./connection-scoped-bundle-store.js";
import type { CompanyVatInfo } from "./types/api.js";

/**
 * The company's VAT status for every VAT-treatment decision.
 *
 * `/vat_info` only carries `vat_number`, so a limited taxpayer (piiratud
 * maksukohustuslane, KMS § 21) whose number is entered in e-arveldaja would
 * otherwise read as fully VAT-registered (deductible reverse charge, VAT on
 * sales). The owner sets `limited` explicitly (`limited_vat` mode
 * `set_status`); without a setting: a number is `full` (unchanged behaviour),
 * no number is `none`. Only `full` is VAT-registered.
 */
export type CompanyVatStatus = "none" | "limited" | "full";

export const COMPANY_VAT_STATUSES = ["none", "limited", "full"] as const;

/**
 * The resolved status: a stored or derived `CompanyVatStatus`, or `unknown`
 * when the status store exists but cannot be read (or holds an invalid
 * setting). `unknown` is never treated as `full` or `none`: VAT decisions
 * refuse (`company_vat_status_unknown`).
 */
export type ResolvedVatStatus = CompanyVatStatus | "unknown";

export const COMPANY_VAT_STATUS_UNKNOWN = "company_vat_status_unknown";

/** Thrown at a VAT decision when the status is `unknown`. */
export class CompanyVatStatusUnknownError extends Error {
  readonly code = COMPANY_VAT_STATUS_UNKNOWN;
  constructor(detail: string | undefined) {
    super(`${COMPANY_VAT_STATUS_UNKNOWN}: the company VAT status cannot be read from limited-vat.json (${detail ?? "invalid setting"}), so VAT treatment cannot be decided. Nothing was written. Repair or restore the file in the accounting-rules bundle, then retry.`);
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

export type LimitedVatStoreRecord = CompanyVatStatusRecord | LimitedVatSupplierRecord | LimitedVatBookingRecord;

export const LIMITED_VAT_STORE_FILE = "limited-vat.json";

export const limitedVatStore = createConnectionScopedBundleStore<LimitedVatStoreRecord>({
  fileName: LIMITED_VAT_STORE_FILE,
  label: "Limited-VAT settings (limited-vat.json)",
  maxEntries: 5000,
  keyOf: record => record.key,
});

export const supplierRecordKey = (clientsId: number) => `supplier:${clientsId}`;
export const bookingRecordKey = (documentNumber: string) => `booking:${documentNumber}`;

export interface ResolvedCompanyVatStatus {
  status: ResolvedVatStatus;
  /** `setting` = owner-approved record; `derived` = from `/vat_info`; `store_error` = status unknown. */
  source: "setting" | "derived" | "store_error";
  vat_number: string | null;
  effective_from: string | null;
  /** False in single-file rules mode: no setting can be stored (so `limited` is unavailable). */
  store_available: boolean;
  /** The store exists but could not be read (status `unknown`). */
  store_error?: string;
}

/**
 * The stored records of this connection, re-read from disk (another process
 * may have written since); null = store unavailable (single-file mode).
 */
export function readLimitedVatRecords(): LimitedVatStoreRecord[] | null {
  limitedVatStore.reset();
  return limitedVatStore.read();
}

export function deriveCompanyVatStatus(
  vatInfo: CompanyVatInfo | undefined,
  records: readonly LimitedVatStoreRecord[] | null,
  storeError?: string,
): ResolvedCompanyVatStatus {
  const vatNumber = vatInfo?.vat_number?.trim() || null;
  const base = { vat_number: vatNumber, store_available: records !== null };
  if (storeError !== undefined) {
    return { ...base, status: "unknown", source: "store_error", effective_from: null, store_error: storeError };
  }
  const setting = records?.find((record): record is CompanyVatStatusRecord => record.kind === "status");
  if (setting) {
    if (!(COMPANY_VAT_STATUSES as readonly string[]).includes(setting.status) || typeof setting.effective_from !== "string") {
      return { ...base, status: "unknown", source: "store_error", effective_from: null, store_error: "the stored status setting is invalid" };
    }
    return { ...base, status: setting.status, source: "setting", effective_from: setting.effective_from };
  }
  return { ...base, status: vatNumber ? "full" : "none", source: "derived", effective_from: null };
}

/**
 * The single VAT-status decision used by every VAT-treatment site, read
 * fresh from the store each time. An unreadable store gives `unknown`
 * (never a derived `full`).
 */
export async function resolveCompanyVatStatus(
  api: { readonly: { getVatInfo(): Promise<CompanyVatInfo> } },
): Promise<ResolvedCompanyVatStatus> {
  return companyVatStatusFromInfo(await api.readonly.getVatInfo());
}

/** The same decision for a caller that already read `/vat_info`. */
export function companyVatStatusFromInfo(vatInfo: CompanyVatInfo | undefined): ResolvedCompanyVatStatus {
  let records: LimitedVatStoreRecord[] | null;
  try {
    records = readLimitedVatRecords();
  } catch (error) {
    return deriveCompanyVatStatus(vatInfo, null, (error as Error).message);
  }
  return deriveCompanyVatStatus(vatInfo, records);
}

/** The resolved status for a VAT decision; throws `CompanyVatStatusUnknownError` for `unknown`. */
export function requireKnownCompanyVatStatus(resolved: ResolvedCompanyVatStatus): CompanyVatStatus {
  if (resolved.status === "unknown") throw new CompanyVatStatusUnknownError(resolved.store_error);
  return resolved.status;
}

/**
 * True only for a fully VAT-registered company (`full`); `limited` and `none`
 * are not. Throws `CompanyVatStatusUnknownError` when the status is `unknown`,
 * so no VAT treatment is decided on a guess.
 */
export async function isCompanyVatRegistered(
  api: { readonly: { getVatInfo(): Promise<CompanyVatInfo> } },
): Promise<boolean> {
  return requireKnownCompanyVatStatus(await resolveCompanyVatStatus(api)) === "full";
}
