import type { Journal } from "./types/api.js";

export interface AccountPostingRow {
  journal_id: number;
  journal_title: string;          // plain; callers wrap via wrapUntrustedOcr at MCP output
  document_number: string | null;
  operation_type: string | null;
  date: string;                   // journal.effective_date
  type: "D" | "C";
  amount: number;                 // base_amount ?? amount
  accounts_dimensions_id: number | null;
  clients_id: number | null;
}

export function listAccountDimensionPostings(
  journals: Journal[],
  accountId: number,
  opts?: { dateFrom?: string; dateTo?: string },
): AccountPostingRow[] {
  const rows: AccountPostingRow[] = [];
  for (const journal of journals) {
    if (journal.is_deleted || !journal.registered) continue;
    if (opts?.dateFrom && journal.effective_date < opts.dateFrom) continue;
    if (opts?.dateTo && journal.effective_date > opts.dateTo) continue;
    if (!journal.postings) continue;
    for (const p of journal.postings) {
      if (p.accounts_id !== accountId || p.is_deleted) continue;
      if (p.type !== "D" && p.type !== "C") continue;
      rows.push({
        journal_id: journal.id!,
        journal_title: journal.title ?? "",
        document_number: journal.document_number ?? null,
        operation_type: journal.operation_type ?? null,
        date: journal.effective_date,
        type: p.type,
        amount: p.base_amount ?? p.amount,
        accounts_dimensions_id: p.accounts_dimensions_id ?? null,
        clients_id: journal.clients_id ?? null,
      });
    }
  }
  return rows;
}
