import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PROMPT_REGISTRY } from "./prompt-registry.js";
import { buildWorkflowPromptSourceText } from "./workflow-prompt-source.js";
import { MAXIMUM_VALID_PROMPT_ARGUMENTS } from "../scripts/prompt-surface-files.js";
import type { ToolProfile } from "./tool-profile.js";
import type { ToolExposureConfig } from "./config.js";

const NORMAL_EXPOSURE: ToolExposureConfig = {
  enableLightyear: true, enableTaxTools: true, enableReferenceAdmin: true,
  enableAnnualReport: true, enableSales: true, enableProducts: true,
  exposeGranularTools: false, exposeSetupTools: false,
};
const LEAN_EXPOSURE: ToolExposureConfig = {
  enableLightyear: false, enableTaxTools: false, enableReferenceAdmin: false,
  enableAnnualReport: false, enableSales: false, enableProducts: false,
  exposeGranularTools: false, exposeSetupTools: false,
};
const SURFACES: readonly { name: string; profile: ToolProfile; exposure: ToolExposureConfig }[] = [
  ...(["standard", "full", "guided", "guided-sales"] as const).map(profile => ({ name: profile, profile, exposure: NORMAL_EXPOSURE })),
  { name: "custom-sales-disabled", profile: "custom", exposure: { ...NORMAL_EXPOSURE, enableSales: false } },
  { name: "custom-lean", profile: "custom", exposure: LEAN_EXPOSURE },
];

function render(name: string, profile: ToolProfile, exposure: ToolExposureConfig = NORMAL_EXPOSURE) {
  const entry = PROMPT_REGISTRY.find(item => item.name === name)!;
  const args = z.object(entry.argsSchema ?? {}).parse(MAXIMUM_VALID_PROMPT_ARGUMENTS[name as keyof typeof MAXIMUM_VALID_PROMPT_ARGUMENTS] ?? {});
  return buildWorkflowPromptSourceText(entry.slug, args, entry.variants, { toolProfile: profile, toolExposure: exposure }).split("Canonical workflow source:")[1]!;
}

describe("P01/P03-P08 rendered business instructions", () => {
  for (const { name, profile, exposure } of SURFACES) {
    it(`${name}: selected historical ranges and honest aging`, () => {
      const body = render("company-overview", profile, exposure);
      expect(body).toContain("2025-01-01..2025-12-31");
      expect(body).toContain("2025-10-01..2025-12-31");
      expect(body).toContain("January 1 of that selected reporting date's year");
      expect(body).toContain("current payment status");
      expect(body).toContain("paid after the cutoff may be absent");
    });
    it(`${name}: month-end coverage and blockers remain independent of mutation capability`, () => {
      const body = render("month-end-close", profile, exposure);
      expect(body).toContain("PRESENCE of `unconfirmed_sale_invoices`, even when its count is zero");
      expect(body).toContain("`ready_to_close: false` always means HAS BLOCKERS");
      expect(body).toContain("Coverage:");
      // Only the guided report façade takes `fresh` (cleared on its first call after UI edits).
      if (profile === "guided" || profile === "guided-sales") expect(body).toContain("pass `fresh: true` on the first `run_accounting_report` call");
      else expect(body).not.toContain("`fresh: true`");
      if (profile === "standard" || profile === "full") {
        expect(body).toContain("offer `confirm_sale_invoice`");
        expect(body).not.toContain("`manage_sale_invoice`");
      } else if (profile === "guided-sales") {
        expect(body).toContain('`manage_sale_invoice` (`action: "confirm"`');
        expect(body).not.toContain("`confirm_sale_invoice`");
      } else {
        expect(body).not.toContain("`confirm_sale_invoice`");
        expect(body).not.toContain("`manage_sale_invoice`");
      }
      if (profile === "guided") {
        expect(body).toContain("still show their IDs, dates and amounts");
        expect(body).toContain("a new review on `guided-sales`, `standard` or `full`");
      }
    });
  }
  it("guided single-ID reconciliation checks all Auto mutations", () => {
    const body = render("reconcile-bank", "guided");
    expect(body).toContain("does NOT filter the Auto mode batch");
    expect(body).toContain("ALL mutation commands on ALL pages");
    expect(body).toContain("do not execute the batch or broaden approval");
  });
  for (const profile of ["standard", "guided"] as const) {
    it(`${profile}: receipt approval covers the complete public effects`, () => {
      const body = render("receipt-batch", profile);
      expect(body).toContain("EVERY `next_cursor` until null");
      expect(body).toContain("Approval of invoice confirmation alone does not authorize bank confirmation");
      expect(body).toContain("client reassignments");
      if (profile === "guided") expect(body).toContain('`detail: "full"`');
    });
  }
  it("Lightyear WAC is analytical, not FIFO control", () => {
    const body = render("lightyear-booking", "standard");
    expect(body).toContain("WAC EUR 20 but FIFO EUR 30");
    expect(body).toContain("do not use WAC as a ledger control total");
  });
});
