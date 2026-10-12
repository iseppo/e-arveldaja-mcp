import type { Journal, Transaction } from "./types/api.js";
import type { ApiContext } from "./tools/crud/shared.js";
import { signedBankTransactionDirection } from "./bank-transaction-direction.js";

type ProvenDirection = "incoming" | "outgoing" | undefined;

/**
 * Direction of a CONFIRMED bank row as booked by its registration journal(s)
 * (operation_type TRANSACTION, operations_id = the row's id, registered, not
 * deleted): the EUR net of the postings on the row's own bank GL account and
 * dimension — a debit means money in, a credit money out. `undefined` when the
 * row is not CONFIRMED, has no registration journal, the bank net is zero, or
 * any bank posting has no finite EUR base (not comparable). Legacy rows (LHV
 * import, old Wise/CAMT markers) carry no signed marker, but every CONFIRMED
 * one has exactly this journal, so its cash side is ledger-proven.
 */
export function journalBankDirection(
  tx: Pick<Transaction, "id" | "status" | "is_deleted" | "accounts_dimensions_id">,
  journals: readonly Journal[],
  bankAccountsId: number | undefined,
): ProvenDirection {
  if (tx.status !== "CONFIRMED" || tx.is_deleted === true) return undefined;
  if (tx.id === undefined || !Number.isFinite(tx.id)) return undefined;
  const dimension = tx.accounts_dimensions_id;
  if (typeof dimension !== "number" || !Number.isFinite(dimension)) return undefined;
  if (bankAccountsId === undefined || !Number.isFinite(bankAccountsId)) return undefined;

  let netCents = 0;
  for (const journal of journals) {
    if (journal.operation_type !== "TRANSACTION" || journal.operations_id !== tx.id) continue;
    if (journal.registered !== true || journal.is_deleted === true) continue;
    for (const posting of journal.postings ?? []) {
      if (posting.is_deleted === true) continue;
      if (posting.accounts_id !== bankAccountsId || posting.accounts_dimensions_id !== dimension) continue;
      const currency = (posting.cl_currencies_id ?? journal.cl_currencies_id ?? "EUR").toUpperCase();
      const eur = typeof posting.base_amount === "number" && Number.isFinite(posting.base_amount)
        ? posting.base_amount
        : currency === "EUR" && Number.isFinite(posting.amount) ? posting.amount : undefined;
      if (eur === undefined || (posting.type !== "D" && posting.type !== "C")) return undefined;
      netCents += (posting.type === "D" ? 1 : -1) * Math.round(eur * 100);
    }
  }
  if (netCents > 0) return "incoming";
  if (netCents < 0) return "outgoing";
  return undefined;
}

/**
 * Proven direction of a bank row: the signed importer marker, else — for a
 * CONFIRMED row only — the direction its registration journal books on the
 * row's bank account. A marker and a journal that disagree prove nothing
 * (`undefined`); a PROJECT row has no journal and stays marker-only.
 */
export function provenBankDirection(
  tx: Pick<Transaction, "id" | "status" | "is_deleted" | "accounts_dimensions_id" | "description">,
  journals: readonly Journal[],
  bankAccountsId: number | undefined,
): ProvenDirection {
  const marker = signedBankTransactionDirection(tx);
  const booked = journalBankDirection(tx, journals, bankAccountsId);
  if (marker !== undefined && booked !== undefined && marker !== booked) return undefined;
  return marker ?? booked;
}

/**
 * `provenBankDirection` with the evidence loaded: the bank GL account behind
 * the row's dimension (account dimensions) and the row's registration
 * journal(s) from the journal list, fetched individually when the list omits
 * postings. A non-CONFIRMED row loads nothing and stays marker-only.
 */
export async function loadProvenBankDirection(
  api: Pick<ApiContext, "journals" | "readonly">,
  tx: Transaction,
): Promise<ProvenDirection> {
  if (tx.status !== "CONFIRMED" || tx.is_deleted === true || tx.id === undefined) {
    return provenBankDirection(tx, [], undefined);
  }
  const [dimensions, allJournals] = await Promise.all([
    api.readonly.getAccountDimensions(),
    api.journals.listAll(),
  ]);
  const bankAccountsId = dimensions.find(dim => dim.id === tx.accounts_dimensions_id && !dim.is_deleted)?.accounts_id;
  const registration = await Promise.all(allJournals
    .filter(journal => journal.operation_type === "TRANSACTION" && journal.operations_id === tx.id && journal.is_deleted !== true)
    .map(journal => !journal.postings || journal.postings.length === 0
      ? (journal.id === undefined ? journal : api.journals.get(journal.id))
      : journal));
  return provenBankDirection(tx, registration, bankAccountsId);
}
