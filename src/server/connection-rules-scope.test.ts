import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./create-server.js";
import type { NamedConfig } from "../config.js";
import { buildConnectionFingerprint } from "../connection-fingerprint.js";
import { buildAccountingRulesConnectionScope, initAccountingRulesConnection } from "../accounting-rules.js";
import { makeAccount, makeJournal, makePosting } from "../__fixtures__/accounting.js";
import { parseToolPayload } from "../__fixtures__/mcp-response.js";
import type { buildAnnualReportData } from "../tools/annual-report.js";
import { ReferenceDataApi } from "../api/readonly.api.js";
import { JournalsApi } from "../api/journals.api.js";
import { ClientsApi } from "../api/clients.api.js";
import { SaleInvoicesApi } from "../api/sale-invoices.api.js";
import { PurchaseInvoicesApi } from "../api/purchase-invoices.api.js";
import * as paths from "../paths.js";

const configs: NamedConfig[] = ["a", "b"].map(name => ({
  name: `rules-scope-${name}`,
  verifiedCompanyName: `Rules Scope ${name}`,
  config: { apiKeyId: name, apiPublicValue: `${name}-public`, apiPassword: `${name}-secret`, baseUrl: "https://demo-rmp-api.rik.ee/v1" },
}));

const accounts = [
  makeAccount(1020, "D", "Varad", "Pangakonto"),
  makeAccount(2100, "C", "Kohustused", "Võlad tarnijatele"),
  makeAccount(2900, "C", "Omakapital", "Osakapital"),
  makeAccount(2960, "C", "Omakapital", "Eelmiste perioodide jaotamata kasum"),
  makeAccount(2970, "C", "Omakapital", "Aruandeaasta kasum"),
  makeAccount(9000, "D", "Kulud", "Arvestuslik koondtulemus"),
];

describe("invocation-scoped accounting rules", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    initAccountingRulesConnection(() => ({ name: "default", stableIdentity: "default" }));
  });

  it.each([false, true])("refuses an annual report resumed after a connection switch (switched back: %s)", async switchedBack => {
    const root = mkdtempSync(join(process.cwd(), ".test-rules-scope-"));
    vi.stubEnv("EARVELDAJA_CONFIG_DIR", join(root, "config"));
    vi.stubEnv("EARVELDAJA_RULES_FILE", "");
    vi.stubEnv("EARVELDAJA_RULES_DIR", "");
    vi.stubEnv("EARVELDAJA_DEFAULT_CONNECTION", "");
    vi.spyOn(paths, "getProjectRoot").mockReturnValue(join(root, "project"));
    for (const [index, config] of configs.entries()) {
      const scope = buildAccountingRulesConnectionScope(config.name, buildConnectionFingerprint(config.config));
      const dir = join(root, "config", scope);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "accounting-rules.md"),
        `# Accounting Rules\n\n## Liability Classification\n| account_id | classification |\n| --- | --- |\n| 2100 | ${index === 0 ? "current" : "non_current"} |\n`);
    }

    let pauseReads = false;
    let releaseRead!: () => void;
    const pendingRead = new Promise<void>(resolve => { releaseRead = resolve; });
    let notifyReadStarted!: () => void;
    const readStarted = new Promise<void>(resolve => { notifyReadStarted = resolve; });
    vi.spyOn(ReferenceDataApi.prototype, "getAccounts").mockImplementation(async () => {
      if (pauseReads) { notifyReadStarted(); await pendingRead; }
      return accounts;
    });
    vi.spyOn(ReferenceDataApi.prototype, "getInvoiceInfo").mockResolvedValue({ invoice_company_name: "Original company" });
    vi.spyOn(ReferenceDataApi.prototype, "getVatInfo").mockResolvedValue({ vat_number: "" });
    vi.spyOn(JournalsApi.prototype, "listAllWithPostings").mockResolvedValue([
      makeJournal("2026-01-01", [makePosting(1020, "D", 10_000), makePosting(2100, "C", 10_000)], { id: 1, operation_type: "INITIAL" }),
    ]);
    vi.spyOn(ClientsApi.prototype, "listAll").mockResolvedValue([]);
    vi.spyOn(SaleInvoicesApi.prototype, "listAll").mockResolvedValue([]);
    vi.spyOn(PurchaseInvoicesApi.prototype, "listAll").mockResolvedValue([]);

    const bootstrap = await createMcpServer({ configs, toolProfile: "full", connect: false });
    const client = new Client({ name: "rules-scope-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bootstrap.server.connect(serverTransport), client.connect(clientTransport)]);
    const report = () => client.callTool({ name: "generate_annual_report_data", arguments: { year: 2026 } });
    const switchTo = async (index: number) => {
      expect((await client.callTool({ name: "switch_connection", arguments: { index } })).isError).not.toBe(true);
    };
    try {
      const a = await report();
      expect(a.isError).not.toBe(true);
      expect(parseToolPayload<Awaited<ReturnType<typeof buildAnnualReportData>>>(
        (a.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ key_ratios: { current_ratio: 1 } });
      await switchTo(1);
      const b = await report();
      expect(b.isError).not.toBe(true);
      expect(parseToolPayload<Awaited<ReturnType<typeof buildAnnualReportData>>>(
        (b.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ key_ratios: { current_ratio: null } });
      await switchTo(0);

      pauseReads = true;
      const staleReport = report();
      await readStarted;
      await switchTo(1);
      if (switchedBack) await switchTo(0);
      releaseRead();
      const response = await staleReport;
      expect(response.isError).toBe(true);
      expect((response.content as Array<{ text: string }>)[0]!.text).toContain("ConnectionSwitchInterruptedError");
    } finally {
      releaseRead();
      await Promise.allSettled([client.close(), bootstrap.server.close()]);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
