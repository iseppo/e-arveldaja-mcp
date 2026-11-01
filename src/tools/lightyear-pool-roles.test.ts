import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFileInput } from "../file-validation.js";
import { readFileCapped } from "../bounded-read.js";
import { lightyearStatementCsv, parseLightyearRowsForTest } from "../__fixtures__/lightyear-rows.js";
import {
  POOL_STATEMENT_PATH,
  poolDistribution,
  poolJournal,
  poolOpening,
  setupPoolTool,
} from "../__fixtures__/lightyear-pool-harness.js";
import { classifyLightyearStatementPool, type LightyearTradesPayload } from "./lightyear-investments.js";

vi.mock("../bounded-read.js", async () => {
  const actual = await vi.importActual<typeof import("../bounded-read.js")>("../bounded-read.js");
  return { ...actual, readFileCapped: vi.fn() };
});
vi.mock("../file-validation.js", () => ({ resolveFileInput: vi.fn() }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

const mockedReadFileCapped = vi.mocked(readFileCapped);
const mockedResolveFileInput = vi.mocked(resolveFileInput);
const FUND = new Set(["ICSUSSDP"]);

function load(rows: string[][]): void {
  mockedReadFileCapped.mockResolvedValue(Buffer.from(lightyearStatementCsv(rows), "utf8"));
}

/** Pool roles keyed by reference + currency (stable under row shuffles); asserts one role per USD row. */
function roles(rows: string[][], fundingTickers: ReadonlySet<string> = FUND): Map<string, string> {
  const parsed = parseLightyearRowsForTest(rows);
  const { events } = classifyLightyearStatementPool(parsed, fundingTickers);
  const usdRows = parsed.filter(row => row.ccy === "USD");
  expect(events.map(event => event.row_index).sort((a, b) => a - b)).toEqual(usdRows.map(row => row.row_index));
  return new Map(events.map(event => [event.ref, event.role]));
}

function assignments(rows: string[][]): Record<string, string | null> {
  const { trades } = classifyLightyearStatementPool(parseLightyearRowsForTest(rows), FUND);
  return Object.fromEntries(trades.trades.map(trade => [trade.reference, trade.conversion_ref]));
}

function tradesTool(options: Parameters<typeof setupPoolTool>[2] = {}) {
  return setupPoolTool<LightyearTradesPayload>("book_lightyear_trades", { investment_account: 1550, broker_account: 1120 }, options);
}

function reviewCode(payload: LightyearTradesPayload, reference: string): string | undefined {
  const text = (payload.warnings ?? []).find(warning => warning.includes(reference));
  return text ? /FX review \[([a-z_]+)\]/.exec(text)?.[1] : undefined;
}

const buy = (ts: string, ref: string, gross: string, fee = "0"): string[] =>
  [ts, ref, "AMD", "US0079031078", "Buy", "1", "USD", "1", gross, "0", fee, (Number(gross) - Number(fee)).toFixed(2), "0"];
const sell = (ts: string, ref: string, gross: string, fee: string): string[] =>
  [ts, ref, "AMD", "US0079031078", "Sell", "1", "USD", "1", gross, "0", fee, (Number(gross) - Number(fee)).toFixed(2), "0"];
/** EUR→USD conversion: EUR leg −eurGross (fee on the EUR leg), USD leg +usd. */
const convIn = (ts: string, ref: string, usd: string, eurGross: string, eurFee = "0"): string[][] => {
  const eurNet = (Number(eurGross) - Number(eurFee)).toFixed(2);
  return [
    [ts, ref, "", "", "Conversion", "0", "EUR", "0", `-${eurGross}`, String(Number(usd) / Number(eurNet)), eurFee, `-${eurNet}`, "0"],
    [ts, ref, "", "", "Conversion", "0", "USD", "0", usd, String(Number(eurNet) / Number(usd)), "0", usd, "0"],
  ];
};
/** USD→EUR conversion: USD leg −usdGross (fee on the USD leg), EUR leg +eur. */
const convOut = (ts: string, ref: string, usdGross: string, usdFee: string, eur: string): string[][] => {
  const usdNet = (Number(usdGross) - Number(usdFee)).toFixed(2);
  return [
    [ts, ref, "", "", "Conversion", "0", "USD", "0", `-${usdGross}`, String(Number(eur) / Number(usdNet)), usdFee, `-${usdNet}`, "0"],
    [ts, ref, "", "", "Conversion", "0", "EUR", "0", eur, String(Number(usdNet) / Number(eur)), "0", eur, "0"],
  ];
};
const fundSell = (ts: string, ref: string, usd: string, price = "1", fee = "0"): string[] =>
  [ts, ref, "ICSUSSDP", "IE00B44QSF52", "Sell", usd, "USD", price, usd, "0", fee, (Number(usd) - Number(fee)).toFixed(2), "0"];

describe("USD pool roles: order-independent 1:1 pairing and complete classification (plan Q2)", () => {
  beforeEach(() => {
    mockedResolveFileInput.mockResolvedValue({ path: POOL_STATEMENT_PATH });
    mockedReadFileCapped.mockReset();
  });

  it("tie-break: two 114.96 USD buys pair with the conversion of their own timestamp and book the 1:1 shape", async () => {
    const rows = [
      buy("08/06/2026 14:29:35", "OR-TESTTIE001", "114.96", "0.11"),
      ...convIn("08/06/2026 14:29:35", "CN-TESTTIE001", "114.96", "100.00", "0.35"),
      buy("08/06/2026 15:37:20", "OR-TESTTIE002", "114.96", "0.11"),
      ...convIn("08/06/2026 15:37:20", "CN-TESTTIE002", "114.96", "100.00", "0.35"),
    ];
    expect(assignments(rows)).toEqual({ "OR-TESTTIE001": "CN-TESTTIE001", "OR-TESTTIE002": "CN-TESTTIE002" });
    expect([...roles(rows).values()]).toEqual(["pass_through", "pass_through", "pass_through", "pass_through"]);
    load(rows);
    const env = tradesTool();
    const { exec } = await env.book();
    expect(exec.result.isError).toBeFalsy();
    expect(env.created.map(journal => journal.postings)).toEqual([0, 1].map(() => [
      { accounts_id: 1550, type: "D", amount: 99.55 },
      { accounts_id: 8335, type: "D", amount: 0.35 },
      { accounts_id: 8335, type: "D", amount: 0.1 },
      { accounts_id: 1120, type: "C", amount: 100 },
    ]));
  });

  it("D2: a fund sell never consumes a USD→EUR conversion — the conversion is conversion_out, the sell a sweep", () => {
    const rows = [fundSell("12/04/2026 20:34:12", "OR-TESTD2SW", "200.18"), ...convOut("12/04/2026 20:35:07", "CN-TESTD2", "200.18", "0.70", "170.12")];
    expect(roles(rows)).toEqual(new Map([["OR-TESTD2SW", "sweep"], ["CN-TESTD2", "conversion_out"]]));
  });

  it("two candidate conversions both within 60 s of two buys → both buys invalid_conversion_pair, neither pool-funded", async () => {
    const rows = [
      buy("19/10/2026 10:00:00", "OR-TESTAMB01", "100.00"),
      buy("19/10/2026 10:00:30", "OR-TESTAMB02", "100.00"),
      ...convIn("19/10/2026 10:00:10", "CN-TESTAMB01", "100.00", "90.00"),
      ...convIn("19/10/2026 10:00:20", "CN-TESTAMB02", "100.00", "80.00"),
    ];
    expect(new Set(roles(rows).values())).toEqual(new Set(["pairing_ambiguous"]));
    load(rows);
    const dry = await tradesTool({ pool: [poolOpening(10000, 9000, "1.1111111111")] }).run({ dry_run: true });
    for (const ref of ["OR-TESTAMB01", "OR-TESTAMB02"]) {
      expect(reviewCode(dry.payload, ref)).toBe("invalid_conversion_pair");
      expect(dry.payload.results.find(row => String(row.reference).includes(ref))).toMatchObject({ status: "skipped" });
    }
    expect(dry.payload.created).toBe(0);
  });

  it("Codex r1 #1: buys 10:00 / 10:00:30, conversions 10:00:20 (€90) / 17:00 (€80) → ambiguous; no €80 buy", async () => {
    const rows = [
      buy("19/10/2026 10:00:00", "OR-TESTCDX01", "100.00"),
      buy("19/10/2026 10:00:30", "OR-TESTCDX02", "100.00"),
      ...convIn("19/10/2026 10:00:20", "CN-TESTCDX01", "100.00", "90.00"),
      ...convIn("19/10/2026 17:00:00", "CN-TESTCDX02", "100.00", "80.00"),
    ];
    expect(roles(rows)).toEqual(new Map([
      ["OR-TESTCDX01", "pairing_ambiguous"], ["OR-TESTCDX02", "pairing_ambiguous"],
      ["CN-TESTCDX01", "pairing_ambiguous"], ["CN-TESTCDX02", "pairing_ambiguous"],
    ]));
    load(rows);
    const env = tradesTool();
    const dry = await env.run({ dry_run: true });
    expect(reviewCode(dry.payload, "OR-TESTCDX01")).toBe("invalid_conversion_pair");
    expect(reviewCode(dry.payload, "OR-TESTCDX02")).toBe("invalid_conversion_pair");
    expect(dry.payload.results.some(row => row.eur_amount === 80)).toBe(false);
  });

  it("2 buys + 1 conversion of the same amount, conversion ≥ 60 s from both → ambiguous, no pool fall-through", () => {
    const rows = [
      buy("19/10/2026 10:00:00", "OR-TESTTWO01", "50.00"),
      buy("19/10/2026 10:00:05", "OR-TESTTWO02", "50.00"),
      ...convIn("19/10/2026 10:05:00", "CN-TESTTWO", "50.00", "45.00"),
    ];
    expect(new Set(roles(rows).values())).toEqual(new Set(["pairing_ambiguous"]));
  });

  it("a distant 1:1 pair still pairs; an extra same-amount conversion next to two near pairs is ambiguous, not conversion_out", () => {
    expect(assignments([buy("19/10/2026 09:00:00", "OR-TESTFAR01", "70.00"), ...convIn("19/10/2026 14:00:00", "CN-TESTFAR01", "70.00", "60.00")]))
      .toEqual({ "OR-TESTFAR01": "CN-TESTFAR01" });
    const rows = [
      buy("19/10/2026 10:00:00", "OR-TESTEXT01", "70.00"),
      ...convIn("19/10/2026 10:00:00", "CN-TESTEXT01", "70.00", "60.00"),
      buy("19/10/2026 11:00:00", "OR-TESTEXT02", "70.00"),
      ...convIn("19/10/2026 11:00:00", "CN-TESTEXT02", "70.00", "60.00"),
      ...convIn("19/10/2026 16:00:00", "CN-TESTEXT03", "70.00", "60.00"),
    ];
    expect(assignments(rows)).toEqual({ "OR-TESTEXT01": "CN-TESTEXT01", "OR-TESTEXT02": "CN-TESTEXT02" });
    expect(roles(rows).get("CN-TESTEXT03")).toBe("pairing_ambiguous");
  });

  it.each([["newest first", true], ["oldest first", false]])("D4 (%s): the 13:40:58 sell takes the 13:41:27 conversion, the 16:39:20 sell is sell_in", (_label, newestFirst) => {
    const early = sell("22/04/2026 13:40:58", "OR-TESTD4E", "100.00", "0.10");
    const late = sell("22/04/2026 16:39:20", "OR-TESTD4L", "100.00", "0.10");
    const conversion = convOut("22/04/2026 13:41:27", "CN-TESTD4", "99.90", "0", "85.00");
    const rows = newestFirst ? [late, ...conversion, early] : [early, ...conversion, late];
    expect(assignments(rows)).toEqual({ "OR-TESTD4E": "CN-TESTD4", "OR-TESTD4L": null });
    expect(roles(rows)).toEqual(new Map([["OR-TESTD4E", "pass_through"], ["CN-TESTD4", "pass_through"], ["OR-TESTD4L", "sell_in"]]));
  });

  it("assignment and roles are independent of row order (all 720 orders of a 6-node group, 50 shuffles of a full fixture)", () => {
    const group = [
      buy("08/06/2026 14:29:35", "OR-TESTPRM01", "114.96", "0.11"),
      buy("08/06/2026 15:37:20", "OR-TESTPRM02", "114.96", "0.11"),
      buy("08/06/2026 18:00:00", "OR-TESTPRM03", "114.96", "0.11"),
      ...convIn("08/06/2026 14:29:35", "CN-TESTPRM01", "114.96", "100.00", "0.35"),
      ...convIn("08/06/2026 15:37:20", "CN-TESTPRM02", "114.96", "100.00", "0.35"),
      ...convIn("08/06/2026 18:00:40", "CN-TESTPRM03", "114.96", "100.00", "0.35"),
    ];
    // Six nodes: three buys and three conversions (each conversion's two legs stay together).
    const nodes = [[group[0]!], [group[1]!], [group[2]!], group.slice(3, 5), group.slice(5, 7), group.slice(7, 9)];
    const expectedAssignments = assignments(group);
    const expectedRoles = roles(group);
    expect(expectedAssignments).toEqual({ "OR-TESTPRM01": "CN-TESTPRM01", "OR-TESTPRM02": "CN-TESTPRM02", "OR-TESTPRM03": "CN-TESTPRM03" });
    const permutations = (items: number[]): number[][] => items.length <= 1 ? [items]
      : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]));
    const orders = permutations([0, 1, 2, 3, 4, 5]);
    expect(orders).toHaveLength(720);
    for (const order of orders) {
      const rows = order.flatMap(i => nodes[i]!);
      expect(assignments(rows)).toEqual(expectedAssignments);
      expect(roles(rows)).toEqual(expectedRoles);
    }
    const full = [
      ...group,
      sell("22/04/2026 13:40:58", "OR-TESTPRM10", "100.00", "0.10"),
      sell("22/04/2026 16:39:20", "OR-TESTPRM11", "100.00", "0.10"),
      ...convOut("22/04/2026 13:41:27", "CN-TESTPRM10", "99.90", "0", "85.00"),
      fundSell("12/04/2026 20:34:12", "OR-TESTPRM12", "200.18"),
      ...convOut("12/04/2026 20:35:07", "CN-TESTPRM12", "200.18", "0.70", "170.12"),
      ["12/06/2026 10:00:00", "DD-TESTPRM13", "AMD", "US0079031078", "Dividend", "0", "USD", "0", "0.70", "0", "0", "0.60", "0.10"],
    ];
    const fullAssignments = assignments(full);
    const fullRoles = roles(full);
    let seed = 99;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 50; i++) {
      const shuffled = [...full].map(row => ({ row, key: random() })).sort((a, b) => a.key - b.key).map(entry => entry.row);
      expect(assignments(shuffled)).toEqual(fullAssignments);
      expect(roles(shuffled)).toEqual(fullRoles);
    }
  });

  it("USD deposit / withdrawal and an EUR→USD conversion with no trade are unsupported; USD interest with no conversion is distribution_in", () => {
    expect(roles([
      ["01/05/2026 10:00:00", "DT-TESTDEP", "", "", "Deposit", "0", "USD", "0", "10.00", "0", "0", "10.00", "0"],
      ["02/05/2026 10:00:00", "WL-TESTWDR", "", "", "Withdrawal", "0", "USD", "0", "-10.00", "0", "0", "-10.00", "0"],
      ...convIn("03/05/2026 10:00:00", "CN-TESTINONLY", "10.00", "9.00"),
      ["04/05/2026 10:00:00", "IN-TESTINT", "", "", "Interest", "0", "USD", "0", "0.05", "0", "0", "0.05", "0"],
    ])).toEqual(new Map([["DT-TESTDEP", "unsupported"], ["WL-TESTWDR", "unsupported"], ["CN-TESTINONLY", "unsupported"], ["IN-TESTINT", "distribution_in"]]));
  });

  it("skip_tickers none: ICSUSSDP trades keep today's 1:1 pairing and nothing is pool-funded", () => {
    const rows = [fundSell("12/04/2026 20:34:12", "OR-TESTNONE", "200.18"), ...convOut("12/04/2026 20:35:07", "CN-TESTNONE", "200.18", "0.70", "170.12")];
    const { trades } = classifyLightyearStatementPool(parseLightyearRowsForTest(rows), new Set());
    expect(trades.trades[0]).toMatchObject({ reference: "OR-TESTNONE", conversion_ref: "CN-TESTNONE" });
    expect(trades.fundedConversionRefs.size).toBe(0);
  });

  it("an unplaceable USD row (25:00:00, date-only, empty) blocks the pool: no €90 relief", async () => {
    for (const date of ["01/10/2026 25:00:00", "01/10/2026", ""]) {
      const rows = [
        [date, "WL-TESTUNPL", "", "", "Withdrawal", "0", "USD", "0", "-50.00", "0", "0", "-50.00", "0"],
        fundSell("19/10/2026 14:43:15", "OR-TESTUNSW", "100.00"),
        buy("19/10/2026 14:43:49", "OR-TESTUNBY", "100.00"),
      ];
      expect(roles(rows).get("WL-TESTUNPL")).toBe("unplaceable");
      load(rows);
      const env = tradesTool({ pool: [poolOpening(10000, 9000, "1.1111111111")] });
      const dry = await env.run({ dry_run: true });
      expect(reviewCode(dry.payload, "OR-TESTUNBY")).toBe("usd_pool_row_unplaceable");
      expect(dry.payload.created).toBe(0);
    }
  });

  it("mixed second (Codex r1 #2): a logged +100 USD / €80 inflow and a 50 USD spend in one second are refused, and so is every later spend", async () => {
    const dividend = ["19/10/2026 14:43:49", "DD-TESTMIX", "AMD", "US0079031078", "Dividend", "0", "USD", "0", "100.00", "0", "0", "100.00", "0"];
    const pool = [poolOpening(10000, 9000, "1.1111111111"), poolDistribution("DD-TESTMIX", "2026-10-19T14:43:49Z", 10000, 8000, 601, 8330)];
    const journals = [poolJournal(601, "DD-TESTMIX", 8000, 8330)];
    load([dividend, fundSell("19/10/2026 14:43:40", "OR-TESTMXSW1", "50.00"), buy("19/10/2026 14:43:49", "OR-TESTMXBY1", "50.00"),
      fundSell("20/10/2026 10:00:00", "OR-TESTMXSW2", "10.00"), buy("20/10/2026 10:00:10", "OR-TESTMXBY2", "10.00")]);
    const dry = await tradesTool({ pool, journals }).run({ dry_run: true });
    expect(reviewCode(dry.payload, "OR-TESTMXBY1")).toBe("usd_pool_ambiguous_order");
    expect(reviewCode(dry.payload, "OR-TESTMXBY2")).toBe("usd_pool_ambiguous_order");
    expect(dry.payload.created).toBe(0);
    // Control: the spend one second later relieves €42.50 from 200 USD / €170.
    load([dividend, fundSell("19/10/2026 14:43:41", "OR-TESTMXSW1", "50.00"), buy("19/10/2026 14:43:50", "OR-TESTMXBY1", "50.00")]);
    const control = await tradesTool({ pool, journals }).run({ dry_run: true });
    expect(control.payload.results.find(row => String(row.reference).includes("OR-TESTMXBY1"))!.pool!.relief_eur).toBe(42.5);
  });

  it("an ICSUSSDP row priced 1.0001 or with a fee inside the interval is usd_pool_fund_price_not_stable at validation", async () => {
    for (const [price, fee] of [["1.0001", "0"], ["1", "0.01"]] as const) {
      load([fundSell("19/10/2026 14:43:15", "OR-TESTPRSW", "100.00", price, fee), buy("19/10/2026 14:43:49", "OR-TESTPRBY", fee === "0" ? "100.00" : "99.99")]);
      const dry = await tradesTool({ pool: [poolOpening(10000, 9000, "1.1111111111")] }).run({ dry_run: true });
      expect(reviewCode(dry.payload, "OR-TESTPRBY")).toBe("usd_pool_fund_price_not_stable");
    }
  });

  it("D2 visible: a fund-paid buy after a USD→EUR conversion is valued from the balance that conversion leaves, never the stale one", async () => {
    load([
      ...convOut("12/10/2026 20:35:07", "CN-TESTD2V", "50.00", "0.18", "42.50"),
      fundSell("19/10/2026 14:43:15", "OR-TESTD2VSW", "20.00"),
      buy("19/10/2026 14:43:49", "OR-TESTD2VBY", "20.00"),
    ]);
    // Opening 100 USD / €90; the conversion (booked by the same plan, Q4) relieves 50 USD / €45, so the 20 USD buy
    // relieves 20 × 45 / 50 = €18.00 (not 20 × 90 / 100 from the stale balance — the same here — nor a guess).
    const dry = await tradesTool({ pool: [poolOpening(10000, 9000, "1.1111111111")] }).run({ dry_run: true });
    expect(dry.payload.results.find(row => String(row.reference).includes("CN-TESTD2V"))).toMatchObject({ status: "would_create", pool: { kind: "conversion_out", relief_eur: 45 } });
    expect(dry.payload.results.find(row => String(row.reference).includes("OR-TESTD2VBY"))).toMatchObject({ status: "would_create", pool: { relief_eur: 18 } });
    // Without that conversion booked first (a journal booked outside the pool log), the buy reviews instead.
    const outside = await tradesTool({
      pool: [poolOpening(10000, 9000, "1.1111111111")],
      journals: [{ id: 801, document_number: "LY:CN-TESTD2V", effective_date: "2026-10-12", registered: true, is_deleted: false, postings: [] }],
    }).run({ dry_run: true });
    expect(reviewCode(outside.payload, "OR-TESTD2VBY")).toBe("usd_pool_prerequisite_unbooked");
  });

  it("parse, portfolio and trades flag the same trades for conversion review", async () => {
    const rows = [
      buy("19/10/2026 10:00:00", "OR-TESTXT01", "100.00"),
      buy("19/10/2026 10:00:30", "OR-TESTXT02", "100.00"),
      ...convIn("19/10/2026 10:00:20", "CN-TESTXT01", "100.00", "90.00"),
      buy("08/06/2026 14:29:35", "OR-TESTXT03", "114.96", "0.11"),
      ...convIn("08/06/2026 14:29:35", "CN-TESTXT03", "114.96", "100.00", "0.35"),
    ];
    const flagged = (warnings: readonly string[] | undefined) =>
      ["OR-TESTXT01", "OR-TESTXT02", "OR-TESTXT03"].filter(ref => (warnings ?? []).some(w => w.includes(ref) && w.includes("[invalid_conversion_pair]")));
    load(rows);
    const book = await tradesTool().run({ dry_run: true });
    load(rows);
    const parse = await setupPoolTool<{ warnings?: string[] }>("parse_lightyear_statement", {}).run();
    load(rows);
    const portfolio = await setupPoolTool<{ warnings?: string[] }>("lightyear_portfolio_summary", {}).run();
    expect(flagged(book.payload.warnings)).toEqual(["OR-TESTXT01", "OR-TESTXT02"]);
    expect(flagged(parse.payload.warnings)).toEqual(["OR-TESTXT01", "OR-TESTXT02"]);
    expect(flagged(portfolio.payload.warnings)).toEqual(["OR-TESTXT01", "OR-TESTXT02"]);
  });
});
