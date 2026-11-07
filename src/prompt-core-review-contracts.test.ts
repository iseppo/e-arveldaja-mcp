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
    expect(standard).toContain("off by 0.01 EUR or more, OR exact duplicates were found");
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

describe("control prompt review 2026-11-07", () => {
  const profiles = ["guided", "guided-sales", "standard", "full"] as const;

  it.each(profiles)("month-end blocks a failed balance-sheet check and a one-cent imbalance on %s", profile => {
    const body = render("month-end-close", profile);
    expect(body).toContain("0.01 EUR or more is a blocker");
    expect(body).toContain("`check.balanced` is false");
    expect(body).toContain("off by 0.01 EUR or more, OR exact duplicates were found");
    expect(body).not.toContain("off by more than 0.01 EUR");
  });

  it.each(profiles)("accounting inbox routes owner-confirmed third-party Wise payments through a fresh import preview on %s", profile => {
    const body = render("accounting-inbox", profile);
    expect(body).toContain("If the owner confirms a held row is a payment to or from a third party");
    expect(body).toContain("no candidate own-account evidence on any bank");
    expect(body).toContain("**Import Wise** workflow with that exact Wise ID in `not_own_transfer_ids`");
    expect(body).toContain("Keep all earlier owner decisions");
    expect(body).toContain("fresh preview, plan handle and digest");
    expect(body).toContain("owner approval before execution");
    expect(body).toContain("conflicting or uncertain own-account evidence stays held");
  });

  it.each(profiles)("CAMT acknowledgement distinguishes drift from storage, context and handle refusals on %s", profile => {
    const body = render("prepare-accounting-review-action", profile);
    expect(body).toContain("`plan_drift` means the journal or review item changed");
    expect(body).toContain("For other refusals, follow the returned `error_code` and explanation");
    expect(body).toContain("`camt_ack_store_unavailable`");
    expect(body).toContain("single-file rules mode cannot store acknowledgements");
    expect(body).toContain("`camt_ack_needs_inbox_scan`");
    expect(body).toContain("invalid, expired or consumed plan handle");
    expect(body).toContain("fresh preparation and approval");
    expect(body).not.toContain("a `plan_drift` or refusal means the journal changed");
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
      "2. Before restarting, record the stored credential the import reported (`env_file`, `storage_scope`, `target`) and, while it is still advertised, the stored inventory from `list_stored_credentials`",
      "Then restart the MCP server with the source file still in place.",
      "3. After the restart, refresh the tool list. Use `list_stored_credentials` only if it is advertised; otherwise check the recorded `env_file` / `storage_scope` / `target`. Either way, make one authenticated read that returns the intended company's data.",
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

describe("astra prompt review 2026-11-04", () => {
  it("never deletes a stored entry just because the owner says an automatic match is a different movement", () => {
    for (const name of ["import-camt", "import-wise"]) {
      for (const profile of ["standard", "guided"] as const) {
        const body = render(name, profile);
        expect(body, `${name}/${profile}`).toContain("that alone does not make the stored transaction");
        expect(body, `${name}/${profile}`).toContain("never delete or change it on that basis");
        expect(body, `${name}/${profile}`).toContain("only once it is shown to be erroneous or a duplicate");
        expect(body, `${name}/${profile}`).not.toContain("the undo is to correct or delete");
      }
    }
    expect(render("import-camt", "guided")).not.toContain("create_transaction");
  });

  it("books a foreign-currency GL confirm at the EUR base amount and keeps a guided single-ID lookup from inferring no match", () => {
    expect(render("reconcile-bank", "standard"))
      .toContain("The distribution `amount` is the transaction amount only for a EUR transaction (`cl_currencies_id` EUR).");
    const guided = render("reconcile-bank", "guided");
    expect(guided).toContain("never report \"no match\" from its absence");
    expect(guided).not.toContain("If no match exists for that transaction, report that and stop.");
  });

  it("checks the registration of already-attached receipts on guided and reads their invoice id from the right place", () => {
    expect(render("receipt-batch", "guided")).toContain("neither proves the invoice is registered");
    const standard = render("receipt-batch", "standard");
    expect(standard).toContain("`result.results[].already_attached_to.invoice_id`");
    expect(standard).toContain("`result.already_booked.ids`");
  });

  it("new-supplier re-checks final identifiers and stops on review holds and deactivated clients", () => {
    const body = render("new-supplier", "standard");
    expect(body).toContain("First re-check duplicates with the final identifiers");
    // resolve_supplier matches registry code, VAT number and name only — never the IBAN.
    expect(body).toContain("The IBAN is not a match key");
    expect(body).not.toMatch(/IBAN added in step 4 can match/);
    expect(body).toContain("`requires_manual_review: true`: nothing was created and this is NOT an ordinary not-found result");
    expect(body).toContain("`registry_data.status: \"K\"`");
    expect(body).toContain("call `reactivate_client` with its ID");
    expect(body.indexOf("First re-check duplicates")).toBeLessThan(body.indexOf("present one approval card"));
  });

  it("a CAMT journal review for another payment is never acknowledged, and guided keeps it open", () => {
    const guided = render("resolve-accounting-review", "guided");
    expect(guided).toContain("never use `prepare_action` for it");
    expect(guided).toContain("keep the item unresolved");
    expect(guided).not.toContain("create_transaction");
    expect(render("resolve-accounting-review", "standard")).toContain("`create_transaction`");
  });

  it("month-end describes missing-document counts as attachment-only", () => {
    expect(render("month-end-close", "guided")).toContain("The counts are attachment-only");
  });
});

describe("money prompt review 2026-11-07", () => {
  it.each(["standard", "full", "guided", "guided-sales"] as const)("requires movement identity before CAMT direction repair on %s", profile => {
    const body = render("import-camt", profile);
    expect(body).toContain("same date and amount with opposite bank postings do not prove movement identity");
    expect(body).toContain("prove that the named transaction is the SAME statement movement before proposing invalidation or deletion");
    expect(body).toContain("Preserve a transaction that books a different real movement");
    expect(body).not.toContain("the ledger is wrong until that row is fixed");
    expect(body).not.toContain("rows need the existing booking fixed");
  });

  it.each(["standard", "full"] as const)("uses invoice and supplier VAT prefixes for reverse-charge region on %s", profile => {
    const body = render("book-invoice", profile);
    expect(body).toContain("An EU member-state VAT prefix (including XI) on EITHER the current invoice OR the supplier record selects EU row 6");
    expect(body).toContain("`EU…` OSS numbers are non-EU prefixes, not EU member-state VAT numbers");
    expect(body).toContain("otherwise use a non-EU VAT prefix, then the client's ISO3 country only when neither has a VAT number");
  });

  it.each(["standard", "full"] as const)("resolves full versus limited VAT status before allowing deduction on %s", profile => {
    const body = render("book-invoice", profile);
    expect(body).toContain("Call `limited_vat` with `mode: \"status\"`");
    expect(body).toContain("Only resolved `full` status permits ordinary input-VAT deduction");
    expect(body).toContain("Never infer `full` from a VAT number");
    expect(body).toContain("For `none` or `limited`, use non-deductible treatment");
  });

  it("keeps the tax-disabled VAT fallback explicit without naming an unavailable status tool", () => {
    const body = render("book-invoice", "custom", { ...NORMAL_EXPOSURE, enableTaxTools: false });
    expect(body).not.toContain("limited_vat");
    expect(body).toContain("`get_vat_info` alone cannot distinguish full from limited registration");
    expect(body).toContain("If status remains unknown, stop before choosing VAT treatment or asking for booking approval");
  });

  it.each(["standard", "full", "guided", "guided-sales"] as const)("gets CAMT acknowledgements from a retained inbox scan on %s", profile => {
    const body = render("import-camt", profile);
    expect(body).toContain("first scan the statement with `accounting_inbox` in the current server process");
    expect(body).toContain("complete review item / `resolver_input` containing `acknowledgement`");
    expect(body).toContain('`mode: "dry_run"`, `workspace_path`: the statement folder, and `bank_account_dimension_id`: the reviewed bank dimension');
    expect(body).toContain("`autopilot.needs_accountant_review[*].resolver_input`");
    expect(body).toContain('`review_type: "camt_journal_review"` and `item.acknowledgement`');
    expect(body).toContain("The default scan and guided workflow `next` do not return that payload");
    expect(body).not.toContain("next action to retrieve the review");
    expect(body).toContain("A compact warning or plan exclusion is not that complete item");
    expect(body).toContain("Acknowledgements require bundle storage");
    expect(body).toContain("After a server restart, scan again");
  });

  it.each(["standard", "full", "guided", "guided-sales"] as const)("keeps acknowledged Wise third-party payments as drafts on %s", profile => {
    const body = render("import-wise", profile);
    expect(body).toContain("Third-party payments (`not_own_transfer_ids`) remain PROJECT and need later reconciliation");
    expect(body).toContain("only eligible own-account transfers are confirmed against their reviewed counterpart account");
    expect(body).not.toContain("the released row is created and confirmed as a new transaction");
  });

  it.each(["guided", "guided-sales"] as const)("uses compact inter-account execution follow-up fields on %s", profile => {
    const body = render("reconcile-bank", profile);
    expect(body).not.toContain("command_partitions");
    expect(body).not.toContain("stop_reason");
    expect(body).not.toContain("incoming_action");
    expect(body).toContain("After inter-account execute, inspect `summary.status`, `summary.blockers` and `summary.warnings`");
    expect(body).toContain("Follow `summary.details` with `get_operation_result_page`");
  });

  it("refreshes the Lightyear trade preview after prerequisite bookings before execution", () => {
    const body = render("lightyear-booking", "standard");
    expect(body).toContain("After storing a pool opening or booking prerequisite distributions, run a fresh `book_lightyear_trades` dry run");
    expect(body).toContain("Never execute the earlier trade handle after those prerequisites change");
    expect(body).toContain("Review the fresh trade plan completely and obtain approval for newly bookable or changed effects");
  });
});
