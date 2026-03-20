import { describe, expect, it, vi } from "vitest";
import { validateFilePath } from "../file-validation.js";
import { parseDocument } from "../document-parser.js";
import { registerPdfWorkflowTools } from "./pdf-workflow.js";

vi.mock("../file-validation.js", () => ({
  validateFilePath: vi.fn(),
}));

vi.mock("../document-parser.js", () => ({
  parseDocument: vi.fn(),
}));

const mockedValidateFilePath = vi.mocked(validateFilePath);
const mockedParseDocument = vi.mocked(parseDocument);

function setupPdfWorkflowTool(toolName: string) {
  const server = { registerTool: vi.fn() } as any;
  const api = {
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue([
        {
          id: 1,
          clients_id: 7,
          status: "CONFIRMED",
          create_date: "2026-02-15",
        },
      ]),
      get: vi.fn().mockResolvedValue({
        id: 1,
        number: "PI-1",
        create_date: "2026-02-15",
        gross_price: 124,
        liability_accounts_id: 2310,
        items: [{
          custom_title: "Internet subscription",
          cl_purchase_articles_id: 45,
          purchase_accounts_id: 5230,
          total_net_price: 100,
          vat_rate_dropdown: "24",
          vat_accounts_id: 1510,
          cl_vat_articles_id: 1,
          reversed_vat_id: null,
        }],
      }),
    },
  } as any;

  registerPdfWorkflowTools(server, api);

  const registration = server.registerTool.mock.calls.find(([name]) => name === toolName);
  if (!registration) {
    throw new Error("Tool was not registered");
  }

  return registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

describe("pdf workflow tools", () => {
  it("extract_pdf_invoice uses LiteParse output for raw text and page count", async () => {
    mockedValidateFilePath.mockResolvedValue("/tmp/invoice.pdf");
    mockedParseDocument.mockResolvedValue({
      text: "Registrikood 12345678\nVAT EE123456789\nEE471000001020145685\nViitenumber 12345",
      pageCount: 2,
      result: { text: "", pages: [] } as any,
    });

    const handler = setupPdfWorkflowTool("extract_pdf_invoice");

    const response = await handler({ file_path: "/tmp/invoice.pdf" });
    const payload = JSON.parse(response.content[0]!.text);

    expect(mockedValidateFilePath).toHaveBeenCalledWith("/tmp/invoice.pdf", [".pdf"], 50 * 1024 * 1024);
    expect(mockedParseDocument).toHaveBeenCalledWith("/tmp/invoice.pdf");
    expect(payload.page_count).toBe(2);
    expect(payload.hints).toEqual(expect.objectContaining({
      raw_text: expect.stringContaining("Registrikood 12345678"),
      supplier_reg_code: "12345678",
      supplier_vat_no: "EE123456789",
      supplier_iban: "EE471000001020145685",
      ref_number: "12345",
    }));
  });

  it("returns purchase account and VAT metadata from similar invoices", async () => {
    const handler = setupPdfWorkflowTool("suggest_booking");

    const result = await handler({
      clients_id: 7,
      description: "internet",
    });

    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.supplier_id).toBe(7);
    expect(payload.suggestion).toContain("VAT settings");
    expect(payload.past_invoices).toHaveLength(1);
    expect(payload.past_invoices[0]!.items).toEqual([
      expect.objectContaining({
        custom_title: "Internet subscription",
        cl_purchase_articles_id: 45,
        purchase_accounts_id: 5230,
        vat_rate_dropdown: "24",
        vat_accounts_id: 1510,
        cl_vat_articles_id: 1,
        reversed_vat_id: null,
      }),
    ]);
  });
});
