import type { ApiResponse, Transaction } from "./types/api.js";

export interface BankTransactionCreateApi {
  transactions: {
    create(payload: Partial<Transaction>): Promise<ApiResponse>;
  };
}

/**
 * The e-arveldaja bank-transaction create endpoint requires the API transport
 * discriminator `C` for every newly created row. Bank-statement direction is
 * separate provenance and must not be encoded in this transport field.
 */
export function createBankTransaction(
  api: BankTransactionCreateApi,
  input: Partial<Transaction>,
): Promise<ApiResponse> {
  const { type: _callerSuppliedType, ...payload } = input;
  return api.transactions.create({
    ...payload,
    type: "C",
  });
}
