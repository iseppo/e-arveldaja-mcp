import { describe, it, expect } from "vitest";
import { applyListView, BRIEF_FIELDS } from "./list-views.js";
import { toMcpJson } from "./mcp-json.js";

describe("applyListView", () => {
  it("returns items unchanged when view='full'", () => {
    const items = [{ id: 1, name: "x", code: "C", notes: "secret" }];
    expect(applyListView("client", items, "full")).toBe(items);
  });

  it("strips to brief field set when view is undefined (default)", () => {
    const items = [{
      id: 1, name: "Alice", code: "C-1", email: "a@b.c", invoice_vat_no: "EE1",
      is_client: true, is_supplier: false, is_deleted: false,
      address_text: "should be stripped", notes: "should be stripped",
      bank_account_no: "EE0", invoice_electronic_opts: { foo: "bar" },
    }];
    const out = applyListView("client", items, undefined) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: 1, name: "Alice", code: "C-1", email: "a@b.c", invoice_vat_no: "EE1",
      is_client: true, is_supplier: false, is_deleted: false,
    });
    expect(out[0]).not.toHaveProperty("address_text");
    expect(out[0]).not.toHaveProperty("notes");
    expect(out[0]).not.toHaveProperty("invoice_electronic_opts");
  });

  it("strips to brief field set when view='brief'", () => {
    const items = [{
      id: 5, name: "P", code: "P-5", sales_price: 100, unit: "h",
      price_currency: "EUR", description: "long text", notes: "x", is_deleted: false,
    }];
    const out = applyListView("product", items, "brief") as Array<Record<string, unknown>>;
    expect(out[0]).toEqual({
      id: 5, name: "P", code: "P-5", sales_price: 100, unit: "h",
      price_currency: "EUR", is_deleted: false,
    });
  });

  it("omits fields that are absent on the source row (no undefined fill)", () => {
    const items = [{ id: 7, name: "minimal" }];
    const out = applyListView("client", items, "brief") as Array<Record<string, unknown>>;
    expect(out[0]).toEqual({ id: 7, name: "minimal" });
    expect(Object.keys(out[0])).toEqual(["id", "name"]);
  });

  it("passes non-object rows through untouched", () => {
    const items = [null, "weird", 42] as unknown[];
    const out = applyListView("client", items as never[], "brief");
    expect(out).toEqual([null, "weird", 42]);
  });

  it("brief output is meaningfully smaller than full when TOON-encoded", () => {
    const fullRow = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`field_${i}`, `value-${i}`])
        .concat([
          ["id", 1], ["name", "Alice"], ["code", "C"], ["email", "a@b.c"],
          ["invoice_vat_no", "EE1"], ["is_client", true], ["is_supplier", false],
          ["is_deleted", false], ["invoice_electronic_opts", { x: "y" }],
        ]),
    );
    const items = Array.from({ length: 20 }, (_, i) => ({ ...fullRow, id: i }));
    const fullSize = toMcpJson({ items: applyListView("client", items, "full") }).length;
    const briefSize = toMcpJson({ items: applyListView("client", items, "brief") }).length;
    expect(briefSize).toBeLessThan(fullSize / 2);
  });

  it("BRIEF_FIELDS lists are non-empty for every supported entity", () => {
    for (const fields of Object.values(BRIEF_FIELDS)) {
      expect(fields.length).toBeGreaterThan(0);
      expect(fields).toContain("id");
    }
  });
});
