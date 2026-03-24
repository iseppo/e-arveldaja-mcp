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

function setupWiseTool(
  existingTransactions: unknown[],
  createImpl?: ReturnType<typeof vi.fn>,
  options: {
    accountDimensions?: unknown[];
    journals?: unknown[];
    bankAccounts?: unknown[];
    invoiceInfo?: unknown;
    findByNameResult?: unknown[];
  } = {},
) {
  const server = { registerTool: vi.fn() } as any;
  const create = createImpl ?? vi.fn().mockResolvedValue({ created_object_id: 9001 });
  const api = {
    clients: {
      listAll: vi.fn().mockResolvedValue([{ id: 77, name: "Wise" }]),
      findByName: vi.fn().mockResolvedValue(options.findByNameResult ?? []),
    },
    readonly: {
      getAccountDimensions: vi.fn().mockResolvedValue(options.accountDimensions ?? [{
        id: 9,
        accounts_id: 8610,
        title_est: "Muud finantskulud",
        is_deleted: false,
      }]),
      getBankAccounts: vi.fn().mockResolvedValue(options.bankAccounts ?? []),
      getInvoiceInfo: vi.fn().mockResolvedValue(options.invoiceInfo ?? {}),
    },
    journals: {
      listAllWithPostings: vi.fn().mockResolvedValue(options.journals ?? []),
    },
    transactions: {
      listAll: vi.fn().mockResolvedValue(existingTransactions),
      create,
      update: vi.fn().mockResolvedValue({}),
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

  it("does not treat VOID transactions as duplicates", async () => {
    mockedReadFile.mockResolvedValue(buildCsvRow([
      "void-1", "COMPLETED", "OUT", "2026-01-09 09:00:00", "2026-01-09 09:00:00",
      "0", "EUR", "0", "EUR",
      "Seppo OU", "12.5", "EUR",
      "Acme Ltd", "12.5", "EUR",
      "1", "INV-VOID", "", "", "General", "",
    ]));

    const { api, handler } = setupWiseTool([{
      status: "VOID",
      is_deleted: false,
      date: "2026-01-09",
      amount: 12.5,
      bank_account_name: "Acme Ltd",
      ref_number: "INV-VOID",
      description: "Acme Ltd",
    }]);

    const result = await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      fee_account_dimensions_id: 9,
      execute: true,
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(api.transactions.create).toHaveBeenCalledTimes(1);
    expect(payload.skipped_details).toEqual([]);
    expect(payload.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ wise_id: "void-1" }),
    ]));
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
      fee_account_dimensions_id: 9,
      execute: true,
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(api.transactions.create).not.toHaveBeenCalled();
    expect(payload.skipped_details).toEqual([
      { reason: "Already imported (date/amount/counterparty/reference match)", count: 1, sample_ids: ["abc-1"] },
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
      fee_account_dimensions_id: 9,
      execute: true,
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(api.transactions.create).toHaveBeenCalledTimes(1);
    expect(payload.skipped_details).toEqual([
      { reason: "Fee already imported (date/amount/counterparty match)", count: 1, sample_ids: ["FEE:abc-2"] },
    ]);
  });

  it("can create a missing fee row on rerun even when the main Wise transaction already exists", async () => {
    mockedReadFile.mockResolvedValue(buildCsvRow([
      "abc-3", "COMPLETED", "OUT", "2026-01-12 09:00:00", "2026-01-12 09:00:00",
      "1.5", "EUR", "0", "EUR",
      "Seppo OU", "40", "EUR",
      "Acme Ltd", "40", "EUR",
      "1", "INV-3", "", "", "General", "",
    ]));

    const create = vi.fn().mockResolvedValue({ created_object_id: 9003 });
    const { api, handler } = setupWiseTool([{
      date: "2026-01-12",
      amount: 40,
      bank_account_name: "Acme Ltd",
      ref_number: "INV-3",
      description: "Acme Ltd",
    }], create);

    const result = await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      fee_account_dimensions_id: 9,
      execute: true,
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(api.transactions.create).toHaveBeenCalledTimes(1);
    expect(api.transactions.confirm).toHaveBeenCalledWith(9003, [
      { related_table: "accounts", related_id: 8610, related_sub_id: 9, amount: 1.5 },
    ]);
    expect(api.transactions.create).toHaveBeenCalledWith(expect.objectContaining({
      description: "WISE:FEE:abc-3 Wise teenustasu",
    }));
    expect(payload.skipped_details).toContainEqual(
      expect.objectContaining({ reason: "Already imported (date/amount/counterparty/reference match)", sample_ids: expect.arrayContaining(["abc-3"]) }),
    );
    expect(payload.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        wise_id: "FEE:abc-3",
        status: "created_and_confirmed",
      }),
    ]));
  });

  it("does not create an orphan fee row when main transaction creation fails", async () => {
    mockedReadFile.mockResolvedValue(buildCsvRow([
      "abc-4", "COMPLETED", "OUT", "2026-01-13 09:00:00", "2026-01-13 09:00:00",
      "2.5", "EUR", "0", "EUR",
      "Seppo OU", "50", "EUR",
      "Acme Ltd", "50", "EUR",
      "1", "INV-4", "", "", "General", "",
    ]));

    const create = vi.fn().mockRejectedValue(new Error("Main create failed"));
    const { api, handler } = setupWiseTool([], create);

    const result = await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      fee_account_dimensions_id: 9,
      execute: true,
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(api.transactions.create).toHaveBeenCalledTimes(1);
    expect(payload.results).toEqual([]);
    expect(payload.skipped_details).toEqual(expect.arrayContaining([
      { reason: "Main create failed", count: 1, sample_ids: ["abc-4"] },
      { reason: "Skipped because main transaction was not created", count: 1, sample_ids: ["FEE:abc-4"] },
    ]));
  });

  it("skips Jar transfers by default", async () => {
    mockedReadFile.mockResolvedValue([
      CSV_HEADER,
      // Jar transfer: category contains "Jar"
      ["jar-1", "COMPLETED", "OUT", "2026-01-20 09:00:00", "2026-01-20 09:00:00",
       "0", "EUR", "0", "EUR",
       "Seppo AI OÜ", "100", "EUR",
       "Seppo AI OÜ", "100", "EUR",
       "1", "", "", "", "Jar transfer", "Holiday fund"].join(","),
      // Self-transfer: same source and target name
      ["jar-2", "COMPLETED", "IN", "2026-01-21 09:00:00", "2026-01-21 09:00:00",
       "0", "EUR", "0", "EUR",
       "Seppo AI OÜ", "50", "EUR",
       "Seppo AI OÜ", "50", "EUR",
       "1", "", "", "", "General", ""].join(","),
      // Normal transaction: should NOT be skipped
      ["normal-1", "COMPLETED", "OUT", "2026-01-22 09:00:00", "2026-01-22 09:00:00",
       "0", "EUR", "0", "EUR",
       "Seppo AI OÜ", "25", "EUR",
       "Acme Ltd", "25", "EUR",
       "1", "INV-99", "", "", "General", ""].join(","),
    ].join("\n"));

    const { handler } = setupWiseTool([]);

    const result = await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      fee_account_dimensions_id: 9,
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.skipped_jar_transfers).toBe(2);
    expect(payload.eligible).toBe(1);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]!.wise_id).toBe("normal-1");
  });

  it("includes Jar transfers when skip_jar_transfers=false", async () => {
    mockedReadFile.mockResolvedValue([
      CSV_HEADER,
      ["jar-3", "COMPLETED", "OUT", "2026-01-20 09:00:00", "2026-01-20 09:00:00",
       "0", "EUR", "0", "EUR",
       "Seppo AI OÜ", "100", "EUR",
       "Seppo AI OÜ", "100", "EUR",
       "1", "", "", "", "Jar transfer", ""].join(","),
    ].join("\n"));

    const { handler } = setupWiseTool([]);

    const result = await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      fee_account_dimensions_id: 9,
      skip_jar_transfers: false,
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.skipped_jar_transfers).toBeUndefined();
    expect(payload.eligible).toBe(1);
  });

  it("skips note-based Jar transfers in CRLF exports", async () => {
    mockedReadFile.mockResolvedValue([
      CSV_HEADER,
      ["jar-crlf-1", "COMPLETED", "OUT", "2026-01-23 09:00:00", "2026-01-23 09:00:00",
       "0", "EUR", "0", "EUR",
       "Seppo AI OÜ", "100", "EUR",
       "Savings Pot", "100", "EUR",
       "1", "", "", "", "General", "Jar top-up"].join(","),
    ].join("\r\n") + "\r\n");

    const { handler } = setupWiseTool([]);

    const result = await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      fee_account_dimensions_id: 9,
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.skipped_jar_transfers).toBe(1);
    expect(payload.eligible).toBe(0);
    expect(payload.results).toEqual([]);
  });

  it("maps IN rows to incoming transactions and uses the source side as counterparty", async () => {
    mockedReadFile.mockResolvedValue(buildCsvRow([
      "abc-5", "COMPLETED", "IN", "2026-01-14 09:00:00", "2026-01-14 09:00:00",
      "0", "EUR", "0", "EUR",
      "Customer OU", "125", "EUR",
      "Seppo AI OÜ", "125", "EUR",
      "1", "PAY-5", "", "", "General", "",
    ]));

    const create = vi.fn().mockResolvedValue({ created_object_id: 9005 });
    const { api, handler } = setupWiseTool([], create);

    await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      fee_account_dimensions_id: 9,
      execute: true,
    });

    expect(api.transactions.create).toHaveBeenCalledWith(expect.objectContaining({
      type: "D",
      amount: 125,
      bank_account_name: "Customer OU",
      description: "WISE:abc-5 Customer OU",
      ref_number: "PAY-5",
    }));
  });

  it("preserves non-EUR source currencies for Wise transactions and fees", async () => {
    mockedReadFile.mockResolvedValue(buildCsvRow([
      "fx-1", "COMPLETED", "OUT", "2026-01-15 09:00:00", "2026-01-15 09:00:00",
      "1.5", "USD", "0", "USD",
      "Seppo AI OÜ", "100", "USD",
      "Acme Ltd", "100", "USD",
      "1", "INV-FX", "", "", "General", "",
    ]));

    const create = vi.fn()
      .mockResolvedValueOnce({ created_object_id: 9010 })
      .mockResolvedValueOnce({ created_object_id: 9011 });
    const { api, handler } = setupWiseTool([], create);

    await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      fee_account_dimensions_id: 9,
      execute: true,
    });

    expect(api.transactions.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      amount: 100,
      cl_currencies_id: "USD",
      description: "WISE:fx-1 Acme Ltd",
    }));
    expect(api.transactions.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      amount: 1.5,
      cl_currencies_id: "USD",
      description: "WISE:FEE:fx-1 Wise teenustasu",
    }));
  });

  it("uses the target-side amount, currency, and fee for incoming FX rows", async () => {
    mockedReadFile.mockResolvedValue(buildCsvRow([
      "fx-in-1", "COMPLETED", "IN", "2026-01-16 09:00:00", "2026-01-16 09:00:00",
      "0", "USD", "2", "EUR",
      "Customer Inc", "100", "USD",
      "Seppo AI OÜ", "92", "EUR",
      "0.92", "PAY-FX-IN", "", "", "General", "",
    ]));

    const create = vi.fn()
      .mockResolvedValueOnce({ created_object_id: 9020 })
      .mockResolvedValueOnce({ created_object_id: 9021 });
    const { api, handler } = setupWiseTool([], create);

    await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      fee_account_dimensions_id: 9,
      execute: true,
    });

    expect(api.transactions.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: "D",
      amount: 92,
      cl_currencies_id: "EUR",
      bank_account_name: "Customer Inc",
      description: "WISE:fx-in-1 Customer Inc [100 USD @ 0.92]",
      ref_number: "PAY-FX-IN",
    }));
    expect(api.transactions.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: "C",
      amount: 2,
      cl_currencies_id: "EUR",
      description: "WISE:FEE:fx-in-1 Wise teenustasu",
    }));
  });

  it("requires fee_account_dimensions_id when an incoming row has only a target-side fee", async () => {
    mockedReadFile.mockResolvedValue(buildCsvRow([
      "fx-in-fee-1", "COMPLETED", "IN", "2026-01-18 09:00:00", "2026-01-18 09:00:00",
      "0", "USD", "2", "EUR",
      "Customer Inc", "100", "USD",
      "Seppo AI OÜ", "92", "EUR",
      "0.92", "PAY-FX-FEE", "", "", "General", "",
    ]));

    const { handler } = setupWiseTool([]);

    await expect(handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
    })).rejects.toThrow("Wise fee rows require fee_account_dimensions_id");
  });

  it("does not require fee_account_dimensions_id when only filtered-out rows have fees", async () => {
    mockedReadFile.mockResolvedValue([
      CSV_HEADER,
      ["fee-old-1", "COMPLETED", "OUT", "2026-01-10 09:00:00", "2026-01-10 09:00:00",
       "1.5", "EUR", "0", "EUR",
       "Seppo AI OÜ", "40", "EUR",
       "Acme Ltd", "40", "EUR",
       "1", "INV-OLD", "", "", "General", ""].join(","),
      ["normal-new-1", "COMPLETED", "OUT", "2026-01-22 09:00:00", "2026-01-22 09:00:00",
       "0", "EUR", "0", "EUR",
       "Seppo AI OÜ", "25", "EUR",
       "Acme Ltd", "25", "EUR",
       "1", "INV-NEW", "", "", "General", ""].join(","),
    ].join("\n"));

    const { handler } = setupWiseTool([]);

    const result = await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      date_from: "2026-01-20",
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.eligible).toBe(1);
    expect(payload.created).toBe(1);
    expect(payload.results).toEqual([
      expect.objectContaining({
        wise_id: "normal-new-1",
        status: "would_create",
      }),
    ]);
  });

  it("does not treat same-amount rows in different currencies as duplicates", async () => {
    mockedReadFile.mockResolvedValue(buildCsvRow([
      "fx-dup-1", "COMPLETED", "OUT", "2026-01-17 09:00:00", "2026-01-17 09:00:00",
      "0", "USD", "0", "USD",
      "Seppo AI OÜ", "100", "USD",
      "Acme Ltd", "100", "USD",
      "1", "INV-DUP", "", "", "General", "",
    ]));

    const create = vi.fn().mockResolvedValue({ created_object_id: 9030 });
    const { api, handler } = setupWiseTool([{
      date: "2026-01-17",
      amount: 100,
      cl_currencies_id: "EUR",
      bank_account_name: "Acme Ltd",
      ref_number: "INV-DUP",
      description: "Acme Ltd",
    }], create);

    const result = await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      fee_account_dimensions_id: 9,
      execute: true,
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(api.transactions.create).toHaveBeenCalledTimes(1);
    expect(api.transactions.create).toHaveBeenCalledWith(expect.objectContaining({
      amount: 100,
      cl_currencies_id: "USD",
      description: "WISE:fx-dup-1 Acme Ltd",
    }));
    expect(payload.skipped_details).toEqual([]);
  });

  it("leaves transfer unconfirmed when already journalized from other side", async () => {
    mockedReadFile.mockResolvedValue(buildCsvRow([
      "TRANSFER-xfer-1", "COMPLETED", "IN", "2026-02-01 10:00:00", "2026-02-01 10:00:00",
      "0", "EUR", "0", "EUR",
      "LHV Bank", "500", "EUR",
      "Seppo AI OÜ", "500", "EUR",
      "1", "", "", "", "General", "",
    ]));

    // accounts_dimensions_id=5 (Wise), inter_account_dimension_id=20 (LHV)
    // Existing journal has postings from LHV(dim=20) to Wise(dim=5) for 500 EUR on 2026-02-01
    const existingJournal = {
      id: 111,
      is_deleted: false,
      registered: true,
      effective_date: "2026-02-01",
      postings: [
        { is_deleted: false, accounts_dimensions_id: 5,  type: "D", amount: 500, base_amount: 500 },
        { is_deleted: false, accounts_dimensions_id: 20, type: "C", amount: 500, base_amount: 500 },
      ],
    };

    const create = vi.fn().mockResolvedValue({ created_object_id: 9100 });
    const { api, handler } = setupWiseTool([], create, {
      accountDimensions: [
        { id: 5,  accounts_id: 1010, title_est: "Wise", is_deleted: false },
        { id: 20, accounts_id: 1020, title_est: "LHV",  is_deleted: false },
      ],
      journals: [existingJournal],
      bankAccounts: [
        { accounts_dimensions_id: 5 },
        { accounts_dimensions_id: 20 },
      ],
    });

    const result = await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      inter_account_dimension_id: 20,
      execute: true,
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.inter_account_reconciliation).toBeDefined();
    expect(payload.inter_account_reconciliation.already_journalized).toBe(1);
    expect(payload.inter_account_reconciliation.confirmed).toBe(0);
    expect(api.transactions.confirm).not.toHaveBeenCalled();
  });

  it("auto-confirms transfer against other bank account when not journalized", async () => {
    mockedReadFile.mockResolvedValue(buildCsvRow([
      "TRANSFER-xfer-2", "COMPLETED", "IN", "2026-02-05 10:00:00", "2026-02-05 10:00:00",
      "0", "EUR", "0", "EUR",
      "LHV Bank", "750", "EUR",
      "Seppo AI OÜ", "750", "EUR",
      "1", "", "", "", "General", "",
    ]));

    const create = vi.fn().mockResolvedValue({ created_object_id: 9200 });
    const { api, handler } = setupWiseTool([], create, {
      accountDimensions: [
        { id: 5,  accounts_id: 1010, title_est: "Wise", is_deleted: false },
        { id: 20, accounts_id: 1020, title_est: "LHV",  is_deleted: false },
      ],
      journals: [],
      bankAccounts: [
        { accounts_dimensions_id: 5 },
        { accounts_dimensions_id: 20 },
      ],
      invoiceInfo: { invoice_company_name: "Seppo AI OÜ" },
      findByNameResult: [{ id: 55, name: "Seppo AI OÜ" }],
    });

    const result = await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      inter_account_dimension_id: 20,
      execute: true,
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.inter_account_reconciliation).toBeDefined();
    expect(payload.inter_account_reconciliation.confirmed).toBe(1);
    expect(payload.inter_account_reconciliation.already_journalized).toBe(0);
    expect(api.transactions.confirm).toHaveBeenCalledWith(9200, [{
      related_table: "accounts",
      related_id: 1020,
      related_sub_id: 20,
      amount: 750,
    }]);
  });

  it("dry run reports would_create for transfer rows and does not call confirm", async () => {
    mockedReadFile.mockResolvedValue(buildCsvRow([
      "TRANSFER-xfer-3", "COMPLETED", "IN", "2026-02-10 10:00:00", "2026-02-10 10:00:00",
      "0", "EUR", "0", "EUR",
      "LHV Bank", "200", "EUR",
      "Seppo AI OÜ", "200", "EUR",
      "1", "", "", "", "General", "",
    ]));

    const { api, handler } = setupWiseTool([], undefined, {
      accountDimensions: [
        { id: 5,  accounts_id: 1010, title_est: "Wise", is_deleted: false },
        { id: 20, accounts_id: 1020, title_est: "LHV",  is_deleted: false },
      ],
      bankAccounts: [
        { accounts_dimensions_id: 5 },
        { accounts_dimensions_id: 20 },
      ],
    });

    const result = await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      inter_account_dimension_id: 20,
      // execute not set → dry run
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.mode).toBe("DRY_RUN");
    // In dry run, transfer rows are staged as would_create; no reconciliation is attempted
    expect(payload.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        wise_id: "TRANSFER-xfer-3",
        status: "would_create",
      }),
    ]));
    expect(api.transactions.confirm).not.toHaveBeenCalled();
    expect(api.journals.listAllWithPostings).not.toHaveBeenCalled();
  });

  it("auto-detects target bank account when only one other exists", async () => {
    mockedReadFile.mockResolvedValue(buildCsvRow([
      "TRANSFER-xfer-4", "COMPLETED", "IN", "2026-02-15 10:00:00", "2026-02-15 10:00:00",
      "0", "EUR", "0", "EUR",
      "LHV Bank", "300", "EUR",
      "Seppo AI OÜ", "300", "EUR",
      "1", "", "", "", "General", "",
    ]));

    const create = vi.fn().mockResolvedValue({ created_object_id: 9300 });
    const { api, handler } = setupWiseTool([], create, {
      accountDimensions: [
        { id: 5,  accounts_id: 1010, title_est: "Wise", is_deleted: false },
        { id: 30, accounts_id: 1030, title_est: "LHV",  is_deleted: false },
      ],
      journals: [],
      // Only one other bank account (dim=30), so auto-detection should pick it
      bankAccounts: [
        { accounts_dimensions_id: 5 },
        { accounts_dimensions_id: 30 },
      ],
    });

    const result = await handler({
      file_path: "/tmp/wise.csv",
      accounts_dimensions_id: 5,
      // inter_account_dimension_id intentionally omitted
      execute: true,
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.inter_account_reconciliation).toBeDefined();
    expect(payload.inter_account_reconciliation.confirmed).toBe(1);
    expect(api.transactions.confirm).toHaveBeenCalledWith(9300, [{
      related_table: "accounts",
      related_id: 1030,
      related_sub_id: 30,
      amount: 300,
    }]);
  });
});
