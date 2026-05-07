import { describe, expect, it, vi } from "vitest";
import { registerReferenceDataTools } from "./reference-data-tools.js";

describe("registerReferenceDataTools", () => {
  it("keeps the public reference-data tool surface registered", () => {
    const server = { registerTool: vi.fn() };
    const api = {
      readonly: {},
    };

    registerReferenceDataTools(server as never, api as never);

    expect(server.registerTool.mock.calls.map(([name]) => name)).toEqual([
      "list_accounts",
      "list_account_dimensions",
      "list_currencies",
      "list_sale_articles",
      "list_purchase_articles",
      "list_templates",
      "list_projects",
      "get_invoice_info",
      "get_vat_info",
      "list_invoice_series",
      "create_invoice_series",
      "list_bank_accounts",
      "create_bank_account",
    ]);
  });
});
