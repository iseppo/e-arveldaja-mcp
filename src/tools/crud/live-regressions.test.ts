import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerProductTools } from "./products.js";
import { registerSaleInvoiceTools } from "./sale-invoices.js";
import { parseMcpResponse } from "../../mcp-json.js";

vi.mock("../../audit-log.js", () => ({ logAudit: vi.fn() }));

function harness(kind: "product" | "sale", current: Record<string, unknown> = {}) {
  const resource = {
    get: vi.fn().mockResolvedValue(current),
    invalidateListCache: vi.fn(),
    update: vi.fn().mockResolvedValue({ code: 200 }),
    create: vi.fn().mockResolvedValue({ created_object_id: 51 }),
  };
  const api = { products: resource, saleInvoices: resource };
  const server = { registerTool: vi.fn() };
  (kind === "product" ? registerProductTools : registerSaleInvoiceTools)(server as never, api as never);
  function tool(name: string) {
    const registration = server.registerTool.mock.calls.find(([n]) => n === name)!;
    return {
      schema: z.object(registration[1].inputSchema),
      call: registration[2] as (args: Record<string, unknown>) => Promise<any>,
    };
  }
  return { resource, tool };
}

describe("live MCP product regressions", () => {
  it("reads fresh selectors for name-only PATCH and excludes computed account/state fields", async () => {
    const { resource, tool } = harness("product", {
      id: 51, name: "Old", code: "EXAMPLE", is_deleted: false,
      cl_sale_articles_id: 7, sale_accounts_id: 3100, sale_accounts_dimensions_id: 81,
      cl_purchase_articles_id: 8, purchase_accounts_id: 4000, purchase_accounts_dimensions_id: 82,
    });
    await tool("update_product").call({ id: 51, data: { name: "New" } });
    expect(resource.invalidateListCache).toHaveBeenCalledBefore(resource.get);
    expect(resource.get).toHaveBeenCalledWith(51);
    expect(resource.update).toHaveBeenCalledWith(51, {
      name: "New", cl_sale_articles_id: 7, sale_accounts_dimensions_id: 81,
      cl_purchase_articles_id: 8, purchase_accounts_dimensions_id: 82,
    });
  });

  it.each(["sale_accounts_id", "purchase_accounts_id"])("refuses read-only %s in create with actionable article guidance", async (field) => {
    const { resource, tool } = harness("product");
    const response = await tool("create_product").call({ name: "Service", code: "SRV", [field]: 3100 });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(parseMcpResponse(response.content[0].text))).toContain("article");
    expect(resource.create).not.toHaveBeenCalled();
  });

  it("canonicalizes the legacy sales-dimension alias without sending it to API", async () => {
    const { resource, tool } = harness("product");
    await tool("create_product").call({ name: "Service", code: "SRV", cl_sale_articles_id: 7, cl_sale_accounts_dimensions_id: 81 });
    expect(resource.create).toHaveBeenCalledWith({ name: "Service", code: "SRV", cl_sale_articles_id: 7, sale_accounts_dimensions_id: 81 });
  });

  it("refuses article-less creation before contacting the API", async () => {
    const { resource, tool } = harness("product");
    expect((await tool("create_product").call({ name: "Service", code: "SRV" })).isError).toBe(true);
    expect(resource.create).not.toHaveBeenCalled();
  });

  it("refuses conflicting legacy/canonical dimension aliases", async () => {
    const { resource, tool } = harness("product");
    expect((await tool("create_product").call({ name: "Service", code: "SRV", cl_sale_articles_id: 7,
      cl_sale_accounts_dimensions_id: 81, sale_accounts_dimensions_id: 82 })).isError).toBe(true);
    expect(resource.create).not.toHaveBeenCalled();
  });

  it.each(["sale", "purchase"])("refuses carrying old %s dimension across an article change", async (side) => {
    const article = `cl_${side}_articles_id`;
    const dimension = `${side}_accounts_dimensions_id`;
    const { resource, tool } = harness("product", { [article]: 7, [dimension]: 81 });
    expect((await tool("update_product").call({ id: 51, data: { [article]: 8 } })).isError).toBe(true);
    expect(resource.update).not.toHaveBeenCalled();
  });

  it("allows explicit dimension clearing when changing an article", async () => {
    const { resource, tool } = harness("product", { cl_sale_articles_id: 7, sale_accounts_dimensions_id: 81 });
    await tool("update_product").call({ id: 51, data: { cl_sale_articles_id: 8, sale_accounts_dimensions_id: null } });
    expect(resource.update).toHaveBeenCalledWith(51, { cl_sale_articles_id: 8, sale_accounts_dimensions_id: null });
  });

  it.each([{ name: "x".repeat(1001) }, { code: "x".repeat(21) }, { unit: "x".repeat(11) }])("enforces official string limits in create and update: %j", async (data) => {
    const { resource, tool } = harness("product");
    expect(tool("create_product").schema.safeParse({ name: "Service", code: "SRV", ...data }).success).toBe(false);
    const result = await tool("update_product").call({ id: 51, data });
    expect(result.isError).toBe(true);
    expect(resource.update).not.toHaveBeenCalled();
    expect(resource.get).not.toHaveBeenCalled();
  });

  it.each([{ mysterious: true }, { is_deleted: true }, { sale_accounts_id: 3100 }])("rejects unknown or read-only update fields before any read: %j", async (data) => {
    const { resource, tool } = harness("product");
    const result = await tool("update_product").call({ id: 51, data });
    expect(result.isError).toBe(true);
    expect(resource.update).not.toHaveBeenCalled();
    expect(resource.get).not.toHaveBeenCalled();
  });
});

describe("live MCP sales header regression", () => {
  it("resends the fresh complete draft rows on a notes-only update", async () => {
    const items = [{ id: 91, products_id: 51, custom_title: "Service", amount: 2, unit_net_price: 0.01, sale_accounts_id: 3100, sale_accounts_dimensions_id: 81 }];
    const { resource, tool } = harness("sale", { id: 71, status: "PROJECT", items });
    await tool("update_sale_invoice").call({ id: 71, data: { notes: "Changed" } });
    expect(resource.invalidateListCache).toHaveBeenCalledBefore(resource.get);
    expect(resource.update).toHaveBeenCalledWith(71, { notes: "Changed", items });
  });

  it.each(["CONFIRMED", "VOID", "UNKNOWN"])("never injects draft rows on %s", async (status) => {
    const { resource, tool } = harness("sale", { id: 71, status, items: [{ id: 91 }] });
    await tool("update_sale_invoice").call({ id: 71, data: { notes: "Changed" } });
    for (const [, payload] of resource.update.mock.calls) expect(payload).not.toHaveProperty("items");
  });
});
