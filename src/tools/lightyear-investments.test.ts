import { readFile } from "fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateFilePath } from "../file-validation.js";
import { parseMcpResponse } from "../mcp-json.js";
import { registerLightyearTools } from "./lightyear-investments.js";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../file-validation.js", () => ({
  validateFilePath: vi.fn(),
}));

vi.mock("../progress.js", () => ({
  reportProgress: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../audit-log.js", () => ({
  logAudit: vi.fn(),
}));

const mockedReadFile = vi.mocked(readFile);
const mockedValidateFilePath = vi.mocked(validateFilePath);

const STATEMENT_HEADER = [
  "Date", "Reference", "Ticker", "ISIN", "Type", "Quantity", "CCY",
  "Price/share", "Gross Amount", "FX Rate", "Fee", "Net Amt.", "Tax Amt.",
].join(",");

function csvRow(values: string[]): string {
  return values.map((value) => `"${value}"`).join(",");
}

function buildStatementCsv(rows: string[][]): string {
  return `${STATEMENT_HEADER}\n${rows.map(csvRow).join("\n")}\n`;
}

function setupLightyearTool(
  toolName: "parse_lightyear_statement" | "book_lightyear_trades",
  options: {
    journals?: unknown[];
    createImpl?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const server = { registerTool: vi.fn() } as any;
  const create = options.createImpl ?? vi.fn().mockResolvedValue({ created_object_id: 9001 });
  const api = {
    readonly: {
      getAccounts: vi.fn().mockResolvedValue([
        { id: 1120, is_deleted: false, code: "1120", title_est: "Lightyear konto" },
        { id: 1550, is_deleted: false, code: "1550", title_est: "Finantsinvesteeringud" },
        { id: 8610, is_deleted: false, code: "8610", title_est: "Muud finantskulud" },
        { id: 8320, is_deleted: false, code: "8320", title_est: "Investeeringutulu" },
      ]),
    },
    journals: {
      listAll: vi.fn().mockResolvedValue(options.journals ?? []),
      create,
    },
  } as any;

  registerLightyearTools(server, api);

  const registration = server.registerTool.mock.calls.find(([name]) => name === toolName);
  if (!registration) throw new Error(`Tool was not registered: ${toolName}`);

  return {
    api,
    handler: registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>,
  };
}

describe("lightyear investments tools", () => {
  beforeEach(() => {
    mockedValidateFilePath.mockResolvedValue("/tmp/lightyear.csv");
    mockedReadFile.mockReset();
  });

  it("keeps BRICEKSP buy/sell rows out of booked trades while leaving reconciliation balanced", async () => {
    mockedReadFile.mockResolvedValue(buildStatementCsv([
      ["10/03/2026 11:51:35", "OR-BRICE-BUY", "BRICEKSP", "IE000GWTNRJ7", "Buy", "900.000000000", "EUR", "1.000000000", "900.00", "", "0.00", "900.00", ""],
      ["10/03/2026 16:46:39", "OR-BRICE-SELL", "BRICEKSP", "IE000GWTNRJ7", "Sell", "150.000000000", "EUR", "1.000000000", "150.00", "", "0.00", "150.00", ""],
    ]));

    const { handler } = setupLightyearTool("parse_lightyear_statement");
    const result = await handler({
      file_path: "/tmp/lightyear.csv",
    });

    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.trades.count).toBe(0);
    expect(payload.cash_equivalent_skipped).toEqual(expect.objectContaining({
      count: 2,
      by_ticker: {
        BRICEKSP: { buys: 1, sells: 1 },
      },
    }));
    expect(payload.cash_reconciliation.is_balanced).toBe(true);
    expect(payload.unhandled).toBeUndefined();
  });

  it("does not flag matched ICSUSSDP sell plus conversion plus withdrawal as unhandled", async () => {
    mockedReadFile.mockResolvedValue(buildStatementCsv([
      ["10/11/2025 13:40:29", "CN-GZUJLSKLL2", "", "", "Conversion", "", "EUR", "", "1126.28", "1.15709", "", "1126.28", ""],
      ["10/11/2025 13:40:29", "CN-GZUJLSKLL2", "", "", "Conversion", "", "USD", "", "-1307.80", "0.86423", "4.58", "-1303.22", ""],
      ["10/11/2025 08:51:32", "OR-ARAW6RQL67", "ICSUSSDP", "IE00B44BQ083", "Sell", "1307.800000000", "USD", "1.000000000", "1307.80", "", "0.00", "1307.80", ""],
      ["10/11/2025 13:41:37", "WL-5NMF7K3N8S", "", "", "Withdrawal", "", "EUR", "", "-1126.28", "", "", "-1126.28", ""],
    ]));

    const { handler } = setupLightyearTool("parse_lightyear_statement");
    const result = await handler({
      file_path: "/tmp/lightyear.csv",
    });

    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload.trades.count).toBe(0);
    expect(payload.cash_equivalent_skipped).toEqual(expect.objectContaining({
      count: 1,
      by_ticker: {
        ICSUSSDP: { buys: 0, sells: 1 },
      },
    }));
    expect(payload.cash_reconciliation.is_balanced).toBe(true);
    expect(payload.unhandled).toBeUndefined();
  });

  it("skips cash-equivalent tickers by default when booking trades", async () => {
    mockedReadFile.mockResolvedValue(buildStatementCsv([
      ["10/03/2026 11:51:35", "OR-BRICE-BUY", "BRICEKSP", "IE000GWTNRJ7", "Buy", "900.000000000", "EUR", "1.000000000", "900.00", "", "0.00", "900.00", ""],
      ["10/03/2026 16:46:39", "OR-BRICE-SELL", "BRICEKSP", "IE000GWTNRJ7", "Sell", "150.000000000", "EUR", "1.000000000", "150.00", "", "0.00", "150.00", ""],
    ]));

    const { api, handler } = setupLightyearTool("book_lightyear_trades");
    const result = await handler({
      file_path: "/tmp/lightyear.csv",
      investment_account: 1550,
      broker_account: 1120,
      dry_run: false,
    });

    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(api.journals.create).not.toHaveBeenCalled();
    expect(payload.total_trades).toBe(0);
    expect(payload.created).toBe(0);
    expect(payload.duplicates_skipped).toBe(0);
  });

  it("books EUR cash-equivalent sells 1:1 when skip_tickers is disabled", async () => {
    mockedReadFile.mockResolvedValue(buildStatementCsv([
      ["10/03/2026 11:51:35", "OR-BRICE-BUY", "BRICEKSP", "IE000GWTNRJ7", "Buy", "900.000000000", "EUR", "1.000000000", "900.00", "", "0.00", "900.00", ""],
      ["10/03/2026 16:46:39", "OR-BRICE-SELL", "BRICEKSP", "IE000GWTNRJ7", "Sell", "150.000000000", "EUR", "1.000000000", "150.00", "", "0.00", "150.00", ""],
    ]));

    const createdPostings: unknown[][] = [];
    const create = vi.fn(async (payload: any) => {
      createdPostings.push(payload.postings);
      return { created_object_id: 5000 + createdPostings.length };
    });

    const { api, handler } = setupLightyearTool("book_lightyear_trades", { createImpl: create });
    const result = await handler({
      file_path: "/tmp/lightyear.csv",
      investment_account: 1550,
      broker_account: 1120,
      skip_tickers: "none",
      dry_run: false,
    });

    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(api.journals.create).toHaveBeenCalledTimes(2);
    expect(payload.total_trades).toBe(2);
    expect(payload.created).toBe(2);
    expect(payload.skipped).toBe(0);

    const sellPostings = createdPostings[1]!;
    expect(sellPostings).toEqual([
      { accounts_id: 1120, type: "D", amount: 150 },
      { accounts_id: 1550, type: "C", amount: 150 },
    ]);
    const sellResult = payload.results.find((r: any) => r.reference === "OR-BRICE-SELL");
    expect(sellResult).toEqual(expect.objectContaining({
      status: "created",
      cost_basis: 150,
      gain_loss: 0,
    }));
  });

  it("skips non-EUR cash-equivalent sells without cost basis to avoid FX drift", async () => {
    mockedReadFile.mockResolvedValue(buildStatementCsv([
      ["10/11/2025 13:40:29", "CN-GZUJLSKLL2", "", "", "Conversion", "", "EUR", "", "1126.28", "1.15709", "", "1126.28", ""],
      ["10/11/2025 13:40:29", "CN-GZUJLSKLL2", "", "", "Conversion", "", "USD", "", "-1307.80", "0.86423", "4.58", "-1303.22", ""],
      ["10/11/2025 08:51:32", "OR-ARAW6RQL67", "ICSUSSDP", "IE00B44BQ083", "Sell", "1307.800000000", "USD", "1.000000000", "1307.80", "", "0.00", "1307.80", ""],
    ]));

    const { api, handler } = setupLightyearTool("book_lightyear_trades");
    const result = await handler({
      file_path: "/tmp/lightyear.csv",
      investment_account: 1550,
      broker_account: 1120,
      skip_tickers: "none",
      dry_run: false,
    });

    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(api.journals.create).not.toHaveBeenCalled();
    expect(payload.created).toBe(0);
    expect(payload.skipped).toBe(1);
    const skipped = payload.results[0];
    expect(skipped).toEqual(expect.objectContaining({
      reference: "OR-ARAW6RQL67",
      ticker: "ICSUSSDP",
      status: "skipped",
    }));
    expect(skipped.skip_reason).toMatch(/Non-EUR cash-equivalent/);
  });

  it("treats empty skip_tickers as the default skip list", async () => {
    mockedReadFile.mockResolvedValue(buildStatementCsv([
      ["10/03/2026 11:51:35", "OR-BRICE-BUY", "BRICEKSP", "IE000GWTNRJ7", "Buy", "900.000000000", "EUR", "1.000000000", "900.00", "", "0.00", "900.00", ""],
    ]));

    const { api, handler } = setupLightyearTool("book_lightyear_trades");
    const result = await handler({
      file_path: "/tmp/lightyear.csv",
      investment_account: 1550,
      broker_account: 1120,
      skip_tickers: "",
      dry_run: false,
    });

    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(api.journals.create).not.toHaveBeenCalled();
    expect(payload.total_trades).toBe(0);
    expect(payload.created).toBe(0);
  });

  it("recognizes legacy raw OR document numbers as duplicates", async () => {
    mockedReadFile.mockResolvedValue(buildStatementCsv([
      ["21/06/2024 13:41:19", "OR-VUAA-BUY", "VUAA", "IE00BFMXXD54", "Buy", "4.000000000", "EUR", "96.656000000", "386.62", "", "0.00", "386.62", ""],
    ]));

    const { api, handler } = setupLightyearTool("book_lightyear_trades", {
      journals: [{
        is_deleted: false,
        document_number: "OR-VUAA-BUY",
      }],
    });
    const result = await handler({
      file_path: "/tmp/lightyear.csv",
      investment_account: 1550,
      broker_account: 1120,
      dry_run: false,
    });

    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(api.journals.create).not.toHaveBeenCalled();
    expect(payload.duplicates_skipped).toBe(1);
    expect(payload.duplicate_refs).toEqual([
      { reference: "OR-VUAA-BUY", ticker: "VUAA", date: "2024-06-21" },
    ]);
  });
});
