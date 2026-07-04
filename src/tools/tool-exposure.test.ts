import { describe, expect, it, vi } from "vitest";
import { getToolExposureConfig, type ToolExposureConfig } from "../config.js";
import { registerAccountingInboxTools } from "./accounting-inbox.js";
import { registerBankReconciliationTools } from "./bank-reconciliation.js";
import { registerCamtImportTools } from "./camt-import.js";
import { registerReceiptInboxTools } from "./receipt-inbox.js";
import { registerReferenceDataTools } from "./reference-data-tools.js";
import { registerPrompts } from "../prompts.js";

const HIDDEN: ToolExposureConfig = { enableLightyear: true, exposeGranularTools: false, exposeSetupTools: false, enableTaxTools: true, enableReferenceAdmin: true, enableAnnualReport: true };
const EXPOSED: ToolExposureConfig = { enableLightyear: true, exposeGranularTools: true, exposeSetupTools: true, enableTaxTools: true, enableReferenceAdmin: true, enableAnnualReport: true };

function registeredToolNames(
  register: (server: any, api: any, exposure?: ToolExposureConfig) => void,
  exposure: ToolExposureConfig,
): string[] {
  const server = { registerTool: vi.fn() } as any;
  register(server, {} as any, exposure);
  return server.registerTool.mock.calls.map(([name]: [string]) => name);
}

function registeredPromptNames(toolExposure: ToolExposureConfig): string[] {
  const server = { registerPrompt: vi.fn() } as any;
  registerPrompts(server, { toolExposure });
  return server.registerPrompt.mock.calls.map(([name]: [string]) => name);
}

describe("getToolExposureConfig", () => {
  it("enables Lightyear by default", () => {
    expect(getToolExposureConfig({} as NodeJS.ProcessEnv).enableLightyear).toBe(true);
  });

  it("disables Lightyear only when EARVELDAJA_DISABLE_LIGHTYEAR is truthy", () => {
    expect(getToolExposureConfig({ EARVELDAJA_DISABLE_LIGHTYEAR: "1" } as any).enableLightyear).toBe(false);
    expect(getToolExposureConfig({ EARVELDAJA_DISABLE_LIGHTYEAR: "true" } as any).enableLightyear).toBe(false);
    expect(getToolExposureConfig({ EARVELDAJA_DISABLE_LIGHTYEAR: "" } as any).enableLightyear).toBe(true);
    expect(getToolExposureConfig({ EARVELDAJA_DISABLE_LIGHTYEAR: "0" } as any).enableLightyear).toBe(true);
  });

  it("hides granular constituent tools by default", () => {
    expect(getToolExposureConfig({} as NodeJS.ProcessEnv).exposeGranularTools).toBe(false);
  });

  it("exposes granular tools only when EARVELDAJA_EXPOSE_GRANULAR_TOOLS is truthy", () => {
    expect(getToolExposureConfig({ EARVELDAJA_EXPOSE_GRANULAR_TOOLS: "1" } as any).exposeGranularTools).toBe(true);
    expect(getToolExposureConfig({ EARVELDAJA_EXPOSE_GRANULAR_TOOLS: "true" } as any).exposeGranularTools).toBe(true);
    expect(getToolExposureConfig({ EARVELDAJA_EXPOSE_GRANULAR_TOOLS: "" } as any).exposeGranularTools).toBe(false);
    expect(getToolExposureConfig({ EARVELDAJA_EXPOSE_GRANULAR_TOOLS: "0" } as any).exposeGranularTools).toBe(false);
  });

  it("hides setup/credential tools by default", () => {
    expect(getToolExposureConfig({} as NodeJS.ProcessEnv).exposeSetupTools).toBe(false);
  });

  it("exposes setup tools only when EARVELDAJA_EXPOSE_SETUP_TOOLS is truthy", () => {
    expect(getToolExposureConfig({ EARVELDAJA_EXPOSE_SETUP_TOOLS: "1" } as any).exposeSetupTools).toBe(true);
    expect(getToolExposureConfig({ EARVELDAJA_EXPOSE_SETUP_TOOLS: "true" } as any).exposeSetupTools).toBe(true);
    expect(getToolExposureConfig({ EARVELDAJA_EXPOSE_SETUP_TOOLS: "" } as any).exposeSetupTools).toBe(false);
    expect(getToolExposureConfig({ EARVELDAJA_EXPOSE_SETUP_TOOLS: "0" } as any).exposeSetupTools).toBe(false);
  });

  it("enables the tax tools by default", () => {
    expect(getToolExposureConfig({} as NodeJS.ProcessEnv).enableTaxTools).toBe(true);
  });

  it("disables the tax tools only when EARVELDAJA_DISABLE_TAX_TOOLS is truthy", () => {
    expect(getToolExposureConfig({ EARVELDAJA_DISABLE_TAX_TOOLS: "1" } as any).enableTaxTools).toBe(false);
    expect(getToolExposureConfig({ EARVELDAJA_DISABLE_TAX_TOOLS: "true" } as any).enableTaxTools).toBe(false);
    expect(getToolExposureConfig({ EARVELDAJA_DISABLE_TAX_TOOLS: "" } as any).enableTaxTools).toBe(true);
    expect(getToolExposureConfig({ EARVELDAJA_DISABLE_TAX_TOOLS: "0" } as any).enableTaxTools).toBe(true);
  });

  it("enables the reference-admin tools by default", () => {
    expect(getToolExposureConfig({} as NodeJS.ProcessEnv).enableReferenceAdmin).toBe(true);
  });

  it("disables the reference-admin tools only when EARVELDAJA_DISABLE_REFERENCE_ADMIN is truthy", () => {
    expect(getToolExposureConfig({ EARVELDAJA_DISABLE_REFERENCE_ADMIN: "1" } as any).enableReferenceAdmin).toBe(false);
    expect(getToolExposureConfig({ EARVELDAJA_DISABLE_REFERENCE_ADMIN: "true" } as any).enableReferenceAdmin).toBe(false);
    expect(getToolExposureConfig({ EARVELDAJA_DISABLE_REFERENCE_ADMIN: "" } as any).enableReferenceAdmin).toBe(true);
    expect(getToolExposureConfig({ EARVELDAJA_DISABLE_REFERENCE_ADMIN: "0" } as any).enableReferenceAdmin).toBe(true);
  });

  it("enables the annual-report tools by default", () => {
    expect(getToolExposureConfig({} as NodeJS.ProcessEnv).enableAnnualReport).toBe(true);
  });

  it("disables the annual-report tools only when EARVELDAJA_DISABLE_ANNUAL_REPORT is truthy", () => {
    expect(getToolExposureConfig({ EARVELDAJA_DISABLE_ANNUAL_REPORT: "1" } as any).enableAnnualReport).toBe(false);
    expect(getToolExposureConfig({ EARVELDAJA_DISABLE_ANNUAL_REPORT: "true" } as any).enableAnnualReport).toBe(false);
    expect(getToolExposureConfig({ EARVELDAJA_DISABLE_ANNUAL_REPORT: "" } as any).enableAnnualReport).toBe(true);
    expect(getToolExposureConfig({ EARVELDAJA_DISABLE_ANNUAL_REPORT: "0" } as any).enableAnnualReport).toBe(true);
  });
});

describe("reference-data admin tool surface", () => {
  const REFERENCE_ADMIN_TOOLS = [
    "update_invoice_info",
    "get_invoice_series",
    "create_invoice_series",
    "update_invoice_series",
    "delete_invoice_series",
    "get_bank_account",
    "create_bank_account",
    "update_bank_account",
    "delete_bank_account",
  ];
  const REFERENCE_READ_TOOLS = [
    "list_accounts",
    "list_invoice_series",
    "list_bank_accounts",
    "get_invoice_info",
    "get_vat_info",
  ];

  it("registers the config-mutation reference-admin tools when enabled", () => {
    const names = registeredToolNames(registerReferenceDataTools, EXPOSED);
    for (const tool of REFERENCE_ADMIN_TOOLS) expect(names).toContain(tool);
    for (const tool of REFERENCE_READ_TOOLS) expect(names).toContain(tool);
  });

  it("hides the config-mutation reference-admin tools but keeps the reads when disabled", () => {
    const names = registeredToolNames(registerReferenceDataTools, {
      ...EXPOSED,
      enableReferenceAdmin: false,
    });
    for (const tool of REFERENCE_ADMIN_TOOLS) expect(names).not.toContain(tool);
    for (const tool of REFERENCE_READ_TOOLS) expect(names).toContain(tool);
  });
});

describe("accounting inbox tool surface", () => {
  it("registers the merged accounting_inbox entry point", () => {
    expect(registeredToolNames(registerAccountingInboxTools, HIDDEN)).toContain("accounting_inbox");
  });

  it("no longer registers the removed prepare/run inbox aliases (folded into accounting_inbox modes)", () => {
    const names = registeredToolNames(registerAccountingInboxTools, HIDDEN);
    expect(names).not.toContain("prepare_accounting_inbox");
    expect(names).not.toContain("run_accounting_inbox_dry_runs");
  });

  it("hides the review constituents behind continue_accounting_workflow by default", () => {
    const names = registeredToolNames(registerAccountingInboxTools, HIDDEN);
    expect(names).toContain("continue_accounting_workflow");
    expect(names).not.toContain("resolve_accounting_review_item");
    expect(names).not.toContain("prepare_accounting_review_action");
  });

  it("registers the review constituents when granular tools are exposed", () => {
    const names = registeredToolNames(registerAccountingInboxTools, EXPOSED);
    expect(names).toContain("resolve_accounting_review_item");
    expect(names).toContain("prepare_accounting_review_action");
  });
});

describe("bank reconciliation tool surface", () => {
  it("hides constituents covered by reconcile_bank_transactions by default", () => {
    const names = registeredToolNames(registerBankReconciliationTools, HIDDEN);
    expect(names).toContain("reconcile_bank_transactions");
    expect(names).not.toContain("reconcile_transactions");
    expect(names).not.toContain("auto_confirm_exact_matches");
  });

  it("always registers reconcile_inter_account_transfers (no merged execute mode)", () => {
    expect(registeredToolNames(registerBankReconciliationTools, HIDDEN))
      .toContain("reconcile_inter_account_transfers");
  });

  it("registers the constituents when granular tools are exposed", () => {
    const names = registeredToolNames(registerBankReconciliationTools, EXPOSED);
    expect(names).toContain("reconcile_transactions");
    expect(names).toContain("auto_confirm_exact_matches");
  });
});

describe("camt import tool surface", () => {
  it("hides parse_camt053/import_camt053 behind process_camt053 by default", () => {
    const names = registeredToolNames(registerCamtImportTools, HIDDEN);
    expect(names).toContain("process_camt053");
    expect(names).not.toContain("parse_camt053");
    expect(names).not.toContain("import_camt053");
  });

  it("registers the constituents when granular tools are exposed", () => {
    const names = registeredToolNames(registerCamtImportTools, EXPOSED);
    expect(names).toContain("parse_camt053");
    expect(names).toContain("import_camt053");
  });
});

describe("receipt inbox tool surface", () => {
  it("hides constituents behind receipt_batch / classify_bank_transactions by default", () => {
    const names = registeredToolNames(registerReceiptInboxTools, HIDDEN);
    expect(names).toContain("receipt_batch");
    expect(names).toContain("classify_bank_transactions");
    expect(names).not.toContain("scan_receipt_folder");
    expect(names).not.toContain("process_receipt_batch");
    expect(names).not.toContain("classify_unmatched_transactions");
    expect(names).not.toContain("apply_transaction_classifications");
  });

  it("registers the constituents when granular tools are exposed", () => {
    const names = registeredToolNames(registerReceiptInboxTools, EXPOSED);
    expect(names).toContain("scan_receipt_folder");
    expect(names).toContain("process_receipt_batch");
    expect(names).toContain("classify_unmatched_transactions");
    expect(names).toContain("apply_transaction_classifications");
  });
});

describe("prompt surface", () => {
  it("registers the lightyear-booking prompt when Lightyear is enabled", () => {
    expect(registeredPromptNames({ enableLightyear: true, exposeGranularTools: false, exposeSetupTools: false, enableTaxTools: true, enableReferenceAdmin: true, enableAnnualReport: true }))
      .toContain("lightyear-booking");
  });

  it("skips the lightyear-booking prompt when Lightyear is disabled", () => {
    const names = registeredPromptNames({ enableLightyear: false, exposeGranularTools: false, exposeSetupTools: false, enableTaxTools: true, enableReferenceAdmin: true, enableAnnualReport: true });
    expect(names).not.toContain("lightyear-booking");
    // The rest of the prompt surface is unaffected.
    expect(names).toContain("book-invoice");
    expect(names).toContain("import-wise");
  });
});
