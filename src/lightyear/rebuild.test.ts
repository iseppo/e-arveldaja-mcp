import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFileInput } from "../file-validation.js";
import { readFileCapped } from "../bounded-read.js";
import { lightyearStatementCsv } from "../__fixtures__/lightyear-rows.js";
import { poolDistribution, poolJournal, sourceDigestOf, poolOpening, rateFetch, setupPoolTool, type FetchMock } from "../__fixtures__/lightyear-pool-harness.js";
import type { Account, AccountDimension, Journal } from "../types/api.js";
import type { LightyearTradesPayload } from "../tools/lightyear-investments.js";
import { canonicalPoolPostings, defaultUsdPoolStore, type UsdPoolRecord } from "./usd-pool.js";
import { GetOnlyHttpClient, compareWithBooks, parseRebuildArgs, renderRebuildReport, safeDocumentNumber, simulateLightyearYear, type ProposedJournal, type RebuildAccounts, type RebuildOpening } from "./rebuild.js";

vi.mock("../bounded-read.js", async () => {
  const actual = await vi.importActual<typeof import("../bounded-read.js")>("../bounded-read.js");
  return { ...actual, readFileCapped: vi.fn() };
});
vi.mock("../file-validation.js", () => ({ resolveFileInput: vi.fn() }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

const mockedReadFileCapped = vi.mocked(readFileCapped);
const mockedResolveFileInput = vi.mocked(resolveFileInput);

const GAINS_PATH = "/tmp/CapitalGainsStatement-TESTACCT1-2026.csv";
const GAINS_HEADER = "Date,Ticker,Name,ISIN,Country,Asset Class,Fees (EUR),Quantity,Cost Basis (EUR),Proceeds (EUR),Capital Gains (EUR)";
/** Synthetic accounts, as the pool harness: 1120 broker, 1550 investment. */
const ACCOUNTS: RebuildAccounts = {
  broker_account: 1120, investment_account: 1550, income_account: 8320, interest_account: 8400, fund_distribution_account: 8320,
  reward_account: 8600, tax_account: 8610, trade_fee_account: 8335, distribution_fee_account: 8610, gain_account: 8330, loss_account: 8335, fx_account: 8500,
};
const TOOL_ACCOUNTS = { investment_account: 1550, broker_account: 1120, gain_loss_account: 8330, loss_account: 8335, fee_account: 8335, fx_account: 8500 };

const buy = (ts: string, ref: string, gross: string, fee = "0", ccy = "USD"): string[] =>
  [ts, ref, "NVDA", "US67066G1040", "Buy", "1", ccy, "1", gross, "0", fee, (Number(gross) - Number(fee)).toFixed(2), "0"];
const sell = (ts: string, ref: string, gross: string, fee: string): string[] =>
  [ts, ref, "AMD", "US0079031078", "Sell", "1", "USD", "1", gross, "0", fee, (Number(gross) - Number(fee)).toFixed(2), "0"];
const gain = (ts: string, cost: string, proceeds: string): string[] =>
  [ts, "AMD", "AMD", "US0079031078", "United States", "equity", "0", "1", cost, proceeds, (Number(proceeds) - Number(cost)).toFixed(2)];
const dividend = (ts: string, ref: string, net: string): string[] => [ts, ref, "AMD", "US0079031078", "Dividend", "0", "USD", "0", net, "0", "0", net, "0"];
const convOut = (ts: string, ref: string, usdGross: string, usdFee: string, eur: string): string[][] => {
  const usdNet = (Number(usdGross) - Number(usdFee)).toFixed(2);
  return [
    [ts, ref, "", "", "Conversion", "0", "USD", "0", `-${usdGross}`, String(Number(eur) / Number(usdNet)), usdFee, `-${usdNet}`, "0"],
    [ts, ref, "", "", "Conversion", "0", "EUR", "0", eur, String(Number(usdNet) / Number(eur)), "0", eur, "0"],
  ];
};
const convIn = (ts: string, ref: string, usd: string, eurGross: string): string[][] => [
  [ts, ref, "", "", "Conversion", "0", "EUR", "0", `-${eurGross}`, String(Number(usd) / Number(eurGross)), "0", `-${eurGross}`, "0"],
  [ts, ref, "", "", "Conversion", "0", "USD", "0", usd, String(Number(eurGross) / Number(usd)), "0", usd, "0"],
];
const fundSell = (ts: string, ref: string, usd: string, price = "1", fee = "0"): string[] =>
  [ts, ref, "ICSUSSDP", "IE00B44QSF52", "Sell", usd, "USD", price, usd, "0", fee, (Number(usd) - Number(fee)).toFixed(2), "0"];
const gainsCsv = (rows: string[][]) => `${GAINS_HEADER}\n${rows.map(row => row.map(value => `"${value}"`).join(",")).join("\n")}\n`;

function reviewCode(warnings: readonly string[] | undefined, reference: string): string | undefined {
  const text = (warnings ?? []).find(warning => warning.includes(reference));
  return text ? /FX review \[([a-z_]+)\]/.exec(text)?.[1] : undefined;
}

function simulate(rows: string[][], opening: RebuildOpening, options: { gains?: string[][]; fetch?: FetchMock } = {}) {
  return simulateLightyearYear({
    statementCsv: lightyearStatementCsv(rows), gainsCsv: options.gains ? gainsCsv(options.gains) : null,
    from: "2026-01-01", to: "2026-10-30", lightyearAccount: "TESTACCT1", opening, accounts: ACCOUNTS,
    ecb: { fetch: options.fetch ?? rateFetch(), today: () => "2026-10-31", now: () => new Date("2026-10-31T08:00:00Z"), cache: new Map() },
  });
}

describe("simulateLightyearYear accounts as the booking tools", () => {
  beforeEach(() => {
    mockedResolveFileInput.mockReset();
    mockedResolveFileInput.mockImplementation(async (input: string) => ({ path: input }));
    mockedReadFileCapped.mockReset();
  });

  const ROWS = [
    ["01/10/2026 11:00:00", "IN-TESTFEE001", "BRICEKSP", "IE00BCRY6557", "Distribution", "0", "EUR", "0", "3.36", "1", "0.14", "3.22", "0"],
    ["22/10/2026 09:00:00", "RW-TESTRWD001", "", "", "Reward", "0", "EUR", "0", "15", "1", "0", "15", "0"],
  ];
  const OPENING: RebuildOpening = { as_of: "2026-09-30", usd_cents: 0, eur_cents: 0, rate: "1.1355" };
  const account = (id: number, allows_dimensions: boolean) => ({ id, name_est: `Konto ${id}`, is_valid: true, allows_dimensions }) as unknown as Account;
  const CHART = {
    accounts: [account(1120, false), account(8320, false), account(8600, true), account(8610, true)],
    dimensions: [
      { id: 942290, accounts_id: 8600, title_est: "Muud finantstulud", is_deleted: false },
      { id: 942302, accounts_id: 8610, title_est: "Muud finantskulud", is_deleted: false },
    ] as unknown as AccountDimension[],
  };
  const run = (chart?: typeof CHART) => simulateLightyearYear({
    statementCsv: lightyearStatementCsv(ROWS), gainsCsv: null,
    from: "2026-10-01", to: "2026-10-30", lightyearAccount: "TESTACCT1", opening: OPENING, accounts: ACCOUNTS,
    ecb: { fetch: rateFetch(), today: () => "2026-10-31", now: () => new Date("2026-10-31T08:00:00Z"), cache: new Map() },
    ...(chart ? { chart } : {}),
  });
  const postingsOf = (journals: readonly ProposedJournal[], ref: string) =>
    journals.find(journal => journal.document_number === `LY:${ref}`)?.postings.map(p => [p.type, p.accounts_id, p.accounts_dimensions_id, p.amount_cents]);

  it("books a distribution fee on the distribution fee account (8610), not the trade fee account", async () => {
    const sim = await run();
    expect(postingsOf(sim.journals, "IN-TESTFEE001")).toEqual(expect.arrayContaining([["D", 8610, null, 14], ["C", 8320, null, 336]]));
    expect(sim.journals.flatMap(journal => journal.postings).some(posting => posting.accounts_id === 8335)).toBe(false);
  });

  it("with the live chart, fills an account's only dimension the way the tools do", async () => {
    const sim = await run(CHART);
    expect(postingsOf(sim.journals, "IN-TESTFEE001")).toEqual(expect.arrayContaining([["D", 8610, 942302, 14]]));
    expect(postingsOf(sim.journals, "RW-TESTRWD001")).toEqual(expect.arrayContaining([["C", 8600, 942290, 1500]]));
  });

  it("refuses the whole distribution run when a posting fails account validation, as the tool does", async () => {
    // 8600 has two dimensions and none is chosen: book_lightyear_distributions answers
    // "Account validation failed" and books nothing, so the simulation applies nothing either.
    const ambiguous = {
      ...CHART,
      dimensions: [...CHART.dimensions, { id: 942291, accounts_id: 8600, title_est: "Teine", is_deleted: false }] as unknown as AccountDimension[],
    };
    const sim = await run(ambiguous);
    expect(sim.journals.filter(journal => journal.source === "distribution")).toEqual([]);
    expect(sim.reviews).toEqual([expect.objectContaining({ reference: "RW-TESTRWD001", source: "distribution", status: "account_validation_failed" })]);
  });
});

describe("GetOnlyHttpClient", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each(["POST", "PATCH", "PUT", "DELETE"] as const)("%s throws and is never sent", async method => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new GetOnlyHttpClient({ apiKeyId: "k", apiPublicValue: "p", apiPassword: "s", baseUrl: "https://rebuild.invalid/api/v1" });
    await expect(client.request("/journals", { method, body: {} })).rejects.toThrow(/refused before sending/);
    if (method === "POST") await expect(client.post("/journals", {})).rejects.toThrow(/refused/);
    if (method === "PATCH") await expect(client.patch("/journals/1/register", {})).rejects.toThrow(/refused/);
    if (method === "DELETE") await expect(client.delete("/journals/1")).rejects.toThrow(/refused/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("simulateLightyearYear (plan Q5)", () => {
  beforeEach(() => {
    mockedResolveFileInput.mockReset();
    mockedResolveFileInput.mockImplementation(async (input: string) => ({ path: input }));
    mockedReadFileCapped.mockReset();
  });

  /** The April 2026 golden of the Q4 tests. */
  const APRIL = [
    dividend("02/04/2026 10:00:00", "DD-TESTQ4G1", "0.60"),
    dividend("06/04/2026 10:00:00", "DD-TESTQ4G2", "0.21"),
    sell("10/04/2026 10:00:00", "OR-TESTQ4GS0", "199.20", "0.20"),
    ...convOut("12/04/2026 20:35:07", "CN-TESTQ4GC1", "200.18", "0.70", "170.12"),
    sell("17/04/2026 14:10:12", "OR-TESTQ4GS1", "100.00", "0.10"),
    buy("17/04/2026 14:10:21", "OR-TESTQ4GB1", "99.90", "0.10"),
    sell("21/04/2026 10:00:00", "OR-TESTQ4GS2", "100.00", "0.10"),
    sell("22/04/2026 10:00:00", "OR-TESTQ4GS3", "100.00", "0.10"),
    sell("24/04/2026 10:00:00", "OR-TESTQ4GS4", "100.00", "0.10"),
    buy("24/04/2026 18:56:00", "OR-TESTQ4GB2", "99.90", "0.10"),
    ...convOut("25/04/2026 10:00:00", "CN-TESTQ4GC2", "100.00", "0.35", "85.01"),
    buy("27/04/2026 10:00:00", "OR-TESTQ4GB3", "99.80", "0.10"),
  ];
  const APRIL_GAINS = ["10/04/2026 10:00:00", "17/04/2026 14:10:12", "21/04/2026 10:00:00", "22/04/2026 10:00:00", "24/04/2026 10:00:00"].map(ts => gain(ts, "60.00", "85.00"));
  const APRIL_RATES = { "2026-04-10": "1.1706", "2026-04-17": "1.1797", "2026-04-21": "1.1767", "2026-04-22": "1.1733", "2026-04-24": "1.1712", "2026-04-27": "1.1749" };
  // 0.37 USD / €0.31 at 1.1935 (the stored opening rate recomputes the EUR value).
  const APRIL_OPENING: RebuildOpening = { as_of: "2026-03-31", usd_cents: 37, eur_cents: 31, rate: "1.1935" };

  it("the April golden equals the book_lightyear_trades journals posting for posting and ends the pool at 0.00 / €0.00", async () => {
    const sim = await simulate(APRIL, APRIL_OPENING, { gains: APRIL_GAINS, fetch: rateFetch("1.1500", APRIL_RATES) });
    // Production run: the same statement, the dividends booked first (0.60 / 0.21 USD at 1.1500 → €0.52 / €0.18).
    mockedReadFileCapped.mockImplementation(async (path: string) => Buffer.from(path === GAINS_PATH ? gainsCsv(APRIL_GAINS) : lightyearStatementCsv(APRIL), "utf8"));
    const env = setupPoolTool<LightyearTradesPayload>("book_lightyear_trades", TOOL_ACCOUNTS, {
      pool: [poolOpening(37, 31, "1.1935", "2026-03-31"), poolDistribution("DD-TESTQ4G1", "2026-04-02T10:00:00Z", 60, 52, 601, undefined, sourceDigestOf(APRIL, "DD-TESTQ4G1")), poolDistribution("DD-TESTQ4G2", "2026-04-06T10:00:00Z", 21, 18, 602, undefined, sourceDigestOf(APRIL, "DD-TESTQ4G2"))],
      journals: [poolJournal(601, "DD-TESTQ4G1", 52), poolJournal(602, "DD-TESTQ4G2", 18)],
      fetch: rateFetch("1.1500", APRIL_RATES),
    });
    await env.book({ capital_gains_file: GAINS_PATH });
    expect(env.created).toHaveLength(10);
    const produced = env.created.map(entry => ({ document_number: entry.document_number, postings: canonicalPoolPostings(entry.postings ?? []) }));
    const simulated = sim.journals.filter(journal => journal.source === "trade").map(journal => ({ document_number: journal.document_number, postings: journal.postings }));
    expect(simulated).toEqual(produced);
    expect(sim.journals.filter(journal => journal.source === "distribution").map(journal => journal.postings)).toEqual([
      canonicalPoolPostings(poolJournal(601, "DD-TESTQ4G1", 52).postings), canonicalPoolPostings(poolJournal(602, "DD-TESTQ4G2", 18).postings),
    ]);
    expect(sim.monthEnds.find(month => month.month === "2026-04")).toMatchObject({ usd_cents: 0, eur_cents: 0 });
    const fx = sim.journals.flatMap(journal => journal.postings).filter(posting => posting.accounts_id === 8500)
      .reduce((sum, posting) => sum + (posting.type === "D" ? posting.amount_cents : -posting.amount_cents), 0);
    expect(fx).toBe(8);
    expect(sim.reviews).toEqual([]);
  });

  it("astra review 2026-11-04 #6: movements between the opening and --from are replayed, not dropped (USD 110, not 100)", async () => {
    // Opening 2025-12-31 asserts 100 USD / €100 at 1; a January 10 USD dividend (€10 at ECB 1) and a February EUR
    // reward follow. Reporting February only, the pool at the end of February is 110 USD / €110.
    const rows = [
      dividend("15/01/2026 10:00:00", "DD-TESTGAP01", "10.00"),
      ["10/02/2026 09:00:00", "RW-TESTGAP02", "", "", "Reward", "0", "EUR", "0", "5", "1", "0", "5", "0"],
    ];
    const sim = await simulateLightyearYear({
      statementCsv: lightyearStatementCsv(rows), gainsCsv: null,
      from: "2026-02-01", to: "2026-02-28", lightyearAccount: "TESTACCT1", opening: { as_of: "2025-12-31", usd_cents: 10000, eur_cents: 10000, rate: "1" }, accounts: ACCOUNTS,
      ecb: { fetch: rateFetch("1"), today: () => "2026-10-31", now: () => new Date("2026-10-31T08:00:00Z"), cache: new Map() },
    });
    expect(sim.monthEnds).toEqual([expect.objectContaining({ month: "2026-02", usd_cents: 11000, eur_cents: 11000 })]);
    expect(sim.journals.map(journal => journal.document_number)).toEqual(["LY:RW-TESTGAP02"]);
    expect(sim.reviews).toEqual([]);
  });

  it("statement days set the month: 31/03 23:59:59 is March, 01/04 00:00:00 is April", async () => {
    const rows = [buy("31/03/2026 23:59:59", "OR-TESTMB1", "10.00", "0", "EUR"), buy("01/04/2026 00:00:00", "OR-TESTMB2", "11.00", "0", "EUR")];
    const sim = await simulate(rows, { as_of: "2025-12-31", usd_cents: 0, eur_cents: 0, rate: "1" });
    expect(sim.journals.map(journal => [journal.document_number, journal.date.slice(0, 7)])).toEqual([["LY:OR-TESTMB1", "2026-03"], ["LY:OR-TESTMB2", "2026-04"]]);
  });

  describe("refusal parity: the rebuild stops where the trades dry run reviews", () => {
    const opening = { as_of: "2025-12-31", usd_cents: 10000, eur_cents: 9000, rate: "1.1111111111" };
    const MIXED_DIVIDEND = ["19/10/2026 14:43:49", "DD-TESTPMX", "AMD", "US0079031078", "Dividend", "0", "USD", "0", "100.00", "0", "0", "100.00", "0"];
    const cases: Array<[string, string[][], string[], { pool?: UsdPoolRecord[]; journals?: Journal[] }]> = [
      ["unsupported USD deposit", [
        ["01/05/2026 10:00:00", "DT-TESTPDEP", "", "", "Deposit", "0", "USD", "0", "100.00", "0", "0", "100.00", "0"],
        buy("02/05/2026 10:00:00", "OR-TESTPDB", "50.00"),
      ], ["OR-TESTPDB"], {}],
      ["malformed conversion", (() => {
        const both = convOut("12/04/2026 20:35:07", "CN-TESTPMC", "100.00", "0.70", "85.00");
        both[1]![8] = "85.60"; both[1]![10] = "0.60";
        return [...both, buy("20/04/2026 10:00:00", "OR-TESTPMB", "10.00")];
      })(), ["CN-TESTPMC", "OR-TESTPMB"], {}],
      ["non-par sweep", [fundSell("19/10/2026 14:43:15", "OR-TESTPNS", "100.00", "1.0001"), buy("19/10/2026 14:43:49", "OR-TESTPNB", "100.00")], ["OR-TESTPNB"], {}],
      ["unplaceable row", [
        ["01/10/2026 25:00:00", "WL-TESTPUN", "", "", "Withdrawal", "0", "USD", "0", "-50.00", "0", "0", "-50.00", "0"],
        buy("19/10/2026 14:43:49", "OR-TESTPUB", "100.00"),
      ], ["OR-TESTPUB"], {}],
      ["ambiguous pairing", [
        buy("19/10/2026 10:00:00", "OR-TESTPAB1", "100.00"), buy("19/10/2026 10:00:30", "OR-TESTPAB2", "100.00"),
        ...convIn("19/10/2026 10:00:10", "CN-TESTPAC1", "100.00", "90.00"), ...convIn("19/10/2026 10:00:20", "CN-TESTPAC2", "100.00", "80.00"),
      ], ["OR-TESTPAB1", "OR-TESTPAB2"], {}],
      ["mixed second", [
        MIXED_DIVIDEND,
        buy("19/10/2026 14:43:49", "OR-TESTPMXB", "50.00"),
      ], ["OR-TESTPMXB"], {
        pool: [poolDistribution("DD-TESTPMX", "2026-10-19T14:43:49Z", 10000, 8909, 601, undefined, sourceDigestOf([MIXED_DIVIDEND], "DD-TESTPMX"))],
        journals: [poolJournal(601, "DD-TESTPMX", 8909)],
      }],
    ];

    it.each(cases)("%s", async (_label, rows, refs, extra) => {
      mockedReadFileCapped.mockResolvedValue(Buffer.from(lightyearStatementCsv(rows), "utf8"));
      const dry = await setupPoolTool<LightyearTradesPayload>("book_lightyear_trades", TOOL_ACCOUNTS, {
        pool: [poolOpening(10000, 9000, "1.1111111111"), ...(extra.pool ?? [])], journals: extra.journals ?? [],
      }).run({ dry_run: true });
      const sim = await simulate(rows, opening);
      for (const ref of refs) {
        const code = reviewCode(dry.payload.warnings, ref);
        expect(code, ref).toBeDefined();
        expect(reviewCode(sim.warnings, ref), ref).toBe(code);
        expect(sim.journals.some(journal => journal.document_number === `LY:${ref}`)).toBe(false);
      }
    });
  });

  it("a populated pool store stays byte-identical and no store file is created", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rebuild-store-"));
    const previous = process.env.EARVELDAJA_RULES_DIR;
    try {
      const bundle = join(dir, "accounting-rules");
      process.env.EARVELDAJA_RULES_DIR = bundle;
      const file = join(dir, "lightyear-usd-pool.json");
      writeFileSync(file, JSON.stringify({ records: [{ record: "checkpoint" }, { record: "event", state: "intent" }] }));
      const before = createHash("sha256").update(readFileSync(file)).digest("hex");
      const listing = readdirSync(dir).sort();
      const spies = (["read", "upsert", "remove", "reset"] as const).map(method => vi.spyOn(defaultUsdPoolStore, method));
      const sim = await simulate(APRIL, APRIL_OPENING, { gains: APRIL_GAINS, fetch: rateFetch("1.1500", APRIL_RATES) });
      expect(sim.journals.length).toBeGreaterThan(0);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(before);
      expect(readdirSync(dir).sort()).toEqual(listing);
    } finally {
      if (previous === undefined) delete process.env.EARVELDAJA_RULES_DIR; else process.env.EARVELDAJA_RULES_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});

describe("compareWithBooks (plan Q5)", () => {
  const scope = { from: "2026-01-01", to: "2026-12-31", accounts: [1120, 1550, 8320, 8330, 8335, 8500], broker_account: 1120, broker_dimension_id: 7, investment_account: 1550 };
  const posting = (accounts_id: number, type: "D" | "C", amount: number, dimension?: number) =>
    ({ accounts_id, type, amount, ...(dimension !== undefined ? { accounts_dimensions_id: dimension } : {}) });
  const live = (id: number, documentNumber: string | null, date: string, postings: ReturnType<typeof posting>[], extra: Partial<Journal> = {}): Journal =>
    ({ id, document_number: documentNumber, effective_date: date, registered: true, is_deleted: false, postings, ...extra });
  const proposed = (documentNumber: string, date: string, postings: ReturnType<typeof posting>[]): ProposedJournal =>
    ({ document_number: documentNumber, date, source: "trade", journal_free: false, postings: canonicalPoolPostings(postings) });

  it("classifies equal, different, proposed-only and books-only journals, transfers and drafts", () => {
    const buyLines = [posting(1550, "D", 100), posting(1120, "C", 100, 7)];
    const result = compareWithBooks([
      proposed("LY:OR-TESTCEQ", "2026-03-31", buyLines),
      proposed("LY:OR-TESTCDF", "2026-04-01", buyLines),
      proposed("LY:OR-TESTCPO", "2026-04-02", [posting(1550, "D", 5), posting(1120, "C", 5, 7)]),
    ], [
      live(1, "LY:OR-TESTCEQ", "2026-03-31", buyLines),
      live(2, "LY:OR-TESTCDF", "2026-04-01", [posting(1550, "D", 99), posting(8335, "D", 1), posting(1120, "C", 100, 7)]),
      live(3, "reward", "2026-04-03", [posting(1120, "D", 2, 7), posting(8600, "C", 2)], { registered: false }),
      live(4, null, "2026-04-04", [posting(1120, "D", 500, 7), posting(1020, "C", 500, 3)], { operation_type: "TRANSACTION" }),
      live(5, null, "2026-04-05", [posting(1120, "C", 3, 8), posting(8335, "D", 3)]),
      live(6, "LY:OR-OTHER", "2025-12-31", buyLines),
      live(7, "LY:OR-DELETED", "2026-04-06", buyLines, { is_deleted: true }),
    ], scope, [{ month: "2026-04", cents: 50000 }]);
    expect(result.byRef).toEqual({
      matched_equal: ["LY:OR-TESTCEQ"], matched_different: ["LY:OR-TESTCDF"], proposed_only: ["LY:OR-TESTCPO"],
      books_only: [{ id: 3, document_number: "reward", date: "2026-04-03" }, { id: 5, document_number: null, date: "2026-04-05" }],
    });
    expect(result.transfers).toEqual([{ month: "2026-04", books_broker_transaction_cents: 50000, statement_eur_deposit_withdrawal_cents: 50000 }]);
    const cell = (account: number, month: string, dimension?: number) =>
      result.byAccountMonth.find(entry => entry.account === account && entry.month === month && entry.dimension === dimension);
    expect(cell(1550, "2026-03")).toMatchObject({ books_cents: 10000, proposed_cents: 10000, diff_cents: 0 });
    expect(cell(1550, "2026-04")).toMatchObject({ books_cents: 9900, proposed_cents: 10500, diff_cents: 600 });
    expect(cell(1120, "2026-04", 7)).toMatchObject({ books_cents: -10000 + 200, books_draft_cents: 200, proposed_cents: -10500 });
    // 1120 on another dimension and 8600 are out of scope; 8335 counts the hand-booked fee too.
    expect(cell(1120, "2026-04", 8)).toBeUndefined();
    expect(cell(8335, "2026-04")).toMatchObject({ books_cents: 400, proposed_cents: 0, diff_cents: -400 });
  });

  it("compares books over the same inclusive --from..--to range as the simulation", () => {
    const lines = [posting(1100, "D", 100), posting(1020, "C", 100)];
    const accounts = { accounts: [1020, 1100], broker_account: 1020, investment_account: 1100 };
    // April only: a booked March purchase is outside the run, not books_only with ±€100 differences.
    const april = compareWithBooks([], [live(1, "LY:OR-TESTRMAR", "2026-03-15", lines)], { ...accounts, from: "2026-04-01", to: "2026-04-30" });
    expect(april.byRef.books_only).toEqual([]);
    expect(april.byAccountMonth).toEqual([]);
    // December–January: January's booked journal is compared, not dropped with the start year.
    const span = compareWithBooks([proposed("LY:OR-TESTRJAN", "2027-01-05", lines)], [live(2, "LY:OR-TESTRJAN", "2027-01-05", lines)], { ...accounts, from: "2026-12-01", to: "2027-01-31" });
    expect(span.byRef.matched_equal).toEqual(["LY:OR-TESTRJAN"]);
    expect(span.byAccountMonth.every(entry => entry.diff_cents === 0)).toBe(true);
  });

  it("Codex #5: identical D1100 €100 / C1020 €100 proposed on April 1 but booked on April 2 is matched_different", () => {
    const dated = { from: "2026-01-01", to: "2026-12-31", accounts: [1020, 1100], broker_account: 1020, investment_account: 1100 };
    const lines = [posting(1100, "D", 100), posting(1020, "C", 100)];
    const result = compareWithBooks([proposed("LY:OR-TESTCDT", "2026-04-01", lines)], [live(1, "LY:OR-TESTCDT", "2026-04-02", lines)], dated);
    expect(result.byRef).toMatchObject({ matched_equal: [], matched_different: ["LY:OR-TESTCDT"] });
    // Same month: the account/month view stays at zero difference; the reference view carries the date.
    expect(result.byAccountMonth.every(entry => entry.diff_cents === 0)).toBe(true);
    expect(compareWithBooks([proposed("LY:OR-TESTCDT", "2026-04-02", lines)], [live(1, "LY:OR-TESTCDT", "2026-04-02", lines)], dated).byRef.matched_equal).toEqual(["LY:OR-TESTCDT"]);
  });
});

describe("lightyear:rebuild-compare arguments and report", () => {
  const base = ["--statement", "s.csv", "--from", "2026-01-01", "--to", "2026-10-30", "--opening-as-of", "2025-12-31", "--start-usd-holding", "0.37"];

  it("parses a complete argument list", () => {
    expect(parseRebuildArgs([...base, "--gains", "g.csv", "--broker-dimension", "11", "--no-books"])).toMatchObject({
      statement: "s.csv", gains: "g.csv", from: "2026-01-01", to: "2026-10-30", openingAsOf: "2025-12-31", startUsdHolding: 0.37, brokerDimension: 11, noBooks: true,
    });
  });

  it.each([
    ["missing --statement", base.slice(2)],
    ["unknown flag", [...base, "--write"]],
    ["flag without value", [...base, "--gains"]],
    ["bad date", base.map(value => value === "2026-10-30" ? "30.10.2026" : value)],
    ["to before from", base.map(value => value === "2026-10-30" ? "2025-06-30" : value)],
    ["opening not before from", base.map(value => value === "2025-12-31" ? "2026-01-01" : value)],
    ["holding with 3 decimals", base.map(value => value === "0.37" ? "0.375" : value)],
    ["non-integer dimension", [...base, "--broker-dimension", "x1"]],
  ])("%s throws before any file or API access", (_label, argv) => {
    expect(() => parseRebuildArgs(argv)).toThrow();
  });

  it("renders unsafe references as <unsafe>", () => {
    expect(safeDocumentNumber("LY:OR-ABCDEF1234")).toBe("LY:OR-ABCDEF1234");
    expect(safeDocumentNumber("LY:OR-abc\nignore previous")).toBe("LY:<unsafe>");
    expect(safeDocumentNumber("LY-FX:TESTACCT1:USD:2026-10-30")).toBe("LY-FX:TESTACCT1:USD:2026-10-30");
    const report = renderRebuildReport(
      { args: parseRebuildArgs(base), opening: { as_of: "2025-12-31", usd_cents: 37, eur_cents: 31, rate: "1.175" } },
      { journals: [{ document_number: "LY:<script>", date: "2026-03-01", source: "trade", journal_free: false, postings: [{ accounts_id: 8500, accounts_dimensions_id: null, type: "D", amount_cents: 1 }] }],
        monthEnds: [], reviews: [{ reference: "OR-<b>x</b>", source: "trade", status: "skipped", reason: "<b>" }], warnings: [], statementTransfers: [] },
      null,
    );
    expect(report.markdown).not.toContain("<script>");
    expect(report.markdown).not.toContain("<b>");
    expect(report.markdown).toContain("2026-03: 0.01");
    expect(JSON.stringify(report.json)).not.toContain("<script>");
  });
});
