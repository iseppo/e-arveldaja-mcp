import type { Client, Transaction } from "../types/api.js";
import type { StatementBalanceCheck } from "../statement-balance-check.js";

// --- Parsed statement data ---------------------------------------------------

export interface ImportRejectedField {
  source_row_id: string;
  field: string;
  value: string;
  reason: string;
}

export interface CamtBalance {
  amount: number;
  currency: string;
  direction?: string;
  date?: string;
}

export interface CamtStatementMetadata {
  statement_id?: string;
  iban: string;
  currency?: string;
  bank_bic?: string;
  bank_name?: string;
  period: {
    from?: string;
    to?: string;
  };
  opening_balance?: CamtBalance;
  closing_balance?: CamtBalance;
}

export interface ParsedCamtEntry {
  date: string;
  amount: number;
  currency: string;
  direction: "CRDT" | "DBIT";
  original_amount?: number;
  original_currency?: string;
  counterparty_name?: string;
  counterparty_iban?: string;
  counterparty_reg_code?: string;
  description?: string;
  reference_number?: string;
  end_to_end_id?: string;
  bank_reference?: string;
  duplicate: boolean;
  duplicate_transaction_ids: number[];
}

export interface CamtParseResult {
  statement_metadata: CamtStatementMetadata;
  entries: ParsedCamtEntry[];
  summary: {
    entry_count: number;
    credit_count: number;
    credit_total: number;
    debit_count: number;
    debit_total: number;
    duplicate_count: number;
  };
}

export type CamtPreflightResult =
  | { ok: true; source: "camt"; value: CamtParseResult }
  | { ok: false; source: "camt"; rejected_fields: ImportRejectedField[] };

// --- Duplicate identity / lookups --------------------------------------------

export interface DuplicateLookup {
  byBankRef: Map<string, number[]>;
  byEntryKey: Map<string, number[]>;
}

export interface PossibleDuplicateLookup {
  byCandidateKey: Map<string, Transaction[]>;
}

export type PossibleDuplicateAction =
  | "link_confirmed_transaction_then_delete_new_project_transaction"
  | "review_status_before_cleanup";

export interface CamtPossibleDuplicateMatch {
  id: number;
  status?: string;
  counterparty?: string | null;
  description?: string | null;
  ref_number?: string | null;
  match_reasons: string[];
  suggested_patch_missing_fields: Partial<Transaction>;
}

// --- Client resolution / create payload --------------------------------------

export interface ClientResolution {
  clients_id?: number;
  match_type?: "reg_code" | "exact_name" | "single_name_match";
  matched_client_name?: string;
}

export interface ClientResolutionCache {
  byCode: Map<string, ClientResolution>;
  byName: Map<string, ClientResolution>;
}

export type CreateTransactionPayload = Pick<Transaction,
  "accounts_dimensions_id" |
  "type" |
  "amount" |
  "cl_currencies_id" |
  "date"
> & Partial<Pick<Transaction,
  "description" |
  "bank_account_name" |
  "bank_account_no" |
  "clients_id" |
  "ref_number" |
  "bank_ref_number"
>>;

// --- Projection --------------------------------------------------------------

export interface CamtCreateDescriptor {
  entry: ParsedCamtEntry;
  payload: CreateTransactionPayload;
  storedDescription?: string;
  clientResolution: ClientResolution;
  possibleDuplicateMatches: CamtPossibleDuplicateMatch[];
  batchDuplicateKey: string;
}

export interface CamtSkippedRow {
  date: string;
  amount: number;
  bank_reference?: string;
  duplicate_transaction_ids: number[];
  reason: string;
}

export interface CamtImportProjection {
  parsed: CamtParseResult;
  statementMetadata: CamtStatementMetadata;
  descriptors: CamtCreateDescriptor[];
  skipped: CamtSkippedRow[];
  repeatedBankReferences: Set<string>;
  totalStatementEntries: number;
  eligibleEntries: number;
  filteredOut: number;
}

export interface StatementBalanceCheckResult {
  check?: StatementBalanceCheck;
  persisted: boolean;
  notes: string[];
}

// Re-export so downstream modules can name the API interfaces used here.
export type { Client, Transaction };
