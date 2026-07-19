import type { HttpClient } from "../http-client.js";
import { HttpError, type HttpMethod } from "../http-client.js";
import type { Transaction, TransactionDistribution, PurchaseInvoice, SaleInvoice, ApiResponse } from "../types/api.js";
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

export class TransactionsApi extends BaseResource<Transaction> {
  constructor(client: HttpClient) {
    super(client, "/transactions");
  }

  public invalidateTransactionsAfterAmbiguousCleanup(): void {
    this.invalidateCache();
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
   */
  async confirm(
    id: number,
    distributions?: TransactionDistribution[],
    options?: { autoFixClientsId?: boolean },
  ): Promise<ApiResponse> {
    const body = distributions ?? [];
    const autoFixClientsId = options?.autoFixClientsId !== false;

    // Auto-fix missing clients_id from linked invoice
    let clientsIdWasSet = false;
    if (autoFixClientsId && body.length > 0) {
      const tx = await this.get(id);
      if (!tx.clients_id) {
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
          clientsIdWasSet = true;
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

      if (clientsIdWasSet) {
        try {
          await this.update(id, { clients_id: null } as Partial<Transaction>);
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
