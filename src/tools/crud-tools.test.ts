import { describe, it, expect } from "vitest";
import {
  safeJsonParse,
  parseSaleInvoiceItems,
  parsePurchaseInvoiceItems,
  parseJsonObject,
  parseJsonObjectArray,
  requireFields,
  MAX_JSON_INPUT_SIZE,
} from "./crud-tools.js";

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse('{"a":1}', "test")).toEqual({ a: 1 });
    expect(safeJsonParse("[1,2,3]", "test")).toEqual([1, 2, 3]);
    expect(safeJsonParse('"hello"', "test")).toBe("hello");
  });

  it("throws on invalid JSON", () => {
    expect(() => safeJsonParse("{invalid", "test")).toThrow('Invalid JSON in "test"');
  });

  it("throws on oversized input", () => {
    const huge = "x".repeat(MAX_JSON_INPUT_SIZE + 1);
    expect(() => safeJsonParse(huge, "test")).toThrow("exceeds maximum size");
  });

  it("accepts JSON whose length is exactly MAX_JSON_INPUT_SIZE", () => {
    const value = "x".repeat(MAX_JSON_INPUT_SIZE - 2);
    const json = `"${value}"`;
    expect(json.length).toBe(MAX_JSON_INPUT_SIZE);
    expect(safeJsonParse(json, "test")).toBe(value);
  });
});

describe("parseJsonObject", () => {
  it("parses a valid JSON object", () => {
    expect(parseJsonObject('{"name":"test"}', "data")).toEqual({ name: "test" });
  });

  it("throws on JSON array", () => {
    expect(() => parseJsonObject("[1,2]", "data")).toThrow('"data" must be a JSON object');
  });

  it("throws on JSON string", () => {
    expect(() => parseJsonObject('"hello"', "data")).toThrow('"data" must be a JSON object');
  });
});

describe("parseJsonObjectArray", () => {
  it("parses a valid JSON array of objects", () => {
    const result = parseJsonObjectArray('[{"a":1},{"b":2}]', "items");
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("throws on non-array JSON", () => {
    expect(() => parseJsonObjectArray('{"a":1}', "items")).toThrow('"items" must be a JSON array');
  });

  it("throws when array contains non-objects", () => {
    expect(() => parseJsonObjectArray('[1, 2]', "items")).toThrow('"items" item 1 must be a JSON object');
  });
});

describe("requireFields", () => {
  it("passes when all fields present", () => {
    expect(() => requireFields([{ a: 1, b: "x" }], "items", ["a", "b"])).not.toThrow();
  });

  it("throws on missing field", () => {
    expect(() => requireFields([{ a: 1 }], "items", ["a", "b"])).toThrow('"items" item 1 is missing required field "b"');
  });

  it("throws on null field", () => {
    expect(() => requireFields([{ a: null }], "items", ["a"])).toThrow('"items" item 1 is missing required field "a"');
  });

  it("throws on empty string field", () => {
    expect(() => requireFields([{ a: "" }], "items", ["a"])).toThrow('"items" item 1 is missing required field "a"');
  });

  it("reports correct item index", () => {
    expect(() => requireFields([{ a: 1 }, { b: 2 }], "items", ["a"])).toThrow("item 2");
  });
});

describe("parsePurchaseInvoiceItems", () => {
  it("parses valid items", () => {
    const items = parsePurchaseInvoiceItems('[{"cl_purchase_articles_id":45,"custom_title":"Internet"}]');
    expect(items).toHaveLength(1);
    expect(items[0]!.custom_title).toBe("Internet");
  });

  it("throws when cl_purchase_articles_id missing", () => {
    expect(() => parsePurchaseInvoiceItems('[{"custom_title":"test"}]')).toThrow("cl_purchase_articles_id");
  });

  it("throws when custom_title missing", () => {
    expect(() => parsePurchaseInvoiceItems('[{"cl_purchase_articles_id":1}]')).toThrow("custom_title");
  });
});

describe("parseSaleInvoiceItems", () => {
  it("coerces string-typed discount_percent to number", () => {
    const items = parseSaleInvoiceItems('[{"products_id":1,"custom_title":"Service","amount":1,"discount_percent":"10"}]');
    expect(items[0]!.discount_percent).toBe(10);
  });

  it("rejects non-numeric discount_percent values", () => {
    expect(() =>
      parseSaleInvoiceItems('[{"products_id":1,"custom_title":"Service","amount":1,"discount_percent":"bad"}]')
    ).toThrow("discount_percent");
  });
});
