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
    expect(body).toContain("Before concluding `exceeded`, `needs_manual_review` or `approaching`, also ask whether any sale invoices are fixed-asset disposals or have a non-Estonian place of supply");
    expect(body).toContain("re-run with `taxable_turnover_adjustment` (negative to exclude, positive to add), conclude from the re-run's `status`, and report both runs");
    expect(body).toContain("at least 80% of the threshold");
  });
});

describe("control prompt review 2026-10-31", () => {
  it("asks about turnover outside confirmed sale invoices before concluding ok too (VAT threshold)", () => {
    const body = render("vat-registration-threshold", "standard");
    expect(body).toContain("Before concluding ANY status other than `already_registered` (`ok` included), ask whether there is taxable or 0% turnover without a confirmed sale invoice");
  });

  it("runs an undated supplier + invoice-number duplicate lookup before offering a purchase-invoice confirm (month-end)", () => {
    const standard = render("month-end-close", "standard");
    expect(standard).toContain("call `detect_duplicate_purchase_invoice` with that draft's `clients_id` and `invoice_number` and NO dates");
    expect(standard).toContain("one whose undated lookup returns any other invoice id");
    expect(standard.indexOf("NO dates")).toBeLessThan(standard.indexOf("offer `confirm_purchase_invoice`"));
  });

  it.each(["month-end-close", "company-overview"])("%s refreshes guided reports with fresh:true after UI changes", name => {
    const guided = render(name, "guided");
    expect(guided).toContain("pass `fresh: true` on the first `run_accounting_report` call");
    expect(guided).not.toContain("may lag those edits");
  });

  it.each(["standard", "guided"] as const)("company overview checks drafts in every month of the period on %s", profile => {
    const body = render("company-overview", profile);
    expect(body).toContain("reads the unconfirmed counts for EVERY calendar month of the selected period");
    expect(body).toContain("each YYYY-MM of the selected period in turn");
    expect(body).not.toContain("the reporting date's YYYY-MM");
  });

  it("treats the owner-expense continuation as a draft and offers registration per profile", () => {
    const standard = render("prepare-accounting-review-action", "standard");
    expect(standard).toContain("creates the journal as an unconfirmed draft");
    expect(standard).toContain("`journal_entry.api_response.created_object_id`");
    expect(standard).toContain("ask for explicit approval to register it, then call `confirm_journal` for that one journal");
    const guided = render("prepare-accounting-review-action", "guided");
    expect(guided).toContain("creates the journal as an unconfirmed draft");
    expect(guided).toContain("No tool on this profile registers a journal");
    expect(guided).not.toContain("confirm_journal");
  });

  it.each(["standard", "guided"] as const)("accounting inbox requires the owning tool's preview for a plan handle on %s", profile => {
    const body = render("accounting-inbox", profile);
    expect(body).not.toContain("do not repeat them unless the user asks");
    expect(body).toContain("run its owning tool's own preview (the call that returns the `plan_handle`) unless that handle was already supplied");
    expect(body).toContain("follow `workflow.recommended_next_action` on standard/full and `workflow.next_action` on guided");
    expect(body).toContain("`delete_proposed_mirrors: true`, explicit owner approval of the planned deletion");
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

  it("reviews the full import projection and suggests removing the apikey file only after the stored credential is proven", () => {
    const body = render("setup-credentials", "standard", NORMAL_EXPOSURE, true);
    expect(body).toContain("`masked_api_key_id`, `env_file`, `storage_scope`, `target`, any `profile`, and any `legacy_exposure_keys_removed`");
    expect(body).toContain("Pass `profile` only when the user explicitly asks");
    expect(body).toContain("This workflow can inspect, append, replace, or remove stored `.env` credentials.");
    // An explicit key file wins over the stored .env and fails startup once it is gone,
    // and raw apikey*.txt scanning hides whether the stored credential works.
    expect(body).not.toContain("After the import is verified, suggest moving the `apikey*.txt` out of the working directory or deleting it");
    const steps = [
      "Keep the source `apikey*.txt` in place until the restarted server is proven to use the stored credential:",
      "1. If `EARVELDAJA_API_KEY_FILE` is set in the MCP launch configuration or environment, remove it there first",
      "2. Restart the MCP server with the source file still in place.",
      "3. Verify the stored credential the import reported (`env_file`, `storage_scope`, `target`; `list_stored_credentials` shows the stored inventory) and make one authenticated read that returns the intended company's data.",
      "A successful restart or a non-empty `list_connections` is not proof",
      "4. Only then suggest moving the `apikey*.txt` out of the working directory or deleting it.",
      "If the stored credential's use cannot be established, keep the file",
    ];
    const positions = steps.map(step => body.indexOf(step));
    for (const [index, step] of steps.entries()) expect(positions[index], step).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
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
