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
  status: CompanyVatStatus;
  /** `setting` = owner-approved record; `derived` = from `/vat_info`. */
  source: "setting" | "derived";
  vat_number: string | null;
  effective_from: string | null;
  /** False in single-file rules mode: no setting can be stored (so `limited` is unavailable). */
  store_available: boolean;
  /** The store exists but could not be read; the status was derived. */
  store_error?: string;
}

/** The stored records of this connection; null = store unavailable (single-file mode). */
export function readLimitedVatRecords(): LimitedVatStoreRecord[] | null {
  return limitedVatStore.read();
}

export function deriveCompanyVatStatus(
  vatInfo: CompanyVatInfo | undefined,
  records: readonly LimitedVatStoreRecord[] | null,
  storeError?: string,
): ResolvedCompanyVatStatus {
  const vatNumber = vatInfo?.vat_number?.trim() || null;
  const setting = records?.find((record): record is CompanyVatStatusRecord => record.kind === "status");
  const base = { vat_number: vatNumber, store_available: records !== null, ...(storeError ? { store_error: storeError } : {}) };
  if (setting && (COMPANY_VAT_STATUSES as readonly string[]).includes(setting.status)) {
    return { ...base, status: setting.status, source: "setting", effective_from: setting.effective_from };
  }
  return { ...base, status: vatNumber ? "full" : "none", source: "derived", effective_from: null };
}

/**
 * The single VAT-status decision used by every VAT-treatment site. An
 * unreadable store falls back to the derived status (today's behaviour) and
 * says so in `store_error`.
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
    return deriveCompanyVatStatus(vatInfo, [], (error as Error).message);
  }
  return deriveCompanyVatStatus(vatInfo, records);
}

/** True only for a fully VAT-registered company (`full`); `limited` and `none` are not. */
export async function isCompanyVatRegistered(
  api: { readonly: { getVatInfo(): Promise<CompanyVatInfo> } },
): Promise<boolean> {
  return (await resolveCompanyVatStatus(api)).status === "full";
}
