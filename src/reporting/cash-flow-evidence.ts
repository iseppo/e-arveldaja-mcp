import type { ApiContext } from "../tools/crud-tools.js";
import type { Journal, Transaction } from "../types/api.js";

export interface CashFlowEvidence {
  transactions: Map<number, Transaction>;
  failures: Map<number, string>;
  requested: number;
  limit: number;
}

/** Only exact registration IDs are read; no invoice/date/client guessing. */
export async function loadCashFlowEvidence(
  api: ApiContext,
  journals: Journal[],
  cashAccounts: Set<number>,
  dateFrom: string,
  dateTo: string,
  limit = 500,
): Promise<CashFlowEvidence> {
  const evidence: CashFlowEvidence = { transactions: new Map(), failures: new Map(), requested: 0, limit };
  const ids = [...new Set(journals.filter(j => j.registered && !j.is_deleted && j.operation_type === "TRANSACTION" &&
    j.effective_date >= dateFrom && j.effective_date <= dateTo && j.postings?.some(p => !p.is_deleted && cashAccounts.has(p.accounts_id)) &&
    (j.postings.some(p => !p.is_deleted && ((p.accounts_id >= 1200 && p.accounts_id < 1300) || (p.accounts_id >= 2300 && p.accounts_id < 2400))) ||
      (j.postings.filter(p=>!p.is_deleted&&cashAccounts.has(p.accounts_id)).length>1&&j.postings.some(p=>!p.is_deleted&&!cashAccounts.has(p.accounts_id)))))
    .map(j => Number(j.operations_id)).filter(id => Number.isInteger(id) && id > 0))];
  for (const id of ids.slice(limit)) evidence.failures.set(id, "detail_read_budget_exhausted");
  for (let start = 0; start < Math.min(ids.length, limit); start += 5) {
    await Promise.all(ids.slice(start, Math.min(start + 5, limit)).map(async id => {
      evidence.requested++;
      try {
        const detail = await api.transactions.get(id);
        if (detail.id !== id || detail.status !== "CONFIRMED" || detail.is_deleted) evidence.failures.set(id, "transaction_detail_identity_or_status");
        else evidence.transactions.set(id, detail);
      } catch { evidence.failures.set(id, "transaction_detail_unavailable"); }
    }));
  }
  return evidence;
}
