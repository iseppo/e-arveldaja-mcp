import { describe, expect, it, vi } from "vitest";
import { registerDocumentAuditTools } from "./document-audit.js";
import { parseMcpResponse } from "../mcp-json.js";

function setupDuplicateTool(existingPurchases: unknown[]) {
  const server = { registerTool: vi.fn() } as any;
  const api = {
    journals: { listAll: vi.fn().mockResolvedValue([]) },
    transactions: { listAll: vi.fn().mockResolvedValue([]) },
    purchaseInvoices: { listAll: vi.fn().mockResolvedValue(existingPurchases) },
    saleInvoices: { listAll: vi.fn().mockResolvedValue([]) },
  } as any;

  registerDocumentAuditTools(server, api);

  const registration = server.registerTool.mock.calls.find(([name]) => name === "detect_duplicate_purchase_invoice");
  if (!registration) {
    throw new Error("Tool was not registered");
  }

  return registration[2] as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
}

describe("detect_duplicate_purchase_invoice", () => {
  it("reports candidate matches for an incoming invoice even when only one existing invoice matches", async () => {
    const handler = setupDuplicateTool([{
      id: 1,
      clients_id: 10,
      client_name: "Acme Ltd",
      number: "INV-1",
      create_date: "2026-03-10",
      gross_price: 124,
      status: "CONFIRMED",
    }]);

    const result = await handler({
      date_from: "2026-03-10",
      date_to: "2026-03-10",
      invoice_number: " inv-1 ",
      gross_price: 124,
    });

    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.exact_duplicates.count).toBe(0);
    expect(payload.suspicious_same_amount_date.count).toBe(0);
    expect(payload.candidate_invoice_number_matches).toEqual({
      count: 1,
      items: [expect.objectContaining({
        id: 1,
        supplier: expect.stringMatching(/^<<UNTRUSTED_OCR_START:[0-9a-f]+>>\nAcme Ltd\n<<UNTRUSTED_OCR_END:[0-9a-f]+>>$/),
        invoice_number: "INV-1",
        gross: 124,
      })],
    });
    expect(payload.candidate_same_amount_date_matches).toEqual({
      count: 1,
      items: [expect.objectContaining({
        id: 1,
        supplier: expect.stringMatching(/^<<UNTRUSTED_OCR_START:[0-9a-f]+>>\nAcme Ltd\n<<UNTRUSTED_OCR_END:[0-9a-f]+>>$/),
        invoice_number: "INV-1",
        gross: 124,
      })],
    });
    expect(payload.candidate_duplicate_risk).toBe(true);
  });

  it("applies the supplier filter to candidate matches when clients_id is provided", async () => {
    const handler = setupDuplicateTool([
      {
        id: 1,
        clients_id: 10,
        client_name: "Acme Ltd",
        number: "INV-2",
        create_date: "2026-03-11",
        gross_price: 248,
        status: "CONFIRMED",
      },
      {
        id: 2,
        clients_id: 11,
        client_name: "Other Supplier",
        number: "INV-2",
        create_date: "2026-03-11",
        gross_price: 248,
        status: "CONFIRMED",
      },
    ]);

    const result = await handler({
      clients_id: 10,
      date_from: "2026-03-11",
      date_to: "2026-03-11",
      invoice_number: "INV-2",
      gross_price: 248,
    });

    const payload = parseMcpResponse(result.content[0]!.text);

    expect(payload.candidate_invoice_number_matches.count).toBe(1);
    expect(payload.candidate_invoice_number_matches.items).toEqual([
      expect.objectContaining({
        id: 1,
        supplier: expect.stringMatching(/^<<UNTRUSTED_OCR_START:[0-9a-f]+>>\nAcme Ltd\n<<UNTRUSTED_OCR_END:[0-9a-f]+>>$/),
        supplier_id: 10,
      }),
    ]);
    expect(payload.candidate_same_amount_date_matches.count).toBe(1);
    expect(payload.candidate_same_amount_date_matches.items).toEqual([
      expect.objectContaining({
        id: 1,
        supplier: expect.stringMatching(/^<<UNTRUSTED_OCR_START:[0-9a-f]+>>\nAcme Ltd\n<<UNTRUSTED_OCR_END:[0-9a-f]+>>$/),
        supplier_id: 10,
      }),
    ]);
  });
});
