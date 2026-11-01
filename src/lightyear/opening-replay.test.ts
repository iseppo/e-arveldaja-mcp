import { describe, expect, it } from "vitest";
import { parseLightyearRowsForTest } from "../__fixtures__/lightyear-rows.js";
import { replayUsdOpening } from "./usd-pool.js";
import { openingReplayRowsForTesting, statementRowCashDeltaForTesting } from "../tools/lightyear-investments.js";

const FUND = new Set(["ICSUSSDP"]);
const END = Date.parse("2026-12-31T23:59:59Z") / 1000;

function replay(rows: string[][]) {
  return replayUsdOpening(openingReplayRowsForTesting(parseLightyearRowsForTest(rows)), END, FUND);
}

// Plan Q1 / D1: a USD→EUR conversion takes its gross (fee included) out of the USD balance.
const FUND_IN = [
  ["10/04/2026 09:00:00", "CN-TESTQ1IN", "", "", "Conversion", "0", "EUR", "0", "-171.10", "1.17", "0", "-171.10", "0"],
  ["10/04/2026 09:00:00", "CN-TESTQ1IN", "", "", "Conversion", "0", "USD", "0", "200.18", "0.85", "0", "200.18", "0"],
  ["10/04/2026 09:00:05", "OR-TESTQ1SW1", "ICSUSSDP", "IE00B44QSF52", "Buy", "200.18", "USD", "1", "200.18", "0", "0", "200.18", "0"],
];
const FUND_OUT = [
  ["12/04/2026 20:34:12", "OR-TESTQ1SW2", "ICSUSSDP", "IE00B44QSF52", "Sell", "200.18", "USD", "1", "200.18", "0", "0", "200.18", "0"],
  ["12/04/2026 20:35:07", "CN-TESTQ1OUT", "", "", "Conversion", "0", "USD", "0", "-200.18", "0.85", "0.70", "-199.48", "0"],
  ["12/04/2026 20:35:07", "CN-TESTQ1OUT", "", "", "Conversion", "0", "EUR", "0", "170.12", "1.17", "0", "170.12", "0"],
];

describe("opening replay uses the statement cash rule (plan Q1, D1)", () => {
  it("fund sell 200.18 then conversion −200.18 / fee 0.70 / net −199.48 leaves 0.00 USD (not 0.70)", () => {
    expect(replay([...FUND_IN, ...FUND_OUT])).toEqual({ ok: true, value: expect.objectContaining({ usd_cents: 0, cash_cents: 0, fund_units_cents: 0 }) });
  });

  it("an EUR→USD conversion with its fee on the EUR leg adds the USD net", () => {
    const rows = [
      ["10/04/2026 09:00:00", "CN-TESTQ1FE", "", "", "Conversion", "0", "EUR", "0", "-86.00", "1.17", "0.30", "-85.70", "0"],
      ["10/04/2026 09:00:00", "CN-TESTQ1FE", "", "", "Conversion", "0", "USD", "0", "100.00", "0.857", "0", "100.00", "0"],
    ];
    expect(replay(rows)).toMatchObject({ ok: true, value: { usd_cents: 10000, cash_cents: 10000 } });
  });

  it("a sell adds its net and a buy subtracts its gross", () => {
    const rows = [
      ["10/04/2026 09:00:00", "CN-TESTQ1B", "", "", "Conversion", "0", "USD", "0", "500.00", "0.857", "0", "500.00", "0"],
      ["10/04/2026 10:00:00", "OR-TESTQ1S", "AMD", "US0079031078", "Sell", "1", "USD", "100", "100.00", "0", "0.10", "99.90", "0"],
      ["10/04/2026 11:00:00", "OR-TESTQ1BY", "AMD", "US0079031078", "Buy", "1", "USD", "199.90", "200.00", "0", "0.10", "199.90", "0"],
    ];
    expect(replay(rows)).toMatchObject({ ok: true, value: { usd_cents: 50000 + 9990 - 20000 } });
  });

  it("0.37 USD already held before the statement and drained by a −0.37 conversion is unproven from empty (OQ1)", () => {
    const rows = [
      ["13/01/2026 10:00:00", "CN-TESTQ1Z", "", "", "Conversion", "0", "USD", "0", "-0.37", "0.84", "0", "-0.37", "0"],
      ["13/01/2026 10:00:00", "CN-TESTQ1Z", "", "", "Conversion", "0", "EUR", "0", "0.31", "1.19", "0", "0.31", "0"],
    ];
    expect(replay(rows)).toMatchObject({ ok: false, code: "usd_pool_opening_replay_unproven" });
  });

  it("the opening replay and the statement cash rule agree on a 50-row random fixture", () => {
    let seed = 4242;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const types = ["Buy", "Sell", "Conversion", "Deposit", "Withdrawal", "Dividend", "Distribution", "Interest", "Reward"];
    const rows: string[][] = [];
    for (let i = 0; i < 50; i++) {
      const type = types[Math.floor(random() * types.length)]!;
      const gross = (Math.floor(random() * 100000) / 100).toFixed(2);
      const fee = (Math.floor(random() * 300) / 100).toFixed(2);
      const sign = type === "Withdrawal" || (type === "Conversion" && random() < 0.5) ? "-" : "";
      const net = (Number(gross) - Number(fee)).toFixed(2);
      rows.push([`${String(1 + (i % 28)).padStart(2, "0")}/05/2026 10:00:${String(i % 60).padStart(2, "0")}`, `XX-TESTR${i}`, "AMD", "", type, "1", random() < 0.5 ? "USD" : "EUR", "1", `${sign}${gross}`, "0", fee, `${sign}${net}`, "0"]);
    }
    const parsed = parseLightyearRowsForTest(rows);
    const replayRows = openingReplayRowsForTesting(parsed);
    expect(replayRows.map(row => row.cash_delta)).toEqual(parsed.map(row => statementRowCashDeltaForTesting(row)?.amount ?? null));
  });
});
