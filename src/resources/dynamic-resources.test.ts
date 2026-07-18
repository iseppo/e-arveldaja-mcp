import { describe, expect, it, vi } from "vitest";
import { parseMcpResponse } from "../mcp-json.js";
import { registerDynamicResources } from "./dynamic-resources.js";

const resourceCases = [
  ["client", "clients", "earveldaja://clients/7", { id: 7, name: "Injected client" }],
  ["product", "products", "earveldaja://products/7", { id: 7, name: "Injected product" }],
  ["journal", "journals", "earveldaja://journals/7", { id: 7, title: "Injected journal", postings: [] }],
  ["sale_invoice", "saleInvoices", "earveldaja://sale_invoices/7", { id: 7, client_name: "Injected buyer", items: [{ custom_title: "Injected item" }] }],
  ["purchase_invoice", "purchaseInvoices", "earveldaja://purchase_invoices/7", { id: 7, client_name: "Injected supplier", items: [{ custom_title: "Injected item" }] }],
  ["transaction", "transactions", "earveldaja://transactions/7", { id: 7, bank_account_name: "Injected bank party", description: "Injected description" }],
] as const;

describe("dynamic external-text rendering", () => {
  it.each(resourceCases)("sandboxes the %s resource without mutating the source", async (resourceName, apiKey, uri, source) => {
    const server = { registerResource: vi.fn() } as unknown as Parameters<typeof registerDynamicResources>[0];
    const api = {
      clients: { get: vi.fn() }, products: { get: vi.fn() }, journals: { get: vi.fn() },
      saleInvoices: { get: vi.fn() }, purchaseInvoices: { get: vi.fn() }, transactions: { get: vi.fn() },
    } as never;
    const snapshot = JSON.parse(JSON.stringify(source));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (api as any)[apiKey].get.mockResolvedValue(source);
    registerDynamicResources(server, api);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registration = (server.registerResource as any).mock.calls.find(([name]: [string]) => name === resourceName);
    if (!registration) throw new Error(`Resource not registered: ${resourceName}`);
    const handler = registration[3] as (uri: URL, params: { id: string }) => Promise<{ contents: Array<{ text: string }> }>;
    const response = await handler(new URL(uri), { id: "7" });
    const payload = parseMcpResponse(response.contents[0]!.text);
    expect(JSON.stringify(payload)).toContain("UNTRUSTED_OCR_START:");
    expect(source).toEqual(snapshot);
  });
});
