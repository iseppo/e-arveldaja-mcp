import { describe, it, expect } from "vitest";
import {
  standardVatRateOn,
  detectVatDeductionNotes,
  STANDARD_VAT_RATE_TIMELINE,
  REDUCED_VAT_RATES,
} from "./estonian-tax-rules.js";

describe("standardVatRateOn", () => {
  it("returns the rate in force on the given date", () => {
    expect(standardVatRateOn("2023-11-15")).toBe(20);
    expect(standardVatRateOn("2024-06-01")).toBe(22);
    expect(standardVatRateOn("2025-08-01")).toBe(24);
  });

  it("respects the exact change-over boundaries (inclusive)", () => {
    expect(standardVatRateOn("2023-12-31")).toBe(20);
    expect(standardVatRateOn("2024-01-01")).toBe(22);
    expect(standardVatRateOn("2025-06-30")).toBe(22);
    expect(standardVatRateOn("2025-07-01")).toBe(24);
  });

  it("tolerates full ISO timestamps and returns null on bad input", () => {
    expect(standardVatRateOn("2025-07-01T10:30:00Z")).toBe(24);
    expect(standardVatRateOn("not-a-date")).toBeNull();
    expect(standardVatRateOn(undefined)).toBeNull();
    expect(standardVatRateOn(null)).toBeNull();
  });

  it("keeps the timeline contiguous with no gaps or open middle periods", () => {
    for (let i = 1; i < STANDARD_VAT_RATE_TIMELINE.length; i++) {
      const prev = STANDARD_VAT_RATE_TIMELINE[i - 1];
      const cur = STANDARD_VAT_RATE_TIMELINE[i];
      expect(prev.to).not.toBeNull();
      // current period starts the day after the previous one ends
      expect(cur.from > (prev.to as string)).toBe(true);
    }
    // only the last period may be open-ended
    expect(STANDARD_VAT_RATE_TIMELINE[STANDARD_VAT_RATE_TIMELINE.length - 1].to).toBeNull();
  });

  it("exposes the current reduced rates", () => {
    const accommodation = REDUCED_VAT_RATES.find(r => /majutus/.test(r.applies));
    expect(accommodation?.rate).toBe(13);
    const zero = REDUCED_VAT_RATES.find(r => r.rate === 0);
    expect(zero).toBeDefined();
  });
});

describe("detectVatDeductionNotes", () => {
  it("flags entertainment / representation costs (KMS § 30)", () => {
    const notes = detectVatDeductionNotes({ supplierName: "Restoran Tabac OÜ" });
    expect(notes).toHaveLength(1);
    expect(notes[0].code).toBe("KMS § 30");
    expect(notes[0].severity).toBe("warning");
    expect(notes[0].basis).toContain("KMS § 30");
    expect(notes[0].basis).toContain("TuMS § 49 lg 4");
  });

  it("flags passenger-car costs with the 50% restriction (KMS § 30 lg 4)", () => {
    const notes = detectVatDeductionNotes({ descriptions: ["Sõiduauto kütus, tankla"] });
    expect(notes).toHaveLength(1);
    expect(notes[0].code).toBe("KMS § 30 lg 4");
    expect(notes[0].detail).toContain("50%");
  });

  it("can raise both notes when both signals are present", () => {
    const notes = detectVatDeductionNotes({
      supplierName: "Catering & Auto OÜ",
      descriptions: ["esinduskulu lõuna", "leasing"],
    });
    const codes = notes.map(n => n.code).sort();
    expect(codes).toEqual(["KMS § 30", "KMS § 30 lg 4"]);
  });

  it("returns nothing for ordinary, unrestricted purchases", () => {
    expect(detectVatDeductionNotes({ supplierName: "Microsoft Ireland", descriptions: ["Cloud subscription"] })).toEqual([]);
    expect(detectVatDeductionNotes({})).toEqual([]);
    expect(detectVatDeductionNotes({ descriptions: [null, undefined, ""] })).toEqual([]);
  });
});
