import { describe, expect, it } from "vitest";
import { daysPastDue, getMonthLastDay, toUtcDay } from "./date-utils.js";

describe("toUtcDay", () => {
  it("maps a date or ISO prefix to its UTC-midnight epoch millis", () => {
    expect(toUtcDay("2026-03-29")).toBe(Date.UTC(2026, 2, 29));
    expect(toUtcDay("2026-03-29T23:59:59+03:00")).toBe(Date.UTC(2026, 2, 29));
    expect(toUtcDay("2026-03-30") - toUtcDay("2026-03-29")).toBe(86_400_000);
  });

  it("is lenient: missing parts default to 1, garbage yields NaN", () => {
    expect(toUtcDay("2026")).toBe(Date.UTC(2026, 0, 1));
    expect(toUtcDay("2026-02-30")).toBe(Date.UTC(2026, 2, 2));
    expect(toUtcDay("not-a-date")).toBeNaN();
  });
});

describe("getMonthLastDay", () => {
  it("returns the day count of the month, leap-year aware", () => {
    expect(getMonthLastDay("2026-01")).toBe(31);
    expect(getMonthLastDay("2026-04")).toBe(30);
    expect(getMonthLastDay("2026-02")).toBe(28);
    expect(getMonthLastDay("2024-02")).toBe(29);
    expect(getMonthLastDay("2000-02")).toBe(29);
    expect(getMonthLastDay("1900-02")).toBe(28);
  });
});

describe("daysPastDue", () => {
  it("counts whole days from due date to as-of date, signed", () => {
    expect(daysPastDue("2026-01-31", "2026-03-01")).toBe(29);
    expect(daysPastDue("2026-03-01", "2026-03-01")).toBe(0);
    expect(daysPastDue("2026-03-10", "2026-03-01")).toBe(-9);
    expect(daysPastDue("2024-02-28", "2024-03-01")).toBe(2);
  });

  it("yields NaN for input that is not a bare date", () => {
    expect(daysPastDue("2026-03-01T00:00:00Z", "2026-03-02")).toBeNaN();
    expect(daysPastDue("2026-03-01", "garbage")).toBeNaN();
  });
});
