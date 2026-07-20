import type { ApiResponse, Transaction } from "./types/api.js";
import { bankTransactionDirection, type BankTransactionDirection } from "./bank-transaction-direction.js";

export interface BankTransactionCreateApi {
  transactions: {
    create(payload: Partial<Transaction>): Promise<ApiResponse>;
  };
}

/**
 * Single boundary for creating bank transactions.
 *
 * The e-arveldaja backend derives the cash-account (e.g. 1020) debit/credit leg
 * from the stored API `type` at confirmation time: `type="D"` books the cash on
 * the DEBIT side ("Laekumine" / money in), `type="C"` on the CREDIT side
 * ("Tasumine" / money out). On the write path `type` is therefore NOT a cosmetic
 * transport discriminator — it must reflect the true statement direction, or
 * every incoming row is booked backwards (cash on the wrong side, counter-account
 * reversed). Forcing `type="C"` unconditionally caused exactly that regression in
 * 0.22.0; this boundary restores the historical directional mapping.
 *
 * Direction comes from the explicit `direction` argument when the caller knows it
 * (CAMT/Wise importers pass their parsed statement direction), otherwise it is
 * derived from the payload's signed source metadata / legacy `type` via
 * `bankTransactionDirection`. Unknown falls back to `"C"` — the historical
 * default for manually-created rows with no direction signal.
 */
export function createBankTransaction(
  api: BankTransactionCreateApi,
  input: Partial<Transaction>,
  direction?: BankTransactionDirection,
): Promise<ApiResponse> {
  const resolved = direction ?? bankTransactionDirection(input);
  const type = resolved === "incoming" ? "D" : "C";
  const { type: _callerSuppliedType, ...payload } = input;
  return api.transactions.create({
    ...payload,
    type,
  });
}
