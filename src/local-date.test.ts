import { describe, expect, it } from "vitest";
import { todayInTallinn } from "./local-date.js";

describe("todayInTallinn", () => {
  it("rolls over at Tallinn midnight, not UTC midnight (summer, UTC+3)", () => {
    expect(todayInTallinn(new Date("2026-09-25T20:59:00Z"))).toBe("2026-09-25");
    expect(todayInTallinn(new Date("2026-09-25T21:00:00Z"))).toBe("2026-09-26");
  });

  it("rolls over at Tallinn midnight in winter (UTC+2)", () => {
    expect(todayInTallinn(new Date("2026-12-31T21:59:00Z"))).toBe("2026-12-31");
    expect(todayInTallinn(new Date("2026-12-31T22:00:00Z"))).toBe("2027-01-01");
  });
});
