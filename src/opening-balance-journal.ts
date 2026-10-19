import type { ApiContext } from "./tools/crud-tools.js";
import type { Journal } from "./types/api.js";

export interface OpeningBalanceJournal {
  source: "api";
  journal: Journal;
  openingDate: string;
}

export function isOpeningBalanceJournal(journal: Journal): boolean {
  return journal.operation_type === "INITIAL";
}

export function openingFromApi(journals: Journal[]): OpeningBalanceJournal | null {
  const initial = journals.filter(isOpeningBalanceJournal);
  const active = initial.filter(j => !j.is_deleted);
  if (active.length > 1) throw new Error("Multiple active INITIAL journals: opening balances require manual review.");
  const journal = active[0] ?? initial[0];
  for (const posting of journal?.postings ?? []) {
    if (posting.is_deleted) continue;
    if ((posting.type !== "D" && posting.type !== "C") || !Number.isFinite(posting.amount) || posting.amount < 0 ||
      (posting.base_amount != null && (!Number.isFinite(posting.base_amount) || posting.base_amount < 0))) {
      throw new Error("Malformed INITIAL posting: expected D/C and finite nonnegative amounts; opening balances require manual review.");
    }
  }
  return journal ? { source: "api", journal, openingDate: journal.effective_date } : null;
}

/** Preserve the complete API journal set; INITIAL is identified, never prepended. */
export async function loadJournalsWithOpeningBalance(
  api: ApiContext,
): Promise<{ journals: Journal[]; journalsFromApi: Journal[]; opening: OpeningBalanceJournal | null }> {
  const journals = await api.journals.listAllWithPostings();
  return { journals, journalsFromApi: journals, opening: openingFromApi(journals) };
}
