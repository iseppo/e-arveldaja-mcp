import { describe, expect, it, vi } from "vitest";
import { getToolExposureConfig } from "../config.js";
import { registerAccountingInboxTools } from "./accounting-inbox.js";

function registeredInboxToolNames(): string[] {
  const server = { registerTool: vi.fn() } as any;
  registerAccountingInboxTools(server, {} as any);
  return server.registerTool.mock.calls.map(([name]: [string]) => name);
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
});

describe("accounting inbox tool surface", () => {
  it("registers the merged accounting_inbox entry point", () => {
    expect(registeredInboxToolNames()).toContain("accounting_inbox");
  });

  it("no longer registers the removed prepare/run inbox aliases (folded into accounting_inbox modes)", () => {
    const names = registeredInboxToolNames();
    expect(names).not.toContain("prepare_accounting_inbox");
    expect(names).not.toContain("run_accounting_inbox_dry_runs");
  });
});
