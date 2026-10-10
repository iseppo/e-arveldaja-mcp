import { describe, expect, it, vi } from "vitest";
import { getToolExposureConfig, getToolProfileConfig, type ToolExposureConfig } from "../config.js";
import { registerAccountingInboxTools } from "./accounting-inbox.js";
import { registerBankReconciliationTools } from "./bank-reconciliation.js";
import { registerCamtImportTools } from "./camt-import.js";
import { registerReceiptInboxTools } from "./receipt-inbox.js";
import { registerWiseImportTools } from "./wise-import.js";
import { registerLightyearTools } from "./lightyear-investments.js";
import { registerCrudTools } from "./crud-tools.js";

const EXPOSED: ToolExposureConfig = { enableLightyear: true, exposeGranularTools: true, exposeSetupTools: true, enableTaxTools: true, enableReferenceAdmin: true, enableAnnualReport: true, enableSales: true, enableProducts: true };

function registeredToolNames(
  register: (server: any, api: any, exposure?: ToolExposureConfig) => void,
  exposure: ToolExposureConfig,
): string[] {
  const server = { registerTool: vi.fn() } as any;
  register(server, {} as any, exposure);
  return server.registerTool.mock.calls.map(([name]: [string]) => name);
}

describe("getToolExposureConfig", () => {
  it("keeps standard as the absent-profile compatibility surface and maps full to all groups", () => {
    expect(getToolProfileConfig({} as NodeJS.ProcessEnv).profile).toBe("standard");
    expect(getToolProfileConfig({ EARVELDAJA_PROFILE: "full" } as NodeJS.ProcessEnv).exposure)
      .toEqual(EXPOSED);
  });
  it("fails every safety-sensitive registrar immediately without an explicit valid runtime context", () => {
    const server = { registerTool: vi.fn() } as any;
    const api = new Proxy({}, { get() { throw new Error("API must not be read"); } }) as any;
    const invocations = [
      () => registerAccountingInboxTools(server, api, undefined as never, EXPOSED),
      () => registerBankReconciliationTools(server, api, undefined as never, EXPOSED),
      () => registerCamtImportTools(server, api, undefined as never, EXPOSED),
      () => registerReceiptInboxTools(server, api, undefined as never, EXPOSED),
      () => registerWiseImportTools(server, api, undefined as never),
      () => registerLightyearTools(server, api, undefined as never),
    ];
    for (const invoke of invocations) expect(invoke).toThrow("valid runtime safety context");
    expect(server.registerTool).not.toHaveBeenCalled();

    let traps = 0;
    const hostile = new Proxy({}, { get() { traps += 1; throw new Error("secret"); } });
    expect(() => registerWiseImportTools(server, api, hostile as never)).toThrow("valid runtime safety context");
    expect(traps).toBe(0);
  });

  // Every exposure flag: default value plus the truthy/falsy env parsing.
  it.each([
    ["enableLightyear", "EARVELDAJA_DISABLE_LIGHTYEAR", true],
    ["exposeGranularTools", "EARVELDAJA_EXPOSE_GRANULAR_TOOLS", false],
    ["exposeSetupTools", "EARVELDAJA_EXPOSE_SETUP_TOOLS", false],
    ["enableTaxTools", "EARVELDAJA_DISABLE_TAX_TOOLS", true],
    ["enableReferenceAdmin", "EARVELDAJA_DISABLE_REFERENCE_ADMIN", true],
    ["enableAnnualReport", "EARVELDAJA_DISABLE_ANNUAL_REPORT", true],
    ["enableSales", "EARVELDAJA_DISABLE_SALES", true],
    ["enableProducts", "EARVELDAJA_DISABLE_PRODUCTS", true],
  ] as const)("%s defaults to the unset value and flips only when %s is truthy", (key, envVar, defaultValue) => {
    expect(getToolExposureConfig({} as NodeJS.ProcessEnv)[key]).toBe(defaultValue);
    expect(getToolExposureConfig({ [envVar]: "1" } as any)[key]).toBe(!defaultValue);
    expect(getToolExposureConfig({ [envVar]: "true" } as any)[key]).toBe(!defaultValue);
    expect(getToolExposureConfig({ [envVar]: "" } as any)[key]).toBe(defaultValue);
    expect(getToolExposureConfig({ [envVar]: "0" } as any)[key]).toBe(defaultValue);
  });
});

describe("sales and products tool surface", () => {
  // Full inventories — a partial-gating regression (a tool left in/out of the
  // group) must fail, so these list every tool the flag is meant to govern.
  const SALE_INVOICE_TOOLS = [
    "list_sale_invoices",
    "get_sale_invoice",
    "create_sale_invoice",
    "update_sale_invoice",
    "delete_sale_invoice",
    "confirm_sale_invoice",
    "invalidate_sale_invoice",
    "get_sale_invoice_delivery_options",
    "send_sale_invoice",
    "get_sale_invoice_document",
    "get_sale_invoice_xml",
  ];
  const PRODUCT_TOOLS = [
    "list_products",
    "get_product",
    "create_product",
    "update_product",
    "deactivate_product",
    "reactivate_product",
    "delete_product",
  ];

  it("drops the sale-invoice tools but keeps purchase + products when sales is disabled", () => {
    const names = registeredToolNames(registerCrudTools, { ...EXPOSED, enableSales: false });
    for (const tool of SALE_INVOICE_TOOLS) expect(names).not.toContain(tool);
    expect(names).toContain("create_purchase_invoice");
    for (const tool of PRODUCT_TOOLS) expect(names).toContain(tool);
  });

  it("drops the product tools but keeps sale invoices when products is disabled", () => {
    const names = registeredToolNames(registerCrudTools, { ...EXPOSED, enableProducts: false });
    for (const tool of PRODUCT_TOOLS) expect(names).not.toContain(tool);
    for (const tool of SALE_INVOICE_TOOLS) expect(names).toContain(tool);
  });
});
