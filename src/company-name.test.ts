import { describe, expect, it } from "vitest";
import { normalizeCompanyName } from "./company-name.js";

describe("normalizeCompanyName", () => {
  it("removes punctuation left behind by legal suffix stripping", () => {
    expect(normalizeCompanyName("OpenAI, Inc.")).toBe("openai");
    expect(normalizeCompanyName("Company, Ltd.")).toBe("company");
  });

  it("normalizes punctuation variants to the same exact-match key", () => {
    expect(normalizeCompanyName("OpenAI, Inc.")).toBe(normalizeCompanyName("OpenAI Inc"));
    expect(normalizeCompanyName("Mägi OÜ")).toBe("magi");
  });

  it("strips US Public Benefit Corporation (PBC) suffix", () => {
    // Real-world: Anthropic invoices use 'Anthropic, PBC'; existing book
    // entries use just 'Anthropic'. Both should normalize to the same key
    // so supplier_history can reuse prior bookings.
    expect(normalizeCompanyName("Anthropic, PBC")).toBe("anthropic");
    expect(normalizeCompanyName("Anthropic")).toBe("anthropic");
    expect(normalizeCompanyName("Anthropic, PBC")).toBe(normalizeCompanyName("Anthropic"));
  });

  it("strips additional US/UK/EU corporate forms (no dots)", () => {
    expect(normalizeCompanyName("Acme Corp")).toBe("acme");
    expect(normalizeCompanyName("Acme Corporation")).toBe("acme");
    expect(normalizeCompanyName("Acme PLC")).toBe("acme");
    expect(normalizeCompanyName("Acme LP")).toBe("acme");
    expect(normalizeCompanyName("Acme LLP")).toBe("acme");
    expect(normalizeCompanyName("Acme AG")).toBe("acme");
    expect(normalizeCompanyName("Acme NV")).toBe("acme");
    expect(normalizeCompanyName("Acme BV")).toBe("acme");
    expect(normalizeCompanyName("Acme SAS")).toBe("acme");
    expect(normalizeCompanyName("Acme SRL")).toBe("acme");
  });

  it("strips dotted single-letter corporate-form variants (N.V., B.V., S.A.S., S.r.l.)", () => {
    expect(normalizeCompanyName("Acme N.V.")).toBe("acme");
    expect(normalizeCompanyName("Acme B.V.")).toBe("acme");
    expect(normalizeCompanyName("Acme S.A.")).toBe("acme");
    expect(normalizeCompanyName("Acme S.A.S.")).toBe("acme");
    expect(normalizeCompanyName("Acme S.r.l.")).toBe("acme");
  });

  it("does NOT strip the standalone word 'Company' so real names that include it survive", () => {
    expect(normalizeCompanyName("Foo Company OÜ")).toBe("foo company");
  });

  it("does not strip 'co' embedded inside another word (Coca-Cola, Costco, OpenAI OpCo)", () => {
    expect(normalizeCompanyName("Coca-Cola")).toBe("coca cola");
    expect(normalizeCompanyName("Costco")).toBe("costco");
    // Real-world: OpenAI OpCo, LLC is the existing client name. The
    // embedded "Co" inside "OpCo" must not be stripped or the LLC strip
    // would leave us with just "openai" — fine for matching, but if it
    // *did* strip "co" the result would be "openai op", a regression.
    expect(normalizeCompanyName("OpenAI OpCo, LLC")).toBe("openai opco");
  });

  it("pins the documented behavioural change for bare 2-letter leading codes", () => {
    // These leading bare codes are stripped because LEGAL_SUFFIXES is
    // intentionally inclusive. The companion test documents the trade-off
    // so future regex tweaks don't silently shift it.
    expect(normalizeCompanyName("NV Holdings")).toBe("holdings");
    expect(normalizeCompanyName("BV Solutions")).toBe("solutions");
    expect(normalizeCompanyName("Co Brand Studio")).toBe("brand studio");
  });
});
