import { describe, expect, it } from "vitest";
import {
  arrayAt,
  isRecord,
  numberAt,
  recordAt,
  stringArrayAt,
  stringAt,
} from "./record-utils.js";

describe("record-utils", () => {
  it("recognizes plain JSON records and rejects arrays/nulls", () => {
    expect(isRecord({ id: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });

  it("reads only finite numeric fields", () => {
    const record = { count: 3, nan: Number.NaN, infinite: Number.POSITIVE_INFINITY, text: "3" };

    expect(numberAt(record, "count")).toBe(3);
    expect(numberAt(record, "nan")).toBeUndefined();
    expect(numberAt(record, "infinite")).toBeUndefined();
    expect(numberAt(record, "text")).toBeUndefined();
    expect(numberAt(record, "missing")).toBeUndefined();
  });

  it("reads strings, arrays, nested records, and string arrays defensively", () => {
    const nested = { ok: true };
    const record = {
      name: "receipt",
      count: 2,
      items: ["a", 1, "b", null],
      nested,
      nested_array: [nested],
    };

    expect(stringAt(record, "name")).toBe("receipt");
    expect(stringAt(record, "count")).toBeUndefined();
    expect(arrayAt(record, "items")).toEqual(["a", 1, "b", null]);
    expect(arrayAt(record, "missing")).toEqual([]);
    expect(recordAt(record, "nested")).toBe(nested);
    expect(recordAt(record, "nested_array")).toBeUndefined();
    expect(stringArrayAt(record, "items")).toEqual(["a", "b"]);
  });
});
