import { describe, expect, it } from "vitest";
import {
  isStrictDate,
  isStrictDateRange,
  parseStrictDate,
  parseStrictMonth,
  validateOptionalStrictDate,
  validateOptionalStrictDateRange,
} from "./strict-date.js";

describe("parseStrictDate", () => {
  it.each([
    "2026-02-29", // 2026 is not a leap year
    "2026-02-31",
    "2026-13-01",
    "2026-00-10",
    "2026-01-00",
    "2026-04-31",
    "2026-1-1", // non-canonical form
    "26-01-01",
    "2026/01/01",
    "2026-01-01T00:00:00Z",
    " 2026-01-01",
    "2026-01-01 ",
    "",
    "not-a-date",
    "1900-02-29", // century non-leap
  ])("rejects %s", value => {
    expect(parseStrictDate(value)).toBeUndefined();
    expect(isStrictDate(value)).toBe(false);
  });

  it.each([
    "2024-02-29", // real leap day
    "2000-02-29", // 400-year leap
    "2026-01-01",
    "2026-12-31",
    "2026-02-28",
    "2026-04-30",
  ])("accepts %s and returns the canonical value", value => {
    const parsed = parseStrictDate(value);
    expect(parsed).toBeDefined();
    expect(parsed!.canonical).toBe(value);
  });

  it("returns the numeric parts", () => {
    expect(parseStrictDate("2026-07-24")).toEqual({ year: 2026, month: 7, day: 24, canonical: "2026-07-24" });
  });
});

describe("parseStrictMonth", () => {
  it("accepts canonical months and rejects invalid ones", () => {
    expect(parseStrictMonth("2026-07")).toEqual({ year: 2026, month: 7, canonical: "2026-07" });
    expect(parseStrictMonth("2026-13")).toBeUndefined();
    expect(parseStrictMonth("2026-00")).toBeUndefined();
    expect(parseStrictMonth("2026-7")).toBeUndefined();
    expect(parseStrictMonth("2026-07-01")).toBeUndefined();
  });
});

describe("isStrictDateRange", () => {
  it("requires strict dates on both sides and from <= to", () => {
    expect(isStrictDateRange("2026-01-01", "2026-01-31")).toBe(true);
    expect(isStrictDateRange("2026-01-01", "2026-01-01")).toBe(true);
    expect(isStrictDateRange("2026-02-01", "2026-01-31")).toBe(false);
    expect(isStrictDateRange("2026-02-30", "2026-03-01")).toBe(false);
  });
});

describe("validateOptionalStrictDate / Range", () => {
  it("passes undefined through and names the offending field", () => {
    expect(validateOptionalStrictDate("date_from", undefined)).toBeUndefined();
    expect(validateOptionalStrictDate("date_from", "2026-01-15")).toBeUndefined();
    expect(validateOptionalStrictDate("date_from", "2026-02-31")).toContain("date_from");
  });

  it("rejects an inverted range with a field-naming message", () => {
    expect(validateOptionalStrictDateRange("date_from", "2026-02-01", "date_to", "2026-01-01")).toContain("date_from");
    expect(validateOptionalStrictDateRange("date_from", "2026-01-01", "date_to", "2026-02-01")).toBeUndefined();
    expect(validateOptionalStrictDateRange("date_from", undefined, "date_to", undefined)).toBeUndefined();
    expect(validateOptionalStrictDateRange("date_from", undefined, "date_to", "2026-00-01")).toContain("date_to");
  });
});
