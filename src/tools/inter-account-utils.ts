import type { Journal } from "../types/api.js";

/**
 * Build a map from bidirectional "sourceDim|targetDim|amount|date" keys to journal IDs
 * by scanning confirmed journals that have exactly 2 bank account postings (one D, one C).
 * Keys are inserted in both directions so lookups succeed regardless of which side is checked.
 */
export function buildInterAccountJournalIndex(
  journals: Journal[],
  ownDimensionIds: Set<number>,
): Map<string, number> {
  const index = new Map<string, number>();
  for (const j of journals) {
    if (j.is_deleted || !j.registered || !j.postings) continue;
    const bankPostings = j.postings.filter(
      p => !p.is_deleted && p.accounts_dimensions_id && ownDimensionIds.has(p.accounts_dimensions_id),
    );
    if (bankPostings.length !== 2) continue;
    const [a, b] = bankPostings;
    if (!a || !b) continue;
    if (a.type === b.type) continue; // must be one D and one C
    const debit = a.type === "D" ? a : b;
    const credit = a.type === "C" ? a : b;
    const amount = Math.round(((debit.base_amount ?? debit.amount) as number) * 100) / 100;
    // Insert in both directions so we catch it regardless of which side we're checking from
    const key1 = `${credit.accounts_dimensions_id}|${debit.accounts_dimensions_id}|${amount}|${j.effective_date}`;
    const key2 = `${debit.accounts_dimensions_id}|${credit.accounts_dimensions_id}|${amount}|${j.effective_date}`;
    index.set(key1, j.id!);
    index.set(key2, j.id!);
  }
  return index;
}
