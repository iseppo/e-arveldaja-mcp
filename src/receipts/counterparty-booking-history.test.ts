import { describe, expect, it } from "vitest";
import type { Journal, Transaction } from "../types/api.js";
import { buildCounterpartyBookingHistory, lookupCounterpartyHistory } from "./counterparty-booking-history.js";

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
  it("(1) suggests only the most recent unbroken run: 5× 1410/901 then 3× 2110/900 → 2110/900, streak 3, total 8", () => {
    const index = history([
      ...[1, 2, 3, 4, 5].map((m) => ({ date: month(m), contra: [[1410, 901]] as Array<[number, number]> })),
      ...[6, 7, 8].map((m) => ({ date: month(m) })),
    ]);
    const result = lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "incoming" });
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
    });
  });

  it("(2) two recent rows are not enough: no suggestion, breakdown shown", () => {
    const index = history([{ date: month(1) }, { date: month(2) }]);
    const result = lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "incoming" });
    expect(result.suggestion).toBeUndefined();
    expect(result.history_total).toBe(2);
    expect(result.breakdown).toEqual([{ account_id: 2110, dimension_id: 900, count: 2 }]);
  });

  it("(3) a contra on another own bank dimension breaks the run", () => {
    const index = history([
      { date: month(1) }, { date: month(2) }, { date: month(3) },
      { date: month(4), contra: [[1020, 200]] },
    ]);
    expect(lookupCounterpartyHistory(index, { name: "Laenaja OÜ", direction: "incoming" }).suggestion).toBeUndefined();
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
