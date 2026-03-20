import { readFile } from "fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateFilePath } from "../file-validation.js";
import { registerWiseImportTools } from "./wise-import.js";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../file-validation.js", () => ({
  validateFilePath: vi.fn(),
}));

vi.mock("../progress.js", () => ({
  reportProgress: vi.fn().mockResolvedValue(undefined),
}));

const mockedReadFile = vi.mocked(readFile);
const mockedValidateFilePath = vi.mocked(validateFilePath);

const CSV_HEADER = [
  "ID", "Status", "Direction", "Created on", "Finished on",
  "Source fee amount", "Source fee currency", "Target fee amount", "Target fee currency",
  "Source name", "Source amount (after fees)", "Source currency",
  "Target name", "Target amount (after fees)", "Target currency",
  "Exchange rate", "Reference", "Batch", "Created by", "Category", "Note",
].join(",");

function buildCsvRow(values: string[]): string {
  return `${CSV_HEADER}\n${values.join(",")}\n`;
}

function setupWiseTool(existingTransactions: unknown[], createImpl?: ReturnType<typeof vi.fn>) {
  const server = { registerTool: vi.fn() } as any;
  const create = createImpl ?? vi.fn().mockResolvedValue({ created_object_id: 9001 });
  const api = {
    clients: {
      listAll: vi.fn().mockResolvedValue([{ id: 77, name: "Wise" }]),
    },
    transactions: {
      listAll: vi.fn().mockResolvedValue(existingTransactions),
      create,
      confirm: vi.fn().mockResolvedValue({}),
    },
  } as any;

  registerWiseImportTools(server, api);

  const registration = server.registerTool.mock.calls.find(([name]) => name === "import_wise_transactions");
  if (!registration) throw new Error("Tool was not registered");

  return {
    api,
    handler: registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>,
  };
}

describe("wise import tool", () => {
  beforeEach(() => {
    mockedValidateFilePath.mockResolvedValue("/tmp/wise.csv");
    mockedReadFile.mockReset();
  });

  it("skips legacy duplicates even when existing rows do not contain a WISE id prefix", async () => {
    mockedReadFile.mockResolvedValue(buildCsvRow([
      "abc-1", "COMPLETED", "OUT", "2026-01-10 09:00:00", "2026-01-10 09:00:00",
      "0", "EUR", "0", "EUR",
      "Seppo OU", "12.5", "EUR",
      "Acme Ltd", "12.5", "EUR",
      "1", "INV-1", "", "", "General", "",
    ]));

    const { api, handler } = setupWiseTool([{
      date: "2026-01-10",
      amount: 12.5,
      bank_account_name: "Acme Ltd",
      ref_number: "INV-1",
      description: "Acme Ltd",
    }]);

    const result = await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      fee_account_relation_id: 9,
      execute: true,
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(api.transactions.create).not.toHaveBeenCalled();
    expect(payload.skipped_details).toEqual([
      { wise_id: "abc-1", reason: "Already imported (date/amount/counterparty/reference match)" },
    ]);
  });

  it("skips duplicate fee rows independently from the main transaction", async () => {
    mockedReadFile.mockResolvedValue(buildCsvRow([
      "abc-2", "COMPLETED", "OUT", "2026-01-11 09:00:00", "2026-01-11 09:00:00",
      "1.2", "EUR", "0", "EUR",
      "Seppo OU", "25", "EUR",
      "Acme Ltd", "25", "EUR",
      "1", "INV-2", "", "", "General", "",
    ]));

    const create = vi.fn().mockResolvedValue({ created_object_id: 9002 });
    const { api, handler } = setupWiseTool([{
      date: "2026-01-11",
      amount: 1.2,
      bank_account_name: "Wise",
      description: "Wise teenustasu",
    }], create);

    const result = await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      fee_account_relation_id: 9,
      execute: true,
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(api.transactions.create).toHaveBeenCalledTimes(1);
    expect(payload.skipped_details).toEqual([
      { wise_id: "FEE:abc-2", reason: "Fee already imported (date/amount/counterparty match)" },
    ]);
  });
});
