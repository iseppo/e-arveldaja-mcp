import { describe, expect, it } from "vitest";
import type { Journal, Transaction } from "../types/api.js";
import { buildCounterpartyBookingHistory, lookupCounterpartyHistory } from "./counterparty-booking-history.js";
import { buildCamtDescriptionWithMetadata, isCamtCounterpartyIbanOmitted } from "../camt/duplicate-identity.js";

// Anonymised: company "Näide OÜ", related company "Laenaja OÜ", own bank dims
// 100/200 on account 1020, loan dim 900 on account 2110, old treatment 1410/901.
const OWN_DIMS = new Set([100, 200]);

let nextId = 1000;

interface RowSpec {
  date: string;
  name?: string;
  iban?: string;
  dim?: number;
  /** The bank leg side: D = money in, C = money out. */
  side?: "D" | "C";
  /** Contra lines [account, dimension]; default one line to 2110/900. */
  contra?: Array<[number, number | null]>;
  /** Number of registered TRANSACTION journals joined to the row (default 1). */
  journals?: number;
  clients_id?: number;
}

function ledger(rows: RowSpec[]): { transactions: Transaction[]; journals: Journal[] } {
  const transactions: Transaction[] = [];
  const journals: Journal[] = [];
  for (const row of rows) {
    const id = ++nextId;
    const dim = row.dim ?? 100;
    transactions.push({
      id,
      status: "CONFIRMED",
      is_deleted: false,
      accounts_id: 1020,
      accounts_dimensions_id: dim,
      type: "C", // the live API reads every row back as "C": the side comes from the journal
      amount: 100,
      cl_currencies_id: "EUR",
      date: row.date,
      bank_account_name: row.name ?? "Laenaja OÜ",
      bank_account_no: row.iban ?? null,
      ...(row.clients_id !== undefined ? { clients_id: row.clients_id } : {}),
    });
    const side = row.side ?? "D";
    const contra = row.contra ?? [[2110, 900]];
    for (let index = 0; index < (row.journals ?? 1); index++) {
      journals.push({
        id: id * 10 + index,
        operation_type: "TRANSACTION",
        operations_id: id,
        registered: true,
        is_deleted: false,
        effective_date: row.date,
        postings: [
          { accounts_id: 1020, accounts_dimensions_id: dim, type: side, amount: 100, base_amount: 100, cl_currencies_id: "EUR" },
          ...contra.map(([account, contraDim]) => ({
            accounts_id: account,
            accounts_dimensions_id: contraDim,
            type: side === "D" ? "C" as const : "D" as const,
            amount: 100 / contra.length,
            base_amount: 100 / contra.length,
            cl_currencies_id: "EUR",
          })),
        ],
      });
    }
  }
  return { transactions, journals };
}

function history(rows: RowSpec[]) {
  return buildCounterpartyBookingHistory({ ...ledger(rows), ownBankDimensionIds: OWN_DIMS });
}

const month = (index: number) => `2026-${String(index).padStart(2, "0")}-15`;

describe("counterparty booking history — chronological streak", () => {
  it.each(["Laenaja", "Laenaja OÜ"])("C3 only allows legal-form name identity: %s", name => {
    const rows = ledger([1, 2, 3].map(m => ({ date: month(m), name })));
    for (const tx of rows.transactions) {
      const description = "a".repeat(60);
      tx.description = buildCamtDescriptionWithMetadata(description, {
        date: tx.date, amount: tx.amount, currency: "EUR", direction: "CRDT", counterparty_name: name,
        counterparty_iban: "EE471000001020145685", bank_reference: "2947447407B8F111BB4E0627B324E395",
        description,
      }, { omitCounterpartyIban: true });
      expect(isCamtCounterpartyIbanOmitted(tx)).toBe(true);
    }
    const index = buildCounterpartyBookingHistory({ ...rows, ownBankDimensionIds: OWN_DIMS });
    const result = lookupCounterpartyHistory(index, { name, direction: "incoming", accounts_dimensions_id: 100 });
    expect(result.history_total).toBe(name.endsWith("OÜ") ? 3 : 0);
    // Query-side omission has the same rule even against an IBAN-less row.
    const plain = history([1, 2, 3].map(m => ({ date: month(m), name })));
    expect(lookupCounterpartyHistory(plain, { name, iban_omitted: true, direction: "incoming", accounts_dimensions_id: 100 }).history_total).toBe(name.endsWith("OÜ") ? 3 : 0);
  });

  it("(1) suggests only the most recent unbroken run: 5× 1410/901 then 3× 2110/900 → 2110/900, streak 3, total 8", () => {
    const rows = ledger([
      ...[1, 2, 3, 4, 5].map((m) => ({ date: month(m), contra: [[1410, 901]] as Array<[number, number]> })),
      ...[6, 7, 8].map((m) => ({ date: month(m) })),
    ]);
    const index = buildCounterpartyBookingHistory({ ...rows, ownBankDimensionIds: OWN_DIMS });
    const result = lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "incoming" });
    const runJournals = rows.journals.slice(-3).map((journal) => journal.id!).reverse();
    expect(result.suggestion).toEqual({
      account_id: 2110,
      dimension_id: 900,
      streak: 3,
      history_total: 8,
      latest_date: month(8),
      breakdown: [
        { account_id: 1410, dimension_id: 901, count: 5 },
        { account_id: 2110, dimension_id: 900, count: 3 },
      ],
      // The newest run over a different past: a review hint, never consistent.
      consistent: false,
      last_journal_ids: runJournals,
    });
  });

  it("(2) two recent rows after a different past are not enough: no suggestion, breakdown shown", () => {
    const index = history([{ date: month(1), contra: [[1410, 901]] }, { date: month(2) }, { date: month(3) }]);
    const result = lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "incoming" });
    expect(result.suggestion).toBeUndefined();
    expect(result.history_total).toBe(3);
    expect(result.breakdown).toEqual([{ account_id: 2110, dimension_id: 900, count: 2 }, { account_id: 1410, dimension_id: 901, count: 1 }]);
  });

  it("(2b) two rows that are the whole history, booked alike, are a consistent suggestion; one row is not", () => {
    const pair = history([{ date: month(1) }, { date: month(2) }]);
    expect(lookupCounterpartyHistory(pair, { name: "Laenaja OÜ", direction: "incoming" }).suggestion).toMatchObject({
      account_id: 2110, dimension_id: 900, streak: 2, history_total: 2, consistent: true,
    });
    const single = history([{ date: month(1) }]);
    expect(lookupCounterpartyHistory(single, { name: "Laenaja OÜ", direction: "incoming" }).suggestion).toBeUndefined();
    // An invoice-linked row anywhere in the history makes it inconsistent.
    const withInvoice = history([{ date: month(1), contra: [[2310, null]] }, { date: month(2) }, { date: month(3) }, { date: month(4) }]);
    expect(lookupCounterpartyHistory(withInvoice, { name: "Laenaja OÜ", direction: "incoming" }).suggestion).toMatchObject({
      streak: 3, history_total: 4, consistent: false,
    });
  });

  it("(3) a contra on another own bank dimension breaks the run", () => {
    const index = history([
      { date: month(1) }, { date: month(2) }, { date: month(3) },
      { date: month(4), contra: [[1020, 200]] },
    ]);
    expect(lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "incoming" }).suggestion).toBeUndefined();
  });

  it("(3c) suggests an own-bank-dimension contra only when the caller allows it, and never on a name-only identity", () => {
    // Live shape: top-ups to a broker's pooled IBAN booked against the broker's own bank dimension.
    const topUp = (m: number, spec: Partial<RowSpec> = {}): RowSpec =>
      ({ date: month(m), name: "Maakler AS", iban: "DE25502109000222308186", side: "C", contra: [[1020, 200]], ...spec });
    const index = history([topUp(1), topUp(2), topUp(3)]);
    const query = { name: "Maakler AS", iban: "DE25502109000222308186", direction: "outgoing" as const, accounts_dimensions_id: 100 };
    expect(lookupCounterpartyHistory(index, query).suggestion).toBeUndefined();
    expect(lookupCounterpartyHistory(index, { ...query, allow_own_bank_contra: true }).suggestion).toEqual({
      account_id: 1020,
      dimension_id: 200,
      own_bank_account: true,
      streak: 3,
      history_total: 3,
      latest_date: month(3),
      breakdown: [{ account_id: 1020, dimension_id: 200, own_bank_account: true, count: 3 }],
      consistent: true,
      last_journal_ids: expect.any(Array),
    });

    // The same run under a bare display name (no IBAN, no legal form) is never enough.
    const bare = history([1, 2, 3].map((m) => topUp(m, { name: "Maakler", iban: undefined })));
    expect(lookupCounterpartyHistory(bare, { name: "Maakler", direction: "outgoing", accounts_dimensions_id: 100, allow_own_bank_contra: true }).suggestion).toBeUndefined();

    // A different contra in between still breaks the run.
    const mixed = history([topUp(1), topUp(2, { contra: [[2110, 900]] }), topUp(3), topUp(4)]);
    expect(lookupCounterpartyHistory(mixed, { ...query, allow_own_bank_contra: true }).suggestion).toBeUndefined();
  });

  it("(3b) never suggests an own-bank-dimension or invoice-ledger contra, however long its run", () => {
    for (const contra of [[1020, 200], [2310, null], [1210, null]] as Array<[number, number | null]>) {
      const index = history([1, 2, 3, 4].map((m) => ({ date: month(m), contra: [contra] })));
      const result = lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "incoming" });
      expect(result.suggestion).toBeUndefined();
      expect(result.history_total).toBe(4);
    }
  });

  it("(3d) an explicit invoice-ledger set excludes custom payable and receivable settlements", () => {
    const invoiceLedgerAccountIds = new Set([2310, 1210, 2991, 1991]);
    for (const [side, account, direction] of [["C", 2991, "outgoing"], ["D", 1991, "incoming"]] as const) {
      const index = buildCounterpartyBookingHistory({
        ...ledger([1, 2].map(m => ({ date: month(m), side, contra: [[account, null]] }))),
        ownBankDimensionIds: OWN_DIMS,
        invoiceLedgerAccountIds,
      });
      const result = lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction });
      expect(result.history_total).toBe(2);
      expect(result.breakdown).toEqual([]);
      expect(result.suggestion).toBeUndefined();
    }
  });

  it("(4) keeps directions separate", () => {
    const index = history([
      { date: month(1) }, { date: month(2) }, { date: month(3) },
      { date: month(4), side: "C", contra: [[1410, 901]] },
    ]);
    expect(lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "incoming" }).suggestion?.account_id).toBe(2110);
    const outgoing = lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "outgoing" });
    expect(outgoing.suggestion).toBeUndefined();
    expect(outgoing.history_total).toBe(1);
  });

  it("(5) takes the side from the journal's bank leg, not the stored type (always C)", () => {
    const index = history([1, 2, 3].map((m) => ({ date: month(m), side: "C" as const })));
    expect(lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "outgoing" }).suggestion?.streak).toBe(3);
    expect(lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "incoming" }).history_total).toBe(0);
  });

  it("(6) excludes a history row whose stored IBAN differs from the query's", () => {
    const index = history([1, 2, 3].map((m) => ({ date: month(m), iban: "EE111111111111111111" })));
    const result = lookupCounterpartyHistory(index, { name: "Laenaja OÜ", iban: "EE222222222222222222", direction: "incoming" });
    expect(result.history_total).toBe(0);
    expect(result.suggestion).toBeUndefined();
  });

  it("(7) filter-after-streak trap: 3× 2110/900 then a newest row to the invoice ledger 2310 → no suggestion", () => {
    const index = history([
      { date: month(1) }, { date: month(2) }, { date: month(3) },
      { date: month(4), contra: [[2310, null]] },
    ]);
    const result = lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "incoming" });
    expect(result.suggestion).toBeUndefined();
    expect(result.history_total).toBe(4);
  });

  it("(8) a newest split booking → no suggestion", () => {
    const index = history([
      { date: month(1) }, { date: month(2) }, { date: month(3) },
      { date: month(4), contra: [[2110, 900], [1410, 901]] },
    ]);
    expect(lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "incoming" }).suggestion).toBeUndefined();
  });

  it("(8b) a newest row with an ambiguous journal join (none, or two) → no suggestion", () => {
    for (const journals of [0, 2]) {
      const index = history([
        { date: month(1) }, { date: month(2) }, { date: month(3) },
        { date: month(4), journals },
      ]);
      expect(lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "incoming" }).suggestion).toBeUndefined();
    }
  });

  it("(9) 5× 1410 then 1× 2110 → no suggestion (the old account is suppressed after a change of treatment)", () => {
    const index = history([
      ...[1, 2, 3, 4, 5].map((m) => ({ date: month(m), contra: [[1410, 901]] as Array<[number, number]> })),
      { date: month(6) },
    ]);
    expect(lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "incoming" }).suggestion).toBeUndefined();
  });

  it("sorts by date then id before walking, whatever the input order", () => {
    const { transactions, journals } = ledger([
      { date: month(1) }, { date: month(2) }, { date: month(3) },
      { date: month(4), contra: [[2310, null]] },
    ]);
    const index = buildCounterpartyBookingHistory({
      transactions: [...transactions].reverse(),
      journals: [...journals].reverse(),
      ownBankDimensionIds: OWN_DIMS,
    });
    expect(lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "incoming" }).suggestion).toBeUndefined();
  });
});

describe("counterparty booking history — identity", () => {
  it("(10) 'Laenaja OÜ' history without IBANs does not answer for 'Laenaja AS'", () => {
    const index = history([1, 2, 3].map((m) => ({ date: month(m) })));
    const result = lookupCounterpartyHistory(index, { name: "Laenaja AS", direction: "incoming" });
    expect(result.suggestion).toBeUndefined();
    expect(result.history_total).toBe(0);
  });

  it("(11) 'Laenaja OU' and 'Laenaja OÜ' share one history", () => {
    const index = history([
      { date: month(1), name: "Laenaja OU" },
      { date: month(2), name: "LAENAJA OÜ" },
      { date: month(3), name: "Laenaja OÜ" },
    ]);
    expect(lookupCounterpartyHistory(index, { name: "Laenaja OU", direction: "incoming" }).suggestion?.streak).toBe(3);
  });

  it("(12) a name without a legal form needs matching IBANs: differing or missing IBANs are excluded", () => {
    const index = history([
      { date: month(1), name: "Mari Maasikas", iban: "EE111111111111111111" },
      { date: month(2), name: "Mari Maasikas", iban: "EE111111111111111111" },
      { date: month(3), name: "Mari Maasikas" },
    ]);
    expect(lookupCounterpartyHistory(index, { name: "Mari Maasikas", iban: "EE999999999999999999", direction: "incoming" }).history_total).toBe(0);
    expect(lookupCounterpartyHistory(index, { name: "Mari Maasikas", direction: "incoming" }).history_total).toBe(0);
    expect(lookupCounterpartyHistory(index, { name: "Mari Maasikas", iban: "EE111111111111111111", direction: "incoming" }).history_total).toBe(2);
  });

  it("(13) history_total counts rows on both own bank dimensions 100 and 200", () => {
    const index = history([
      { date: month(1), dim: 100 },
      { date: month(2), dim: 200 },
      { date: month(3), dim: 100 },
      { date: month(4), dim: 200 },
    ]);
    const result = lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "incoming" });
    expect(result.history_total).toBe(4);
    expect(result.suggestion?.streak).toBe(4);
  });

  it("an unknown direction never yields history", () => {
    const index = history([1, 2, 3].map((m) => ({ date: month(m) })));
    expect(lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "unknown" }).suggestion).toBeUndefined();
  });
});

describe("counterparty booking history — name-only identity (A4)", () => {
  // Live shape: a Wise fee row "TransferWise", outgoing, no IBAN, no legal form,
  // previously booked to 8610 with a dimension on the same own bank dimension.
  const fee = (m: number, spec: Partial<RowSpec> = {}): RowSpec =>
    ({ date: month(m), name: "TransferWise", side: "C", contra: [[8610, 950]], ...spec });

  it("suggests the run for an exact name on the same own bank dimension, marked name_only", () => {
    const index = history([fee(1), fee(2, { name: "transferwise" }), fee(3, { name: " TransferWise " })]);
    const result = lookupCounterpartyHistory(index, { name: "TransferWise", accounts_dimensions_id: 100, direction: "outgoing" });
    expect(result.suggestion).toMatchObject({ account_id: 8610, dimension_id: 950, streak: 3, history_total: 3, identity: "name_only" });
  });

  it("needs the query's own bank dimension: missing or different → no match", () => {
    const index = history([fee(1), fee(2), fee(3)]);
    expect(lookupCounterpartyHistory(index, { name: "TransferWise", direction: "outgoing" }).history_total).toBe(0);
    expect(lookupCounterpartyHistory(index, { name: "TransferWise", accounts_dimensions_id: 200, direction: "outgoing" }).history_total).toBe(0);
  });

  it("does not count rows on another own bank dimension toward the streak", () => {
    const index = history([fee(1), fee(2, { dim: 200 }), fee(3)]);
    const result = lookupCounterpartyHistory(index, { name: "TransferWise", accounts_dimensions_id: 100, direction: "outgoing" });
    expect(result.history_total).toBe(2);
    expect(result.suggestion).toBeUndefined();
  });

  it("names that differ beyond case and whitespace do not match, even with the same history key", () => {
    const index = history([fee(1, { name: "Transfer-Wise" }), fee(2, { name: "Transfer Wise" }), fee(3, { name: "Transfer.Wise" })]);
    const result = lookupCounterpartyHistory(index, { name: "Transfer Wise", accounts_dimensions_id: 100, direction: "outgoing" });
    expect(result.history_total).toBe(1);
    expect(result.suggestion).toBeUndefined();
  });

  it("an IBAN on either side keeps the IBAN rule", () => {
    const withIban = history([fee(1, { iban: "EE111111111111111111" }), fee(2, { iban: "EE111111111111111111" }), fee(3, { iban: "EE111111111111111111" })]);
    expect(lookupCounterpartyHistory(withIban, { name: "TransferWise", accounts_dimensions_id: 100, direction: "outgoing" }).history_total).toBe(0);
    const withoutIban = history([fee(1), fee(2), fee(3)]);
    expect(lookupCounterpartyHistory(withoutIban, {
      name: "TransferWise", iban: "EE111111111111111111", accounts_dimensions_id: 100, direction: "outgoing",
    }).history_total).toBe(0);
    // A matching IBAN still matches, and is not marked name-only.
    const matched = lookupCounterpartyHistory(withIban, {
      name: "TransferWise", iban: "EE111111111111111111", accounts_dimensions_id: 100, direction: "outgoing",
    }).suggestion;
    expect(matched?.streak).toBe(3);
    expect(matched?.identity).toBeUndefined();
  });

  it("a legal-form name on either side never matches by name only", () => {
    const plain = history([fee(1, { name: "Laenaja" }), fee(2, { name: "Laenaja" }), fee(3, { name: "Laenaja" })]);
    expect(lookupCounterpartyHistory(plain, { name: "Laenaja OÜ", accounts_dimensions_id: 100, direction: "outgoing" }).history_total).toBe(0);
    const formed = history([fee(1, { name: "Laenaja OÜ" }), fee(2, { name: "Laenaja OÜ" }), fee(3, { name: "Laenaja OÜ" })]);
    expect(lookupCounterpartyHistory(formed, { name: "Laenaja", accounts_dimensions_id: 100, direction: "outgoing" }).history_total).toBe(0);
    // Two legal-form names keep the legal-person rule, not marked name-only.
    const legal = lookupCounterpartyHistory(formed, { name: "Laenaja OÜ", accounts_dimensions_id: 100, direction: "outgoing" }).suggestion;
    expect(legal?.streak).toBe(3);
    expect(legal?.identity).toBeUndefined();
  });

  it("still requires MIN_STREAK", () => {
    const index = history([fee(1), fee(2)]);
    const result = lookupCounterpartyHistory(index, { name: "TransferWise", accounts_dimensions_id: 100, direction: "outgoing" });
    expect(result.history_total).toBe(2);
    expect(result.suggestion).toBeUndefined();
  });
});

describe("counterparty booking history — client identity", () => {
  // Live shape: a person without legal form whose older rows carry no IBAN,
  // while the new CAMT row has one; both rows are linked to the same client.
  const kassa = (m: number, spec: Partial<RowSpec> = {}): RowSpec =>
    ({ date: month(m), name: "Mari Maasikas", side: "C", contra: [[1010, 391]], clients_id: 77, ...spec });

  it("matches the query's client across IBAN-less rows, name spellings and own bank dimensions, with evidence", () => {
    const rows = ledger([kassa(1), kassa(2, { name: "MARI MAASIKAS", dim: 200 }), kassa(3, { name: "Maasikas Mari" })]);
    const index = buildCounterpartyBookingHistory({ ...rows, ownBankDimensionIds: OWN_DIMS });
    const query = { name: "Mari Maasikas", iban: "EE947700771000826270", clients_id: 77, accounts_dimensions_id: 100, direction: "outgoing" as const };
    const result = lookupCounterpartyHistory(index, query);
    expect(result.history_total).toBe(3);
    expect(result.suggestion).toEqual({
      account_id: 1010, dimension_id: 391, streak: 3, history_total: 3, latest_date: month(3),
      breakdown: [{ account_id: 1010, dimension_id: 391, count: 3 }],
      consistent: true,
      clients_id: 77,
      last_journal_ids: rows.journals.map((journal) => journal.id!).reverse(),
    });
    // Without the client the same rows do not answer (no IBAN on the history rows).
    expect(lookupCounterpartyHistory(index, { ...query, clients_id: undefined }).history_total).toBe(0);
  });

  it("never matches rows of another client, nor rows whose stored IBAN differs", () => {
    const index = history([
      kassa(1, { clients_id: 78 }),
      kassa(2, { iban: "EE111111111111111111" }),
      kassa(3),
      kassa(4),
    ]);
    const result = lookupCounterpartyHistory(index, {
      name: "Mari Maasikas", iban: "EE947700771000826270", clients_id: 77, accounts_dimensions_id: 100, direction: "outgoing",
    });
    expect(result.history_total).toBe(2);
    expect(result.suggestion).toMatchObject({ streak: 2, consistent: true, clients_id: 77 });
  });

  it("a client on the query never vouches for client-less rows matched by name: the suggestion is name_only", () => {
    const query = { name: "Mari Maasikas", clients_id: 77, accounts_dimensions_id: 100, direction: "outgoing" as const };
    const byName = history([kassa(1, { clients_id: undefined }), kassa(2, { clients_id: undefined })]);
    // Two consistent name-only rows are below MIN_STREAK: no suggestion at all.
    expect(lookupCounterpartyHistory(byName, query)).toMatchObject({ history_total: 2 });
    expect(lookupCounterpartyHistory(byName, query).suggestion).toBeUndefined();
    // One name-only row among client rows taints the whole history.
    const mixed = history([kassa(1, { clients_id: undefined }), kassa(2), kassa(3)]);
    expect(lookupCounterpartyHistory(mixed, query).suggestion).toMatchObject({ streak: 3, consistent: true, identity: "name_only" });
    // Client rows only: strong evidence, no identity flag.
    const linked = history([kassa(1), kassa(2)]);
    expect(lookupCounterpartyHistory(linked, query).suggestion).toMatchObject({ streak: 2, consistent: true, clients_id: 77 });
    expect(lookupCounterpartyHistory(linked, query).suggestion?.identity).toBeUndefined();
  });

  it("a mixed client history stays a review hint with the split", () => {
    const index = history([kassa(1, { contra: [[2110, 384]] }), kassa(2), kassa(3), kassa(4)]);
    const result = lookupCounterpartyHistory(index, { name: "Mari Maasikas", clients_id: 77, direction: "outgoing" });
    expect(result.suggestion).toMatchObject({ account_id: 1010, streak: 3, history_total: 4, consistent: false });
    expect(result.breakdown).toEqual([{ account_id: 1010, dimension_id: 391, count: 3 }, { account_id: 2110, dimension_id: 384, count: 1 }]);
  });
});
