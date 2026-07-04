import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Journal } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { buildAnnualReportData, registerAnnualReportTools } from "./annual-report.js";
import { parseMcpResponse } from "../mcp-json.js";
import { makePosting, makeJournal } from "../__fixtures__/accounting.js";
import { resetAccountingRulesCache } from "../accounting-rules.js";

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

describe("buildAnnualReportData", () => {
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
