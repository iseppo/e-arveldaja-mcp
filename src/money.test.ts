import { describe, it, expect, vi } from "vitest";
import { roundMoney, parseVatRateDropdown, effectiveGross } from "./money.js";

describe("roundMoney", () => {
  it("rounds to 2 decimal places", () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(1.235)).toBe(1.24);
    expect(roundMoney(99.999)).toBe(100);
  });

  it("handles IEEE 754 edge cases", () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(2.675)).toBe(2.68);
  });

  it("handles zero, negatives, and special values", () => {
    expect(roundMoney(0)).toBe(0);
    expect(Object.is(roundMoney(-0), 0)).toBe(true); // -0 returns +0
    expect(roundMoney(-1.235)).toBe(-1.24);
    expect(roundMoney(-0.005)).toBe(-0.01);
    expect(() => roundMoney(NaN)).toThrow("roundMoney received NaN");
    expect(() => roundMoney(Infinity)).toThrow("non-finite value");
    expect(() => roundMoney(-Infinity)).toThrow("non-finite value");
  });

  it("handles mid-range .005 boundaries correctly", () => {
    expect(roundMoney(10000.005)).toBe(10000.01);
    expect(roundMoney(-10000.005)).toBe(-10000.01);
    expect(roundMoney(0.005)).toBe(0.01);
    expect(roundMoney(100.005)).toBe(100.01);
  });

  it("handles large values", () => {
    expect(roundMoney(1000000.995)).toBe(1000001);
    expect(roundMoney(1000000.005)).toBe(1000000.01);
    expect(roundMoney(999999.995)).toBe(1000000);
    expect(roundMoney(-999999.995)).toBe(-1000000);
    expect(roundMoney(123456.789)).toBe(123456.79);
  });

  it("does not zero extremely large values", () => {
    expect(roundMoney(1e19)).toBe(1e19);
    expect(roundMoney(-1e19)).toBe(-1e19);
    expect(roundMoney(1e21)).toBe(1e21);
    expect(roundMoney(-1e21)).toBe(-1e21);
  });

  it("handles already-rounded values", () => {
    expect(roundMoney(1.23)).toBe(1.23);
    expect(roundMoney(100)).toBe(100);
  });

  it("rounds values on both sides of the half-cent boundary", () => {
    expect(roundMoney(1.2349)).toBe(1.23);
    expect(roundMoney(1.2351)).toBe(1.24);
    expect(roundMoney(-1.2349)).toBe(-1.23);
    expect(roundMoney(-1.2351)).toBe(-1.24);
  });
});

describe("parseVatRateDropdown", () => {
  it("parses integer rate string", () => {
    expect(parseVatRateDropdown("9")).toBe(9);
    expect(parseVatRateDropdown("24")).toBe(24);
  });

  it("returns 0 for dash (no VAT)", () => {
    expect(parseVatRateDropdown("-")).toBe(0);
  });

  it("parses comma-separated decimal rate", () => {
    expect(parseVatRateDropdown("9,5")).toBe(9.5);
  });

  it("parses rate with percent sign", () => {
    expect(parseVatRateDropdown("9.5%")).toBe(9.5);
  });

  it("returns 0 for null or undefined", () => {
    expect(parseVatRateDropdown(null)).toBe(0);
    expect(parseVatRateDropdown(undefined)).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(parseVatRateDropdown("")).toBe(0);
  });

  it("returns 0 for non-numeric string", () => {
    expect(parseVatRateDropdown("abc")).toBe(0);
  });

  it("passes through numeric values", () => {
    expect(parseVatRateDropdown(24)).toBe(24);
    expect(parseVatRateDropdown(9.5)).toBe(9.5);
  });
});

describe("effectiveGross", () => {
  it("returns base_gross_price when present", () => {
    expect(effectiveGross({ base_gross_price: 92, gross_price: 100, id: 1 })).toBe(92);
  });

  it("falls back to gross_price when base_gross_price is null", () => {
    expect(effectiveGross({ base_gross_price: null, gross_price: 100, id: 2 })).toBe(100);
  });

  it("falls back to gross_price when base_gross_price is undefined", () => {
    expect(effectiveGross({ gross_price: 55.5, id: 3 })).toBe(55.5);
  });

  it("returns 0 and warns on stderr when both are null", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = effectiveGross({ base_gross_price: null, gross_price: null, id: 42 });
    expect(result).toBe(0);
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stderrSpy.mock.calls[0]![0]).toContain("42");
    stderrSpy.mockRestore();
  });

  it("includes 'unknown' in warning when id is missing", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    effectiveGross({ base_gross_price: null, gross_price: null });
    expect(stderrSpy.mock.calls[0]![0]).toContain("unknown");
    stderrSpy.mockRestore();
  });
});
