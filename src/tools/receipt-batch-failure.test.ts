import { describe, expect, it, vi } from "vitest";
import { readFile, readdir, realpath, stat } from "fs/promises";
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

describe("process_receipt_batch rollback handling", () => {
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
    expect(payload.results[0]!.notes).toEqual(expect.arrayContaining([
      "Invalidated created purchase invoice 9001 because source document upload failed: upload failed.",
    ]));
    expect(api.purchaseInvoices.invalidate).toHaveBeenCalledWith(9001);
    expect(api.purchaseInvoices.confirmWithTotals).not.toHaveBeenCalled();
  });
});
