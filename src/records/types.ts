import type { OperationOutcome } from "../operation-outcome.js";

// Typed accounting-record operations (Task 14, PR 8C). The HARD security
// constraint: NO universal API executor. An EXPLICIT entity enum bounds WHICH
// endpoints are reachable, and a BOUNDED per-entity filter allowlist bounds
// WHICH filters may be sent. An agent can neither reach an un-enumerated
// endpoint nor inject an arbitrary path/query/method. Reads are over persisted,
// operator-reviewed API state (trusted-CRUD): the façade renders entities with
// renderExternalEntity (NOT wrapUntrustedOcr) exactly like list_/get_ handlers.

export const RECORD_ENTITIES = [
  "journals",
  "transactions",
  "clients",
  "purchase_invoices",
  "sale_invoices",
  "products",
] as const;
export type RecordEntity = (typeof RECORD_ENTITIES)[number];

/** The complete set of filter keys any entity may accept. Every entity binds a
 * fixed SUBSET of these; anything outside its subset is rejected. */
export interface RecordSearchFilters {
  readonly page?: number;
  readonly date_from?: string;
  readonly date_to?: string;
  readonly status?: string;
  readonly payment_status?: string;
  readonly clients_id?: number;
  /** clients-ONLY: fuzzy name search (same matcher as search_client). */
  readonly query?: string;
}

export interface SearchAccountingRecordsInput {
  readonly entity: RecordEntity;
  readonly filters?: RecordSearchFilters;
}

export interface RecordSearchResult {
  readonly entity: RecordEntity;
  readonly page: number;
  readonly total_pages: number;
  readonly total_items?: number;
  /** Raw, UNWRAPPED API rows — the façade renders/wraps at the output boundary. */
  readonly items: readonly unknown[];
}

export interface InspectAccountingRecordInput {
  readonly entity: RecordEntity;
  readonly id: number;
}

export interface AccountingRecord {
  readonly entity: RecordEntity;
  /** Raw, UNWRAPPED API record. */
  readonly record: unknown;
}

export interface RecordOperations {
  search(input: SearchAccountingRecordsInput): Promise<OperationOutcome<RecordSearchResult>>;
  inspect(input: InspectAccountingRecordInput): Promise<OperationOutcome<AccountingRecord>>;
}
