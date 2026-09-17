import type { HttpClient } from "../http-client.js";
import { HttpError, type HttpMethod } from "../http-client.js";
import type { Transaction, TransactionDistribution, PurchaseInvoice, SaleInvoice, ApiResponse } from "../types/api.js";
import type { CreateBankTransactionPayload, UpdateBankTransactionRequest } from "../types/mutations.js";
import { isMutationIndeterminate, MutationIndeterminateError } from "../mutation-outcome.js";
import { BaseResource } from "./base-resource.js";

function isHttpMethod(value: unknown): value is HttpMethod {
  return value === "GET" || value === "POST" || value === "PUT" ||
    value === "PATCH" || value === "DELETE";
}

export function getNormalizedNetworkCause(error: unknown): HttpError | undefined {
  try {
    if (!isMutationIndeterminate(error)) return undefined;
    if (typeof error.cause !== "object" || error.cause === null) return undefined;
    const cause = error.cause as unknown as Record<string, unknown>;
    if (
      cause.name !== "HttpError" ||
      cause.status !== "network" ||
      typeof cause.message !== "string" ||
      typeof cause.path !== "string" ||
      cause.path.trim() === "" ||
      !isHttpMethod(cause.method)
    ) {
      return undefined;
    }
    return new HttpError(cause.message, "network", cause.method, cause.path);
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
   * Resolve the single client shared by every invoice in a distribution.
   *
   * Returns `undefined` when there is no invoice row, when an invoice carries no
   * client (it cannot pin the journal's sub-ledger), or when the invoices
   * disagree — one journal has one client, so a split-client distribution has no
   * satisfiable expectation and must not be blocked.
   */
  private async resolveLinkedInvoiceClient(
    body: TransactionDistribution[],
  ): Promise<LinkedInvoiceClient | undefined> {
    const resolved: LinkedInvoiceClient[] = [];
    for (const dist of body) {
      if (!dist.related_id) continue;
      if (dist.related_table !== "purchase_invoices" && dist.related_table !== "sale_invoices") continue;
      const invoice = dist.related_table === "purchase_invoices"
        ? await this.client.get<PurchaseInvoice>(`/purchase_invoices/${dist.related_id}`)
        : await this.client.get<SaleInvoice>(`/sale_invoices/${dist.related_id}`);
      const clientsId = invoice?.clients_id;
      if (typeof clientsId !== "number") return undefined;
      resolved.push({ table: dist.related_table, id: dist.related_id, clientsId });
    }
    const first = resolved[0];
    if (!first) return undefined;
    if (resolved.some(r => r.clientsId !== first.clientsId)) return undefined;
    return first;
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
    if (body.length > 0 && (autoFixClientsId || hasInvoiceDistribution)) {
      const tx = await this.get(id);
      if (!tx.clients_id) {
        // Auto-fix missing clients_id from linked invoice
        if (autoFixClientsId) {
          let clientsId: number | undefined;

          for (const dist of body) {
            if (dist.related_table === "purchase_invoices" && dist.related_id) {
              const inv = await this.client.get<PurchaseInvoice>(`/purchase_invoices/${dist.related_id}`);
              clientsId = inv?.clients_id;
            } else if (dist.related_table === "sale_invoices" && dist.related_id) {
              const inv = await this.client.get<SaleInvoice>(`/sale_invoices/${dist.related_id}`);
              clientsId = inv?.clients_id;
            }
            if (clientsId !== undefined) break;
          }

          if (clientsId !== undefined) {
            await this.update(id, { clients_id: clientsId });
            clientsIdRollbackValue = null;
          }
        }
      } else if (hasInvoiceDistribution) {
        const invoice = await this.resolveLinkedInvoiceClient(body);
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
      this.invalidateCache();
      // Registering a transaction creates a journal server-side — bust the
      // journal aggregate cache too so list_journals / analyze_unconfirmed
      // don't serve stale data (missing the new registration journal).
      this.invalidateCache("/journals");
      return result;
    } catch (error) {
      this.invalidateCache();
      if (error instanceof HttpError && error.status === "network") {
        let freshTransaction: Transaction;
        try {
          freshTransaction = await this.get(id);
        } catch (readError) {
          this.invalidateCache("/journals");
          throw new MutationIndeterminateError({
            operation: "confirm",
            entity: "transaction",
            entityId: id,
            businessKey: "transaction:" + id,
            affectedCaches: ["/transactions", "/journals"],
            cause: readError,
            nextAction: "Freshly read transaction " + id +
              " before any retry; registration may or may not have committed.",
          });
        }

        if (freshTransaction.status === "CONFIRMED") {
          this.invalidateCache("/journals");
          // The tx re-read does not carry the new journal id; callers already
          // tolerate an absent created_object_id (recording the sentinel id).
          return { code: 200, messages: ["Registration recovered after network error"] };
        }

        if (freshTransaction.status !== "PROJECT") {
          this.invalidateCache();
          this.invalidateCache("/journals");
          throw new MutationIndeterminateError({
            operation: "confirm",
            entity: "transaction",
            entityId: id,
            businessKey: "transaction:" + id,
            affectedCaches: ["/transactions", "/journals"],
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
          const normalizedNetworkCause = getNormalizedNetworkCause(rollbackErr);
          if (normalizedNetworkCause) {
            this.invalidateTransactionsAfterAmbiguousCleanup();
            throw new MutationIndeterminateError({
              operation: "rollback",
              entity: "transaction",
              entityId: id,
              businessKey: "transaction:" + id,
              affectedCaches: ["/transactions"],
              cause: normalizedNetworkCause,
              nextAction: "Freshly read transaction " + id +
                "; clients_id cleanup may or may not have committed.",
            });
          }
          if (rollbackErr instanceof HttpError && rollbackErr.status === "network") {
            this.invalidateTransactionsAfterAmbiguousCleanup();
            throw new MutationIndeterminateError({
              operation: "rollback",
              entity: "transaction",
              entityId: id,
              businessKey: "transaction:" + id,
              affectedCaches: ["/transactions"],
              cause: rollbackErr,
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

  async invalidate(id: number): Promise<ApiResponse> {
    const result = await this.client.patch<ApiResponse>(`/transactions/${id}/invalidate`, {});
    this.invalidateCache();
    // Invalidating a confirmed transaction reverses its journal — same
    // cross-namespace flush as confirm().
    this.invalidateCache("/journals");
    return result;
  }

}
