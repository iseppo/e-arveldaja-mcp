import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Journal } from "../types/api.js";

import type { ApiContext } from "./crud-tools.js";
import { buildAnnualReportData, registerAnnualReportTools } from "./annual-report.js";
import * as annualReport from "./annual-report.js";
import { parseMcpResponse } from "../mcp-json.js";
import { makePosting, makeJournal } from "../__fixtures__/accounting.js";
import { resetAccountingRulesCache } from "../accounting-rules.js";
import { OPENING_BALANCE_ACTIONABLE_WARNING } from "../opening-balance-limitations.js";
import { writeOpeningBalances, resetOpeningBalanceCache } from "../opening-balance-store.js";

const ORIGINAL_RULES_FILE = process.env.EARVELDAJA_RULES_FILE;

afterEach(() => {
  if (ORIGINAL_RULES_FILE === undefined) {
    delete process.env.EARVELDAJA_RULES_FILE;
  } else {
    process.env.EARVELDAJA_RULES_FILE = ORIGINAL_RULES_FILE;
  }
  resetAccountingRulesCache();
});

function makeAccount(overrides: Partial<Account> & Pick<Account,
  "id" |
  "balance_type" |
  "account_type_est" |
  "account_type_eng" |
  "name_est" |
  "name_eng"
>): Account {
  return {
    id: overrides.id,
    balance_type: overrides.balance_type,
    account_type_est: overrides.account_type_est,
    account_type_eng: overrides.account_type_eng,
    name_est: overrides.name_est,
    name_eng: overrides.name_eng,
    is_valid: true,
    allows_deactivation: true,
    is_vat_account: false,
    is_fixed_asset: false,
    transaction_in_bindable: false,
    cl_account_groups: [],
    default_disabled: false,
    ...overrides,
  };
}

function createApi(
  journals: Journal[],
  options: { transactions?: unknown[]; extraAccounts?: Account[] } = {},
): ApiContext {
  const accounts: Account[] = [
    makeAccount({
      id: 1000,
      balance_type: "D",
      account_type_est: "Varad",
      account_type_eng: "Assets",
      name_est: "Pangakonto",
      name_eng: "Bank account",
    }),
    makeAccount({
      id: 3000,
      balance_type: "C",
      account_type_est: "Omakapital",
      account_type_eng: "Equity",
      name_est: "Osakapital",
      name_eng: "Share capital",
    }),
    makeAccount({
      id: 3100,
      balance_type: "C",
      account_type_est: "Omakapital",
      account_type_eng: "Equity",
      name_est: "Agio",
      name_eng: "Share premium",
    }),
    makeAccount({
      id: 3200,
      balance_type: "C",
      account_type_est: "Omakapital",
      account_type_eng: "Equity",
      name_est: "Eelmiste perioodide jaotamata kasum",
      name_eng: "Retained earnings",
    }),
    makeAccount({
      id: 2970,
      balance_type: "C",
      account_type_est: "Omakapital",
      account_type_eng: "Equity",
      name_est: "Aruandeaasta kasum",
      name_eng: "Current year profit",
    }),
    makeAccount({
      id: 3001,
      balance_type: "C",
      account_type_est: "Tulud",
      account_type_eng: "Revenue",
      name_est: "Müügitulu",
      name_eng: "Sales revenue",
    }),
    makeAccount({
      id: 5000,
      balance_type: "D",
      account_type_est: "Kulud",
      account_type_eng: "Expenses",
      name_est: "Mitmesugused tegevuskulud",
      name_eng: "Operating expenses",
    }),
    ...(options.extraAccounts ?? []),
  ];

  return {
    readonly: {
      getAccounts: async () => accounts,
      getInvoiceInfo: async () => ({
        invoice_company_name: "Test Co",
        address: null,
        email: null,
        phone: null,
        webpage: null,
      }),
      getVatInfo: async () => ({
        vat_number: null,
      }),
    },
    clients: {
      listAll: async () => [],
    },
    saleInvoices: {
      listAll: async () => [],
    },
    purchaseInvoices: {
      listAll: async () => [],
    },
    transactions: {
      listAll: async () => options.transactions ?? [],
    },
    journals: {
      listAllWithPostings: async () => journals,
    },
  } as unknown as ApiContext;
}

function setupTool(
  toolName: string,
  options: {
    journals?: Journal[];
    transactions?: unknown[];
    extraAccounts?: Account[];
  } = {},
): (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> {
  const server = { registerTool: vi.fn() } as any;
  const api = createApi(options.journals ?? [], {
    transactions: options.transactions,
    extraAccounts: options.extraAccounts,
  });
  registerAnnualReportTools(server, api);

  const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === toolName);
  if (!registration) throw new Error(`Tool '${toolName}' was not registered`);
  return registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

function extractEquity(report: Record<string, unknown>) {
  return ((report.balance_sheet as { equity: unknown }).equity as {
    accounts: Array<{ label: string; amount: number; source_accounts: Array<{ account_id: number }> }>;
    current_year_result: { amount: number; source_accounts: Array<{ account_id: number; amount: number }> };
    total_equity: number;
  });
}

function makeM20BaseJournals(): Journal[] {
  return [
    makeJournal("2024-01-01", [
      makePosting(1000, "D", 100),
      makePosting(3000, "C", 100),
    ], { id: 1001, registered: true }),
    makeJournal("2024-12-31", [
      makePosting(1000, "D", 50),
      makePosting(3200, "C", 50),
    ], { id: 1002, registered: true }),
    makeJournal("2025-01-01", [
      makePosting(1000, "D", 20),
      makePosting(3100, "C", 20),
    ], { id: 1003, registered: true }),
    makeJournal("2025-06-01", [
      makePosting(1000, "D", 60),
      makePosting(3001, "C", 60),
    ], { id: 1004, registered: true }),
    makeJournal("2025-06-15", [
      makePosting(5000, "D", 10),
      makePosting(1000, "C", 10),
    ], { id: 1005, registered: true }),
  ];
}

function makeM20ClosingJournal(
  id: number,
  overrides: Pick<Journal, "effective_date"> & Partial<Pick<Journal, "document_number" | "title">>,
): Journal {
  return makeJournal(overrides.effective_date, [
    makePosting(3001, "D", 60),
    makePosting(5000, "C", 10),
    makePosting(2970, "C", 50),
  ], {
    id,
    registered: true,
    document_number: overrides.document_number,
    title: overrides.title,
  });
}

async function m20Profit(journals: Journal[]): Promise<number> {
  const report = await buildAnnualReportData(createApi(journals), 2025);
  return (report.income_statement_schema_1 as {
    aruandeaasta_puhaskasum: { amount: number };
  }).aruandeaasta_puhaskasum.amount;
}

async function m20Prepare(journals: Journal[]): Promise<Record<string, any>> {
  const handler = setupTool("prepare_year_end_close", { journals });
  const result = await handler({ year: 2025 });
  return parseMcpResponse(result.content[0]!.text);
}

describe("buildAnnualReportData", () => {
  const ACCOUNT_999_WARNING =
    "Some asset accounts fall outside the current (10–16) / non-current (17–19) balance-sheet ranges, so they count toward total assets but appear in neither asset line: 999. Review their classification.";
  const baseJournals: Journal[] = [
    makeJournal("2024-01-01", [
      makePosting(1000, "D", 100),
      makePosting(3000, "C", 100),
    ]),
    makeJournal("2024-12-31", [
      makePosting(1000, "D", 50),
      makePosting(3200, "C", 50),
    ]),
    makeJournal("2025-01-01", [
      makePosting(1000, "D", 20),
      makePosting(3100, "C", 20),
    ]),
    makeJournal("2025-06-01", [
      makePosting(1000, "D", 60),
      makePosting(3001, "C", 60),
    ]),
    makeJournal("2025-06-15", [
      makePosting(5000, "D", 10),
      makePosting(1000, "C", 10),
    ]),
  ];

  function buildAccount999Report() {
    return buildAnnualReportData(createApi([
      ...baseJournals,
      makeJournal("2025-12-31", [
        makePosting(999, "D", 25),
        makePosting(1000, "C", 25),
      ]),
    ], {
      extraAccounts: [
        makeAccount({
          id: 999,
          balance_type: "D",
          account_type_est: "Varad",
          account_type_eng: "Assets",
          name_est: "Määramata vara",
          name_eng: "Unclassified asset",
        }),
      ],
    }), 2025);
  }

  it("preserves the account 999 annual warning", async () => {
    const report = await buildAccount999Report();

    expect((report.warnings as string[])[0]).toBe(ACCOUNT_999_WARNING);
    expect((report.warnings as string[]).filter((warning) => warning === ACCOUNT_999_WARNING)).toHaveLength(1);
  });

  describe("opening-balance disclosure", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "ob-annual-report-"));
      process.env.EARVELDAJA_RULES_DIR = dir;
      resetOpeningBalanceCache();
    });

    afterEach(() => {
      delete process.env.EARVELDAJA_RULES_DIR;
      resetOpeningBalanceCache();
      rmSync(dir, { recursive: true, force: true });
    });

    it("adds annual opening-balance disclosure after the account 999 warning (actionable, nothing captured)", async () => {
      const report = await buildAccount999Report();

      expect(report.opening_balance_status).toBe("api_incomplete");
      expect(report.balance_scope).toBe("journal_api_visible_entries_only");
      expect(report.warnings).toEqual([
        ACCOUNT_999_WARNING,
        OPENING_BALANCE_ACTIONABLE_WARNING,
      ]);
      expect((report.warnings as string[]).filter((warning) => warning === ACCOUNT_999_WARNING)).toHaveLength(1);
      expect((report.warnings as string[]).filter(
        (warning) => warning === OPENING_BALANCE_ACTIONABLE_WARNING,
      )).toHaveLength(1);
    });

    it("reports a complete annual opening-balance scope with the applied-note when a stored algbilanss is captured", async () => {
      writeOpeningBalances(
        {
          openingDate: "2024-12-01",
          accounts: [
            { code: "1000", name: "Pangakonto", debit: 200, credit: 0 },
            { code: "3000", name: "Osakapital", debit: 0, credit: 200 },
          ],
          totals: { debit: 200, credit: 200 },
          rawText: "n/a",
        },
        "2024-12-01T00:00:00.000Z",
      );

      const report = await buildAccount999Report();

      expect(report.opening_balance_status).toBe("complete");
      expect(report.balance_scope).toBe("complete_balance");
      expect(report.warnings).toEqual([
        ACCOUNT_999_WARNING,
        expect.stringContaining("Opening balances applied from the stored algbilanss"),
      ]);
      expect((report.warnings as string[]).filter((warning) => warning === ACCOUNT_999_WARNING)).toHaveLength(1);
      expect(report.warnings).not.toContain(OPENING_BALANCE_ACTIONABLE_WARNING);
    });
  });

  it("includes all equity accounts dynamically before closing while keeping current-year profit separate", async () => {
    const report = await buildAnnualReportData(createApi(baseJournals), 2025);
    const equity = extractEquity(report);

    expect(equity.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Osakapital", amount: 100 }),
      expect.objectContaining({ label: "Agio", amount: 20 }),
      expect.objectContaining({ label: "Eelmiste perioodide jaotamata kasum", amount: 50 }),
    ]));
    expect(equity.accounts.flatMap((line) => line.source_accounts.map((account) => account.account_id))).not.toContain(2970);
    expect(equity.current_year_result.amount).toBe(50);
    expect(equity.current_year_result.source_accounts).toEqual([]);
    expect(equity.total_equity).toBe(220);
  });

  it("keeps the income statement populated after YECL close journals and surfaces 2970 in the equity section", async () => {
    const closingJournal = makeJournal("2025-12-31", [
      makePosting(3001, "D", 60),
      makePosting(5000, "C", 10),
      makePosting(2970, "C", 50),
    ], {
      document_number: "YECL-2025",
      title: "Aasta lõppkanne 2025",
    });

    const report = await buildAnnualReportData(createApi([...baseJournals, closingJournal]), 2025);
    const equity = extractEquity(report);
    const incomeStatement = report.income_statement_schema_1 as {
      aruandeaasta_puhaskasum: { amount: number };
    };

    expect(incomeStatement.aruandeaasta_puhaskasum.amount).toBe(50);
    expect(equity.current_year_result.amount).toBe(50);
    expect(equity.current_year_result.source_accounts).toEqual([
      {
        account_id: 2970,
        name: "Aruandeaasta kasum",
        amount: 50,
      },
    ]);
    expect(equity.total_equity).toBe(220);
  });

  it("M20 excludes an Estonian title-only year-end close from P&L", async () => {
    const closingJournal = makeM20ClosingJournal(1101, {
      effective_date: "2025-12-31",
      title: "Aasta lõppkanne 2025",
    });

    expect(await m20Profit([...makeM20BaseJournals(), closingJournal])).toBe(50);
  });

  it("M20 excludes an English title-only year-end close from P&L", async () => {
    const closingJournal = makeM20ClosingJournal(1102, {
      effective_date: "2025-12-31",
      title: "Year-End Close 2025",
    });

    expect(await m20Profit([...makeM20BaseJournals(), closingJournal])).toBe(50);
  });

  it("M20 prepare detects Estonian and English title-only closes as existing", async () => {
    const journals = [
      ...makeM20BaseJournals(),
      makeM20ClosingJournal(1201, {
        effective_date: "2025-12-31",
        title: "Aasta lõppkanne 2025",
      }),
      makeM20ClosingJournal(1202, {
        effective_date: "2025-12-31",
        title: "Year-End Close 2025",
      }),
    ];

    const payload = await m20Prepare(journals);

    expect(payload.existing_year_end_close_journals.map((journal: { id: number }) => journal.id)).toEqual([
      1201,
      1202,
    ]);
    expect(payload.execution_status.can_execute).toBe(false);
  });

  it("M20 preserves canonical YECL document compatibility in P&L and prepare", async () => {
    const canonicalClose = makeM20ClosingJournal(1301, {
      effective_date: "2025-12-31",
      document_number: "YECL-2025",
      title: "Aasta lõppkanne 2025",
    });
    const journals = [...makeM20BaseJournals(), canonicalClose];

    const payload = await m20Prepare(journals);
    const profit = await m20Profit(journals);

    expect.soft(payload.existing_year_end_close_journals.map((journal: { id: number }) => journal.id)).toEqual([1301]);
    expect.soft(payload.execution_status.can_execute).toBe(false);
    expect.soft(profit).toBe(50);
  });

  it("M20 keeps wrong-year document and title journals in P&L and out of prepare duplicates", async () => {
    const wrongYearClose = makeM20ClosingJournal(1401, {
      effective_date: "2025-12-31",
      document_number: "YECL-2024",
      title: "Aasta lõppkanne 2024",
    });
    const journals = [...makeM20BaseJournals(), wrongYearClose];

    const payload = await m20Prepare(journals);
    const profit = await m20Profit(journals);

    expect.soft(payload.existing_year_end_close_journals).toEqual([]);
    expect.soft(profit).toBe(0);
  });

  it("M20 keeps midyear canonical-looking journals in P&L and out of prepare duplicates", async () => {
    const midyearClose = makeM20ClosingJournal(1402, {
      effective_date: "2025-06-30",
      document_number: "YECL-2025",
      title: "Aasta lõppkanne 2025",
    });
    const journals = [...makeM20BaseJournals(), midyearClose];

    const payload = await m20Prepare(journals);
    const profit = await m20Profit(journals);

    expect.soft(payload.existing_year_end_close_journals).toEqual([]);
    expect.soft(profit).toBe(0);
  });

  it("M20 keeps malformed and prefix-only YECL documents in P&L and out of prepare duplicates", async () => {
    const journals = [
      ...makeM20BaseJournals(),
      makeM20ClosingJournal(1403, {
        effective_date: "2025-12-31",
        document_number: "YECL-2025-extra",
        title: "Malformed close marker",
      }),
      makeM20ClosingJournal(1404, {
        effective_date: "2025-12-31",
        document_number: "YECL-",
        title: "Prefix-only close marker",
      }),
    ];

    const payload = await m20Prepare(journals);
    const profit = await m20Profit(journals);

    expect.soft(payload.existing_year_end_close_journals).toEqual([]);
    expect.soft(profit).toBe(-50);
  });

  it("M20 keeps an ordinary 31 December journal in P&L and out of prepare duplicates", async () => {
    const ordinaryJournal = makeM20ClosingJournal(1405, {
      effective_date: "2025-12-31",
      document_number: "ADJ-2025",
      title: "Ordinary year-end adjustment",
    });
    const journals = [...makeM20BaseJournals(), ordinaryJournal];

    const payload = await m20Prepare(journals);
    const profit = await m20Profit(journals);

    expect.soft(payload.existing_year_end_close_journals).toEqual([]);
    expect.soft(profit).toBe(0);
  });

  it("M20 exports a strict detector for invalid or missing date and year inputs", () => {
    const detector = (annualReport as any).isYearEndClosingJournal;
    expect(detector).toBeTypeOf("function");

    const canonical = {
      effective_date: "2025-12-31",
      document_number: "YECL-2025",
      title: "Aasta lõppkanne 2025",
    };
    const vectors: Array<{
      name: string;
      journal: Pick<Journal, "document_number" | "effective_date" | "title">;
      year?: number;
      expected: boolean;
    }> = [
      { name: "valid inferred document", journal: canonical, expected: true },
      { name: "valid inferred Estonian title", journal: { ...canonical, document_number: null }, expected: true },
      { name: "valid inferred English title", journal: { ...canonical, document_number: null, title: "YEAR-END CLOSE 2025" }, expected: true },
      { name: "valid explicit year", journal: canonical, year: 2025, expected: true },
      { name: "missing date", journal: { ...canonical, effective_date: undefined as unknown as string }, expected: false },
      { name: "empty date", journal: { ...canonical, effective_date: "" }, expected: false },
      { name: "invalid date", journal: { ...canonical, effective_date: "not-a-date" }, expected: false },
      { name: "non-strict date prefix", journal: { ...canonical, effective_date: "x2025-12-31" }, expected: false },
      { name: "slash date", journal: { ...canonical, effective_date: "2025/12/31" }, expected: false },
      { name: "timestamp suffix", journal: { ...canonical, effective_date: "2025-12-31T00:00:00Z" }, expected: false },
      { name: "non-integer explicit year", journal: canonical, year: 2025.5, expected: false },
      { name: "too-small explicit year", journal: canonical, year: 999, expected: false },
      { name: "too-large explicit year", journal: canonical, year: 10000, expected: false },
      { name: "NaN explicit year", journal: canonical, year: Number.NaN, expected: false },
      { name: "infinite explicit year", journal: canonical, year: Number.POSITIVE_INFINITY, expected: false },
      { name: "wrong valid explicit year", journal: canonical, year: 2024, expected: false },
      { name: "midyear date", journal: { ...canonical, effective_date: "2025-06-30" }, expected: false },
      { name: "malformed document", journal: { ...canonical, document_number: "YECL-2025-extra", title: "ordinary" }, expected: false },
      { name: "prefix-only document", journal: { ...canonical, document_number: "YECL-", title: "ordinary" }, expected: false },
      { name: "ordinary journal", journal: { ...canonical, document_number: "ADJ-2025", title: "ordinary" }, expected: false },
    ];

    for (const vector of vectors) {
      expect.soft(detector(vector.journal, vector.year), vector.name).toBe(vector.expected);
    }
  });

  it("M20 recognition has no double effect or journal-order dependence", async () => {
    const overlapClose = makeM20ClosingJournal(1501, {
      effective_date: "2025-12-31",
      document_number: "YECL-2025",
      title: "Aasta lõppkanne 2025",
    });
    const titleOnlyClose = makeM20ClosingJournal(1502, {
      effective_date: "2025-12-31",
      title: "Year-End Close 2025",
    });
    const ordinaryJournal = makeM20ClosingJournal(1503, {
      effective_date: "2025-12-31",
      document_number: "ADJ-2025",
      title: "Ordinary year-end adjustment",
    });
    const forward = [...makeM20BaseJournals(), overlapClose, titleOnlyClose, ordinaryJournal];
    const reverse = [...makeM20BaseJournals(), ordinaryJournal, titleOnlyClose, overlapClose];

    const forwardPrepare = await m20Prepare(forward);
    const reversePrepare = await m20Prepare(reverse);
    const forwardProfit = await m20Profit(forward);
    const reverseProfit = await m20Profit(reverse);
    const forwardIds = forwardPrepare.existing_year_end_close_journals.map((journal: { id: number }) => journal.id);
    const reverseIds = reversePrepare.existing_year_end_close_journals.map((journal: { id: number }) => journal.id);

    expect.soft(forwardIds).toEqual([1501, 1502]);
    expect.soft(reverseIds).toEqual([1502, 1501]);
    expect.soft(forwardIds.filter((id: number) => id === 1501)).toHaveLength(1);
    expect.soft(reverseIds.filter((id: number) => id === 1501)).toHaveLength(1);
    expect.soft([forwardProfit, reverseProfit]).toEqual([0, 0]);
  });

  it("maps 8xxx FX gain/loss into 'Finantstulud ja -kulud' as a net (income − expense), not into unmapped", async () => {
    // The MCP books FX gain to 8500 (Tulud) and FX loss to 8600 (Kulud). Before
    // the financial range widened to 8000-8899 these fell into unmapped_accounts
    // and dropped out of net profit. They must now net into the financial line:
    // gain adds, loss subtracts.
    const fxAccounts: Account[] = [
      makeAccount({
        id: 8500, balance_type: "C", account_type_est: "Tulud", account_type_eng: "Revenue",
        name_est: "Kasum valuutakursi muutustest", name_eng: "FX gain",
      }),
      makeAccount({
        id: 8600, balance_type: "D", account_type_est: "Kulud", account_type_eng: "Expenses",
        name_est: "Kahjum valuutakursi muutustest", name_eng: "FX loss",
      }),
    ];
    const journals = [
      ...baseJournals,
      // FX gain 15 (income) and FX loss 6 (expense), both in the report year.
      makeJournal("2025-07-01", [makePosting(1000, "D", 15), makePosting(8500, "C", 15)]),
      makeJournal("2025-07-02", [makePosting(8600, "D", 6), makePosting(1000, "C", 6)]),
    ];

    const report = await buildAnnualReportData(
      createApi(journals, { extraAccounts: fxAccounts }),
      2025,
    );
    const is = report.income_statement_schema_1 as {
      arikasum: { amount: number };
      finantstulud_ja_kulud: { amount: number; source_accounts: Array<{ account_id: number; amount: number }> };
      kasum_enne_tulumaksustamist: { amount: number };
      aruandeaasta_puhaskasum: { amount: number };
      unmapped_accounts: Array<{ account_id: number }>;
    };

    // Operating profit is unchanged (revenue 60 − operating expense 10 = 50);
    // 8500/8600 are financial, not operating.
    expect(is.arikasum.amount).toBe(50);
    // Net financial result = 15 gain − 6 loss = 9.
    expect(is.finantstulud_ja_kulud.amount).toBe(9);
    expect(is.finantstulud_ja_kulud.source_accounts).toEqual(expect.arrayContaining([
      { account_id: 8500, name: "Kasum valuutakursi muutustest", amount: 15 },
      { account_id: 8600, name: "Kahjum valuutakursi muutustest", amount: -6 },
    ]));
    // Flows through to profit before tax and net profit.
    expect(is.kasum_enne_tulumaksustamist.amount).toBe(59);
    expect(is.aruandeaasta_puhaskasum.amount).toBe(59);
    // No longer stranded in unmapped.
    expect(is.unmapped_accounts.map((a) => a.account_id)).not.toContain(8500);
    expect(is.unmapped_accounts.map((a) => a.account_id)).not.toContain(8600);
  });

  it("prepare_year_end_close ignores VOID transactions in unresolved items", async () => {
    const handler = setupTool("prepare_year_end_close", {
      journals: baseJournals,
      transactions: [{
        id: 1,
        status: "VOID",
        is_deleted: false,
        type: "C",
        amount: 60,
        base_amount: 60,
        cl_currencies_id: "EUR",
        date: "2025-06-20",
        accounts_dimensions_id: 100,
        description: "Voided transfer",
      }],
    });

    const result = await handler({ year: 2025 });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.unresolved_items.unconfirmed_transactions.count).toBe(0);
    expect(payload.unresolved_items.total_issues).toBe(0);
  });

  it("prepare_year_end_close surfaces the RPS/ÄS statutory reminders (inventory, filing deadline, retention)", async () => {
    const handler = setupTool("prepare_year_end_close", { journals: baseJournals });

    const result = await handler({ year: 2025 });
    const payload = parseMcpResponse(result.content[0]!.text);

    const reminders = payload.statutory_reminders as string[];
    expect(reminders.some(r => r.includes("RPS § 15") && r.includes("inventeeri"))).toBe(true);
    expect(reminders.some(r => r.includes("ÄS § 179") && r.includes("6 kuu"))).toBe(true);
    expect(reminders.some(r => r.includes("RPS § 12") && r.includes("7 aastat"))).toBe(true);
  });

  it("prepare_year_end_close uses the standard 2970 current-year profit account by default", async () => {
    const handler = setupTool("prepare_year_end_close", {
      journals: baseJournals,
      extraAccounts: [
        makeAccount({
          id: 2970,
          balance_type: "C",
          account_type_est: "Omakapital",
          account_type_eng: "Equity",
          name_est: "Aruandeaasta kasum",
          name_eng: "Current year profit",
        }),
      ],
    });

    const result = await handler({ year: 2025 });
    const payload = parseMcpResponse(result.content[0]!.text);
    const closingEntry = payload.proposed_journal_entries.find((entry: { source: string }) => entry.source === "closing");

    expect(closingEntry.postings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accounts_id: 2970,
        account_name: "Aruandeaasta kasum",
        type: "C",
        amount: 50,
      }),
    ]));
    expect(closingEntry.rationale).toContain("account 2970");
  });

  it("prepare_year_end_close honors the configured current-year profit account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "earv-annual-rules-"));
    const rulesPath = join(dir, "accounting-rules.md");
    writeFileSync(rulesPath, `# Accounting Rules

## Annual Report
Current year profit account: 2999
`, "utf-8");
    process.env.EARVELDAJA_RULES_FILE = rulesPath;
    resetAccountingRulesCache();

    const handler = setupTool("prepare_year_end_close", {
      journals: baseJournals,
      extraAccounts: [
        makeAccount({
          id: 2999,
          balance_type: "C",
          account_type_est: "Omakapital",
          account_type_eng: "Equity",
          name_est: "Aruandeaasta kasum erikonto",
          name_eng: "Current year profit override",
        }),
      ],
    });

    const result = await handler({ year: 2025 });
    const payload = parseMcpResponse(result.content[0]!.text);
    const closingEntry = payload.proposed_journal_entries.find((entry: { source: string }) => entry.source === "closing");

    expect(closingEntry.postings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accounts_id: 2999,
        account_name: "Aruandeaasta kasum erikonto",
        type: "C",
        amount: 50,
      }),
    ]));
    expect(closingEntry.rationale).toContain("account 2999");

    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps non-loan liabilities in the balance sheet sections instead of dropping them", async () => {
    const report = await buildAnnualReportData(createApi([
      ...baseJournals,
      makeJournal("2025-12-31", [
        makePosting(1000, "D", 50),
        makePosting(2400, "C", 50),
      ]),
    ], {
      extraAccounts: [
        makeAccount({
          id: 2400,
          balance_type: "C",
          account_type_est: "Kohustused",
          account_type_eng: "Liabilities",
          name_est: "Muud lühiajalised kohustused",
          name_eng: "Other current liabilities",
        }),
      ],
    }), 2025);

    const liabilities = (report.balance_sheet as {
      liabilities: {
        luhiajalised_kohustused: { amount: number; source_accounts: Array<{ account_id: number }> };
        pikaajalised_kohustused: { amount: number };
        total_liabilities: number;
      };
    }).liabilities;

    expect(liabilities.luhiajalised_kohustused.amount).toBe(50);
    expect(liabilities.luhiajalised_kohustused.source_accounts).toEqual([
      expect.objectContaining({ account_id: 2400, amount: 50 }),
    ]);
    expect(liabilities.pikaajalised_kohustused.amount).toBe(0);
    expect(liabilities.total_liabilities).toBe(50);
  });

  it("classifies the english current portion of long-term debt as current", async () => {
    const report = await buildAnnualReportData(createApi([
      ...baseJournals,
      makeJournal("2025-12-31", [
        makePosting(1000, "D", 50),
        makePosting(2100, "C", 50),
      ]),
    ], {
      extraAccounts: [
        makeAccount({
          id: 2100,
          balance_type: "C",
          account_type_est: "Kohustused",
          account_type_eng: "Liabilities",
          name_est: "Loan",
          name_eng: "Current portion of long-term loan",
        }),
      ],
    }), 2025);

    const liabilities = (report.balance_sheet as {
      liabilities: {
        luhiajalised_kohustused: { amount: number; source_accounts: Array<{ account_id: number }> };
        pikaajalised_kohustused: { amount: number; source_accounts: Array<{ account_id: number }> };
      };
    }).liabilities;

    expect(liabilities.luhiajalised_kohustused.amount).toBe(50);
    expect(liabilities.luhiajalised_kohustused.source_accounts).toEqual([
      expect.objectContaining({ account_id: 2100, amount: 50 }),
    ]);
    expect(liabilities.pikaajalised_kohustused.amount).toBe(0);
    expect(liabilities.pikaajalised_kohustused.source_accounts).toEqual([]);
  });

  it("keeps the english non-current portion of long-term debt as non-current", async () => {
    const report = await buildAnnualReportData(createApi([
      ...baseJournals,
      makeJournal("2025-12-31", [
        makePosting(1000, "D", 50),
        makePosting(2900, "C", 50),
      ]),
    ], {
      extraAccounts: [
        makeAccount({
          id: 2900,
          balance_type: "C",
          account_type_est: "Kohustused",
          account_type_eng: "Liabilities",
          name_est: "Loan",
          name_eng: "Non-current portion of long-term loan",
        }),
      ],
    }), 2025);

    const liabilities = (report.balance_sheet as {
      liabilities: {
        luhiajalised_kohustused: { amount: number; source_accounts: Array<{ account_id: number }> };
        pikaajalised_kohustused: { amount: number; source_accounts: Array<{ account_id: number }> };
      };
    }).liabilities;

    expect(liabilities.luhiajalised_kohustused.amount).toBe(0);
    expect(liabilities.luhiajalised_kohustused.source_accounts).toEqual([]);
    expect(liabilities.pikaajalised_kohustused.amount).toBe(50);
    expect(liabilities.pikaajalised_kohustused.source_accounts).toEqual([
      expect.objectContaining({ account_id: 2900, amount: 50 }),
    ]);
  });

  it("classifies a 21xx owner payable as a current liability instead of unclassified", async () => {
    const report = await buildAnnualReportData(createApi([
      ...baseJournals,
      makeJournal("2025-12-31", [
        makePosting(1000, "D", 40),
        makePosting(2110, "C", 40),
      ]),
    ], {
      extraAccounts: [
        makeAccount({
          id: 2110,
          balance_type: "C",
          account_type_est: "Kohustused",
          account_type_eng: "Liabilities",
          name_est: "Võlg omanikule",
          name_eng: "Owner payable",
        }),
      ],
    }), 2025);

    const liabilities = (report.balance_sheet as {
      liabilities: {
        luhiajalised_kohustused: { amount: number; source_accounts: Array<{ account_id: number }> };
        klassifitseerimata_kohustused: { amount: number; source_accounts: Array<{ account_id: number }> };
      };
    }).liabilities;

    expect(liabilities.luhiajalised_kohustused.amount).toBe(40);
    expect(liabilities.luhiajalised_kohustused.source_accounts).toEqual([
      expect.objectContaining({ account_id: 2110, amount: 40 }),
    ]);
    expect(liabilities.klassifitseerimata_kohustused.amount).toBe(0);
    expect(liabilities.klassifitseerimata_kohustused.source_accounts).toEqual([]);
  });

  it("classifies an 11xx short-term financial asset as current so the asset lines reconcile", async () => {
    const report = await buildAnnualReportData(createApi([
      ...baseJournals,
      makeJournal("2025-12-31", [
        makePosting(1120, "D", 30),
        makePosting(1000, "C", 30),
      ]),
    ], {
      extraAccounts: [
        makeAccount({
          id: 1120,
          balance_type: "D",
          account_type_est: "Varad",
          account_type_eng: "Assets",
          name_est: "Maakleri rahakonto",
          name_eng: "Broker cash",
        }),
      ],
    }), 2025);

    const assets = (report.balance_sheet as {
      assets: {
        kaibevara: { amount: number; source_accounts: Array<{ account_id: number }> };
        pohivara: { amount: number };
        total_assets: number;
      };
    }).assets;

    expect(assets.kaibevara.source_accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ account_id: 1120, amount: 30 }),
    ]));
    // Bank 1000 (190) + broker cash 1120 (30) fully account for total assets.
    expect(assets.kaibevara.amount).toBe(220);
    expect(assets.pohivara.amount).toBe(0);
    expect(assets.total_assets).toBe(220);
    expect((report.warnings as string[]).some((w) => w.includes("neither asset line"))).toBe(false);
  });

  it("warns when an asset account falls outside the current/non-current balance-sheet ranges", async () => {
    const report = await buildAnnualReportData(createApi([
      ...baseJournals,
      makeJournal("2025-12-31", [
        makePosting(999, "D", 25),
        makePosting(1000, "C", 25),
      ]),
    ], {
      extraAccounts: [
        makeAccount({
          id: 999,
          balance_type: "D",
          account_type_est: "Varad",
          account_type_eng: "Assets",
          name_est: "Määramata vara",
          name_eng: "Unclassified asset",
        }),
      ],
    }), 2025);

    const assets = (report.balance_sheet as {
      assets: {
        kaibevara: { amount: number };
        pohivara: { amount: number };
        total_assets: number;
      };
    }).assets;

    // The mis-ranged 999 counts toward total assets but shows in neither line.
    expect(assets.kaibevara.amount).toBe(195);
    expect(assets.pohivara.amount).toBe(0);
    expect(assets.total_assets).toBe(220);
    const warning = (report.warnings as string[]).find((w) => w.includes("neither asset line"));
    expect(warning).toBeDefined();
    expect(warning).toContain("999");
  });
});
