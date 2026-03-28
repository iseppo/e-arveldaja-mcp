import { describe, expect, it, vi } from "vitest";
import type { Account, Journal } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { buildAnnualReportData, registerAnnualReportTools } from "./annual-report.js";
import { parseMcpResponse } from "../mcp-json.js";
import { makePosting, makeJournal } from "../__fixtures__/accounting.js";

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
      id: 3310,
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
  } = {},
): (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> {
  const server = { registerTool: vi.fn() } as any;
  const api = createApi(options.journals ?? [], { transactions: options.transactions });
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
    expect(equity.accounts.flatMap((line) => line.source_accounts.map((account) => account.account_id))).not.toContain(3310);
    expect(equity.current_year_result.amount).toBe(50);
    expect(equity.current_year_result.source_accounts).toEqual([]);
    expect(equity.total_equity).toBe(220);
  });

  it("keeps the income statement populated after YECL close journals and surfaces 3310 in the equity section", async () => {
    const closingJournal = makeJournal("2025-12-31", [
      makePosting(3001, "D", 60),
      makePosting(5000, "C", 10),
      makePosting(3310, "C", 50),
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
        account_id: 3310,
        name: "Aruandeaasta kasum",
        amount: 50,
      },
    ]);
    expect(equity.total_equity).toBe(220);
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
});
