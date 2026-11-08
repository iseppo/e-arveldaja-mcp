import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  compareCompanyIdentity,
  registerAccountingDataTransferTool,
  type AccountingDataExportPayload,
  type AccountingDataImportPreviewPayload,
  type AccountingDataImportResultPayload,
  type CompanyDataExportFile,
  type CompanyDataIdentity,
} from "./accounting-data-transfer.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { parseToolPayload } from "../__fixtures__/mcp-response.js";
import {
  findAutoBookingRule,
  getCashFlowCategoryRule,
  initAccountingRulesConnection,
  normalizeAutoBookingRuleMatch,
  resetAccountingRulesCache,
  resolveActiveRulesBundle,
  saveAnnualReportAccountRule,
  saveAutoBookingRule,
} from "../accounting-rules.js";
import { limitedVatStore, readLimitedVatRecords, type LimitedVatStoreRecord } from "../company-vat-status.js";
import { defaultUsdPoolStore, type UsdPoolRecord } from "../lightyear/usd-pool.js";
import { recordCompanyIdentity, resetCompanyIdentityState } from "../company-identity.js";
import type { ApiContext } from "./crud-tools.js";
import type { Client } from "../types/api.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface Company {
  name: string | null;
  vat?: string;
  taxRef?: string;
  regCode?: string;
  server?: string;
}

function fakeApi(company: Company): ApiContext {
  const clients: Client[] = company.regCode && company.name
    ? [{ id: 1, name: company.name, code: company.regCode, invoice_vat_no: company.vat, is_client: true, is_supplier: false, is_member: false, send_invoice_to_email: false, send_invoice_to_accounting_email: false } as Client]
    : [];
  return {
    readonly: {
      getInvoiceInfo: async () => ({ invoice_company_name: company.name }),
      getVatInfo: async () => ({ vat_number: company.vat, tax_refnumber: company.taxRef }),
    },
    clients: { listAll: async () => clients },
    journals: { apiBaseUrl: company.server ?? "https://rmp-api.rik.ee/v1", connectionFingerprint: "unused" },
  } as unknown as ApiContext;
}

function setup(company: Company) {
  const handlers = new Map<string, Handler>();
  const server = { registerTool: vi.fn((name: string, _config: unknown, cb: Handler) => handlers.set(name, cb)) } as unknown as McpServer;
  const ctx = createTestRuntimeSafetyContext();
  registerAccountingDataTransferTool(server, fakeApi(company), ctx);
  const call = async (args: Record<string, unknown>) => {
    const result = await handlers.get("accounting_data_transfer")!(args);
    return { result, text: (result.content[0] as { text: string }).text };
  };
  return { call };
}

const ACME: Company = { name: "Acme OÜ", vat: "EE100000001", taxRef: "12345678", regCode: "14000001" };

let work: string;
function useMachine(name: string, identity: string, connectionCount = 1): string {
  const dir = join(work, name);
  process.env.EARVELDAJA_CONFIG_DIR = dir;
  initAccountingRulesConnection(() => ({ name: "acme", stableIdentity: identity, connectionCount }));
  resetAccountingRulesCache();
  limitedVatStore.reset();
  defaultUsdPoolStore.reset();
  return dir;
}

const usdOpening = { record: "checkpoint", kind: "opening", pool_key: { lightyear_account: "ABC", account: 1020, dimension: 5 }, as_of: "2026-01-01" } as unknown as UsdPoolRecord;
const limitedStatus = { kind: "status", key: "company_vat_status", status: "limited", effective_from: "2026-01-01", set_at: "2026-01-02T00:00:00.000Z", vat_number: "EE100000001" } as unknown as LimitedVatStoreRecord;

function seedSource(): void {
  saveAutoBookingRule({ match: "Zone Media", purchase_account_id: 5230, reason: "hosting" });
  saveAnnualReportAccountRule({ rule_type: "cash_flow_category", account_id: 2410, value: "financing" });
  defaultUsdPoolStore.upsert([usdOpening]);
  limitedVatStore.upsert([limitedStatus]);
}

async function exportFrom(company: Company, name = "export.json"): Promise<string> {
  const out = join(work, name);
  const { result, text } = await setup(company).call({ mode: "export", file_path: out });
  expect(result.isError).toBeFalsy();
  const payload = parseToolPayload<AccountingDataExportPayload>(text);
  expect(payload.status).toBe("exported");
  return out;
}

async function dryRun(company: Company, args: Record<string, unknown>) {
  const tool = setup(company);
  const { result, text } = await tool.call({ mode: "import", ...args });
  return { tool, result, text };
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "company-data-"));
});
afterEach(() => {
  delete process.env.EARVELDAJA_CONFIG_DIR;
  delete process.env.EARVELDAJA_RULES_DIR;
  initAccountingRulesConnection(() => ({ name: "default", stableIdentity: "default" }));
  resetAccountingRulesCache();
  limitedVatStore.reset();
  defaultUsdPoolStore.reset();
  resetCompanyIdentityState();
});

describe("compareCompanyIdentity", () => {
  const id = (over: Partial<CompanyDataIdentity>): CompanyDataIdentity => ({ name: null, registry_code: null, vat_number: null, tax_refnumber: null, ...over });
  const live = "https://rmp-api.rik.ee/v1";
  const demo = "https://demo-rmp-api.rik.ee/v1";

  it("matches on an equal registry code, else tax reference number, else name on the same server", () => {
    expect(compareCompanyIdentity({ server: live, company: id({ registry_code: "14000001" }) }, { server: demo, company: id({ registry_code: " 14000001 " }) }))
      .toEqual({ match: true, basis: "registry_code" });
    expect(compareCompanyIdentity({ server: live, company: id({ tax_refnumber: "123" }) }, { server: live, company: id({ tax_refnumber: "123" }) }))
      .toEqual({ match: true, basis: "tax_refnumber" });
    expect(compareCompanyIdentity({ server: live, company: id({ name: "Acme OÜ" }) }, { server: `${live}/`, company: id({ name: "ACME OÜ" }) }))
      .toEqual({ match: true, basis: "name_and_server" });
  });

  it("refuses any differing identifier, a name on another server, and an unattributable export", () => {
    expect(compareCompanyIdentity({ server: live, company: id({ name: "Acme OÜ", registry_code: "14000001" }) }, { server: live, company: id({ name: "Acme OÜ", registry_code: "14000002" }) }).match).toBe(false);
    expect(compareCompanyIdentity({ server: live, company: id({ registry_code: "14000001", tax_refnumber: "1" }) }, { server: live, company: id({ registry_code: "14000001", tax_refnumber: "2" }) }).match).toBe(false);
    expect(compareCompanyIdentity({ server: live, company: id({ name: "Acme OÜ", vat_number: "EE1" }) }, { server: live, company: id({ name: "Acme OÜ", vat_number: "EE2" }) }).match).toBe(false);
    expect(compareCompanyIdentity({ server: live, company: id({ name: "Acme OÜ" }) }, { server: demo, company: id({ name: "Acme OÜ" }) }).match).toBe(false);
    expect(compareCompanyIdentity({ server: live, company: id({}) }, { server: live, company: id({}) }).match).toBe(false);
  });
});

describe("accounting_data_transfer export → import", () => {
  it("round-trips rules, the USD pool and limited-VAT settings into a fresh config dir under a new API key", async () => {
    const machineA = useMachine("a", "fp-old");
    seedSource();
    const out = await exportFrom(ACME);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const doc = JSON.parse(readFileSync(out, "utf8")) as CompanyDataExportFile;
    expect(doc).toMatchObject({ format: "e-arveldaja-mcp-company-data", version: 1, rule_scope: "this_company", source_identity: "fp-old", company: { name: "Acme OÜ", registry_code: "14000001", tax_refnumber: "12345678" } });
    expect(doc.files.map(f => f.path)).toEqual(expect.arrayContaining(["annual-report/cash-flow-category.md", "lightyear-usd-pool.json", "limited-vat.json"]));
    expect(doc.files.some(f => f.path.startsWith("auto-booking/"))).toBe(true);
    expect(doc.files.find(f => f.path === "limited-vat.json")!.content).not.toContain("connectionIdentity");
    expect(resolveActiveRulesBundle()!.dir.startsWith(machineA)).toBe(true);

    useMachine("b", "fp-new");
    expect(getCashFlowCategoryRule(2410)).toBeUndefined();
    const { tool, result, text } = await dryRun(ACME, { file_path: out });
    expect(result.isError).toBeFalsy();
    const preview = parseToolPayload<AccountingDataImportPreviewPayload>(text);
    expect(preview.source.identity_basis).toBe("registry_code");
    expect(preview.held).toEqual([]);
    expect(preview.state_stores).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "lightyear-usd-pool.json", status: "new", action: "write", imported_records: 1 }),
      expect.objectContaining({ name: "limited-vat.json", status: "new", action: "write", imported_records: 1 }),
    ]));
    expect(preview.rule_files.find(f => f.path === "index.md")).toMatchObject({ status: "skipped" });

    const executed = await tool.call({ mode: "import", file_path: out, execute: true, plan_handle: preview.plan_handle });
    expect(executed.result.isError).toBeFalsy();
    const done = parseToolPayload<AccountingDataImportResultPayload>(executed.text);
    expect(done.status).toBe("imported");

    expect(getCashFlowCategoryRule(2410)).toBe("financing");
    expect(findAutoBookingRule(normalizeAutoBookingRuleMatch("Zone Media AS"))?.purchase_account_id).toBe(5230);
    expect(defaultUsdPoolStore.read()).toEqual([usdOpening]);
    expect(readLimitedVatRecords()).toEqual([limitedStatus]);
    const dir = resolveActiveRulesBundle()!.dir;
    const raw = JSON.parse(readFileSync(resolve(dir, "limited-vat.json"), "utf8")) as Array<{ connectionIdentity: string }>;
    expect(raw.map(r => r.connectionIdentity)).toEqual(["fp-new"]);
    expect(statSync(resolve(dir, "limited-vat.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(resolve(dir, "log.md"), "utf8")).toContain("company data import");

    // A second dry run finds everything identical.
    const again = parseToolPayload<AccountingDataImportPreviewPayload>((await dryRun(ACME, { file_path: out })).text);
    expect(again.will_write).toEqual({ rule_files: [], state_stores: [] });
  });

  it("refuses an export of another company (company_mismatch) and writes nothing", async () => {
    useMachine("a", "fp-a");
    seedSource();
    const out = await exportFrom(ACME);
    useMachine("b", "fp-b");
    const other: Company = { name: "Other OÜ", vat: "EE100000002", taxRef: "87654321", regCode: "14000002" };
    const { result, text } = await dryRun(other, { file_path: out });
    expect(result.isError).toBe(true);
    expect(text).toContain("company_mismatch");
    // Same name, different tax reference number: still refused.
    const sameName = await dryRun({ name: "Acme OÜ", taxRef: "99999999" }, { file_path: out });
    expect(sameName.text).toContain("company_mismatch");
    expect(getCashFlowCategoryRule(2410)).toBeUndefined();
  });

  it("holds an existing state store and a differing rule file unless the owner names them", async () => {
    useMachine("a", "fp-a");
    seedSource();
    const out = await exportFrom(ACME);
    useMachine("b", "fp-b");
    const localStatus = { ...limitedStatus, status: "full" } as LimitedVatStoreRecord;
    limitedVatStore.upsert([localStatus]);
    saveAnnualReportAccountRule({ rule_type: "cash_flow_category", account_id: 2410, value: "operating" });
    saveAnnualReportAccountRule({ rule_type: "cash_flow_category", account_id: 2420, value: "operating" });

    const held = await dryRun(ACME, { file_path: out });
    const preview = parseToolPayload<AccountingDataImportPreviewPayload>(held.text);
    expect(preview.held).toEqual(expect.arrayContaining([
      { path: "limited-vat.json", code: "state_store_exists" },
      { path: "annual-report/cash-flow-category.md", code: "rule_file_differs" },
    ]));
    const ruleDiff = preview.rule_files.find(f => f.path === "annual-report/cash-flow-category.md")!.diff!;
    expect(ruleDiff.rows_changed).toHaveLength(1);
    expect(JSON.stringify(ruleDiff.rows_changed[0])).toContain("financing");
    expect(ruleDiff.rows_only_local).toHaveLength(1);
    await held.tool.call({ mode: "import", file_path: out, execute: true, plan_handle: preview.plan_handle });
    expect(readLimitedVatRecords()).toEqual([localStatus]);
    expect(getCashFlowCategoryRule(2410)).toBe("operating");
    expect(defaultUsdPoolStore.read()).toEqual([usdOpening]);

    const approvedArgs = { file_path: out, apply_rule_files: ["annual-report/cash-flow-category.md"], replace_state_stores: ["limited-vat.json"] };
    const approved = await dryRun(ACME, approvedArgs);
    const plan = parseToolPayload<AccountingDataImportPreviewPayload>(approved.text);
    expect(plan.held).toEqual([]);
    const done = await approved.tool.call({ mode: "import", ...approvedArgs, execute: true, plan_handle: plan.plan_handle });
    expect(done.result.isError).toBeFalsy();
    expect(readLimitedVatRecords()).toEqual([limitedStatus]);
    expect(getCashFlowCategoryRule(2410)).toBe("financing");
    expect(getCashFlowCategoryRule(2420)).toBeUndefined();
  });

  it("exports only this connection's records from a shared store and keeps other connections' records on import", async () => {
    const shared = join(work, "shared");
    process.env.EARVELDAJA_RULES_DIR = shared;
    initAccountingRulesConnection(() => ({ name: "other", stableIdentity: "fp-other", connectionCount: 2 }));
    limitedVatStore.reset();
    limitedVatStore.upsert([{ ...limitedStatus, status: "none" } as LimitedVatStoreRecord]);
    initAccountingRulesConnection(() => ({ name: "acme", stableIdentity: "fp-acme", connectionCount: 2 }));
    limitedVatStore.reset();
    limitedVatStore.upsert([limitedStatus]);
    const out = await exportFrom(ACME);
    const doc = JSON.parse(readFileSync(out, "utf8")) as CompanyDataExportFile;
    expect(doc.rule_scope).toBe("shared");
    expect(JSON.parse(doc.files.find(f => f.path === "limited-vat.json")!.content)).toEqual([limitedStatus]);

    limitedVatStore.remove(["company_vat_status"]);
    const { tool, text } = await dryRun(ACME, { file_path: out });
    const preview = parseToolPayload<AccountingDataImportPreviewPayload>(text);
    await tool.call({ mode: "import", file_path: out, execute: true, plan_handle: preview.plan_handle });
    const raw = JSON.parse(readFileSync(join(shared, "limited-vat.json"), "utf8")) as Array<{ connectionIdentity: string; status: string }>;
    expect(raw.map(r => [r.connectionIdentity, r.status]).sort()).toEqual([["fp-acme", "limited"], ["fp-other", "none"]]);
  });

  it("refuses path traversal, unknown store names and oversize files", async () => {
    useMachine("b", "fp-b");
    const base: CompanyDataExportFile = {
      format: "e-arveldaja-mcp-company-data", version: 1, exported_at: "2026-11-08T00:00:00.000Z", server: "https://rmp-api.rik.ee/v1",
      company: { name: "Acme OÜ", registry_code: "14000001", vat_number: null, tax_refnumber: null }, source_identity: "x", rule_scope: "this_company", files: [],
    };
    const write = (name: string, files: CompanyDataExportFile["files"]) => {
      const path = join(work, name);
      writeFileSync(path, JSON.stringify({ ...base, files }));
      return path;
    };
    for (const [name, file] of [
      ["t1.json", { path: "../evil.md", kind: "rule", content: "x" }],
      ["t2.json", { path: "auto-booking/../../evil.md", kind: "rule", content: "x" }],
      ["t3.json", { path: "/etc/passwd.md", kind: "rule", content: "x" }],
      ["t4.json", { path: "../statement-balances.json", kind: "state", content: "[]" }],
      ["t5.json", { path: ".env", kind: "state", content: "[]" }],
    ] as const) {
      const { text } = await dryRun(ACME, { file_path: write(name, [file]) });
      expect(text).toContain("import_path_refused");
    }
    const bad = await dryRun(ACME, { file_path: write("t6.json", [{ path: "limited-vat.json", kind: "state", content: "[{\"no\":1}]" }]) });
    expect(bad.text).toContain("import_file_invalid");
    const extra = join(work, "t7.json");
    writeFileSync(extra, JSON.stringify({ ...base, unexpected: true }));
    expect((await dryRun(ACME, { file_path: extra })).text).toContain("import_file_invalid");
    const big = join(work, "big.json");
    writeFileSync(big, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    const oversize = await dryRun(ACME, { file_path: big });
    expect(oversize.result.isError).toBe(true);
    expect(oversize.text).toContain("import_file_too_large");
  });

  it("refuses execute when the local state, the import file or the approved lists changed (plan_drift)", async () => {
    useMachine("a", "fp-a");
    seedSource();
    const out = await exportFrom(ACME);
    useMachine("b", "fp-b");

    const first = await dryRun(ACME, { file_path: out });
    const plan1 = parseToolPayload<AccountingDataImportPreviewPayload>(first.text);
    limitedVatStore.upsert([{ ...limitedStatus, status: "full" } as LimitedVatStoreRecord]);
    const drift = await first.tool.call({ mode: "import", file_path: out, execute: true, plan_handle: plan1.plan_handle });
    expect(drift.text).toContain("plan_drift");
    expect(defaultUsdPoolStore.read()).toEqual([]);

    const second = await dryRun(ACME, { file_path: out });
    const plan2 = parseToolPayload<AccountingDataImportPreviewPayload>(second.text);
    const doc = JSON.parse(readFileSync(out, "utf8")) as CompanyDataExportFile;
    writeFileSync(out, JSON.stringify({ ...doc, exported_at: "2026-11-09T00:00:00.000Z" }));
    expect((await second.tool.call({ mode: "import", file_path: out, execute: true, plan_handle: plan2.plan_handle })).text).toContain("plan_drift");

    const third = await dryRun(ACME, { file_path: out });
    const plan3 = parseToolPayload<AccountingDataImportPreviewPayload>(third.text);
    const changedLists = await third.tool.call({ mode: "import", file_path: out, replace_state_stores: ["limited-vat.json"], execute: true, plan_handle: plan3.plan_handle });
    expect(changedLists.text).toContain("plan_drift");
    expect(defaultUsdPoolStore.read()).toEqual([]);
  });

  it("never overwrites an existing export file", async () => {
    useMachine("a", "fp-a");
    const out = join(work, "exists.json");
    writeFileSync(out, "keep");
    const { result, text } = await setup(ACME).call({ mode: "export", file_path: out });
    expect(result.isError).toBe(true);
    expect(text).toContain("output_exists");
    expect(readFileSync(out, "utf8")).toBe("keep");
  });

  it("refuses a relative file_path in both modes", async () => {
    useMachine("a", "fp-a");
    for (const mode of ["export", "import"]) {
      const { result, text } = await setup(ACME).call({ mode, file_path: "export.json" });
      expect(result.isError).toBe(true);
      expect(text).toContain("file_path_not_absolute");
    }
  });

  it("carries the registry code resolved from a public register and its source in the header", async () => {
    useMachine("a", "fp-a");
    const fingerprint = "a".repeat(64);
    recordCompanyIdentity(fingerprint, { server: "https://rmp-api.rik.ee/v1", registry_code: "10234957", source: "ariregister_name", resolved_at: "2026-11-08T00:00:00.000Z" });
    const api = fakeApi(ACME);
    (api.journals as unknown as { connectionFingerprint: string }).connectionFingerprint = fingerprint;
    const handlers = new Map<string, Handler>();
    const server = { registerTool: vi.fn((name: string, _config: unknown, cb: Handler) => handlers.set(name, cb)) } as unknown as McpServer;
    registerAccountingDataTransferTool(server, api, createTestRuntimeSafetyContext());
    const out = join(work, "mapped.json");
    const result = await handlers.get("accounting_data_transfer")!({ mode: "export", file_path: out });
    expect(result.isError).toBeFalsy();
    const doc = JSON.parse(readFileSync(out, "utf8")) as CompanyDataExportFile;
    expect(doc.company).toMatchObject({ registry_code: "10234957", registry_code_source: "ariregister_name" });
  });
});
