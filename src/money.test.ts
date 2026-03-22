import { describe, it, expect } from "vitest";
import { roundMoney } from "./money.js";

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
    expect(roundMoney(Infinity)).toBe(0);
    expect(roundMoney(-Infinity)).toBe(0);
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
