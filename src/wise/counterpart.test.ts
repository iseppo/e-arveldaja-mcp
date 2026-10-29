import { describe, expect, it } from "vitest";
import type { AccountDimension, BankAccount, Journal, Transaction } from "../types/api.js";
import { buildCamtDescriptionWithMetadata } from "../camt/duplicate-identity.js";
import { buildBankAccountLookups } from "../tools/inter-account-utils.js";
import { resolveWiseRowCounterparts, wiseCounterpartHoldReview, type WiseCounterpartInput } from "./counterpart.js";
import { isWiseCounterpartyName } from "./preflight.js";
import type { WiseRow } from "./types.js";

const WISE = 5;
const LHV = 20;
const COOP = 30;
const LIGHTYEAR = 40;
const BANK_GL = 1020;
const WISE_IBAN = "BE08905767222113";
const LHV_IBAN = "EE637700771011212909";
const COOP_IBAN = "EE424200000000000001";
const LIGHTYEAR_IBAN = "EE111111111111111111";
const COMPANY = "Seppo AI OÜ";

const bankAccounts = (dims: number[]): BankAccount[] => ([
  { accounts_dimensions_id: WISE, iban_code: WISE_IBAN, account_name_est: "Wise" },
  { accounts_dimensions_id: LHV, iban_code: LHV_IBAN, account_name_est: "LHV" },
  { accounts_dimensions_id: COOP, iban_code: COOP_IBAN, account_name_est: "Coop" },
  { accounts_dimensions_id: LIGHTYEAR, iban_code: LIGHTYEAR_IBAN, account_name_est: "Lightyear" },
] as unknown as BankAccount[]).filter(account => dims.includes(account.accounts_dimensions_id!));
const dimensions = (dims: number[]): AccountDimension[] =>
  dims.map(id => ({ id, accounts_id: BANK_GL, title_est: `Bank ${id}`, is_deleted: false }) as AccountDimension);

function row(id: string, overrides: Partial<WiseRow> = {}): WiseRow {
  return {
    rowIndex: overrides.rowIndex ?? 0,
    id,
    status: "COMPLETED",
    direction: "IN",
    createdOn: "2026-06-01 10:00:00",
    finishedOn: "2026-06-01 10:00:00",
    sourceFeeAmount: 0,
    sourceFeeCurrency: "EUR",
    targetFeeAmount: 0,
    targetFeeCurrency: "EUR",
    sourceName: COMPANY,
    sourceAmount: 100,
    sourceCurrency: "EUR",
    targetName: COMPANY,
    targetAmount: 100,
    targetCurrency: "EUR",
    exchangeRate: 1,
    reference: "",
    category: "General",
    note: "",
    ...overrides,
  };
}

/** A PROJECT row as MCP-CAMT stores it: the IBAN and the direction only in the signed marker. */
function camtTx(id: number, dim: number, overrides: {
  direction?: "DBIT" | "CRDT"; iban?: string; name?: string; amount?: number; date?: string; currency?: string;
} = {}): Transaction {
  const amount = overrides.amount ?? 100;
  const date = overrides.date ?? "2026-06-01";
  const name = overrides.name ?? COMPANY;
  const description = buildCamtDescriptionWithMetadata("Transfer", {
    date, amount, currency: overrides.currency ?? "EUR", direction: overrides.direction ?? "DBIT",
    counterparty_name: name, counterparty_iban: overrides.iban ?? WISE_IBAN, bank_reference: `REF${id}`,
    description: "Transfer",
  });
  return {
    id, status: "PROJECT", is_deleted: false, type: "C", amount, cl_currencies_id: overrides.currency ?? "EUR", date,
    accounts_dimensions_id: dim, bank_account_name: name, bank_account_no: null, bank_ref_number: null, description,
  } as unknown as Transaction;
}

/** Flip one hex character of the marker's sig, keeping it syntactically valid. */
function tamperSig(tx: Transaction): Transaction {
  return { ...tx, description: (tx.description ?? "").replace(/sig=([a-f0-9])/, (_m, c: string) => `sig=${c === "0" ? "1" : "0"}`) };
}

/** A CONFIRMED unsigned row with its registration journal: `bankSide` is the
 * row's own bank posting side, `other` the other leg's dimension. */
function confirmedTx(id: number, dim: number, bankSide: "C" | "D", other: number, overrides: {
  name?: string; iban?: string | null; amount?: number; documentNumber?: string;
} = {}): { tx: Transaction; journal: Journal } {
  const amount = overrides.amount ?? 100;
  const tx = {
    id, status: "CONFIRMED", is_deleted: false, type: "C", amount, cl_currencies_id: "EUR", date: "2026-06-01",
    accounts_dimensions_id: dim, bank_account_name: overrides.name ?? COMPANY,
    bank_account_no: overrides.iban === undefined ? WISE_IBAN : overrides.iban, description: "Transfer",
  } as unknown as Transaction;
  const journal = {
    id: 9000 + id, registered: true, is_deleted: false, operation_type: "TRANSACTION", operations_id: id,
    effective_date: "2026-06-01", document_number: overrides.documentNumber,
    postings: [
      { accounts_id: BANK_GL, accounts_dimensions_id: dim, type: bankSide, amount },
      { accounts_id: BANK_GL, accounts_dimensions_id: other, type: bankSide === "C" ? "D" : "C", amount },
    ],
  } as unknown as Journal;
  return { tx, journal };
}

function resolve(overrides: Partial<WiseCounterpartInput> & { banks?: number[] } = {}) {
  const banks = overrides.banks ?? [WISE, LHV, COOP];
  const rows = overrides.rows ?? [row("TRANSFER-1")];
  return resolveWiseRowCounterparts({
    rows,
    allRows: overrides.allRows ?? rows,
    wiseDim: WISE,
    otherDims: new Set(banks.filter(dim => dim !== WISE)),
    existingTx: overrides.existingTx ?? [],
    journals: overrides.journals ?? [],
    lookups: buildBankAccountLookups(bankAccounts(banks), dimensions(banks)),
    companyLegalName: COMPANY,
    explicit: overrides.explicit,
  });
}

const only = (map: ReturnType<typeof resolve>) => [...map.values()][0];

describe("resolveWiseRowCounterparts — classes and resolution", () => {
  it("one strong candidate (Wise IBAN, proven opposite direction, same amount) selects its bank", () => {
    expect(only(resolve({ existingTx: [camtTx(1, LHV)] }))).toEqual({ dim: LHV, basis: "evidence" });
  });

  it("the company's own name or Wise as counterparty is an own-transfer indicator too", () => {
    const ownName = camtTx(1, COOP, { iban: "EE999999999999999999", name: COMPANY });
    expect(only(resolve({ existingTx: [ownName] }))).toEqual({ dim: COOP, basis: "evidence" });
    const wiseName = camtTx(2, COOP, { iban: "BE48967056780227", name: "Wise Europe SA" });
    expect(only(resolve({ existingTx: [wiseName] }))).toEqual({ dim: COOP, basis: "evidence" });
  });

  it("strong evidence on two banks is a conflict hold", () => {
    expect(only(resolve({ existingTx: [camtTx(1, LHV), camtTx(2, COOP)] }))).toEqual({
      hold: { code: "wise_transfer_counterpart_conflict", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [1, 2] },
    });
  });

  it("explicit never overrides contrary evidence; explicit equal to the evidence is evidence", () => {
    expect(only(resolve({ existingTx: [camtTx(1, COOP)], explicit: LHV }))).toEqual({
      hold: { code: "wise_transfer_counterpart_conflict", candidate_dimension_ids: [COOP], evidence_transaction_ids: [1], selected_dimension_id: LHV },
    });
    expect(only(resolve({ existingTx: [camtTx(1, LHV)], explicit: LHV }))).toEqual({ dim: LHV, basis: "evidence" });
  });

  it("weak evidence on another bank holds an explicit row; weak evidence on the explicit bank resolves to it", () => {
    const weakCoop = camtTx(1, COOP, { iban: "EE999999999999999999", name: "Some Supplier OÜ" });
    expect(only(resolve({ existingTx: [weakCoop], explicit: LHV }))).toEqual({
      hold: { code: "wise_transfer_counterpart_conflict", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [1], selected_dimension_id: LHV },
    });
    const weakLhv = camtTx(2, LHV, { iban: "EE999999999999999999", name: "Some Supplier OÜ" });
    // The fallback names the non-strong evidence it resolved over, so a caller
    // can tell a bare fallback from one with weak evidence on that bank.
    expect(only(resolve({ existingTx: [weakLhv], explicit: LHV }))).toEqual({ dim: LHV, basis: "explicit", otherEvidenceDims: [LHV] });
    expect(only(resolve({ existingTx: [], explicit: LHV }))).toEqual({ dim: LHV, basis: "explicit" });
  });

  it("no evidence: explicit-only rows resolve (OQ-5); several banks without explicit hold unresolved", () => {
    expect(only(resolve({ explicit: COOP }))).toEqual({ dim: COOP, basis: "explicit" });
    expect(only(resolve())).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [] },
    });
  });

  it("the only other bank is the fallback; an invalid explicit value disables it and holds", () => {
    expect(only(resolve({ banks: [WISE, LHV] }))).toEqual({ dim: LHV, basis: "only_other_bank" });
    for (const explicit of [WISE, 99, 0, -20, 20.5, "20"]) {
      expect(only(resolve({ banks: [WISE, LHV], explicit })), String(explicit)).toEqual({
        hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV], evidence_transaction_ids: [] },
      });
    }
  });

  it("a Wise-only company resolves nothing (rows keep the unresolved classification)", () => {
    expect(resolve({ banks: [WISE] }).size).toBe(0);
  });
});

describe("resolveWiseRowCounterparts — excluded candidates", () => {
  it("a transfer to another own account (LHV→Lightyear, same amount, same day) is not a candidate", () => {
    const toLightyear = camtTx(1, LHV, { iban: LIGHTYEAR_IBAN });
    expect(only(resolve({ banks: [WISE, LHV, COOP, LIGHTYEAR], existingTx: [toLightyear] }))).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP, LIGHTYEAR], evidence_transaction_ids: [] },
    });
    expect(only(resolve({ banks: [WISE, LHV, COOP, LIGHTYEAR], existingTx: [toLightyear], explicit: COOP }))).toEqual({ dim: COOP, basis: "explicit" });
  });

  it("a same-direction transaction is not a candidate", () => {
    expect(only(resolve({ existingTx: [camtTx(1, LHV, { direction: "CRDT" })], explicit: COOP }))).toEqual({ dim: COOP, basis: "explicit" });
  });

  it("a CONFIRMED transaction whose registration journal does not touch Wise books another movement", () => {
    const { tx, journal } = confirmedTx(1, LHV, "C", LIGHTYEAR, { iban: null, name: COMPANY });
    expect(only(resolve({ existingTx: [tx], journals: [journal], explicit: COOP }))).toEqual({ dim: COOP, basis: "explicit" });
  });

  it("a different amount or a date two days away is not a candidate", () => {
    expect(only(resolve({ existingTx: [camtTx(1, LHV, { amount: 99.99 }), camtTx(2, LHV, { date: "2026-06-03" })], explicit: COOP })))
      .toEqual({ dim: COOP, basis: "explicit" });
  });
});

describe("resolveWiseRowCounterparts — Codex r3 M1 (usable amount)", () => {
  it("a USD 100 row without a base amount, with the Wise IBAN, is uncertain against Wise EUR 100: held, or the explicit bank", () => {
    const usd = camtTx(1, LHV, { currency: "USD" });
    expect(only(resolve({ existingTx: [usd] }))).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [1] },
    });
    expect(only(resolve({ existingTx: [usd], explicit: LHV }))).toEqual({ dim: LHV, basis: "explicit", otherEvidenceDims: [LHV] });
    expect(only(resolve({ existingTx: [usd], explicit: COOP }))).toEqual({
      hold: { code: "wise_transfer_counterpart_conflict", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [1], selected_dimension_id: COOP },
    });
  });

  it("a foreign row with a matching EUR base amount is usable and strong", () => {
    const usd = { ...camtTx(1, LHV, { currency: "USD", amount: 108.5 }), base_amount: 100 } as Transaction;
    // The marker signs the nominal; the base amount is the EUR evidence.
    expect(only(resolve({ existingTx: [usd] }))).toEqual({ dim: LHV, basis: "evidence" });
  });
});

describe("resolveWiseRowCounterparts — Codex r3 M2 (proven direction)", () => {
  it("an unsigned PROJECT row with the Wise IBAN has no direction: uncertain, held without explicit", () => {
    const unsigned = {
      id: 1, status: "PROJECT", is_deleted: false, type: "C", amount: 100, cl_currencies_id: "EUR", date: "2026-06-01",
      accounts_dimensions_id: LHV, bank_account_name: COMPANY, bank_account_no: WISE_IBAN, description: "Transfer",
    } as unknown as Transaction;
    expect(only(resolve({ existingTx: [unsigned] }))).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [1] },
    });
  });

  it("a CAMT marker with a bad sig claiming the opposite direction proves nothing: uncertain", () => {
    const tampered = { ...tamperSig(camtTx(1, LHV)), bank_account_no: WISE_IBAN } as Transaction;
    expect(only(resolve({ existingTx: [tampered] }))).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [1] },
    });
  });

  it("a CONFIRMED row with an unverifiable legacy CAMT marker is strong when its registration journal proves the side", () => {
    const { tx, journal } = confirmedTx(1, LHV, "C", WISE);
    const legacy = { ...tx, description: tamperSig(camtTx(1, LHV)).description } as Transaction;
    expect(only(resolve({ existingTx: [legacy], journals: [journal] }))).toEqual({ dim: LHV, basis: "evidence" });
    // The journal proves the same side as the row: an incoming LHV row is no evidence for an IN Wise row.
    const incoming = confirmedTx(1, LHV, "D", WISE);
    expect(only(resolve({ existingTx: [{ ...incoming.tx, description: legacy.description } as Transaction], journals: [incoming.journal] }))).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [] },
    });
  });

  it("a confirmed row whose registration journal moves another amount on Wise is a different movement; an uncomparable Wise side is uncertain", () => {
    const legacyMarker = tamperSig(camtTx(1, LHV)).description;
    const lhv = { ...confirmedTx(1, LHV, "C", WISE).tx, description: legacyMarker } as Transaction;
    const netPlusFee = (wisePosting: Record<string, unknown>) => ({
      id: 9001, registered: true, is_deleted: false, operation_type: "TRANSACTION", operations_id: 1, effective_date: "2026-06-01",
      postings: [
        { accounts_id: BANK_GL, accounts_dimensions_id: LHV, type: "C", amount: 100 },
        { accounts_id: BANK_GL, accounts_dimensions_id: WISE, type: "D", amount: 80, ...wisePosting },
        { accounts_id: 8610, type: "D", amount: 20 },
      ],
    }) as unknown as Journal;
    // Wise D 80 for a Wise IN 100 row: not this movement, no evidence.
    expect(only(resolve({ existingTx: [lhv], journals: [netPlusFee({})] }))).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [] },
    });
    // A foreign Wise posting without an EUR base cannot be compared: uncertain.
    expect(only(resolve({ existingTx: [lhv], journals: [netPlusFee({ cl_currencies_id: "USD" })] }))).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [1] },
    });
    // So can a missing or non-finite Wise amount.
    expect(only(resolve({ existingTx: [lhv], journals: [netPlusFee({ amount: Number.NaN })] }))).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [1] },
    });
  });

  it("live-like: a confirmed legacy-marker LHV row whose journal books D LHV 1000 / C Wise 1000 is strong for a Wise OUT 1000", () => {
    const { tx, journal } = confirmedTx(1, LHV, "D", WISE, { amount: 1000 });
    const legacy = { ...tx, description: tamperSig(camtTx(1, LHV, { direction: "CRDT", amount: 1000 })).description } as Transaction;
    const out = row("TRANSFER-OUT", { direction: "OUT", sourceAmount: 1000, targetAmount: 1000 });
    expect(only(resolve({ rows: [out], existingTx: [legacy], journals: [journal] }))).toEqual({ dim: LHV, basis: "evidence" });
  });

  it("a CONFIRMED unsigned row whose registration journal proves the opposite side is strong", () => {
    const { tx, journal } = confirmedTx(1, LHV, "C", WISE);
    expect(only(resolve({ existingTx: [tx], journals: [journal] }))).toEqual({ dim: LHV, basis: "evidence" });
  });
});

describe("resolveWiseRowCounterparts — Codex r3 M3 (one-to-one attribution)", () => {
  it("OLD/NEW: an already-imported same-day same-amount Wise row contests the only candidate, so NEW is held", () => {
    const oldRow = row("TRANSFER-OLD", { rowIndex: 0 });
    const newRow = row("TRANSFER-NEW", { rowIndex: 1 });
    const storedOld = {
      id: 500, status: "CONFIRMED", is_deleted: false, type: "C", amount: 100, cl_currencies_id: "EUR", date: "2026-06-01",
      accounts_dimensions_id: WISE, description: "WISE:TRANSFER-OLD LHV [source_direction=IN]",
    } as unknown as Transaction;
    // In the statement and stored:
    expect(only(resolve({ rows: [newRow], allRows: [oldRow, newRow], existingTx: [camtTx(1, LHV), storedOld] }))).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [1], contested: true },
    });
    // Stored only (another statement):
    expect(only(resolve({ rows: [newRow], existingTx: [camtTx(1, LHV), storedOld] }))).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [1], contested: true },
    });
  });

  it("two new rows and one candidate: both are held", () => {
    const rows = [row("TRANSFER-A", { rowIndex: 0 }), row("TRANSFER-B", { rowIndex: 1 })];
    const resolved = resolve({ rows, existingTx: [camtTx(1, LHV)] });
    for (const wiseRow of rows) {
      expect(resolved.get(wiseRow), wiseRow.id).toEqual({
        hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [1], contested: true },
      });
    }
  });

  it("an authoritative link (registration journal labelled with the Wise ID) resolves that row; the other is held", () => {
    const rows = [row("TRANSFER-A", { rowIndex: 0 }), row("TRANSFER-B", { rowIndex: 1 })];
    const { tx, journal } = confirmedTx(1, LHV, "C", WISE, { documentNumber: "TRANSFER-A" });
    const resolved = resolve({ rows, existingTx: [tx], journals: [journal] });
    expect(resolved.get(rows[0]!)).toEqual({ dim: LHV, basis: "evidence" });
    // Attributed to TRANSFER-A, the row is no evidence for TRANSFER-B at all.
    expect(resolved.get(rows[1]!)).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [] },
    });
  });

  it("an old net+fee transfer's bank row (journal labelled with its Wise ID) is never evidence for a new same-gross transfer", () => {
    // LHV 100 out; its registration journal books Wise 80 + fee 20 and is labelled TRANSFER-123.
    const lhv = {
      id: 1, status: "CONFIRMED", is_deleted: false, type: "C", amount: 100, cl_currencies_id: "EUR", date: "2026-06-01",
      accounts_dimensions_id: LHV, bank_account_name: COMPANY, bank_account_no: WISE_IBAN, description: "To Wise",
    } as unknown as Transaction;
    const journal = {
      id: 9001, registered: true, is_deleted: false, operation_type: "TRANSACTION", operations_id: 1,
      effective_date: "2026-06-01", document_number: "TRANSFER-123",
      postings: [
        { accounts_id: BANK_GL, accounts_dimensions_id: LHV, type: "C", amount: 100 },
        { accounts_id: BANK_GL, accounts_dimensions_id: WISE, type: "D", amount: 80 },
        { accounts_id: 8610, type: "D", amount: 20 },
      ],
    } as unknown as Journal;
    const newRow = row("TRANSFER-999");
    expect(only(resolve({ rows: [newRow], existingTx: [lhv], journals: [journal] }))).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [] },
    });
    // An explicit Coop is not contradicted by it either.
    expect(only(resolve({ rows: [newRow], existingTx: [lhv], journals: [journal], explicit: COOP }))).toEqual({ dim: COOP, basis: "explicit" });
    // A bank row tagged with another Wise ID is likewise that transfer's.
    const tagged = { ...camtTx(2, LHV), description: "WISE:TRANSFER-123 To Wise" } as Transaction;
    expect(only(resolve({ rows: [newRow], existingTx: [tagged] }))).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [] },
    });
  });

  it("a stored WISE:{id}:<not a leg suffix> row is a distinct Wise ID and contests; a generated split-leg suffix does not", () => {
    const stored = (tag: string) => ({
      id: 502, status: "PROJECT", is_deleted: false, type: "D", amount: 100, cl_currencies_id: "EUR", date: "2026-06-01",
      accounts_dimensions_id: WISE, description: `${tag} Seppo AI OÜ [source_direction=IN]`,
    }) as unknown as Transaction;
    expect(only(resolve({ existingTx: [camtTx(1, LHV), stored("WISE:TRANSFER-1:B")] }))).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [1], contested: true },
    });
    expect(only(resolve({ existingTx: [camtTx(1, LHV), stored("WISE:TRANSFER-1:EUR")] }))).toEqual({ dim: LHV, basis: "evidence" });
  });

  it("execute re-check: the row's own just-created WISE:{legId} row (and its fee row) never competes", () => {
    const created = {
      id: 9001, status: "PROJECT", is_deleted: false, type: "D", amount: 100, cl_currencies_id: "EUR", date: "2026-06-01",
      accounts_dimensions_id: WISE, description: "WISE:TRANSFER-1 Seppo AI OÜ [source_direction=IN]",
    } as unknown as Transaction;
    expect(only(resolve({ existingTx: [camtTx(1, LHV), created] }))).toEqual({ dim: LHV, basis: "evidence" });
  });

  it("a stored Wise row in the other direction does not contest", () => {
    const outgoing = {
      id: 501, status: "CONFIRMED", is_deleted: false, type: "C", amount: 100, cl_currencies_id: "EUR", date: "2026-06-01",
      accounts_dimensions_id: WISE, description: "WISE:CARD-9 Shop [source_direction=OUT]",
    } as unknown as Transaction;
    expect(only(resolve({ existingTx: [camtTx(1, LHV), outgoing] }))).toEqual({ dim: LHV, basis: "evidence" });
  });
});

describe("resolveWiseRowCounterparts — review findings 0f4e518", () => {
  it("M1: a CONFIRMED evidence row whose registration journal is not in the snapshot is uncertain, never strong", () => {
    const confirmedNoJournal = { ...camtTx(1, LHV), status: "CONFIRMED" } as Transaction;
    expect(only(resolve({ existingTx: [confirmedNoJournal], journals: [] }))).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [1] },
    });
    // The same row unconfirmed (no journal expected) stays strong evidence.
    expect(only(resolve({ existingTx: [camtTx(1, LHV)], journals: [] }))).toEqual({ dim: LHV, basis: "evidence" });
  });

  it("N2: another statement row booked in a foreign currency never contests an EUR candidate by its nominal amount", () => {
    const eurRow = row("TRANSFER-EUR", { rowIndex: 0 });
    const usdRow = row("TRANSFER-USD", {
      rowIndex: 1, sourceCurrency: "USD", targetCurrency: "USD", sourceAmount: 100, targetAmount: 100,
    });
    expect(only(resolve({ rows: [eurRow], allRows: [eurRow, usdRow], existingTx: [camtTx(1, LHV)] }))).toEqual({ dim: LHV, basis: "evidence" });
    // An EUR row of the same amount still contests.
    const eurTwin = row("TRANSFER-EUR-2", { rowIndex: 1 });
    expect(only(resolve({ rows: [eurRow], allRows: [eurRow, eurTwin], existingTx: [camtTx(1, LHV)] }))).toEqual({
      hold: { code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [1], contested: true },
    });
  });
});

describe("wiseCounterpartHoldReview texts", () => {
  const review = (code: "wise_transfer_counterpart_conflict" | "wise_transfer_dimensions_unverified", evidence: number[]) =>
    wiseCounterpartHoldReview(row("TRANSFER-1"), { code, candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: evidence }, true, false).reason;

  it("unresolved without evidence says there is none; with inconclusive evidence it says what was found", () => {
    expect(review("wise_transfer_dimensions_unverified", [])).toMatch(/^No own-account evidence shows/);
    const inconclusive = review("wise_transfer_dimensions_unverified", [1]);
    expect(inconclusive).toMatch(/^Bank row\(s\) on another own bank may be this transfer \(evidence_transaction_ids\)/);
    expect(inconclusive).not.toContain("No own-account evidence");
  });

  it("a contested demotion says several Wise transfers could match the same bank rows", () => {
    const reason = wiseCounterpartHoldReview(row("TRANSFER-1"), {
      code: "wise_transfer_dimensions_unverified", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [1], contested: true,
    }, true, false).reason;
    expect(reason).toContain("several Wise transfers could match the same bank rows");
    expect(reason).not.toContain("cannot be proven");
  });

  it("a conflict lists only the evidence accounts as evidence and names the selected account separately", () => {
    const conflict = (hold: Partial<Parameters<typeof wiseCounterpartHoldReview>[1]>) => wiseCounterpartHoldReview(row("TRANSFER-1"), {
      code: "wise_transfer_counterpart_conflict", candidate_dimension_ids: [LHV, COOP], evidence_transaction_ids: [1], ...hold,
    }, true, false).reason;
    expect(conflict({ selected_dimension_id: LHV })).toMatch(/points to bank account\(s\) 30, not to 20 \(the selected inter_account_dimension_id or the only other bank account\)/);
    expect(conflict({})).toMatch(/points to several bank accounts \(20, 30\)/);
    // End to end: weak evidence on Coop with the explicit LHV.
    const weakCoop = camtTx(1, COOP, { iban: "EE999999999999999999", name: "Some Supplier OÜ" });
    const resolved = only(resolve({ existingTx: [weakCoop], explicit: LHV }));
    expect("hold" in resolved! && wiseCounterpartHoldReview(row("TRANSFER-1"), resolved.hold, true, false).reason).toContain("points to bank account(s) 30, not to 20");
  });
});

describe("isWiseCounterpartyName", () => {
  it("accepts Wise, TransferWise and a leading WISE token only", () => {
    for (const name of ["Wise", "TRANSFERWISE", "Wise Europe SA", " wise "]) expect(isWiseCounterpartyName(name), name).toBe(true);
    for (const name of ["Wisenheimer OÜ", "Otherwise Ltd", "", undefined]) expect(isWiseCounterpartyName(name), String(name)).toBe(false);
  });
});
