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

function render(name: string, profile: ToolProfile, exposure: ToolExposureConfig = NORMAL_EXPOSURE, setupMode = false) {
  const entry = PROMPT_REGISTRY.find(item => item.name === name)!;
  const args = z.object(entry.argsSchema ?? {}).parse(MAXIMUM_VALID_PROMPT_ARGUMENTS[name as keyof typeof MAXIMUM_VALID_PROMPT_ARGUMENTS] ?? {});
  return buildWorkflowPromptSourceText(entry.slug, args, entry.variants, { toolProfile: profile, toolExposure: exposure, setupMode })
    .split("Canonical workflow source:")[1]!;
}

describe("month-end close safety (core prompt review 2026-10-30)", () => {
  const standard = render("month-end-close", "standard");

  it("runs the duplicate check before any purchase-invoice action, across the month boundary", () => {
    expect(standard.indexOf("detect_duplicate_purchase_invoice")).toBeLessThan(standard.indexOf("confirm_purchase_invoice"));
    expect(standard).toContain("the first day of the PREVIOUS month");
    expect(standard).toContain("route it back to the **Book Invoice** workflow");
  });

  it("never batch-confirms purchase invoices or journals and shows journal postings first", () => {
    expect(standard).toContain("Never batch-approve purchase invoices or journals");
    expect(standard).not.toContain("ask for one batch approval");
    expect(standard).toContain("call `get_journal`, show its number and postings");
    expect(standard).toContain("`DIV-…` (dividend) or `YEC-…` (year-end close): do not confirm them here");
  });

  it("routes inter-account rows away from confirm_transaction and blocks duplicates", () => {
    expect(standard).toContain("use `reconcile_inter_account_transfers`, never `confirm_transaction`");
    expect(standard).toContain("`confirm_transaction` with `block_on_duplicate: true`");
  });

  it("derives HAS BLOCKERS from imbalance and exact duplicates, and leaves KMD/1516 to e-arveldaja", () => {
    expect(standard).toContain("off by more than 0.01 EUR, OR exact duplicates were found");
    expect(standard).toContain("Missing documents, suspicious duplicate matches and overdue items are WARNINGS");
    expect(standard).toContain("prepayment-account (1516) entries. Do not compute, propose, or book those entries here.");
  });

  it("points December to the year-end close only when prepare_year_end_close is registered", () => {
    expect(standard).toContain("`prepare_year_end_close` with `year`");
    expect(render("month-end-close", "custom", { ...NORMAL_EXPOSURE, enableAnnualReport: false })).not.toContain("prepare_year_end_close");
    expect(render("month-end-close", "guided")).not.toContain("prepare_year_end_close");
  });
});

describe("VAT threshold exclusions (core prompt review 2026-10-30)", () => {
  it("asks about excluded turnover and re-runs with taxable_turnover_adjustment", () => {
    const body = render("vat-registration-threshold", "standard");
    expect(body).toContain("Before concluding `exceeded`, `needs_manual_review` or `approaching`, ask the user whether any sale invoices are fixed-asset disposals or have a non-Estonian place of supply");
    expect(body).toContain("re-run with `taxable_turnover_adjustment` (negative to exclude, positive to add) and report both runs");
    expect(body).toContain("at least 80% of the threshold");
  });
});

describe("setup prompts handle secrets (core prompt review 2026-10-30)", () => {
  it.each(["setup-credentials", "setup-e-arveldaja"])("%s forbids reading, pasting or committing secrets", (name) => {
    for (const setupMode of [true, false]) {
      const body = render(name, "standard", NORMAL_EXPOSURE, setupMode);
      expect(body).toContain("Never read, print, or quote the contents of `apikey*.txt` or `.env` files");
      expect(body).toContain("never ask the user to paste the API password");
      expect(body).toContain("Never `git add` or commit");
    }
  });

  it("reviews the full import projection and suggests removing the apikey file after import", () => {
    const body = render("setup-credentials", "standard", NORMAL_EXPOSURE, true);
    expect(body).toContain("`masked_api_key_id`, `env_file`, `storage_scope`, `target`, any `profile`, and any `legacy_exposure_keys_removed`");
    expect(body).toContain("Pass `profile` only when the user explicitly asks");
    expect(body).toContain("suggest moving the `apikey*.txt` out of the working directory or deleting it");
    expect(body).toContain("This workflow can inspect, append, replace, or remove stored `.env` credentials.");
  });
});

describe("reconcile-bank duplicate and document-reference handling (fix review 2026-10-30)", () => {
  const standard = render("reconcile-bank", "standard");
  const guided = render("reconcile-bank", "guided");

  it("resends the dry run's min_confidence and block_on_duplicate on standard execute", () => {
    expect(standard).toContain("the dry run's `min_confidence` and `block_on_duplicate` unchanged");
    expect(standard).toContain("`min_confidence: 90` and `block_on_duplicate: true`");
  });

  it("keeps distinct_source_reference suspects visible and names the profile's scan-unavailable signal", () => {
    for (const text of [standard, guided]) {
      expect(text).toContain("still a suspect: show it, never drop or auto-clear it");
    }
    expect(standard).toContain("`duplicate_scan_note`");
    expect(guided).toContain("`duplicate_scan_unavailable` warning");
    expect(guided).not.toContain("`duplicate_scan_note`");
  });

  it("never sends document-reference candidates to classification", () => {
    for (const text of [standard, guided]) {
      expect(text).toContain("They are NOT unmatched rows and are never auto-confirmed");
      expect(text).toContain("Never send these rows to Step 5 or Classify Unmatched");
    }
    expect(standard).toContain("`result.document_reference_candidates`");
    expect(guided).toContain("`document_reference_candidate` warnings");
  });
});
