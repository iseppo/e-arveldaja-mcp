import type { Transaction } from "./types/api.js";

export function isProjectTransaction(transaction: Pick<Transaction, "status" | "is_deleted">): boolean {
  return transaction.status === "PROJECT" && !transaction.is_deleted;
}

export function isNonVoidTransaction(transaction: Pick<Transaction, "status" | "is_deleted">): boolean {
  return transaction.status !== "VOID" && !transaction.is_deleted;
}
