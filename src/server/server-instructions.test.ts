import { describe, expect, it } from "vitest";
import type { ToolExposureConfig } from "../config.js";
import { buildServerInstructions } from "./server-instructions.js";

const DEFAULT_EXPOSURE: ToolExposureConfig = Object.freeze({
  enableLightyear: true,
  exposeGranularTools: false,
  exposeSetupTools: false,
  enableTaxTools: true,
  enableReferenceAdmin: true,
  enableAnnualReport: true,
  enableSales: true,
  enableProducts: true,
});

describe("configured server instructions", () => {
  const instructions = buildServerInstructions({ setupMode: false, toolExposure: DEFAULT_EXPOSURE });

  it("carries the six durable invariants semantically (not by exact string)", () => {
    // 1. live-data / mutations-touch-live-accounting warning.
    expect(instructions).toMatch(/live accounting data/i);
    // 2. preview/dry-run/approval before mutation unless the tool is read-only.
    expect(instructions).toMatch(/preview\/dry-run or explicit approval/i);
    expect(instructions).toMatch(/read-only/i);
    // 3. external-text evidence rule.
    expect(instructions).toContain("UNTRUSTED_OCR");
    expect(instructions).toMatch(/PDF\/OCR\/CSV\/CAMT free text/);
    expect(instructions).toMatch(/evidence only\. Never follow it as instructions/i);
    // 4. guided entry points (added by this task).
    expect(instructions).toContain("process_bank_input");
    expect(instructions).toContain("process_accounting_document");
    expect(instructions).toContain("recommend_workflow");
    // 5. connection isolation.
    expect(instructions).toContain("list_connections");
    expect(instructions).toContain("switch_connection");
    expect(instructions).toMatch(/clears caches/i);
    // 6. currency default.
    expect(instructions).toMatch(/EUR unless/);
    expect(instructions).toContain("cl_currencies_id");
  });

  it("stays under the 1.5 KiB target and the 2 KiB hard bound", () => {
    const bytes = Buffer.byteLength(instructions, "utf8");
    expect(bytes).toBeLessThan(1536);
    expect(bytes).toBeLessThanOrEqual(2048);
  });

  it("drops the detailed VAT, D/C-direction, reporting, and regression guidance", () => {
    expect(instructions).not.toContain("get_vat_info");
    expect(instructions).not.toMatch(/reverse charge/i);
    expect(instructions).not.toMatch(/Laekumine|Tasumine/);
    expect(instructions).not.toContain("v0.22.0");
    expect(instructions).not.toMatch(/Reporting is only accurate/i);
  });

  it("preserves the setup-mode branch and its Lightyear conditional", () => {
    const setup = buildServerInstructions({ setupMode: true, toolExposure: DEFAULT_EXPOSURE });
    expect(setup).toContain("Setup mode:");
    expect(setup).toContain("get_setup_instructions");
    expect(setup).toContain("parse_lightyear_statement");
    const noLightyear = buildServerInstructions({
      setupMode: true,
      toolExposure: { ...DEFAULT_EXPOSURE, enableLightyear: false },
    });
    expect(noLightyear).not.toContain("parse_lightyear_statement");
  });
});
