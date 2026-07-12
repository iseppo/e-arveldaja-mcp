import { describe, it, expect } from "vitest";
import {
  standardVatRateOn,
  detectVatDeductionNotes,
  classifyExpenseForVat,
  buildTaxRulesReference,
  computeRepresentationCostLimit,
  computeDonationLimit,
  getCitRateForDate,
  currentCitRate,
  currentRepresentationMonthlyLimit,
  STANDARD_VAT_RATE_TIMELINE,
  REDUCED_VAT_RATES,
  CIT_RATE_TIMELINE,
  VAT_REGISTRATION_THRESHOLD_EUR,
  TAX_RULES_VERIFIED_AT,
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

  it("rejects well-formatted but impossible calendar dates", () => {
    expect(standardVatRateOn("2025-13-99")).toBeNull();
    expect(standardVatRateOn("2025-02-31")).toBeNull();
    expect(standardVatRateOn("2025-00-10")).toBeNull();
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

  it("flags accommodation but states the business-trip exception in the note", () => {
    const notes = detectVatDeductionNotes({ supplierName: "Hotell Viru", descriptions: ["majutus"] });
    expect(notes).toHaveLength(1);
    expect(notes[0].code).toBe("KMS § 30");
    expect(notes[0].detail).toContain("töölähetuse majutuse sisendkäibemaks on mahaarvatav");
  });

  it("flags a hotel/hostel/motel supplier even without the word 'majutus'", () => {
    for (const supplierName of ["Hotel Palace", "Hostel Tallinn", "Motell 12"]) {
      const notes = detectVatDeductionNotes({ supplierName });
      expect(notes.map(n => n.code)).toContain("KMS § 30");
    }
  });

  it("returns nothing for ordinary, unrestricted purchases", () => {
    expect(detectVatDeductionNotes({ supplierName: "Microsoft Ireland", descriptions: ["Cloud subscription"] })).toEqual([]);
    expect(detectVatDeductionNotes({})).toEqual([]);
    expect(detectVatDeductionNotes({ descriptions: [null, undefined, ""] })).toEqual([]);
  });
});

describe("classifyExpenseForVat (shared single-source detector)", () => {
  it("classifies passenger-car expenses", () => {
    expect(classifyExpenseForVat("Sõiduauto liising")).toEqual({ isPassengerCar: true, isEntertainmentOrHospitality: false });
    expect(classifyExpenseForVat("Fuel and parking for company car")).toMatchObject({ isPassengerCar: true });
  });

  it("classifies entertainment / hospitality expenses, including the keywords inherited from the guidance detector", () => {
    for (const t of ["restoran", "esindus", "majutus", "accommodation", "food", "catering", "meelelahutus"]) {
      expect(classifyExpenseForVat(t).isEntertainmentOrHospitality).toBe(true);
    }
  });

  it("does not flag ordinary expenses or coincidental substrings", () => {
    expect(classifyExpenseForVat("Office supplies")).toEqual({ isPassengerCar: false, isEntertainmentOrHospitality: false });
    // \\bauto\\b must not fire on "automaatika"; \\bpub\\b must not fire on "publication"
    expect(classifyExpenseForVat("Automaatika ja publication teenus")).toEqual({ isPassengerCar: false, isEntertainmentOrHospitality: false });
    expect(classifyExpenseForVat(undefined)).toEqual({ isPassengerCar: false, isEntertainmentOrHospitality: false });
  });
});

describe("buildTaxRulesReference", () => {
  it("bundles the VAT timeline, reduced rates, and the limit rules", () => {
    const ref = buildTaxRulesReference();
    expect(ref.standard_vat_rate_timeline).toBe(STANDARD_VAT_RATE_TIMELINE);
    expect(ref.reduced_vat_rates).toBe(REDUCED_VAT_RATES);

    const codes = ref.deduction_and_limit_rules.map(r => r.code);
    expect(codes).toEqual(
      expect.arrayContaining(["KMS § 30", "KMS § 30 lg 4", "TuMS § 49 lg 4", "TuMS § 49 lg 2"]),
    );
  });

  it("states the verified representation and donation figures", () => {
    const ref = buildTaxRulesReference();
    const representation = ref.deduction_and_limit_rules.find(r => r.code === "TuMS § 49 lg 4");
    expect(representation?.summary).toContain("50 €");
    expect(representation?.summary).toContain("2%");

    const donations = ref.deduction_and_limit_rules.find(r => r.code === "TuMS § 49 lg 2");
    expect(donations?.summary).toContain("3%");
    expect(donations?.summary).toContain("10%");
  });

  it("bundles the CIT timeline, VAT threshold, profit-distribution and RPS process rules", () => {
    const ref = buildTaxRulesReference();
    expect(ref.cit_rate_timeline).toBe(CIT_RATE_TIMELINE);
    expect(ref.vat_registration_threshold_eur).toBe(VAT_REGISTRATION_THRESHOLD_EUR);
    expect(ref.verified_at).toBe(TAX_RULES_VERIFIED_AT);

    const distributionCodes = ref.profit_distribution_rules.map(r => r.code);
    expect(distributionCodes).toEqual(
      expect.arrayContaining(["ÄS § 157 lg 1", "ÄS § 157 lg 2", "TuMS § 50"]),
    );
    // The core answer the agent must be able to give: the whole retained-
    // earnings balance is distributable as NET dividend; the tax comes on top.
    const lg1 = ref.profit_distribution_rules.find(r => r.code === "ÄS § 157 lg 1");
    expect(lg1?.summary).toContain("kogu jaotamata kasumi");
    expect(lg1?.summary).toContain("netodividendina");
    expect(lg1?.summary).toContain("KINNITATUD");
    const tums50 = ref.profit_distribution_rules.find(r => r.code === "TuMS § 50");
    expect(tums50?.summary).toContain("TSD lisal 7");

    const processCodes = ref.accounting_process_rules.map(r => r.code);
    expect(processCodes).toEqual(
      expect.arrayContaining(["RPS § 10", "RPS § 12", "RPS § 15"]),
    );
    // Fringe benefits are at least referenced in the deduction catalogue.
    expect(ref.deduction_and_limit_rules.map(r => r.code)).toContain("TuMS § 48");
  });
});

describe("getCitRateForDate", () => {
  it("is 20/80 through 2024 and 22/78 from 2025-01-01 (inclusive boundary)", () => {
    expect(getCitRateForDate("2024-12-31")).toEqual({ num: 20, den: 80, formatted: "20/80" });
    expect(getCitRateForDate("2025-01-01")).toEqual({ num: 22, den: 78, formatted: "22/78" });
    expect(getCitRateForDate("2026-06-15").formatted).toBe("22/78");
  });

  it("rejects non-ISO and impossible dates (a DD.MM.YYYY value would compare lexically wrong)", () => {
    expect(() => getCitRateForDate("31.12.2025")).toThrow(/YYYY-MM-DD/);
    expect(() => getCitRateForDate("2025-02-31")).toThrow(/YYYY-MM-DD/);
  });

  it("keeps the timeline contiguous and exposes the current rates for tool descriptions", () => {
    for (let i = 1; i < CIT_RATE_TIMELINE.length; i++) {
      const prevTo = CIT_RATE_TIMELINE[i - 1].to;
      expect(prevTo).not.toBeNull();
      const next = new Date(`${prevTo}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      expect(next.toISOString().slice(0, 10)).toBe(CIT_RATE_TIMELINE[i].from);
    }
    expect(CIT_RATE_TIMELINE[CIT_RATE_TIMELINE.length - 1].to).toBeNull();
    expect(currentCitRate().formatted).toBe("22/78");
    expect(currentRepresentationMonthlyLimit()).toBe(50);
  });
});

describe("computeRepresentationCostLimit", () => {
  it("is 50 € per month plus 2% of YTD payroll from 2025", () => {
    const r = computeRepresentationCostLimit({ ytdSocialTaxedPayroll: 10000, monthsElapsed: 6, ytdRepresentationCosts: 500, asOfDate: "2025-06-01" });
    expect(r.limit).toBe(500); // 50*6 + 0.02*10000 = 300 + 200
    expect(r.remaining).toBe(0);
    expect(r.excess).toBe(0);
    expect(r.basis).toBe("TuMS § 49 lg 4");
    expect(r.formula).toContain("50 €");
  });

  it("uses the pre-2025 32 €/month allowance for 2024 dates", () => {
    const r = computeRepresentationCostLimit({ ytdSocialTaxedPayroll: 10000, monthsElapsed: 6, ytdRepresentationCosts: 500, asOfDate: "2024-06-01" });
    expect(r.limit).toBe(392); // 32*6 + 0.02*10000 = 192 + 200
    expect(r.excess).toBe(108); // 500 − 392
    expect(r.formula).toContain("32 €");
  });

  it("rejects an invalid asOfDate", () => {
    expect(() => computeRepresentationCostLimit({ ytdSocialTaxedPayroll: 0, monthsElapsed: 1, ytdRepresentationCosts: 0, asOfDate: "2025-13-99" })).toThrow(/asOfDate/);
  });

  it("reports the taxable excess when costs exceed the limit", () => {
    const r = computeRepresentationCostLimit({ ytdSocialTaxedPayroll: 10000, monthsElapsed: 6, ytdRepresentationCosts: 700, asOfDate: "2025-06-01" });
    expect(r.limit).toBe(500);
    expect(r.excess).toBe(200);
    expect(r.remaining).toBe(0);
  });

  it("clamps months to 0..12 and floors negative payroll at 0", () => {
    expect(computeRepresentationCostLimit({ ytdSocialTaxedPayroll: 0, monthsElapsed: 13, ytdRepresentationCosts: 0, asOfDate: "2025-06-01" }).limit).toBe(600);
    expect(computeRepresentationCostLimit({ ytdSocialTaxedPayroll: -5000, monthsElapsed: 1, ytdRepresentationCosts: 0, asOfDate: "2025-01-01" }).limit).toBe(50);
  });

  it("floors a negative used amount so it cannot inflate remaining headroom", () => {
    const r = computeRepresentationCostLimit({ ytdSocialTaxedPayroll: 10000, monthsElapsed: 6, ytdRepresentationCosts: -100, asOfDate: "2025-06-01" });
    expect(r.used).toBe(0);
    expect(r.remaining).toBe(500);
    expect(r.excess).toBe(0);
  });
});

describe("computeDonationLimit", () => {
  it("defaults to the more favourable of 3% payroll vs 10% prior-year profit", () => {
    const r = computeDonationLimit({ ytdSocialTaxedPayroll: 10000, priorYearProfit: 50000, ytdDonations: 1000 });
    expect(r.limit).toBe(5000); // max(300, 5000)
    expect(r.remaining).toBe(4000);
    expect(r.excess).toBe(0);
  });

  it("honours an explicit basis choice", () => {
    const byPayroll = computeDonationLimit({ ytdSocialTaxedPayroll: 10000, priorYearProfit: 50000, ytdDonations: 1000, basisChoice: "payroll" });
    expect(byPayroll.limit).toBe(300);
    expect(byPayroll.excess).toBe(700);

    const byProfit = computeDonationLimit({ ytdSocialTaxedPayroll: 10000, priorYearProfit: 50000, ytdDonations: 1000, basisChoice: "profit" });
    expect(byProfit.limit).toBe(5000);
  });

  it("treats a prior-year loss as zero profit headroom", () => {
    const r = computeDonationLimit({ ytdSocialTaxedPayroll: 0, priorYearProfit: -20000, ytdDonations: 100, basisChoice: "profit" });
    expect(r.limit).toBe(0);
    expect(r.excess).toBe(100);
  });

  it("floors a negative donations amount", () => {
    const r = computeDonationLimit({ ytdSocialTaxedPayroll: 10000, priorYearProfit: 50000, ytdDonations: -200 });
    expect(r.used).toBe(0);
    expect(r.excess).toBe(0);
  });
});
