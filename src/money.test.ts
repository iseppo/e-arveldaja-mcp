import { describe, it, expect } from "vitest";
import { roundMoney } from "./money.js";

describe("roundMoney", () => {
  it("rounds to 2 decimal places", () => {
    expect(roundMoney(1.005)).toBe(1);
    expect(roundMoney(1.235)).toBe(1.24);
    expect(roundMoney(99.999)).toBe(100);
  });

  it("handles IEEE 754 edge cases", () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(2.675)).toBe(2.68);
  });

  it("handles zero and negatives", () => {
    expect(roundMoney(0)).toBe(0);
    expect(roundMoney(-1.235)).toBe(-1.24);
    expect(roundMoney(-0) === 0).toBe(true); // -0 and +0 are equal under ===
  });

  it("handles large values", () => {
    expect(roundMoney(1000000.995)).toBe(1000001);
    expect(roundMoney(123456.789)).toBe(123456.79);
  });

  it("handles already-rounded values", () => {
    expect(roundMoney(1.23)).toBe(1.23);
    expect(roundMoney(100)).toBe(100);
  });
});
