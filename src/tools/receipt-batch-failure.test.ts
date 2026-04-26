import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, readdir, realpath, stat } from "fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getAllowedRoots, resolveFilePath, validateFilePath } from "../file-validation.js";
import { parseDocument } from "../document-parser.js";
import {
  classifyReceiptDocument,
  extractReceiptFieldsFromText,
  hasAutoBookableReceiptFields,
  suggestBookingInternal,
} from "./receipt-extraction.js";
import { resolveSupplierInternal } from "./supplier-resolution.js";
import { registerReceiptInboxTools } from "./receipt-inbox.js";
import { parseMcpResponse } from "../mcp-json.js";
import { resetAccountingRulesCache } from "../accounting-rules.js";

vi.mock("fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs/promises")>()),
  readFile: vi.fn(),
  readdir: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("../file-validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../file-validation.js")>()),
  getAllowedRoots: vi.fn(),
  resolveFilePath: vi.fn(),
  validateFilePath: vi.fn(),
}));

vi.mock("../document-parser.js", () => ({
  parseDocument: vi.fn(),
}));

vi.mock("./receipt-extraction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./receipt-extraction.js")>()),
  classifyReceiptDocument: vi.fn(),
  extractReceiptFieldsFromText: vi.fn(),
  hasAutoBookableReceiptFields: vi.fn(),
  suggestBookingInternal: vi.fn(),
}));

vi.mock("./supplier-resolution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supplier-resolution.js")>()),
  resolveSupplierInternal: vi.fn(),
}));

const ORIGINAL_RULES_FILE = process.env.EARVELDAJA_RULES_FILE;

afterEach(() => {
  if (ORIGINAL_RULES_FILE === undefined) {
    delete process.env.EARVELDAJA_RULES_FILE;
  } else {
    process.env.EARVELDAJA_RULES_FILE = ORIGINAL_RULES_FILE;
  }
  resetAccountingRulesCache();
});

describe("process_receipt_batch rollback handling", () => {
  it("prefers accounting-rules.md over generic fallback suggestions in dry run", async () => {
    const rulesDir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const rulesFile = join(rulesDir, "accounting-rules.md");
    writeFileSync(rulesFile, `# Accounting Rules

## Auto Booking
| match | category | purchase_article_id | purchase_account_id | vat_rate_dropdown | reason |
| --- | --- | --- | --- | --- | --- |
| Runikon Retail OÜ | saas_subscriptions | 999 | 5510 | - | Supplier-specific receipt rule |
`, "utf-8");
    process.env.EARVELDAJA_RULES_FILE = rulesFile;
    resetAccountingRulesCache();

    vi.mocked(realpath).mockImplementation(async (path) => String(path));
    vi.mocked(readdir).mockResolvedValue([
      { name: "receipt.pdf", isFile: () => true },
    ] as any);
    vi.mocked(stat).mockImplementation(async (path) => {
      if (String(path) === "/tmp/receipts") {
        return { isDirectory: () => true } as any;
      }

      return {
        isDirectory: () => false,
        size: 512,
        mtime: new Date("2026-03-20T10:00:00.000Z"),
      } as any;
    });
    vi.mocked(readFile).mockResolvedValue(Buffer.from("receipt pdf") as any);

    vi.mocked(resolveFilePath).mockImplementation((path) => path);
    vi.mocked(getAllowedRoots).mockReturnValue(["/tmp"]);
    vi.mocked(validateFilePath).mockImplementation(async (path) => path);

    vi.mocked(parseDocument).mockResolvedValue({
      text: "ignored",
      pageCount: 1,
    } as any);
    vi.mocked(classifyReceiptDocument).mockReturnValue("purchase_invoice");
    vi.mocked(extractReceiptFieldsFromText).mockReturnValue({
      supplier_name: "Runikon Retail OÜ",
      invoice_number: "POS-23-081972",
      invoice_date: "2026-03-20",
      due_date: "2026-03-20",
      total_net: 100,
      total_vat: 24,
      total_gross: 124,
      currency: "EUR",
      description: "Software expense",
      raw_text: "ignored",
    } as any);
    vi.mocked(hasAutoBookableReceiptFields).mockReturnValue(true);
    vi.mocked(suggestBookingInternal).mockResolvedValue({
      item: {
        custom_title: "Software expense",
        amount: 1,
        total_net_price: 100,
        cl_purchase_articles_id: 501,
        purchase_accounts_id: 5230,
      },
      source: "fallback",
      suggested_purchase_article: { id: 501, name: "Software" },
    } as any);
    vi.mocked(resolveSupplierInternal).mockResolvedValue({
      found: true,
      created: false,
      match_type: "exact_name",
      client: {
        id: 7,
        name: "Runikon Retail OU",
        is_supplier: true,
        is_client: false,
        cl_code_country: "EST",
        is_member: false,
        send_invoice_to_email: false,
        send_invoice_to_accounting_email: false,
        is_deleted: false,
      },
    } as any);

    const server = { registerTool: vi.fn() } as any;
    const api = {
      clients: {
        listAll: vi.fn().mockResolvedValue([{
          id: 7,
          name: "Runikon Retail OU",
          is_supplier: true,
          is_client: false,
          cl_code_country: "EST",
          is_member: false,
          send_invoice_to_email: false,
          send_invoice_to_accounting_email: false,
          is_deleted: false,
        }]),
      },
      purchaseInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      readonly: {
        getAccounts: vi.fn().mockResolvedValue([{
          id: 5510,
          name_est: "Erikulu",
          name_eng: "Special expense",
          account_type_est: "Kulud",
          account_type_eng: "Expenses",
        }]),
        getPurchaseArticles: vi.fn().mockResolvedValue([{
          id: 999,
          name_est: "Erikulu",
          name_eng: "Special expense",
          accounts_id: 5510,
          vat_accounts_id: 1510,
          cl_vat_articles_id: 11,
          is_disabled: false,
          priority: 1,
        }]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
      },
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
      },
    } as any;

    registerReceiptInboxTools(server, api);

    const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "process_receipt_batch");
    if (!registration) throw new Error("Tool was not registered");

    const handler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const result = await handler({
      folder_path: "/tmp/receipts",
      accounts_dimensions_id: 100,
      execute: false,
    });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.results[0]!.booking_suggestion).toMatchObject({
      source: "local_rules",
      item: {
        cl_purchase_articles_id: 999,
        purchase_accounts_id: 5510,
        vat_rate_dropdown: "-",
      },
    });
    expect(payload.workflow).toMatchObject({
      contract: "workflow_action_v1",
      recommended_next_action: {
        kind: "approve_tool_call",
        tool: "process_receipt_batch",
        args: {
          folder_path: "/tmp/receipts",
          accounts_dimensions_id: 100,
          execute: true,
        },
      },
      approval_previews: [
        expect.objectContaining({
          title: "Approve receipt batch booking",
          accounting_impact: expect.arrayContaining(["1 purchase invoice"]),
          source_documents: ["/tmp/receipts"],
        }),
      ],
    });

    rmSync(rulesDir, { recursive: true, force: true });
  });

  it("merges VAT-only local rules into an existing fallback booking suggestion", async () => {
    const rulesDir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const rulesFile = join(rulesDir, "accounting-rules.md");
    writeFileSync(rulesFile, `# Accounting Rules

## Auto Booking
| match | category | vat_rate_dropdown | reversed_vat_id | reason |
| --- | --- | --- | --- | --- |
| Runikon Retail OÜ | saas_subscriptions | - | 1 | VAT-only override |
`, "utf-8");
    process.env.EARVELDAJA_RULES_FILE = rulesFile;
    resetAccountingRulesCache();

    vi.mocked(realpath).mockImplementation(async (path) => String(path));
    vi.mocked(readdir).mockResolvedValue([
      { name: "receipt.pdf", isFile: () => true },
    ] as any);
    vi.mocked(stat).mockImplementation(async (path) => {
      if (String(path) === "/tmp/receipts") {
        return { isDirectory: () => true } as any;
      }

      return {
        isDirectory: () => false,
        size: 512,
        mtime: new Date("2026-03-20T10:00:00.000Z"),
      } as any;
    });
    vi.mocked(readFile).mockResolvedValue(Buffer.from("receipt pdf") as any);

    vi.mocked(resolveFilePath).mockImplementation((path) => path);
    vi.mocked(getAllowedRoots).mockReturnValue(["/tmp"]);
    vi.mocked(validateFilePath).mockImplementation(async (path) => path);

    vi.mocked(parseDocument).mockResolvedValue({
      text: "ignored",
      pageCount: 1,
    } as any);
    vi.mocked(classifyReceiptDocument).mockReturnValue("purchase_invoice");
    vi.mocked(extractReceiptFieldsFromText).mockReturnValue({
      supplier_name: "Runikon Retail OÜ",
      invoice_number: "POS-23-081973",
      invoice_date: "2026-03-20",
      due_date: "2026-03-20",
      total_net: 100,
      total_vat: 24,
      total_gross: 124,
      currency: "EUR",
      description: "Software expense",
      raw_text: "ignored",
    } as any);
    vi.mocked(hasAutoBookableReceiptFields).mockReturnValue(true);
    vi.mocked(suggestBookingInternal).mockResolvedValue({
      item: {
        custom_title: "Software expense",
        amount: 1,
        total_net_price: 100,
        cl_purchase_articles_id: 501,
        purchase_accounts_id: 5230,
        vat_rate_dropdown: "24",
      },
      source: "fallback",
      suggested_purchase_article: { id: 501, name: "Software" },
      suggested_account: {
        id: 5230,
        name_est: "Software expense",
        name_eng: "Software expense",
        account_type_est: "Kulud",
        account_type_eng: "Expenses",
      },
    } as any);
    vi.mocked(resolveSupplierInternal).mockResolvedValue({
      found: true,
      created: false,
      match_type: "exact_name",
      client: {
        id: 7,
        name: "Runikon Retail OU",
        is_supplier: true,
        is_client: false,
        cl_code_country: "EST",
        is_member: false,
        send_invoice_to_email: false,
        send_invoice_to_accounting_email: false,
        is_deleted: false,
      },
    } as any);

    const server = { registerTool: vi.fn() } as any;
    const api = {
      clients: {
        listAll: vi.fn().mockResolvedValue([{
          id: 7,
          name: "Runikon Retail OU",
          is_supplier: true,
          is_client: false,
          cl_code_country: "EST",
          is_member: false,
          send_invoice_to_email: false,
          send_invoice_to_accounting_email: false,
          is_deleted: false,
        }]),
      },
      purchaseInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      readonly: {
        getAccounts: vi.fn().mockResolvedValue([{
          id: 5230,
          name_est: "Software expense",
          name_eng: "Software expense",
          account_type_est: "Kulud",
          account_type_eng: "Expenses",
        }]),
        getPurchaseArticles: vi.fn().mockResolvedValue([{
          id: 501,
          name_est: "Software",
          name_eng: "Software",
          accounts_id: 5230,
          vat_accounts_id: 1510,
          cl_vat_articles_id: 1,
          is_disabled: false,
          priority: 1,
        }]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
      },
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
      },
    } as any;

    registerReceiptInboxTools(server, api);

    const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "process_receipt_batch");
    if (!registration) throw new Error("Tool was not registered");

    const handler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const result = await handler({
      folder_path: "/tmp/receipts",
      accounts_dimensions_id: 100,
      execute: false,
    });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.results[0]!.booking_suggestion).toMatchObject({
      source: "local_rules",
      item: {
        cl_purchase_articles_id: 501,
        purchase_accounts_id: 5230,
        vat_rate_dropdown: "-",
        reversed_vat_id: 1,
      },
    });

    rmSync(rulesDir, { recursive: true, force: true });
  });

  it("clears stale purchase-account dimensions when a local rule switches the account", async () => {
    const rulesDir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const rulesFile = join(rulesDir, "accounting-rules.md");
    writeFileSync(rulesFile, `# Accounting Rules

## Auto Booking
| match | category | purchase_article_id | purchase_account_id | reason |
| --- | --- | --- | --- | --- |
| Runikon Retail OÜ | saas_subscriptions | 999 | 5510 | Switch expense account |
`, "utf-8");
    process.env.EARVELDAJA_RULES_FILE = rulesFile;
    resetAccountingRulesCache();

    vi.mocked(realpath).mockImplementation(async (path) => String(path));
    vi.mocked(readdir).mockResolvedValue([
      { name: "receipt.pdf", isFile: () => true },
    ] as any);
    vi.mocked(stat).mockImplementation(async (path) => {
      if (String(path) === "/tmp/receipts") {
        return { isDirectory: () => true } as any;
      }

      return {
        isDirectory: () => false,
        size: 512,
        mtime: new Date("2026-03-20T10:00:00.000Z"),
      } as any;
    });
    vi.mocked(readFile).mockResolvedValue(Buffer.from("receipt pdf") as any);

    vi.mocked(resolveFilePath).mockImplementation((path) => path);
    vi.mocked(getAllowedRoots).mockReturnValue(["/tmp"]);
    vi.mocked(validateFilePath).mockImplementation(async (path) => path);

    vi.mocked(parseDocument).mockResolvedValue({
      text: "ignored",
      pageCount: 1,
    } as any);
    vi.mocked(classifyReceiptDocument).mockReturnValue("purchase_invoice");
    vi.mocked(extractReceiptFieldsFromText).mockReturnValue({
      supplier_name: "Runikon Retail OÜ",
      invoice_number: "POS-23-081974",
      invoice_date: "2026-03-20",
      due_date: "2026-03-20",
      total_net: 100,
      total_vat: 24,
      total_gross: 124,
      currency: "EUR",
      description: "Software expense",
      raw_text: "ignored",
    } as any);
    vi.mocked(hasAutoBookableReceiptFields).mockReturnValue(true);
    vi.mocked(suggestBookingInternal).mockResolvedValue({
      item: {
        custom_title: "Software expense",
        amount: 1,
        total_net_price: 100,
        cl_purchase_articles_id: 501,
        purchase_accounts_id: 5230,
        purchase_accounts_dimensions_id: 777,
        vat_rate_dropdown: "24",
      },
      source: "fallback",
      suggested_purchase_article: { id: 501, name: "Software" },
      suggested_account: {
        id: 5230,
        name_est: "Software expense",
        name_eng: "Software expense",
        account_type_est: "Kulud",
        account_type_eng: "Expenses",
      },
    } as any);
    vi.mocked(resolveSupplierInternal).mockResolvedValue({
      found: true,
      created: false,
      match_type: "exact_name",
      client: {
        id: 7,
        name: "Runikon Retail OU",
        is_supplier: true,
        is_client: false,
        cl_code_country: "EST",
        is_member: false,
        send_invoice_to_email: false,
        send_invoice_to_accounting_email: false,
        is_deleted: false,
      },
    } as any);

    const server = { registerTool: vi.fn() } as any;
    const api = {
      clients: {
        listAll: vi.fn().mockResolvedValue([{
          id: 7,
          name: "Runikon Retail OU",
          is_supplier: true,
          is_client: false,
          cl_code_country: "EST",
          is_member: false,
          send_invoice_to_email: false,
          send_invoice_to_accounting_email: false,
          is_deleted: false,
        }]),
      },
      purchaseInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      readonly: {
        getAccounts: vi.fn().mockResolvedValue([
          {
            id: 5230,
            name_est: "Software expense",
            name_eng: "Software expense",
            account_type_est: "Kulud",
            account_type_eng: "Expenses",
          },
          {
            id: 5510,
            name_est: "Special expense",
            name_eng: "Special expense",
            account_type_est: "Kulud",
            account_type_eng: "Expenses",
          },
        ]),
        getPurchaseArticles: vi.fn().mockResolvedValue([
          {
            id: 501,
            name_est: "Software",
            name_eng: "Software",
            accounts_id: 5230,
            vat_accounts_id: 1510,
            cl_vat_articles_id: 1,
            is_disabled: false,
            priority: 1,
          },
          {
            id: 999,
            name_est: "Special expense",
            name_eng: "Special expense",
            accounts_id: 5510,
            vat_accounts_id: 1510,
            cl_vat_articles_id: 11,
            is_disabled: false,
            priority: 1,
          },
        ]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
      },
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
      },
    } as any;

    registerReceiptInboxTools(server, api);

    const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "process_receipt_batch");
    if (!registration) throw new Error("Tool was not registered");

    const handler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const result = await handler({
      folder_path: "/tmp/receipts",
      accounts_dimensions_id: 100,
      execute: false,
    });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.results[0]!.booking_suggestion).toMatchObject({
      source: "local_rules",
      item: {
        cl_purchase_articles_id: 999,
        purchase_accounts_id: 5510,
      },
    });
    expect(payload.results[0]!.booking_suggestion.item.purchase_accounts_dimensions_id).toBeUndefined();

    rmSync(rulesDir, { recursive: true, force: true });
  });

  it("applies liability-account-only overrides without discarding an existing fallback booking suggestion", async () => {
    const rulesDir = mkdtempSync(join(tmpdir(), "earv-rules-"));
    const rulesFile = join(rulesDir, "accounting-rules.md");
    writeFileSync(rulesFile, `# Accounting Rules

## Auto Booking
| match | category | liability_account_id | reason |
| --- | --- | --- | --- |
| Runikon Retail OÜ | saas_subscriptions | 2315 | Liability override |
`, "utf-8");
    process.env.EARVELDAJA_RULES_FILE = rulesFile;
    resetAccountingRulesCache();

    vi.mocked(realpath).mockImplementation(async (path) => String(path));
    vi.mocked(readdir).mockResolvedValue([
      { name: "receipt.pdf", isFile: () => true },
    ] as any);
    vi.mocked(stat).mockImplementation(async (path) => {
      if (String(path) === "/tmp/receipts") {
        return { isDirectory: () => true } as any;
      }

      return {
        isDirectory: () => false,
        size: 512,
        mtime: new Date("2026-03-20T10:00:00.000Z"),
      } as any;
    });
    vi.mocked(readFile).mockResolvedValue(Buffer.from("receipt pdf") as any);

    vi.mocked(resolveFilePath).mockImplementation((path) => path);
    vi.mocked(getAllowedRoots).mockReturnValue(["/tmp"]);
    vi.mocked(validateFilePath).mockImplementation(async (path) => path);

    vi.mocked(parseDocument).mockResolvedValue({
      text: "ignored",
      pageCount: 1,
    } as any);
    vi.mocked(classifyReceiptDocument).mockReturnValue("purchase_invoice");
    vi.mocked(extractReceiptFieldsFromText).mockReturnValue({
      supplier_name: "Runikon Retail OÜ",
      invoice_number: "POS-23-081974",
      invoice_date: "2026-03-20",
      due_date: "2026-03-20",
      total_net: 100,
      total_vat: 24,
      total_gross: 124,
      currency: "EUR",
      description: "Software expense",
      raw_text: "ignored",
    } as any);
    vi.mocked(hasAutoBookableReceiptFields).mockReturnValue(true);
    vi.mocked(suggestBookingInternal).mockResolvedValue({
      item: {
        custom_title: "Software expense",
        amount: 1,
        total_net_price: 100,
        cl_purchase_articles_id: 501,
        purchase_accounts_id: 5230,
        vat_rate_dropdown: "24",
      },
      source: "fallback",
      suggested_purchase_article: { id: 501, name: "Software" },
      suggested_account: {
        id: 5230,
        name_est: "Software expense",
        name_eng: "Software expense",
        account_type_est: "Kulud",
        account_type_eng: "Expenses",
      },
    } as any);
    vi.mocked(resolveSupplierInternal).mockResolvedValue({
      found: true,
      created: false,
      match_type: "exact_name",
      client: {
        id: 7,
        name: "Runikon Retail OU",
        is_supplier: true,
        is_client: false,
        cl_code_country: "EST",
        is_member: false,
        send_invoice_to_email: false,
        send_invoice_to_accounting_email: false,
        is_deleted: false,
      },
    } as any);

    const server = { registerTool: vi.fn() } as any;
    const api = {
      clients: {
        listAll: vi.fn().mockResolvedValue([{
          id: 7,
          name: "Runikon Retail OU",
          is_supplier: true,
          is_client: false,
          cl_code_country: "EST",
          is_member: false,
          send_invoice_to_email: false,
          send_invoice_to_accounting_email: false,
          is_deleted: false,
        }]),
      },
      purchaseInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      readonly: {
        getAccounts: vi.fn().mockResolvedValue([{
          id: 5230,
          name_est: "Software expense",
          name_eng: "Software expense",
          account_type_est: "Kulud",
          account_type_eng: "Expenses",
        }]),
        getPurchaseArticles: vi.fn().mockResolvedValue([{
          id: 501,
          name_est: "Software",
          name_eng: "Software",
          accounts_id: 5230,
          vat_accounts_id: 1510,
          cl_vat_articles_id: 1,
          is_disabled: false,
          priority: 1,
        }]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
      },
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
      },
    } as any;

    registerReceiptInboxTools(server, api);

    const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "process_receipt_batch");
    if (!registration) throw new Error("Tool was not registered");

    const handler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const result = await handler({
      folder_path: "/tmp/receipts",
      accounts_dimensions_id: 100,
      execute: false,
    });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.results[0]!.booking_suggestion).toMatchObject({
      source: "local_rules",
      suggested_liability_account_id: 2315,
      item: {
        cl_purchase_articles_id: 501,
        purchase_accounts_id: 5230,
      },
    });

    rmSync(rulesDir, { recursive: true, force: true });
  });

  it("invalidates the created invoice when document upload fails", async () => {
    vi.mocked(realpath).mockImplementation(async (path) => String(path));
    vi.mocked(readdir).mockResolvedValue([
      { name: "receipt.pdf", isFile: () => true },
    ] as any);
    vi.mocked(stat).mockImplementation(async (path) => {
      if (String(path) === "/tmp/receipts") {
        return { isDirectory: () => true } as any;
      }

      return {
        isDirectory: () => false,
        size: 512,
        mtime: new Date("2026-03-20T10:00:00.000Z"),
      } as any;
    });
    vi.mocked(readFile).mockResolvedValue(Buffer.from("receipt pdf") as any);

    vi.mocked(resolveFilePath).mockImplementation((path) => path);
    vi.mocked(getAllowedRoots).mockReturnValue(["/tmp"]);
    vi.mocked(validateFilePath).mockImplementation(async (path) => path);

    vi.mocked(parseDocument).mockResolvedValue({
      text: "ignored",
      pageCount: 1,
    } as any);
    vi.mocked(classifyReceiptDocument).mockReturnValue("purchase_invoice");
    vi.mocked(extractReceiptFieldsFromText).mockReturnValue({
      supplier_name: "Runikon Retail OU",
      invoice_number: "POS-23-081972",
      invoice_date: "2026-03-20",
      due_date: "2026-03-20",
      total_net: 100,
      total_vat: 24,
      total_gross: 124,
      currency: "EUR",
      description: "Software expense",
      raw_text: "ignored",
    } as any);
    vi.mocked(hasAutoBookableReceiptFields).mockReturnValue(true);
    vi.mocked(suggestBookingInternal).mockResolvedValue({
      item: {
        custom_title: "Software expense",
        amount: 1,
        total_net_price: 100,
        cl_purchase_articles_id: 501,
        purchase_accounts_id: 5230,
        vat_accounts_id: 1510,
        cl_vat_articles_id: 1,
        vat_rate_dropdown: "24",
      },
      source: "fallback",
      suggested_purchase_article: { id: 501, name: "Software" },
    } as any);
    vi.mocked(resolveSupplierInternal).mockResolvedValue({
      found: true,
      created: false,
      match_type: "exact_name",
      client: {
        id: 7,
        name: "Runikon Retail OU",
        is_supplier: true,
        is_client: false,
        cl_code_country: "EST",
        is_member: false,
        send_invoice_to_email: false,
        send_invoice_to_accounting_email: false,
        is_deleted: false,
      },
    } as any);

    const server = { registerTool: vi.fn() } as any;
    const api = {
      clients: {
        listAll: vi.fn().mockResolvedValue([{
          id: 7,
          name: "Runikon Retail OU",
          is_supplier: true,
          is_client: false,
          cl_code_country: "EST",
          is_member: false,
          send_invoice_to_email: false,
          send_invoice_to_accounting_email: false,
          is_deleted: false,
        }]),
      },
      purchaseInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
        createAndSetTotals: vi.fn().mockResolvedValue({
          id: 9001,
          clients_id: 7,
          client_name: "Runikon Retail OU",
          number: "POS-23-081972",
          create_date: "2026-03-20",
          cl_currencies_id: "EUR",
          gross_price: 124,
          bank_ref_number: null,
          status: "PROJECT",
        }),
        uploadDocument: vi.fn().mockRejectedValue(new Error("upload failed")),
        confirmWithTotals: vi.fn().mockResolvedValue({}),
        invalidate: vi.fn().mockResolvedValue({}),
      },
      readonly: {
        getAccounts: vi.fn().mockResolvedValue([{
          id: 5230,
          name_est: "Software expense",
          name_eng: "Software expense",
          account_type_est: "Kulud",
          account_type_eng: "Expenses",
        }]),
        getPurchaseArticles: vi.fn().mockResolvedValue([{
          id: 501,
          name_est: "Software",
          name_eng: "Software",
          accounts_id: 5230,
          vat_accounts_id: 1510,
          cl_vat_articles_id: 1,
          is_disabled: false,
          priority: 1,
        }]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
      },
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
      },
    } as any;

    registerReceiptInboxTools(server, api);

    const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "process_receipt_batch");
    if (!registration) throw new Error("Tool was not registered");

    const handler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const result = await handler({
      folder_path: "/tmp/receipts",
      accounts_dimensions_id: 100,
      execute: true,
    });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.summary.failed).toBe(1);
    expect(payload.summary.created).toBe(0);
    expect(payload.summary.matched).toBe(0);
    expect(payload.results[0]!.status).toBe("failed");
    expect(payload.results[0]!.error).toContain("upload failed");
    expect(payload.execution).toMatchObject({
      contract: "batch_execution_v1",
      mode: "EXECUTED",
      summary: {
        dry_run: false,
        scanned_files: 1,
        skipped_invalid_files: 0,
        created: 0,
        matched: 0,
        skipped_duplicate: 0,
        failed: 1,
        needs_review: 0,
        dry_run_preview: 0,
      },
      results: [],
      skipped: [],
      errors: [
        expect.objectContaining({
          classification: "purchase_invoice",
          status: "failed",
          error: expect.stringContaining("upload failed"),
        }),
      ],
      needs_review: [],
    });
    // Notes are OCR-sandbox-wrapped at MCP output; match plain text inside the wrap.
    expect(payload.results[0]!.notes).toEqual(expect.arrayContaining([
      expect.stringMatching(/Invalidated created purchase invoice 9001 because source document upload failed: upload failed\./),
    ]));
    expect(api.purchaseInvoices.invalidate).toHaveBeenCalledWith(9001);
    expect(api.purchaseInvoices.confirmWithTotals).not.toHaveBeenCalled();
  });

  it("returns CONFIRMED invoice status after successful confirmation", async () => {
    vi.mocked(realpath).mockImplementation(async (path) => String(path));
    vi.mocked(readdir).mockResolvedValue([
      { name: "receipt.pdf", isFile: () => true },
    ] as any);
    vi.mocked(stat).mockImplementation(async (path) => {
      if (String(path) === "/tmp/receipts") {
        return { isDirectory: () => true } as any;
      }

      return {
        isDirectory: () => false,
        size: 512,
        mtime: new Date("2026-03-20T10:00:00.000Z"),
      } as any;
    });
    vi.mocked(readFile).mockResolvedValue(Buffer.from("receipt pdf") as any);

    vi.mocked(resolveFilePath).mockImplementation((path) => path);
    vi.mocked(getAllowedRoots).mockReturnValue(["/tmp"]);
    vi.mocked(validateFilePath).mockImplementation(async (path) => path);

    vi.mocked(parseDocument).mockResolvedValue({
      text: "ignored",
      pageCount: 1,
    } as any);
    vi.mocked(classifyReceiptDocument).mockReturnValue("purchase_invoice");
    vi.mocked(extractReceiptFieldsFromText).mockReturnValue({
      supplier_name: "Runikon Retail OU",
      invoice_number: "POS-23-081972",
      invoice_date: "2026-03-20",
      due_date: "2026-03-20",
      total_net: 100,
      total_vat: 24,
      total_gross: 124,
      currency: "EUR",
      description: "Software expense",
      raw_text: "ignored",
    } as any);
    vi.mocked(hasAutoBookableReceiptFields).mockReturnValue(true);
    vi.mocked(suggestBookingInternal).mockResolvedValue({
      item: {
        custom_title: "Software expense",
        amount: 1,
        total_net_price: 100,
        cl_purchase_articles_id: 501,
        purchase_accounts_id: 5230,
        vat_accounts_id: 1510,
        cl_vat_articles_id: 1,
        vat_rate_dropdown: "24",
      },
      source: "fallback",
      suggested_purchase_article: { id: 501, name: "Software" },
    } as any);
    vi.mocked(resolveSupplierInternal).mockResolvedValue({
      found: true,
      created: false,
      match_type: "exact_name",
      client: {
        id: 7,
        name: "Runikon Retail OU",
        is_supplier: true,
        is_client: false,
        cl_code_country: "EST",
        is_member: false,
        send_invoice_to_email: false,
        send_invoice_to_accounting_email: false,
        is_deleted: false,
      },
    } as any);

    const server = { registerTool: vi.fn() } as any;
    const api = {
      clients: {
        listAll: vi.fn().mockResolvedValue([{
          id: 7,
          name: "Runikon Retail OU",
          is_supplier: true,
          is_client: false,
          cl_code_country: "EST",
          is_member: false,
          send_invoice_to_email: false,
          send_invoice_to_accounting_email: false,
          is_deleted: false,
        }]),
      },
      purchaseInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
        createAndSetTotals: vi.fn().mockResolvedValue({
          id: 9001,
          clients_id: 7,
          client_name: "Runikon Retail OU",
          number: "POS-23-081972",
          create_date: "2026-03-20",
          cl_currencies_id: "EUR",
          gross_price: 124,
          bank_ref_number: null,
          status: "PROJECT",
        }),
        uploadDocument: vi.fn().mockResolvedValue({}),
        confirmWithTotals: vi.fn().mockResolvedValue({}),
        invalidate: vi.fn().mockResolvedValue({}),
      },
      readonly: {
        getAccounts: vi.fn().mockResolvedValue([{
          id: 5230,
          name_est: "Software expense",
          name_eng: "Software expense",
          account_type_est: "Kulud",
          account_type_eng: "Expenses",
        }]),
        getPurchaseArticles: vi.fn().mockResolvedValue([{
          id: 501,
          name_est: "Software",
          name_eng: "Software",
          accounts_id: 5230,
          vat_accounts_id: 1510,
          cl_vat_articles_id: 1,
          is_disabled: false,
          priority: 1,
        }]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
      },
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
      },
    } as any;

    registerReceiptInboxTools(server, api);

    const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "process_receipt_batch");
    if (!registration) throw new Error("Tool was not registered");

    const handler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const result = await handler({
      folder_path: "/tmp/receipts",
      accounts_dimensions_id: 100,
      execute: true,
    });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.summary.created).toBe(1);
    expect(payload.results[0]!.status).toBe("created");
    expect(payload.results[0]!.created_invoice).toEqual(expect.objectContaining({
      id: 9001,
      number: "POS-23-081972",
      status: "CONFIRMED",
      confirmed: true,
      uploaded_document: true,
    }));
    expect(api.purchaseInvoices.confirmWithTotals).toHaveBeenCalledWith(9001, true, {
      preserveExistingTotals: true,
    });
  });

  it("preserves supplier-history VAT metadata when OCR misses invoice VAT totals", async () => {
    vi.mocked(realpath).mockImplementation(async (path) => String(path));
    vi.mocked(readdir).mockResolvedValue([
      { name: "receipt.pdf", isFile: () => true },
    ] as any);
    vi.mocked(stat).mockImplementation(async (path) => {
      if (String(path) === "/tmp/receipts") {
        return { isDirectory: () => true } as any;
      }

      return {
        isDirectory: () => false,
        size: 512,
        mtime: new Date("2026-03-20T10:00:00.000Z"),
      } as any;
    });
    vi.mocked(readFile).mockResolvedValue(Buffer.from("receipt pdf") as any);

    vi.mocked(resolveFilePath).mockImplementation((path) => path);
    vi.mocked(getAllowedRoots).mockReturnValue(["/tmp"]);
    vi.mocked(validateFilePath).mockImplementation(async (path) => path);

    vi.mocked(parseDocument).mockResolvedValue({
      text: "ignored",
      pageCount: 1,
    } as any);
    vi.mocked(classifyReceiptDocument).mockReturnValue("purchase_invoice");
    vi.mocked(extractReceiptFieldsFromText).mockReturnValue({
      supplier_name: "OpenAI Ireland Limited",
      invoice_number: "INV-2026-03",
      invoice_date: "2026-03-20",
      due_date: "2026-03-20",
      total_net: 100,
      total_vat: undefined,
      total_gross: 100,
      currency: "EUR",
      description: "OpenAI API credits",
      raw_text: "ignored",
    } as any);
    vi.mocked(hasAutoBookableReceiptFields).mockReturnValue(true);
    vi.mocked(suggestBookingInternal).mockResolvedValue({
      item: {
        custom_title: "OpenAI API credits",
        amount: 1,
        total_net_price: 100,
        cl_purchase_articles_id: 501,
        purchase_accounts_id: 5230,
        vat_accounts_id: 1510,
        cl_vat_articles_id: 1,
        vat_rate_dropdown: "24",
        reversed_vat_id: 1,
      },
      source: "supplier_history",
      suggested_purchase_article: { id: 501, name: "Software" },
      matched_invoice_id: 12,
      matched_invoice_number: "OA-2026-02",
    } as any);
    vi.mocked(resolveSupplierInternal).mockResolvedValue({
      found: true,
      created: false,
      match_type: "exact_name",
      client: {
        id: 7,
        name: "OpenAI Ireland Limited",
        is_supplier: true,
        is_client: false,
        cl_code_country: "IRL",
        is_member: false,
        send_invoice_to_email: false,
        send_invoice_to_accounting_email: false,
        is_deleted: false,
      },
    } as any);

    const server = { registerTool: vi.fn() } as any;
    const api = {
      clients: {
        listAll: vi.fn().mockResolvedValue([{
          id: 7,
          name: "OpenAI Ireland Limited",
          is_supplier: true,
          is_client: false,
          cl_code_country: "IRL",
          is_member: false,
          send_invoice_to_email: false,
          send_invoice_to_accounting_email: false,
          is_deleted: false,
        }]),
      },
      purchaseInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
        createAndSetTotals: vi.fn().mockResolvedValue({
          id: 9001,
          clients_id: 7,
          client_name: "OpenAI Ireland Limited",
          number: "INV-2026-03",
          create_date: "2026-03-20",
          cl_currencies_id: "EUR",
          gross_price: 100,
          bank_ref_number: null,
          status: "PROJECT",
        }),
        uploadDocument: vi.fn().mockResolvedValue({}),
        confirmWithTotals: vi.fn().mockResolvedValue({}),
      },
      readonly: {
        getAccounts: vi.fn().mockResolvedValue([{
          id: 5230,
          name_est: "Software expense",
          name_eng: "Software expense",
          account_type_est: "Kulud",
          account_type_eng: "Expenses",
        }]),
        getPurchaseArticles: vi.fn().mockResolvedValue([{
          id: 501,
          name_est: "Software",
          name_eng: "Software",
          accounts_id: 5230,
          vat_accounts_id: 1510,
          cl_vat_articles_id: 1,
          is_disabled: false,
          priority: 1,
        }]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
      },
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
      },
    } as any;

    registerReceiptInboxTools(server, api);

    const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "process_receipt_batch");
    if (!registration) throw new Error("Tool was not registered");

    const handler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    await handler({
      folder_path: "/tmp/receipts",
      accounts_dimensions_id: 100,
      execute: true,
    });

    expect(api.purchaseInvoices.createAndSetTotals).toHaveBeenCalledTimes(1);
    expect(api.purchaseInvoices.createAndSetTotals.mock.calls[0]![0].items[0]).toMatchObject({
      vat_rate_dropdown: "24",
      reversed_vat_id: 1,
    });
  });

  it("contract gate (#19): foreign-supplier reverse-charge default does not auto-create+confirm at execute=true", async () => {
    // Foreign supplier, no explicit reverse-charge phrase, no supplier
    // history with reversed_vat_id. applyReverseChargeAutoDetection sets
    // the default; the row's confidence drops to medium with the
    // foreign_reverse_charge_default_unverified signal; the contract
    // gate routes it to needs_review instead of create+confirm.
    vi.mocked(realpath).mockImplementation(async (path) => String(path));
    vi.mocked(readdir).mockResolvedValue([
      { name: "anthropic.pdf", isFile: () => true },
    ] as any);
    vi.mocked(stat).mockImplementation(async (path) => {
      if (String(path) === "/tmp/receipts") return { isDirectory: () => true } as any;
      return {
        isDirectory: () => false,
        size: 512,
        mtime: new Date("2026-04-20T10:00:00.000Z"),
      } as any;
    });
    vi.mocked(readFile).mockResolvedValue(Buffer.from("anthropic pdf") as any);
    vi.mocked(resolveFilePath).mockImplementation((path) => path);
    vi.mocked(getAllowedRoots).mockReturnValue(["/tmp"]);
    vi.mocked(validateFilePath).mockImplementation(async (path) => path);
    // raw_text intentionally contains NO reverse-charge phrasing in any
    // of the supported languages — we want Case 3 (foreign-supplier
    // default) to fire, not Case 2 (phrase_match), so the contract gate
    // can be exercised on the unverified-default path.
    const plainText = "Anthropic invoice for Claude Max subscription, USD 100, no VAT mentioned.";
    vi.mocked(parseDocument).mockResolvedValue({
      text: plainText,
      pageCount: 1,
    } as any);
    vi.mocked(classifyReceiptDocument).mockReturnValue("purchase_invoice");
    vi.mocked(extractReceiptFieldsFromText).mockReturnValue({
      supplier_name: "Anthropic, PBC",
      invoice_number: "ANT-001",
      invoice_date: "2026-04-20",
      due_date: "2026-04-20",
      total_net: 100,
      total_vat: 0,
      total_gross: 100,
      currency: "USD",
      description: "Claude Max subscription",
      raw_text: plainText,
    } as any);
    vi.mocked(hasAutoBookableReceiptFields).mockReturnValue(true);
    vi.mocked(suggestBookingInternal).mockResolvedValue({
      item: {
        custom_title: "Claude Max subscription",
        amount: 1,
        total_net_price: 100,
        cl_purchase_articles_id: 501,
        purchase_accounts_id: 5230,
        vat_rate_dropdown: "0",
      },
      source: "fallback",
      suggested_purchase_article: { id: 501, name: "Software" },
    } as any);
    vi.mocked(resolveSupplierInternal).mockResolvedValue({
      found: true,
      created: false,
      match_type: "name_normalized",
      client: {
        id: 200,
        name: "Anthropic",
        is_supplier: true,
        is_client: false,
        cl_code_country: "USA",
        is_member: false,
        send_invoice_to_email: false,
        send_invoice_to_accounting_email: false,
        is_deleted: false,
      },
    } as any);

    const server = { registerTool: vi.fn() } as any;
    const api = {
      clients: {
        listAll: vi.fn().mockResolvedValue([{
          id: 200,
          name: "Anthropic",
          is_supplier: true,
          is_client: false,
          cl_code_country: "USA",
          is_member: false,
          send_invoice_to_email: false,
          send_invoice_to_accounting_email: false,
          is_deleted: false,
        }]),
      },
      purchaseInvoices: {
        listAll: vi.fn().mockResolvedValue([]),
        createAndSetTotals: vi.fn(),
        uploadDocument: vi.fn(),
        confirmWithTotals: vi.fn(),
        invalidate: vi.fn(),
      },
      readonly: {
        getAccounts: vi.fn().mockResolvedValue([{
          id: 5230,
          name_est: "Software expense",
          name_eng: "Software expense",
          account_type_est: "Kulud",
          account_type_eng: "Expenses",
        }]),
        getPurchaseArticles: vi.fn().mockResolvedValue([{
          id: 501,
          name_est: "Software",
          name_eng: "Software",
          accounts_id: 5230,
          vat_accounts_id: 1510,
          cl_vat_articles_id: 1,
          is_disabled: false,
          priority: 1,
        }]),
        getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
        getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Seppo AI OÜ" }),
      },
      transactions: {
        listAll: vi.fn().mockResolvedValue([]),
      },
    } as any;

    registerReceiptInboxTools(server, api);

    const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "process_receipt_batch");
    if (!registration) throw new Error("Tool was not registered");
    const handler = registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    const result = await handler({
      folder_path: "/tmp/receipts",
      accounts_dimensions_id: 100,
      execute: true,
    });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(api.purchaseInvoices.createAndSetTotals).not.toHaveBeenCalled();
    expect(api.purchaseInvoices.confirmWithTotals).not.toHaveBeenCalled();
    expect(payload.summary.created).toBe(0);
    expect(payload.summary.needs_review).toBe(1);
    expect(payload.results[0]!.status).toBe("needs_review");
    expect(payload.results[0]!.llm_fallback.confidence).toBe("medium");
    expect(payload.results[0]!.llm_fallback.confidence_signals).toEqual(
      expect.arrayContaining(["foreign_reverse_charge_default_unverified"]),
    );
    // The row carries the auto-applied reverse-charge flag and reason so a
    // reviewer sees what was assumed; only the create/confirm step is
    // gated.
    expect(payload.results[0]!.booking_suggestion.reverse_charge_reason)
      .toBe("foreign_supplier_default");
    expect(payload.results[0]!.booking_suggestion.item.reversed_vat_id).toBe(1);
  });
});
