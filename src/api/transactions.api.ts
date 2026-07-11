import type { HttpClient } from "../http-client.js";
import { HttpError } from "../http-client.js";
import type { Transaction, TransactionDistribution, PurchaseInvoice, SaleInvoice, ApiResponse } from "../types/api.js";
import { BaseResource } from "./base-resource.js";

export class TransactionsApi extends BaseResource<Transaction> {
  constructor(client: HttpClient) {
    super(client, "/transactions");
  }

  /**
   * Confirm a transaction with distribution rows.
   * If the transaction has no clients_id (common for card payments), automatically
   * sets it from the linked invoice before confirming. Without this, the API
   * rejects confirmation with "buyer or supplier is missing".
   * If confirmation fails after setting clients_id, the change is rolled back.
   */
  async confirm(id: number, distributions?: TransactionDistribution[]): Promise<ApiResponse> {
    const body = distributions ?? [];

    // Auto-fix missing clients_id from linked invoice
    let clientsIdWasSet = false;
    if (body.length > 0) {
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
      // A network error on the register PATCH is ambiguous: the registration
      // creates a journal server-side, so a lost response may mean it actually
      // committed. Re-read the transaction (busting the stale cache — the
      // failed PATCH never reached its own invalidateCache) and check its
      // status before deciding. If it is CONFIRMED the registration landed, so
      // we must NOT roll back clients_id (that would corrupt the committed
      // journal's buyer/supplier) and must report success instead of a false
      // failure that invites a duplicating retry.
      if (error instanceof HttpError && error.status === "network") {
        this.invalidateCache();
        let confirmed = false;
        let reReadOk = false;
        try {
          confirmed = (await this.get(id)).status === "CONFIRMED";
          reReadOk = true;
        } catch {
          // Re-read failed — commit state is indeterminate (handled below).
        }
        if (confirmed) {
          this.invalidateCache("/journals");
          // The tx re-read does not carry the new journal id; callers already
          // tolerate an absent created_object_id (recording the sentinel id).
          return { code: 200, messages: ["Registration recovered after network error"] };
        }
        if (!reReadOk) {
          // Indeterminate: the register PATCH may have committed a journal
          // server-side, but we could not confirm. Rolling back clients_id now
          // would corrupt that committed journal's buyer/supplier, so we leave
          // clients_id AS SET and surface the ambiguity. Never roll back or
          // blindly retry on an unknown commit state.
          throw new Error(
            `Transaction ${id} registration hit a network error and the status re-read also failed; ` +
            `commit state is indeterminate. clients_id left as set (a rollback could corrupt a committed ` +
            `journal). Verify the transaction in e-arveldaja before any retry.`
          );
        }
        // reReadOk && !confirmed → the register did NOT commit → safe to roll back.
      }
      if (clientsIdWasSet) {
        try {
          await this.update(id, { clients_id: null } as Partial<Transaction>);
        } catch (rollbackErr) {
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
