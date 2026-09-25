import type { HttpClient } from "../http-client.js";
import { HttpError, type HttpMethod } from "../http-client.js";
import type { Transaction, TransactionDistribution, PurchaseInvoice, SaleInvoice, ApiResponse } from "../types/api.js";
import type { CreateBankTransactionPayload, UpdateBankTransactionRequest } from "../types/mutations.js";
import { classifyMutationFailure, isMutationIndeterminate, MutationIndeterminateError } from "../mutation-outcome.js";
import { BaseResource } from "./base-resource.js";
import { signedBankTransactionDirection, storedTypeContradictsSignedDirection } from "../bank-transaction-direction.js";

function isHttpMethod(value: unknown): value is HttpMethod {
  return value === "GET" || value === "POST" || value === "PUT" ||
    value === "PATCH" || value === "DELETE";
}

/**
 * Rebuild the HttpError behind a MutationIndeterminateError's serialized cause
 * when that cause is itself an indeterminate HTTP outcome (network drop,
 * timeout, 5xx, 408 — see classifyMutationFailure).
 */
export function getNormalizedNetworkCause(error: unknown): HttpError | undefined {
  try {
    if (!isMutationIndeterminate(error)) return undefined;
    if (typeof error.cause !== "object" || error.cause === null) return undefined;
    const cause = error.cause as unknown as Record<string, unknown>;
    const status = cause.status;
    if (
      cause.name !== "HttpError" ||
      !(status === "network" || (
        typeof status === "number" &&
        Number.isFinite(status) &&
        classifyMutationFailure(new HttpError("", status, "GET", "/")) === "indeterminate"
      )) ||
      typeof cause.message !== "string" ||
      typeof cause.path !== "string" ||
      cause.path.trim() === "" ||
      !isHttpMethod(cause.method)
    ) {
      return undefined;
    }
    return new HttpError(cause.message, status as number | "network", cause.method, cause.path);
  } catch {
    return undefined;
  }
}

const LINKED_INVOICE_CLIENT_MISMATCH_NEXT_ACTION =
  "Re-run confirm_transaction with reassign_client_to_invoice: true to book the receipt under the invoice's " +
  "client, or fix the linked invoice; the journal client comes from the transaction's client and would land " +
  "the 1210/2310 entry in the wrong sub-ledger.";

/**
 * The payer on the bank transaction is not the client on the linked invoice.
 *
 * `journal.clients_id` is copied from `transaction.clients_id`, and postings
 * carry no client of their own, so registering this distribution would book the
 * receivable/payable leg into the payer's sub-ledger while the invoice stays
 * open in the invoice client's. Thrown before the register call — nothing is
 * mutated.
 */
export class LinkedInvoiceClientMismatchError extends Error {
  readonly category = "linked_invoice_client_mismatch";
  readonly transaction_id: number;
  readonly transaction_clients_id: number;
  readonly invoice_table: string;
  readonly invoice_id: number;
  readonly invoice_clients_id: number;
  readonly next_action = LINKED_INVOICE_CLIENT_MISMATCH_NEXT_ACTION;

  constructor(details: {
    transactionId: number;
    transactionClientsId: number;
    invoiceTable: string;
    invoiceId: number;
    invoiceClientsId: number;
  }) {
    super(
      `Transaction ${details.transactionId} is booked to client ${details.transactionClientsId}, but the linked ` +
      `${details.invoiceTable} ${details.invoiceId} belongs to client ${details.invoiceClientsId}. Confirming ` +
      `would post the receipt into the payer's client sub-ledger instead of the invoice client's.`,
    );
    this.name = "LinkedInvoiceClientMismatchError";
    this.transaction_id = details.transactionId;
    this.transaction_clients_id = details.transactionClientsId;
    this.invoice_table = details.invoiceTable;
    this.invoice_id = details.invoiceId;
    this.invoice_clients_id = details.invoiceClientsId;
  }
}

/**
 * The signed importer marker on the transaction (CAMT CRDT/DBIT, Wise IN/OUT)
 * proves a direction its stored `type` contradicts. The backend books the cash
 * leg from `type`, so registering would post the bank side backwards. Thrown
 * before any mutation, on every confirm path.
 */
export class StoredTypeDirectionMismatchError extends Error {
  readonly category = "stored_type_direction_mismatch";
  readonly transaction_id: number;
  readonly stored_type: string;
  readonly signed_direction: "incoming" | "outgoing";
  readonly next_action =
    "Do not confirm this row: its stored type would book the bank leg on the wrong side. Delete it and " +
    "re-import the statement line (the importers set type from the signed direction), or book it manually.";

  constructor(details: { transactionId: number; storedType: string; signedDirection: "incoming" | "outgoing" }) {
    super(
      `Transaction ${details.transactionId} is stored as type ${details.storedType}, but its signed statement ` +
      `marker says the money was ${details.signedDirection}. Confirming would book the bank leg backwards.`,
    );
    this.name = "StoredTypeDirectionMismatchError";
    this.transaction_id = details.transactionId;
    this.stored_type = details.storedType;
    this.signed_direction = details.signedDirection;
  }
}

/**
 * The linked invoices belong to different clients. One journal has one client
 * (copied from the transaction), so whichever client the transaction carries —
 * auto-filled or already set — the other invoices' receipts would land in the
 * wrong sub-ledger. Thrown before any mutation; the payment must be split into
 * one transaction per client.
 */
export class LinkedInvoiceClientsAmbiguousError extends Error {
  readonly category = "linked_invoice_clients_ambiguous";
  readonly transaction_id: number;
  readonly invoice_clients_ids: number[];
  readonly next_action =
    "Split the payment into one bank transaction per client (one journal carries one client), then confirm " +
    "each against its own client's invoices; setting clients_id cannot make a mixed-client distribution valid.";

  constructor(details: { transactionId: number; invoiceClientsIds: number[]; transactionClientsId?: number | null }) {
    super(
      `Transaction ${details.transactionId} ` +
      (typeof details.transactionClientsId === "number" ? `is booked to client ${details.transactionClientsId}` : "has no client") +
      ` and its linked invoices belong to different clients (${details.invoiceClientsIds.join(", ")}); ` +
      `one journal has one client, so refusing to confirm.`,
    );
    this.name = "LinkedInvoiceClientsAmbiguousError";
    this.transaction_id = details.transactionId;
    this.invoice_clients_ids = details.invoiceClientsIds;
  }
}

// Caches a transaction register/invalidate can change: the transaction itself,
// the journal it creates/reverses, and the linked invoices' payment status.
const CONFIRM_AFFECTED_CACHES = [
  "/transactions",
  "/journals",
  "/sale_invoices",
  "/purchase_invoices",
] as const;

interface LinkedInvoiceClient {
  table: string;
  id: number;
  clientsId: number;
}

export class TransactionsApi extends BaseResource<Transaction> {
  constructor(client: HttpClient) {
    super(client, "/transactions");
  }

  public invalidateTransactionsAfterAmbiguousCleanup(): void {
    this.invalidateCache();
  }

  // Narrow the create/update boundary from the inherited `Partial<Transaction>`
  // to operation-specific request types. `create` accepts the derived-`type`
  // payload (only `createBankTransaction` calls it, at the single write
  // boundary); `update` is metadata-scoped + `clients_id` (incl. null-clear).
  // Both delegate to the base mutate/cache logic unchanged.
  override async create(data: CreateBankTransactionPayload): Promise<ApiResponse> {
    return super.create(data);
  }

  override async update(id: number, data: UpdateBankTransactionRequest): Promise<ApiResponse> {
    return super.update(id, data);
  }

  /**
   * Resolve the client of every linked invoice in a distribution. Invoices that
   * carry no client of their own cannot pin the journal's sub-ledger and are
   * left out.
   */
  private async resolveLinkedInvoiceClients(
    body: TransactionDistribution[],
  ): Promise<LinkedInvoiceClient[]> {
    const resolved: LinkedInvoiceClient[] = [];
    for (const dist of body) {
      if (!dist.related_id) continue;
      if (dist.related_table !== "purchase_invoices" && dist.related_table !== "sale_invoices") continue;
      const invoice = dist.related_table === "purchase_invoices"
        ? await this.client.get<PurchaseInvoice>(`/purchase_invoices/${dist.related_id}`)
        : await this.client.get<SaleInvoice>(`/sale_invoices/${dist.related_id}`);
      const clientsId = invoice?.clients_id;
      if (typeof clientsId !== "number") continue;
      resolved.push({ table: dist.related_table, id: dist.related_id, clientsId });
    }
    return resolved;
  }

  /**
   * Confirm a transaction with distribution rows.
   * If the transaction has no clients_id (common for card payments), automatically
   * sets it from the linked invoice before confirming. Without this, the API
   * rejects confirmation with "buyer or supplier is missing".
   * If confirmation fails after setting clients_id, the change is rolled back.
   *
   * Pass `{ autoFixClientsId: false }` to disable the implicit linked-invoice
   * client fix. The plan-bound reconciliation executor uses this so the client
   * update is booked as its own reviewed, enumerated command instead of a hidden
   * side effect of confirmation.
   *
   * When the transaction ALREADY has a client and it differs from the linked
   * invoice's, this throws `LinkedInvoiceClientMismatchError` before registering
   * (see that class for why). Pass `{ reassignClientToInvoice: true }` — the
   * caller's explicit approval — to move the transaction to the invoice's client
   * first instead; that update is rolled back if the register call then fails.
   */
  async confirm(
    id: number,
    distributions?: TransactionDistribution[],
    options?: { autoFixClientsId?: boolean; reassignClientToInvoice?: boolean },
  ): Promise<ApiResponse> {
    const body = distributions ?? [];
    const autoFixClientsId = options?.autoFixClientsId !== false;
    const hasInvoiceDistribution = body.some(dist =>
      (dist.related_table === "purchase_invoices" || dist.related_table === "sale_invoices")
      && !!dist.related_id);

    // Value to restore if the register call fails after we touched clients_id
    // (`undefined` = we did not touch it, so there is nothing to roll back).
    let clientsIdRollbackValue: number | null | undefined;
    // Read on every path: the direction guard below applies to all confirms,
    // whatever the distribution.
    const tx = await this.get(id);
    if (tx && storedTypeContradictsSignedDirection(tx)) {
      throw new StoredTypeDirectionMismatchError({
        transactionId: id,
        storedType: String(tx.type),
        signedDirection: signedBankTransactionDirection(tx)!,
      });
    }
    if (tx && body.length > 0 && (autoFixClientsId || hasInvoiceDistribution)) {
      if (!tx.clients_id) {
        // Auto-fix missing clients_id from linked invoice
        if (autoFixClientsId) {
          // Only a real client id is ever written (never null), and only when
          // every linked invoice agrees on it.
          const invoiceClientsIds = new Set<number>();
          for (const dist of body) {
            let inv: PurchaseInvoice | SaleInvoice | undefined;
            if (dist.related_table === "purchase_invoices" && dist.related_id) {
              inv = await this.client.get<PurchaseInvoice>(`/purchase_invoices/${dist.related_id}`);
            } else if (dist.related_table === "sale_invoices" && dist.related_id) {
              inv = await this.client.get<SaleInvoice>(`/sale_invoices/${dist.related_id}`);
            }
            if (typeof inv?.clients_id === "number") invoiceClientsIds.add(inv.clients_id);
          }

          if (invoiceClientsIds.size > 1) {
            throw new LinkedInvoiceClientsAmbiguousError({
              transactionId: id,
              invoiceClientsIds: [...invoiceClientsIds],
            });
          }
          const [clientsId] = invoiceClientsIds;
          if (clientsId !== undefined) {
            await this.update(id, { clients_id: clientsId });
            clientsIdRollbackValue = null;
          }
        }
      } else if (hasInvoiceDistribution) {
        const invoices = await this.resolveLinkedInvoiceClients(body);
        const invoiceClientsIds = [...new Set(invoices.map(r => r.clientsId))];
        if (invoiceClientsIds.length > 1) {
          // Mixed clients: whatever client the journal carries, some invoice's
          // receipt lands in the wrong sub-ledger — reassignment cannot fix it.
          throw new LinkedInvoiceClientsAmbiguousError({
            transactionId: id,
            transactionClientsId: tx.clients_id,
            invoiceClientsIds,
          });
        }
        const invoice = invoices[0];
        if (invoice && invoice.clientsId !== tx.clients_id) {
          if (options?.reassignClientToInvoice === true) {
            await this.update(id, { clients_id: invoice.clientsId });
            clientsIdRollbackValue = tx.clients_id;
          } else {
            throw new LinkedInvoiceClientMismatchError({
              transactionId: id,
              transactionClientsId: tx.clients_id,
              invoiceTable: invoice.table,
              invoiceId: invoice.id,
              invoiceClientsId: invoice.clientsId,
            });
          }
        }
      }
    }

    try {
      const result = await this.client.patch<ApiResponse>(`/transactions/${id}/register`, body);
      // Registering a transaction creates a journal server-side and flips the
      // linked invoices' payment status — bust the journal and invoice caches
      // too so list_journals / analyze_unconfirmed / auto-confirm don't serve
      // stale data (missing the journal, or an invoice still shown unpaid).
      this.invalidateConfirmCaches();
      return result;
    } catch (error) {
      this.invalidateCache();
      if (classifyMutationFailure(error) === "indeterminate") {
        let freshTransaction: Transaction;
        try {
          freshTransaction = await this.get(id);
        } catch (readError) {
          this.invalidateConfirmCaches();
          throw new MutationIndeterminateError({
            operation: "confirm",
            entity: "transaction",
            entityId: id,
            businessKey: "transaction:" + id,
            affectedCaches: [...CONFIRM_AFFECTED_CACHES],
            cause: readError,
            nextAction: "Freshly read transaction " + id +
              " before any retry; registration may or may not have committed.",
          });
        }

        if (freshTransaction.status === "CONFIRMED") {
          this.invalidateConfirmCaches();
          // The tx re-read does not carry the new journal id; callers already
          // tolerate an absent created_object_id (recording the sentinel id).
          return { code: 200, messages: ["Registration recovered after network error"] };
        }

        if (freshTransaction.status !== "PROJECT") {
          this.invalidateConfirmCaches();
          throw new MutationIndeterminateError({
            operation: "confirm",
            entity: "transaction",
            entityId: id,
            businessKey: "transaction:" + id,
            affectedCaches: [...CONFIRM_AFFECTED_CACHES],
            cause: error,
            nextAction: "Freshly read transaction " + id +
              " before any retry; registration may or may not have committed.",
          });
        }
      }

      if (clientsIdRollbackValue !== undefined) {
        try {
          await this.update(id, { clients_id: clientsIdRollbackValue });
        } catch (rollbackErr) {
          // A well-formed indeterminate cleanup outcome (network, 5xx, 408 —
          // raw, or wrapped by update()) means the clients_id restore may or
          // may not have committed. Malformed ambiguity falls through to the
          // compound manual-review error below.
          const normalizedCleanupCause = getNormalizedNetworkCause(rollbackErr) ??
            (rollbackErr instanceof HttpError && classifyMutationFailure(rollbackErr) === "indeterminate"
              ? rollbackErr
              : undefined);
          if (normalizedCleanupCause) {
            this.invalidateTransactionsAfterAmbiguousCleanup();
            throw new MutationIndeterminateError({
              operation: "rollback",
              entity: "transaction",
              entityId: id,
              businessKey: "transaction:" + id,
              affectedCaches: ["/transactions"],
              cause: normalizedCleanupCause,
              nextAction: "Freshly read transaction " + id +
                "; clients_id cleanup may or may not have committed.",
            });
          }
          const rollbackMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          process.stderr.write(
            `WARNING: Failed to roll back clients_id on transaction ${id}: ${rollbackMsg}\n`
          );
          throw new Error(
            `Transaction ${id} confirmation failed: ${error instanceof Error ? error.message : String(error)}. ` +
            `Rollback of clients_id also failed: ${rollbackMsg}. ` +
            `Transaction may have incorrect clients_id — manual review required.`
          );
        }
      }
      throw error;
    }
  }

  private invalidateConfirmCaches(): void {
    for (const pattern of CONFIRM_AFFECTED_CACHES) this.invalidateCache(pattern);
  }

  async invalidate(id: number): Promise<ApiResponse> {
    // Invalidating a confirmed transaction reverses its journal and reopens the
    // linked invoices' payment status — same cross-namespace flush as confirm().
    return this.mutate(
      "invalidate",
      id,
      "transaction:" + id,
      CONFIRM_AFFECTED_CACHES,
      () => this.client.patch<ApiResponse>(`/transactions/${id}/invalidate`, {}),
      "Freshly read transaction " + id +
        " before any retry; invalidation may or may not have committed.",
    );
  }

}
