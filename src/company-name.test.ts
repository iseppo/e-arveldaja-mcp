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
});
