import type { Transaction } from "./types/api.js";

export function isProjectTransaction(transaction: Pick<Transaction, "status" | "is_deleted">): boolean {
  return transaction.status === "PROJECT" && !transaction.is_deleted;
}
