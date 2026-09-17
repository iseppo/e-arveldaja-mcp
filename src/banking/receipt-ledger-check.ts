import type { Journal, Posting, PurchaseInvoice, SaleInvoice, Transaction } from "../types/api.js";

/**
 * Post-confirm receipt-ledger invariant.
 *
 * Registering a bank transaction against an invoice is the one write where the
 * MCP server cannot see what it produced: the register call returns no journal
 * id, and the journal's client is copied from the TRANSACTION (the payer), not
 * from the linked invoice. When a third party pays someone else's invoice, the
 * receivable/payable leg therefore lands in the payer's client sub-ledger while
 * the invoice stays open in the invoice client's — silently.
 *
 * This module re-reads the ledger after such a confirm and asserts three
 * things about the registration journal: it exists and is unique, its client is
 * the invoice's client, and its postings actually move the transaction's own
 * bank account against the invoice's own receivable/payable account for the
 * transaction amount. Every account id comes from the records (`tx.accounts_id`,
 * sale `receivable_accounts_id`, purchase `liability_accounts_id`) — nothing is
 * hardcoded to 1020/1210/2310.
 *
 * Kept MCP-free: no tool-response or sandbox imports, so it stays a pure
 * checker plus one api entry point.
 */

export const RECEIPT_LEDGER_AMOUNT_TOLERANCE = 0.01;

export type ReceiptLedgerFailureCode =
  | "registration_journal_not_found"
  | "ledger_client_mismatch"
  | "ledger_posting_mismatch";

export type InvoiceTable = "sale_invoices" | "purchase_invoices";

export interface LinkedReceiptInvoice {
  table: InvoiceTable;
  id: number;
  clients_id: number | null;
  /**
   * The invoice's own ledger account: `receivable_accounts_id` for a sale,
   * `liability_accounts_id` for a purchase. `null` when the record does not
   * carry it — then the contra leg cannot be checked (and is reported as
   * unverified rather than passed off as verified).
   */
  ledger_accounts_id: number | null;
  /**
   * EUR magnitude of the distribution booked against THIS invoice, not the
   * transaction total. A transaction may settle an invoice alongside a GL row,
   * and an FX receipt splits into invoice amount + exchange difference, so the
   * contra leg must be measured against the invoice rows. `null` when the
   * amount is unknown — then the contra leg is reported as unverified.
   */
  amount: number | null;
}

export interface ReceiptLedgerFailureDetails {
  transaction_id: number | null;
  transaction_clients_id: number | null;
  invoice_clients_id: number | null;
  invoice_table: InvoiceTable | null;
  invoice_id: number | null;
  journal_id?: number;
  [key: string]: unknown;
}

export type ReceiptLedgerCheckResult =
  | { ok: true; journal_id?: number; skipped?: string; unverified?: string[] }
  | { ok: false; code: ReceiptLedgerFailureCode; details: ReceiptLedgerFailureDetails };

/**
 * Locate the registration journals of a confirmed bank transaction.
 *
 * Verified live: `operation_type === "TRANSACTION"` + `operations_id === tx.id`
 * is the only reliable link (the register call returns no journal id). Only
 * registered journals count — invalidating and re-confirming a transaction
 * leaves the superseded journal row behind, and every other ledger consumer
 * filters on `registered` too (see `buildInterAccountJournalIndex`). Returns
 * every live match so the caller can insist on exactly one.
 */
export function findRegistrationJournal(journals: readonly Journal[], txId: number): Journal[] {
  return journals.filter(j =>
    j.operation_type === "TRANSACTION"
    && j.operations_id === txId
    && j.registered === true
    && j.is_deleted !== true);
}

function livePostings(journal: Journal): Posting[] {
  return (journal.postings ?? []).filter(p => p.is_deleted !== true);
}

/** EUR-equivalent magnitude — postings carry base_amount for multi-currency rows. */
function eurMagnitude(row: { amount: number; base_amount?: number | null }): number {
  return Math.abs(row.base_amount ?? row.amount);
}

function sumPostings(postings: readonly Posting[]): number {
  return postings.reduce((total, p) => total + eurMagnitude(p), 0);
}

function uniqueNumbers(values: readonly (number | null | undefined)[]): number[] {
  return [...new Set(values.filter((v): v is number => typeof v === "number"))];
}

export function checkReceiptLedger(input: {
  tx: Transaction;
  invoices: readonly LinkedReceiptInvoice[];
  journals: readonly Journal[];
}): ReceiptLedgerCheckResult {
  const { tx, invoices, journals } = input;
  const txClientsId = tx.clients_id ?? null;
  const invoiceClientIds = uniqueNumbers(invoices.map(inv => inv.clients_id));
  // One journal carries one client, so a distribution spanning several invoice
  // clients has no satisfiable expectation — the client leg stays unverified.
  const invoiceClientsId = invoiceClientIds.length === 1 ? invoiceClientIds[0]! : null;
  const firstInvoice = invoices[0];
  const baseDetails: ReceiptLedgerFailureDetails = {
    transaction_id: tx.id ?? null,
    transaction_clients_id: txClientsId,
    invoice_clients_id: invoiceClientsId,
    invoice_table: firstInvoice?.table ?? null,
    invoice_id: firstInvoice?.id ?? null,
  };

  const matches = tx.id == null ? [] : findRegistrationJournal(journals, tx.id);
  if (matches.length !== 1) {
    // An ambiguous set is as unusable as an empty one — either way the single
    // registration journal this receipt should have produced was not found, and
    // the contract carries no separate code for "several".
    return {
      ok: false,
      code: "registration_journal_not_found",
      details: {
        ...baseDetails,
        journal_count: matches.length,
        journal_ids: matches.map(j => j.id).filter((id): id is number => id != null),
      },
    };
  }
  const journal = matches[0]!;
  const journalId = journal.id;
  const withJournal: ReceiptLedgerFailureDetails = {
    ...baseDetails,
    ...(journalId != null ? { journal_id: journalId } : {}),
  };

  if (invoiceClientsId !== null && (journal.clients_id ?? null) !== invoiceClientsId) {
    return {
      ok: false,
      code: "ledger_client_mismatch",
      details: { ...withJournal, journal_clients_id: journal.clients_id ?? null },
    };
  }

  // The stored transaction `type` is NOT a reliable direction: historically
  // imported rows carry "C" for incoming payments too (verified live — the
  // EIS receipt is type "C" with a Dr bank posting; see the direction notes in
  // CLAUDE.md). The bank leg is therefore identified by account + dimension
  // only, and its posted side defines the direction the contra leg must
  // oppose. A bank leg split across both sides is unusable and fails.
  const expected = eurMagnitude(tx);
  const postings = livePostings(journal);
  const unverified: string[] = [];
  let contraDirection: "D" | "C" | undefined;

  if (tx.accounts_id == null) {
    unverified.push("bank_leg: transaction record carries no accounts_id");
  } else {
    const bankPostings = postings.filter(p =>
      p.accounts_id === tx.accounts_id
      && (tx.accounts_dimensions_id == null || p.accounts_dimensions_id === tx.accounts_dimensions_id));
    const bankSides = [...new Set(bankPostings.map(p => p.type).filter((t): t is "D" | "C" => t === "D" || t === "C"))];
    const bankTotal = sumPostings(bankPostings);
    if (bankSides.length !== 1 || Math.abs(bankTotal - expected) > RECEIPT_LEDGER_AMOUNT_TOLERANCE) {
      return {
        ok: false,
        code: "ledger_posting_mismatch",
        details: {
          ...withJournal,
          leg: "bank",
          expected_amount: expected,
          posted_amount: bankTotal,
          expected_accounts_id: tx.accounts_id,
          expected_accounts_dimensions_id: tx.accounts_dimensions_id ?? null,
          posted_types: bankSides,
        },
      };
    }
    contraDirection = bankSides[0] === "D" ? "C" : "D";
  }

  // The contra leg answers for the INVOICE rows only. A transaction that also
  // carries a GL row, or an FX receipt whose exchange difference is booked
  // separately, posts less to the receivable/payable account than the bank leg
  // moves — comparing against the transaction total would fail those wrongly.
  const ledgerAccountIds = uniqueNumbers(invoices.map(inv => inv.ledger_accounts_id));
  const contraExpected = invoices.some(inv => inv.amount == null)
    ? null
    : invoices.reduce((total, inv) => total + (inv.amount ?? 0), 0);
  if (ledgerAccountIds.length === 0) {
    unverified.push("invoice_leg: no invoice record carries a receivable/liability account id");
  } else if (contraExpected === null) {
    unverified.push("invoice_leg: the transaction carries no distribution amount for every linked invoice");
  } else {
    const contraPostings = postings.filter(p =>
      ledgerAccountIds.includes(p.accounts_id)
      && (contraDirection === undefined || p.type === contraDirection));
    const contraTotal = sumPostings(contraPostings);
    if (Math.abs(contraTotal - contraExpected) > RECEIPT_LEDGER_AMOUNT_TOLERANCE) {
      return {
        ok: false,
        code: "ledger_posting_mismatch",
        details: {
          ...withJournal,
          leg: "invoice",
          expected_amount: contraExpected,
          posted_amount: contraTotal,
          expected_accounts_ids: ledgerAccountIds,
          expected_type: contraDirection ?? null,
        },
      };
    }
  }
  if (invoiceClientsId === null) {
    unverified.push("client_leg: linked invoices carry no single clients_id");
  }

  return {
    ok: true,
    ...(journalId != null ? { journal_id: journalId } : {}),
    ...(unverified.length > 0 ? { unverified } : {}),
  };
}

export interface ReceiptLedgerApi {
  transactions: { get(id: number): Promise<Transaction> };
  saleInvoices: { get(id: number): Promise<SaleInvoice> };
  purchaseInvoices: { get(id: number): Promise<PurchaseInvoice> };
  journals: {
    listAll(params?: { start_date?: string; end_date?: string }): Promise<Journal[]>;
    get(id: number): Promise<Journal>;
  };
}

export interface TransactionInvoiceLink {
  table: InvoiceTable;
  id: number;
  /** EUR magnitude booked against this invoice, or null when a row's amount is unknown. */
  amount: number | null;
}

/**
 * Distinct invoice links carried by a transaction's items
 * (relation_table/relation_id), each with the EUR amount booked against it.
 *
 * Several item rows may point at one invoice, so amounts are summed. A row
 * whose amount is not a finite number makes the whole invoice's amount unknown
 * (`null`) rather than silently under-counting the expectation.
 */
export function invoiceLinksFromTransaction(tx: Transaction): TransactionInvoiceLink[] {
  const order: Array<{ table: InvoiceTable; id: number; key: string }> = [];
  const sums = new Map<string, number | null>();
  for (const item of tx.items ?? []) {
    const table = item.relation_table;
    const id = item.relation_id;
    if (typeof id !== "number" || id <= 0) continue;
    if (table !== "sale_invoices" && table !== "purchase_invoices") continue;
    const key = `${table}:${id}`;
    if (!sums.has(key)) {
      order.push({ table, id, key });
      sums.set(key, 0);
    }
    const raw = item.base_amount ?? item.amount;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      sums.set(key, null);
      continue;
    }
    const running = sums.get(key);
    if (running !== null && running !== undefined) sums.set(key, running + Math.abs(raw));
  }
  return order.map(({ table, id, key }) => ({ table, id, amount: sums.get(key) ?? null }));
}

/**
 * Re-read a just-confirmed transaction and assert the receipt invariant.
 *
 * Only invoice-linked confirms are checked — a transaction booked straight to
 * GL accounts has no invoice client to compare against, so it returns
 * `{ ok: true, skipped: "no_invoice_distribution" }`.
 */
export async function verifyInvoiceReceiptLedger(
  api: ReceiptLedgerApi,
  txId: number,
): Promise<ReceiptLedgerCheckResult> {
  const tx = await api.transactions.get(txId);
  const links = invoiceLinksFromTransaction(tx);
  if (links.length === 0) return { ok: true, skipped: "no_invoice_distribution" };

  const invoices: LinkedReceiptInvoice[] = [];
  for (const link of links) {
    if (link.table === "sale_invoices") {
      const invoice = await api.saleInvoices.get(link.id);
      invoices.push({
        table: "sale_invoices",
        id: link.id,
        clients_id: invoice?.clients_id ?? null,
        ledger_accounts_id: invoice?.receivable_accounts_id ?? null,
        amount: link.amount,
      });
    } else {
      const invoice = await api.purchaseInvoices.get(link.id);
      invoices.push({
        table: "purchase_invoices",
        id: link.id,
        clients_id: invoice?.clients_id ?? null,
        ledger_accounts_id: invoice?.liability_accounts_id ?? null,
        amount: link.amount,
      });
    }
  }

  // One day of journals, not the whole ledger: the registration journal's
  // effective_date is the transaction's date, and `/journals` filters that
  // range server-side. Only the candidates that came back without postings are
  // then fetched individually.
  const sameDay = await api.journals.listAll({ start_date: tx.date, end_date: tx.date });
  const journals: Journal[] = [];
  for (const candidate of findRegistrationJournal(sameDay, txId)) {
    journals.push(candidate.id != null && (candidate.postings?.length ?? 0) === 0
      ? await api.journals.get(candidate.id)
      : candidate);
  }
  return checkReceiptLedger({ tx, invoices, journals });
}
