import { describe, it, expect } from "vitest";
import { BookingGuard } from "../booking-guard.js";
import type { AccountDimension, BankAccount, Journal, Posting } from "../types/api.js";
import {
  buildCamtJournalCoverageContext,
  classifyCamtJournalCoverage,
  type CamtJournalCoverage,
} from "./journal-coverage.js";
import type { ParsedCamtEntry, Transaction } from "./types.js";
import { computeCamtImportProjection } from "./projection.js";
import { buildCamtDescriptionWithMetadata } from "./duplicate-identity.js";
import { summarizeEntries } from "./parser.js";

// LHV dim 7 and Wise dim 8 are own bank dimensions on 1020; dim 70 is a loan
// sub-account on 1410. Entries are on dim 7.
const LHV = 7;
const WISE = 8;
const LOAN = 70;
const WISE_IBAN = "BE08905767222113";
const bankAccounts: BankAccount[] = [
  { accounts_dimensions_id: LHV, account_name_est: "LHV", account_no: "EE637700771011212909", iban_code: "EE637700771011212909" },
  { accounts_dimensions_id: WISE, account_name_est: "Wise", account_no: WISE_IBAN, iban_code: WISE_IBAN },
] as BankAccount[];
const dimensions = (bankAccountId = 1020): AccountDimension[] => [
  { id: LHV, accounts_id: bankAccountId, title_est: "LHV", is_deleted: false },
  { id: WISE, accounts_id: 1020, title_est: "Wise", is_deleted: false },
  { id: LOAN, accounts_id: 1410, title_est: "Loan", is_deleted: false },
] as AccountDimension[];

const DATE = "2026-09-24";

function entry(o: Partial<ParsedCamtEntry> & Pick<ParsedCamtEntry, "amount" | "direction">): ParsedCamtEntry {
  return { date: DATE, currency: "EUR", duplicate: false, duplicate_transaction_ids: [], ...o };
}

function p(accounts_id: number, accounts_dimensions_id: number | null, type: "D" | "C", amount: number, extra: Partial<Posting> = {}): Posting {
  return { accounts_id, accounts_dimensions_id, type, amount, base_amount: amount, cl_currencies_id: "EUR", is_deleted: false, ...extra };
}

function journal(id: number, postings: Posting[], o: Partial<Journal> = {}): Journal {
  return { id, effective_date: DATE, registered: true, is_deleted: false, operation_type: "ENTRY", document_number: null, postings, ...o };
}

function classifyAll(
  journals: Journal[],
  entries: ParsedCamtEntry[],
  o: { ledger?: Transaction[]; accountId?: number } = {},
): CamtJournalCoverage[] {
  const accountId = o.accountId ?? 1020;
  const context = buildCamtJournalCoverageContext({
    snapshot: {
      journals,
      accountId,
      bankAccounts,
      accountDimensions: dimensions(accountId),
      interAccountResolver: (snapshot, own) => BookingGuard.fromSnapshot({} as never, snapshot, own),
    },
    dimensionId: LHV,
    entries,
    ledgerTransactions: o.ledger ?? [],
  });
  return entries.filter(e => !e.duplicate).map(e => classifyCamtJournalCoverage(e, context));
}

const classify = (journals: Journal[], e: ParsedCamtEntry, o?: Parameters<typeof classifyAll>[2]) =>
  classifyAll(journals, [e], o)[0]!;

const loanJournal = (doc: string | null, bankAmount = 10500, o: Partial<Journal> = {}) =>
  journal(601, [p(1410, LOAN, "D", 10500), p(1020, LHV, "C", bankAmount)], { document_number: doc, ...o });
const loanEntry = (o: Partial<ParsedCamtEntry> = {}) =>
  entry({ amount: 10500, direction: "DBIT", bank_reference: "REF-LOAN-1", ...o });

const wiseTransfer = (o: Partial<Journal> = {}) =>
  journal(701, [p(1020, LHV, "D", 15), p(1020, WISE, "C", 15)], { operation_type: "TRANSACTION", operations_id: 9800, ...o });
const wiseEntry = (o: Partial<ParsedCamtEntry> = {}) =>
  entry({ amount: 15, direction: "CRDT", counterparty_iban: WISE_IBAN, bank_reference: "LHV-IN-1", ...o });

describe("classifyCamtJournalCoverage", () => {
  it("1: BANK:-labelled ENTRY journal crediting the bank dimension → identity skip", () => {
    expect(classify([loanJournal("BANK:REF-LOAN-1")], loanEntry())).toEqual({ kind: "identity", journal_ids: [601] });
  });

  it("2: bare reference document number → identity skip", () => {
    expect(classify([loanJournal("REF-LOAN-1")], loanEntry())).toEqual({ kind: "identity", journal_ids: [601] });
  });

  it("3: bank posting of another amount → review", () => {
    expect(classify([loanJournal("BANK:REF-LOAN-1", 10000)], loanEntry()).kind).toBe("review");
  });

  it("4: unregistered journal → review", () => {
    expect(classify([loanJournal("BANK:REF-LOAN-1", 10500, { registered: false })], loanEntry()).kind).toBe("review");
  });

  it("5: deleted journal → none", () => {
    expect(classify([loanJournal("BANK:REF-LOAN-1", 10500, { is_deleted: true })], loanEntry())).toEqual({ kind: "none" });
  });

  it("6: Lane B: ref-less TRANSACTION journal of a Wise transaction → inter_account skip", () => {
    expect(classify([wiseTransfer()], wiseEntry())).toEqual({ kind: "inter_account", journal_ids: [701] });
  });

  it("7: Lane B with the entry dated one day later → skip", () => {
    expect(classify([wiseTransfer()], wiseEntry({ date: "2026-09-25" }))).toEqual({ kind: "inter_account", journal_ids: [701] });
  });

  it("8: two same-key entries → first skip, second review", () => {
    const [first, second] = classifyAll([wiseTransfer()], [wiseEntry(), wiseEntry({ bank_reference: "LHV-IN-2" })]);
    expect(first).toEqual({ kind: "inter_account", journal_ids: [701] });
    expect(second!.kind).toBe("review");
  });

  it("9: labelled inter-account journal (WISE-NATIVE-REF) → review", () => {
    expect(classify([wiseTransfer({ document_number: "WISE-NATIVE-REF" })], wiseEntry()))
      .toMatchObject({ kind: "review", code: "camt_journal_conflict" });
  });

  it("10: direction mismatch (the 28606862 shape) → review", () => {
    expect(classify([wiseTransfer()], wiseEntry({ direction: "DBIT" })).kind).toBe("review");
  });

  it("11: name only, no IBAN → posting-scan review", () => {
    expect(classify([wiseTransfer()], wiseEntry({ counterparty_iban: undefined })))
      .toEqual({ kind: "review", code: "camt_journal_posting_review", journal_ids: [701] });
  });

  const ridango = (date = "2026-06-20") => journal(28424939, [p(5610, null, "D", 10.35), p(1510, null, "D", 2.48), p(1020, LHV, "C", 12.83)],
    { document_number: "RIDANGO-2026-06-50244476", effective_date: date });
  const ridangoEntry = () => entry({ amount: 12.83, direction: "DBIT", date: "2026-06-20", bank_reference: "PILET-1" });

  it("12: RIDANGO multi-leg shape → review", () => {
    expect(classify([ridango()], ridangoEntry())).toMatchObject({ kind: "review", code: "camt_journal_posting_review" });
  });

  it("13: as 12, posting 3 days off → none", () => {
    expect(classify([ridango("2026-06-23")], ridangoEntry())).toEqual({ kind: "none" });
  });

  it("14: USD entry → none", () => {
    expect(classify([loanJournal("BANK:REF-LOAN-1")], loanEntry({ currency: "USD" }))).toEqual({ kind: "none" });
  });

  const tx = (id: number, o: Partial<Transaction> = {}): Transaction => ({
    id, status: "CONFIRMED", accounts_dimensions_id: LHV, type: "C", amount: 100, cl_currencies_id: "EUR", date: DATE,
    bank_ref_number: null, bank_account_no: null, ref_number: null, bank_account_name: "Payee", description: "Payment", ...o,
  }) as Transaction;
  const txJournal = (doc: string | null) =>
    journal(601, [p(1020, LHV, "C", 100), p(2310, null, "D", 100)], { operation_type: "TRANSACTION", operations_id: 801, document_number: doc });
  const outgoing = (ref: string) => entry({ amount: 100, direction: "DBIT", bank_reference: ref });

  it("15: confirmed same-dimension transaction with no identity, journal BANK:R → identity skip (not excluded)", () => {
    expect(classify([txJournal("BANK:R")], outgoing("R"), { ledger: [tx(801)] })).toEqual({ kind: "identity", journal_ids: [601] });
  });

  it("16: journal of a same-dimension transaction that matched ANOTHER statement entry → excluded → none", () => {
    const matched = { ...outgoing("R2"), duplicate: true, duplicate_transaction_ids: [801] };
    const [coverage] = classifyAll([txJournal(null)], [outgoing("R"), matched], { ledger: [tx(801, { bank_ref_number: "R2" })] });
    expect(coverage).toEqual({ kind: "none" });
  });

  it("A1: journal BANK:R whose source transaction carries identity R2 (matching no statement entry) → conflict review, not excluded", () => {
    expect(classify([txJournal("BANK:R")], outgoing("R"), { ledger: [tx(801, { bank_ref_number: "R2" })] }))
      .toEqual({ kind: "review", code: "camt_journal_conflict", journal_ids: [601] });
  });

  it("A1: a same-dimension transaction journal with a differing identity but no matched entry is kept in the posting scan", () => {
    expect(classify([txJournal(null)], outgoing("R"), { ledger: [tx(801, { bank_ref_number: "R2" })] }))
      .toEqual({ kind: "review", code: "camt_journal_posting_review", journal_ids: [601] });
  });

  it.each([["R first", false], ["BANK:R first", true]])("one journal never covers two entries whose references alias it (%s)", (_name, reversed) => {
    const entries = [outgoing("R"), outgoing("BANK:R")];
    const coverages = classifyAll([journal(601, [p(1020, LHV, "C", 100), p(5000, null, "D", 100)], { document_number: "BANK:R" })],
      reversed ? entries.reverse() : entries);
    expect(coverages.map(c => c.kind)).toEqual(["review", "review"]);
  });

  it.each([["R first", false], ["R2 first", true]])("A1: a contradictory journal is not hidden because its transaction matched another entry (%s)", (_name, reversed) => {
    const matched = { ...outgoing("R2"), duplicate: true, duplicate_transaction_ids: [801] };
    const entries = [outgoing("R"), matched];
    const [coverage] = classifyAll([txJournal("BANK:R")], reversed ? entries.reverse() : entries, { ledger: [tx(801, { bank_ref_number: "R2" })] });
    expect(coverage).toEqual({ kind: "review", code: "camt_journal_conflict", journal_ids: [601] });
  });

  it("A1: the journal of a matched transaction carrying that transaction's own reference stays excluded", () => {
    const matched = { ...outgoing("R2"), duplicate: true, duplicate_transaction_ids: [801] };
    const [coverage] = classifyAll([txJournal("BANK:R2")], [outgoing("R"), matched], { ledger: [tx(801, { bank_ref_number: "R2" })] });
    expect(coverage).toEqual({ kind: "none" });
  });

  it("17: offsetting bank postings (net 0) → review", () => {
    const offsetting = journal(601, [p(1020, LHV, "D", 10500), p(1020, LHV, "C", 10500)], { document_number: "BANK:REF-LOAN-1" });
    expect(classify([offsetting], loanEntry()).kind).toBe("review");
  });

  it("18: the only bank posting is deleted → review", () => {
    const deletedPosting = journal(601, [p(1410, LOAN, "D", 10500), p(1020, LHV, "C", 10500, { is_deleted: true })], { document_number: "BANK:REF-LOAN-1" });
    expect(classify([deletedPosting], loanEntry()).kind).toBe("review");
  });

  it("19: matching reference on a stale journal → review camt_journal_identity_stale", () => {
    expect(classify([loanJournal("BANK:REF-LOAN-1", 10500, { effective_date: "2025-01-10" })], loanEntry()))
      .toMatchObject({ kind: "review", code: "camt_journal_identity_stale" });
  });

  it("19b: identity window is ±3 days", () => {
    expect(classify([loanJournal("BANK:REF-LOAN-1", 10500, { effective_date: "2026-09-27" })], loanEntry()).kind).toBe("identity");
    expect(classify([loanJournal("BANK:REF-LOAN-1", 10500, { effective_date: "2026-09-28" })], loanEntry()))
      .toMatchObject({ kind: "review", code: "camt_journal_identity_stale" });
  });

  it("20: non-1020 bank account → identity skip on 1030/7; a posting on 1020/7 does not count", () => {
    const on1030 = journal(601, [p(1410, LOAN, "D", 10500), p(1030, LHV, "C", 10500)], { document_number: "BANK:REF-LOAN-1" });
    expect(classify([on1030], loanEntry(), { accountId: 1030 })).toEqual({ kind: "identity", journal_ids: [601] });
    expect(classify([loanJournal("BANK:REF-LOAN-1")], loanEntry(), { accountId: 1030 }).kind).toBe("review");
  });

  it("21: identity journal plus a second ENTRY posting the same amount → review camt_journal_conflict", () => {
    const second = journal(602, [p(5000, null, "D", 10500), p(1020, LHV, "C", 10500)], { document_number: "OTHER-DOC" });
    expect(classify([loanJournal("BANK:REF-LOAN-1"), second], loanEntry()))
      .toEqual({ kind: "review", code: "camt_journal_conflict", journal_ids: [601, 602] });
  });

  it("22: bank posting whose base_amount differs from amount → review camt_journal_inconsistent_amounts", () => {
    const mixed = journal(601, [p(1410, LOAN, "D", 10500), p(1020, LHV, "C", 10500, { base_amount: 10400 })], { document_number: "BANK:REF-LOAN-1" });
    expect(classify([mixed], loanEntry())).toMatchObject({ kind: "review", code: "camt_journal_inconsistent_amounts" });
  });

  it("22b: non-EUR bank posting → review camt_journal_inconsistent_amounts", () => {
    const usd = journal(601, [p(1410, LOAN, "D", 10500), p(1020, LHV, "C", 10500, { cl_currencies_id: "USD" })], { document_number: "BANK:REF-LOAN-1" });
    expect(classify([usd], loanEntry())).toMatchObject({ kind: "review", code: "camt_journal_inconsistent_amounts" });
  });

  it("a reference repeated in the file never takes the identity channel", () => {
    const coverages = classifyAll([loanJournal("BANK:REF-LOAN-1")], [loanEntry(), loanEntry({ amount: 1 })]);
    expect(coverages[0]!.kind).toBe("review");
  });

  it("a Lane B match is still checked against the signed net on this dimension", () => {
    // Fee-deducted transfer: 15.00 left Wise, 14.50 arrived on LHV.
    const feeDeducted = journal(701, [p(1020, LHV, "D", 14.5), p(1020, WISE, "C", 15), p(8610, null, "D", 0.5)],
      { operation_type: "TRANSACTION", operations_id: 9800 });
    expect(classify([feeDeducted], wiseEntry({ amount: 14.5 }))).toEqual({ kind: "inter_account", journal_ids: [701] });
  });
});

describe("journal coverage through the projection (Codex round 2)", () => {
  // tx801 is R2's row as the API reads it back: no direct bank reference, a
  // description cut to the cap, so only F3 recovers its identity. Its journal
  // carries R's reference and books 100 of the statement's 200.
  const base = {
    date: "2026-02-04", amount: 100, currency: "EUR", direction: "DBIT" as const, counterparty_name: "Supplier",
    counterparty_iban: "EE471000001020145685", description: "Long payment description ".repeat(12),
    duplicate: false, duplicate_transaction_ids: [] as number[],
  };
  const r = { ...base, bank_reference: "R" };
  const r2 = { ...base, bank_reference: "R2" };
  const tx801 = {
    id: 801, status: "CONFIRMED", accounts_dimensions_id: 7, type: "C", amount: 100, cl_currencies_id: "EUR", date: base.date,
    description: buildCamtDescriptionWithMetadata(r2.description, r2), bank_ref_number: null, bank_account_no: null,
    bank_account_name: "Supplier", ref_number: null,
  } as Transaction;
  const journal601 = journal(601, [p(1020, 7, "C", 100), p(5000, null, "D", 100)],
    { operation_type: "TRANSACTION", operations_id: 801, document_number: "BANK:R", effective_date: base.date });

  it.each([["R first", [r, r2]], ["R2 first", [r2, r]]])("an F3-recovered source identity contradicting the journal gives review (%s)", async (_name, entries) => {
    const projection = await computeCamtImportProjection({
      loaded: { entries, summary: summarizeEntries(entries), statement_metadata: { iban: "EE000", period: {} } },
      accountsDimensionsId: 7, dateFrom: undefined, dateTo: undefined, ledgerTransactions: [tx801],
      journalCoverage: { journals: [journal601], accountId: 1020, bankAccounts: [], accountDimensions: [],
        interAccountResolver: () => ({ resolveInterAccount: () => ({ status: "none" }), hasOtherLabelledInterAccount: () => false }) },
      resolveClient: async () => ({}), reportProgress: async () => {},
    });
    expect(tx801.description!.length).toBe(150);
    expect(projection.descriptors).toHaveLength(0);
    expect(projection.skipped.find(row => row.bank_reference === "R2")?.duplicate_transaction_ids).toEqual([801]);
    expect(projection.skipped.find(row => row.bank_reference === "R")).toMatchObject({ review_code: "camt_journal_conflict", journal_ids: [601] });
  });
});
