import type { OperationOutcome } from "../operation-outcome.js";

// Typed sale-invoice operations (Task 14, PR 8C). One typed op absorbs all 11
// granular sale-invoice tools behind read/prepare/execute modes over
// api.saleInvoices.*. EVERY mutation (create/update), destructive action
// (delete/confirm/invalidate) AND send goes through the plan-handle two-call
// gate: prepare mints an execution-plan handle projecting the action; execute
// consumes it (consume-once) BEFORE the API call. `send` dispatches a real
// e-invoice, so it is never a one-shot. Read echoes go through renderExternalEntity
// at the façade (trusted CRUD), and write payloads are desandboxed at the boundary.

export const SALE_INVOICE_PLAN_DOMAIN = "sale_invoice";

export type SaleInvoiceReadAction = "list" | "get" | "document" | "xml" | "delivery_options";
export type SaleInvoiceMutationAction = "create" | "update" | "delete" | "confirm" | "invalidate" | "send";

export interface SaleInvoiceReadInput {
  readonly mode: "read";
  readonly action?: SaleInvoiceReadAction;
  readonly id?: number;
  readonly view?: "brief" | "full";
  readonly filters?: {
    readonly page?: number;
    readonly date_from?: string;
    readonly date_to?: string;
    readonly status?: string;
    readonly payment_status?: string;
    readonly clients_id?: number;
  };
}

export interface SaleInvoicePrepareInput {
  readonly mode: "prepare";
  readonly action: SaleInvoiceMutationAction;
  readonly id?: number;
  /** create/update payload; send request; forwarded verbatim to execute. */
  readonly payload?: Record<string, unknown>;
}

export interface SaleInvoiceExecuteInput {
  readonly mode: "execute";
  readonly action: SaleInvoiceMutationAction;
  readonly id?: number;
  readonly planHandle: string | undefined;
  readonly payload?: Record<string, unknown>;
}

export type SaleInvoiceOperationInput = SaleInvoiceReadInput | SaleInvoicePrepareInput | SaleInvoiceExecuteInput;

export interface SaleInvoiceReadResult {
  readonly mode: "read";
  readonly action: SaleInvoiceReadAction;
  readonly data: unknown;
}
export interface SaleInvoicePrepareResult {
  readonly mode: "prepare";
  readonly action: SaleInvoiceMutationAction;
  readonly id?: number;
  readonly planHandle: string;
  readonly projection: Record<string, unknown>;
}
export interface SaleInvoiceExecuteResult {
  readonly mode: "execute";
  readonly action: SaleInvoiceMutationAction;
  readonly id?: number;
  readonly result: unknown;
}
export type SaleInvoiceOperationResult = SaleInvoiceReadResult | SaleInvoicePrepareResult | SaleInvoiceExecuteResult;

export interface SaleInvoiceOperations {
  run(input: SaleInvoiceOperationInput): Promise<OperationOutcome<SaleInvoiceOperationResult>>;
}
