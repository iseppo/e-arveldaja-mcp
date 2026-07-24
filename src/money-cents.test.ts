import { describe, it, expect } from "vitest";
import { roundMoney } from "./money.js";
import {
  toCents,
  exactCents,
  fromCents,
  centsEqual,
  compareCents,
  centsWithinTolerance,
  eurosWithinTolerance,
  ONE_CENT,
  TEN_CENTS,
} from "./money-cents.js";
import { toExchangeRate, EXCHANGE_RATE_DECIMALS } from "./exchange-rate.js";

describe("toCents", () => {
  it("converts whole-cent euro amounts to integer cents", () => {
    expect(toCents(12.34)).toBe(1234);
    expect(toCents(0)).toBe(0);
    expect(toCents(-12.34)).toBe(-1234);
    expect(toCents(1000000)).toBe(100000000);
  });

  it("reuses roundMoney so float-fuzzy inputs land on the canonical cent", () => {
    expect(toCents(0.1 + 0.2)).toBe(30); // roundMoney(0.30000000000000004) === 0.3
    expect(toCents(1.005)).toBe(101); // roundMoney(1.005) === 1.01
    expect(toCents(2.675)).toBe(268); // roundMoney(2.675) === 2.68
  });

  it("rejects non-finite inputs", () => {
    expect(() => toCents(NaN)).toThrow("NaN");
    expect(() => toCents(Infinity)).toThrow("non-finite");
    expect(() => toCents(-Infinity)).toThrow("non-finite");
  });

  it("rejects amounts whose cent value would not be a safe integer", () => {
    expect(() => toCents(1e18)).toThrow("safe-integer");
  });

  it("is a plain number at runtime (never a bigint)", () => {
    expect(typeof toCents(12.34)).toBe("number");
    expect(Number.isSafeInteger(toCents(12.34))).toBe(true);
  });
});

describe("exactCents", () => {
  it("accepts euro amounts already at cent precision", () => {
    expect(exactCents(12.34)).toBe(1234);
    expect(exactCents(0)).toBe(0);
    expect(exactCents(-5.5)).toBe(-550);
  });

  it("rejects sub-cent (excess-precision) inputs instead of rounding them", () => {
    expect(() => exactCents(12.345)).toThrow("cent precision");
    expect(() => exactCents(1.005)).toThrow("cent precision");
  });

  it("rejects non-finite and unsafe inputs", () => {
    expect(() => exactCents(NaN)).toThrow("NaN");
    expect(() => exactCents(Infinity)).toThrow("non-finite");
    expect(() => exactCents(1e18)).toThrow("safe-integer");
  });
});

describe("fromCents", () => {
  it("converts integer cents back to euros", () => {
    expect(fromCents(toCents(12.34))).toBe(12.34);
    expect(fromCents(toCents(0))).toBe(0);
    expect(fromCents(toCents(-99.99))).toBe(-99.99);
  });

  it("round-trips to the canonical roundMoney value", () => {
    for (const value of [12.34, 0.1 + 0.2, 1.005, 999999.99, -42.5]) {
      expect(fromCents(toCents(value))).toBe(roundMoney(value));
    }
  });
});

describe("cent comparison helpers", () => {
  it("centsEqual compares exact integer cents", () => {
    expect(centsEqual(toCents(12.34), toCents(12.34))).toBe(true);
    expect(centsEqual(toCents(12.34), toCents(12.35))).toBe(false);
    // The classic float trap: 0.1 + 0.2 !== 0.3 as floats, equal as cents.
    expect(centsEqual(toCents(0.1 + 0.2), toCents(0.3))).toBe(true);
  });

  it("compareCents returns the sign of the difference", () => {
    expect(compareCents(toCents(1), toCents(2))).toBe(-1);
    expect(compareCents(toCents(2), toCents(2))).toBe(0);
    expect(compareCents(toCents(3), toCents(2))).toBe(1);
  });

  it("centsWithinTolerance treats the bound as inclusive", () => {
    expect(centsWithinTolerance(toCents(1.00), toCents(1.01), ONE_CENT)).toBe(true);
    expect(centsWithinTolerance(toCents(1.00), toCents(1.02), ONE_CENT)).toBe(false);
    expect(centsWithinTolerance(toCents(1.00), toCents(1.10), TEN_CENTS)).toBe(true);
    expect(centsWithinTolerance(toCents(1.00), toCents(1.11), TEN_CENTS)).toBe(false);
  });

  it("eurosWithinTolerance decides euro tolerance by exact cents", () => {
    expect(eurosWithinTolerance(1.00, 1.10, TEN_CENTS)).toBe(true);
    expect(eurosWithinTolerance(1.00, 1.11, TEN_CENTS)).toBe(false);
    // Float subtraction of these would be 0.09999999999999998; cents is exact.
    expect(eurosWithinTolerance(1.30, 1.20, TEN_CENTS)).toBe(true);
  });
});

describe("exchange rate is separate from cents", () => {
  it("rounds to rate precision and rejects non-positive / non-finite", () => {
    expect(EXCHANGE_RATE_DECIMALS).toBe(6);
    expect(toExchangeRate(1.23456789)).toBe(1.234568);
    expect(() => toExchangeRate(0)).toThrow("positive");
    expect(() => toExchangeRate(-1)).toThrow("positive");
    expect(() => toExchangeRate(NaN)).toThrow("NaN");
    expect(() => toExchangeRate(Infinity)).toThrow("non-finite");
  });
});
