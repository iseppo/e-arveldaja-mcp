import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createHash } from "crypto";
import {
  COMPANY_IDENTITY_FILE,
  adoptedCompany,
  companyKeyOf,
  ensureCompanyIdentity,
  recordCompanyIdentity,
  readCompanyIdentityMapping,
  resetCompanyIdentityState,
  unresolvedCompanyReason,
} from "./company-identity.js";
import { isValidEstonianRegistryCode, resetEmtaKmkrCache, type EmtaFetch } from "./emta-kmkr.js";
import { emtaAnswerHtml, fakeEmtaFetch, LIMITED_ROW } from "./__fixtures__/emta-kmkr.js";
import { releasedChooseDefaultBundleStorage } from "./__fixtures__/released-rules-storage.js";
import {
  companyBundleDir,
  companyRecordStamp,
  describeAccountingRuleScope,
  getAccountingRulesPath,
  getCashFlowCategoryRule,
  initAccountingRulesConnection,
  resetAccountingRulesCache,
  resetCompanyBundleMigrationState,
  saveAnnualReportAccountRule,
  type AccountingRulesCompany,
} from "./accounting-rules.js";
import { limitedVatStore, type LimitedVatStoreRecord } from "./company-vat-status.js";
import type { ApiContext } from "./tools/crud-tools.js";

const SERVER = "https://rmp-api.rik.ee/v1";
const fp = (label: string) => createHash("sha256").update(label).digest("hex");
const scopeOf = (fingerprint: string) => createHash("sha256").update(fingerprint).digest("hex");

function api(vat: string | undefined, name: string | null, calls: string[] = [], clients: unknown[] = []): ApiContext {
  return {
    readonly: {
      getVatInfo: async () => { calls.push("vat_info"); return { vat_number: vat }; },
      getInvoiceInfo: async () => { calls.push("invoice_info"); return { invoice_company_name: name }; },
    },
    clients: { listAll: async () => { calls.push("clients"); return clients; } },
  } as unknown as ApiContext;
}

function registerFetch(data: unknown[], calls: string[] = []): typeof fetch {
  return (async (url: unknown) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ status: "OK", data }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const emta = (html: string) => ({ fetch: fakeEmtaFetch(html).impl as unknown as EmtaFetch });

let config: string;
beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), "company-identity-"));
  process.env.EARVELDAJA_CONFIG_DIR = config;
  resetCompanyIdentityState();
  resetCompanyBundleMigrationState();
  resetEmtaKmkrCache();
});
afterEach(() => {
  delete process.env.EARVELDAJA_RULES_DIR;
  initAccountingRulesConnection(() => ({ name: "default", stableIdentity: "default" }));
  resetAccountingRulesCache();
  limitedVatStore.reset();
  resetCompanyIdentityState();
  resetCompanyBundleMigrationState();
});

describe("registry code check digit", () => {
  it("accepts valid 8-digit registry codes only", () => {
    expect(isValidEstonianRegistryCode("10234957")).toBe(true);
    expect(isValidEstonianRegistryCode("14417608")).toBe(true);
    expect(isValidEstonianRegistryCode("10234958")).toBe(false);
    expect(isValidEstonianRegistryCode("1023495")).toBe(false);
    expect(isValidEstonianRegistryCode("38001010000")).toBe(false);
  });
});

describe("company identity resolution", () => {
  it("takes the registry code of the one active EMTA registration of the company's VAT number and persists it", async () => {
    const a = fp("a");
    await ensureCompanyIdentity(a, `${SERVER}/`, api("EE103050067", "Näidis OÜ"), { emta: emta(emtaAnswerHtml([LIMITED_ROW])) });
    expect(readCompanyIdentityMapping()[a]).toMatchObject({ server: SERVER, registry_code: "14417608", source: "emta_kmkr" });
    expect(statSync(join(config, COMPANY_IDENTITY_FILE)).mode & 0o777).toBe(0o600);
    expect(adoptedCompany(a)).toEqual({ key: companyKeyOf(SERVER, "14417608"), fingerprints: [a] });
  });

  it.each([
    ["a personal code", { ...LIMITED_ROW, code: "38001010000" }],
    ["an invalid check digit", { ...LIMITED_ROW, code: "14417609" }],
  ])("leaves the company unresolved for %s", async (_label, row) => {
    const a = fp("a");
    await ensureCompanyIdentity(a, SERVER, api("EE103050067", "Näidis OÜ"), { emta: emta(emtaAnswerHtml([row])) });
    expect(readCompanyIdentityMapping()).toEqual({});
    expect(adoptedCompany(a)).toBeUndefined();
    expect(unresolvedCompanyReason(a)).toBe("emta_no_registry_code");
  });

  it("without a VAT number, accepts exactly one active business-register company with exactly that name", async () => {
    const a = fp("a");
    const data = [
      { name: "Acme OÜ", status: "R", reg_code: 10234957 },
      { name: "Acme OÜ Holding", status: "R", reg_code: 14417608 },
      { name: "Acme AS", status: "R", reg_code: 12345678 },
      { name: "Acme OÜ", status: "K", reg_code: 11111111 },
    ];
    await ensureCompanyIdentity(a, SERVER, api(undefined, "  acme  oü "), { fetch: registerFetch(data) });
    expect(readCompanyIdentityMapping()[a]).toMatchObject({ registry_code: "10234957", source: "ariregister_name" });
  });

  it.each([
    ["no match (another legal form)", "Acme OÜ", [{ name: "Acme AS", status: "R", reg_code: 10234957 }], "ariregister_no_exact_match"],
    ["several active matches", "Acme OÜ", [{ name: "Acme OÜ", status: "R", reg_code: 10234957 }, { name: "Acme OÜ", status: "L", reg_code: 14417608 }], "ariregister_ambiguous"],
    ["only a deleted company", "Acme OÜ", [{ name: "Acme OÜ", status: "K", reg_code: 10234957 }], "ariregister_no_exact_match"],
    ["a historical name only", "Acme OÜ", [{ name: "Other OÜ", historical_names: ["Acme OÜ"], status: "R", reg_code: 10234957 }], "ariregister_no_exact_match"],
  ])("leaves the company unresolved for %s", async (_label, name, data, reason) => {
    const a = fp("a");
    await ensureCompanyIdentity(a, SERVER, api(undefined, name), { fetch: registerFetch(data) });
    expect(readCompanyIdentityMapping()).toEqual({});
    expect(unresolvedCompanyReason(a)).toBe(reason);
  });

  it("asks nothing of the business register without a company name", async () => {
    const a = fp("a");
    const calls: string[] = [];
    await ensureCompanyIdentity(a, SERVER, api(undefined, null), { fetch: registerFetch([], calls) });
    expect(calls).toEqual([]);
    expect(unresolvedCompanyReason(a)).toBe("company_name_missing");
  });

  it("works offline from the mapping in a later process and does not retry an unresolved company within the hour", async () => {
    const a = fp("a");
    await ensureCompanyIdentity(a, SERVER, api("EE103050067", "x"), { emta: emta(emtaAnswerHtml([LIMITED_ROW])) });
    resetCompanyIdentityState(); // a new process
    resetEmtaKmkrCache();
    const calls: string[] = [];
    const offline = { readonly: { getVatInfo: async () => { calls.push("vat"); throw new Error("offline"); } } } as unknown as ApiContext;
    expect(adoptedCompany(a)?.key).toBe(companyKeyOf(SERVER, "14417608"));
    await ensureCompanyIdentity(a, SERVER, offline, { emta: { fetch: (async () => { throw new TypeError("offline"); }) as unknown as EmtaFetch } });
    expect(calls).toEqual([]);
    expect(adoptedCompany(a)?.key).toBe(companyKeyOf(SERVER, "14417608"));

    const b = fp("b");
    const bCalls: string[] = [];
    let now = 1_000_000;
    await ensureCompanyIdentity(b, SERVER, api(undefined, "Nobody OÜ", bCalls), { fetch: registerFetch([]), now: () => now });
    now += 30 * 60_000;
    await ensureCompanyIdentity(b, SERVER, api(undefined, "Nobody OÜ", bCalls), { fetch: registerFetch([]), now: () => now });
    expect(bCalls.filter(c => c === "vat_info")).toHaveLength(1);
    now += 31 * 60_000;
    await ensureCompanyIdentity(b, SERVER, api(undefined, "Nobody OÜ", bCalls), { fetch: registerFetch([]), now: () => now });
    expect(bCalls.filter(c => c === "vat_info")).toHaveLength(2);
  });

  it("refuses a name match that the company's own client record contradicts", async () => {
    const a = fp("a");
    const clients = [{ id: 1, name: "Acme OÜ", code: "14417608", is_deleted: false }];
    await ensureCompanyIdentity(a, SERVER, api(undefined, "Acme OÜ", [], clients), { fetch: registerFetch([{ name: "Acme OÜ", status: "R", reg_code: 10234957 }]) });
    expect(readCompanyIdentityMapping()).toEqual({});
    expect(unresolvedCompanyReason(a)).toBe("ariregister_client_record_mismatch");
  });

  it("accepts a name match the company's own client record confirms", async () => {
    const a = fp("a");
    const clients = [{ id: 1, name: "Acme OÜ", code: "10234957", is_deleted: false }];
    await ensureCompanyIdentity(a, SERVER, api(undefined, "Acme OÜ", [], clients), { fetch: registerFetch([{ name: "Acme OÜ", status: "R", reg_code: 10234957 }]) });
    expect(readCompanyIdentityMapping()[a]).toMatchObject({ registry_code: "10234957", source: "ariregister_name", company_name: "Acme OÜ", vat_number: null });
  });

  it.each([
    ["has a VAT number", { vat_number: "EE100000001", company_name: null }],
    ["has another name", { vat_number: null, company_name: "Other OÜ" }],
  ])("refuses a name match when another connection mapped to that code %s", async (_label, other) => {
    const b = fp("b");
    recordCompanyIdentity(b, { server: SERVER, registry_code: "10234957", source: "emta_kmkr", resolved_at: "2026-11-01T00:00:00.000Z", ...other });
    const a = fp("a");
    await ensureCompanyIdentity(a, SERVER, api(undefined, "Acme OÜ"), { fetch: registerFetch([{ name: "Acme OÜ", status: "R", reg_code: 10234957 }]) });
    expect(readCompanyIdentityMapping()[a]).toBeUndefined();
    expect(unresolvedCompanyReason(a)).toBe("ariregister_conflicting_mapping");
  });

  it("never overwrites a damaged mapping file and keeps a company already adopted", async () => {
    const a = fp("a");
    await ensureCompanyIdentity(a, SERVER, api("EE103050067", "x"), { emta: emta(emtaAnswerHtml([LIMITED_ROW])) });
    const key = adoptedCompany(a)?.key;
    expect(key).toBe(companyKeyOf(SERVER, "14417608"));
    const path = join(config, COMPANY_IDENTITY_FILE);
    writeFileSync(path, "{ damaged");
    // The adopted company survives the damaged file in this process.
    await ensureCompanyIdentity(a, SERVER, api("EE103050067", "x"), { emta: emta(emtaAnswerHtml([LIMITED_ROW])) });
    expect(adoptedCompany(a)?.key).toBe(key);
    // A new connection is not recorded and the damaged file is left as it is.
    const b = fp("b");
    await ensureCompanyIdentity(b, SERVER, api("EE103050067", "x"), { emta: emta(emtaAnswerHtml([LIMITED_ROW])) });
    expect(readFileSync(path, "utf8")).toBe("{ damaged");
    expect(adoptedCompany(b)).toBeUndefined();
    expect(unresolvedCompanyReason(b)).toBe("company_identity_file_unreadable");
  });

  it("never sends a request with network: false, but still adopts the mapping", async () => {
    const a = fp("a");
    const calls: string[] = [];
    await ensureCompanyIdentity(a, SERVER, api("EE103050067", "x", calls), { network: false });
    expect(calls).toEqual([]);
    expect(adoptedCompany(a)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Company store: migration and record stamps
// ---------------------------------------------------------------------------

function useConnection(fingerprint: string, company?: AccountingRulesCompany, connectionCount = 1): void {
  initAccountingRulesConnection(() => ({ name: "acme", stableIdentity: fingerprint, connectionCount, ...(company ? { company } : {}) }));
  resetAccountingRulesCache();
  limitedVatStore.reset();
}

function fingerprintDir(fingerprint: string): string {
  return join(config, "accounting-rules", scopeOf(fingerprint));
}

function age(path: string, secondsAgo: number): void {
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, when, when);
}

describe("company-keyed rules store", () => {
  const key = companyKeyOf(SERVER, "14417608");

  it("copies the single per-key store into the company store and keeps the original", () => {
    const old = fp("old");
    useConnection(old);
    saveAnnualReportAccountRule({ rule_type: "cash_flow_category", account_id: 2410, value: "financing" });
    expect(getAccountingRulesPath()).toBe(fingerprintDir(old));

    useConnection(old, { key, fingerprints: [old] });
    expect(getAccountingRulesPath()).toBe(companyBundleDir(config, key));
    expect(getCashFlowCategoryRule(2410)).toBe("financing");
    expect(existsSync(join(fingerprintDir(old), "annual-report", "cash-flow-category.md"))).toBe(true);
    expect(describeAccountingRuleScope()).toEqual({ rule_scope: "this_company" });
  });

  it("after a key rotation copies the most recently modified per-key store, reports the other, merges nothing", () => {
    const k1 = fp("k1");
    const k2 = fp("k2");
    useConnection(k1);
    saveAnnualReportAccountRule({ rule_type: "cash_flow_category", account_id: 2410, value: "financing" });
    useConnection(k2);
    saveAnnualReportAccountRule({ rule_type: "cash_flow_category", account_id: 2420, value: "operating" });
    const ageAll = (dir: string, seconds: number) => {
      for (const rel of ["", "annual-report", "annual-report/cash-flow-category.md", "index.md", "log.md"]) {
        if (existsSync(join(dir, rel))) age(join(dir, rel), seconds);
      }
    };
    ageAll(fingerprintDir(k1), 10);
    ageAll(fingerprintDir(k2), 1000);

    const k3 = fp("k3");
    useConnection(k3, { key, fingerprints: [k1, k2, k3] });
    expect(getCashFlowCategoryRule(2410)).toBe("financing");
    expect(getCashFlowCategoryRule(2420)).toBeUndefined();
    expect(describeAccountingRuleScope().storage_notice).toContain(scopeOf(k2));
    expect(readFileSync(join(fingerprintDir(k2), "annual-report", "cash-flow-category.md"), "utf8")).toContain("2420");
  });

  it("reports a per-key store that is not the company store's source, without merging it", () => {
    const k1 = fp("k1");
    useConnection(k1);
    saveAnnualReportAccountRule({ rule_type: "cash_flow_category", account_id: 2410, value: "financing" });
    useConnection(k1, { key, fingerprints: [k1] });
    expect(getCashFlowCategoryRule(2410)).toBe("financing");

    const k2 = fp("k2");
    useConnection(k2);
    saveAnnualReportAccountRule({ rule_type: "cash_flow_category", account_id: 2420, value: "operating" });
    resetCompanyBundleMigrationState(); // a later process
    useConnection(k2, { key, fingerprints: [k1, k2] });
    expect(getCashFlowCategoryRule(2420)).toBeUndefined();
    expect(getCashFlowCategoryRule(2410)).toBe("financing");
    expect(describeAccountingRuleScope().storage_notice).toContain(scopeOf(k2));
    expect(describeAccountingRuleScope().storage_notice).not.toContain(scopeOf(k1));
  });

  it("leaves released versions on their per-key store next to a company store (no shared root bundle)", () => {
    const old = fp("old");
    useConnection(old);
    saveAnnualReportAccountRule({ rule_type: "cash_flow_category", account_id: 2410, value: "financing" });
    useConnection(old, { key, fingerprints: [old] });
    expect(getCashFlowCategoryRule(2410)).toBe("financing");
    const companyDir = companyBundleDir(config, key);
    expect(existsSync(companyDir)).toBe(true);
    // Leftovers of an interrupted company write or migration, as this version names them.
    writeFileSync(`${companyDir}.lock`, "123:token\n");
    mkdirSync(`${companyDir}.migrating`);
    const project = join(config, "project");
    mkdirSync(project);
    expect(releasedChooseDefaultBundleStorage(project, config, "acme", old).dir).toBe(fingerprintDir(old));
    expect(releasedChooseDefaultBundleStorage(project, config, "acme", fp("other")).dir).toBe(fingerprintDir(fp("other")));
    expect(JSON.parse(readFileSync(join(companyDir, "migration.json"), "utf8"))).toMatchObject({ kind: "company", company_key: key, source_scope: scopeOf(old) });
  });

  it("reports a per-key source store changed after it was copied", () => {
    const old = fp("old");
    useConnection(old);
    saveAnnualReportAccountRule({ rule_type: "cash_flow_category", account_id: 2410, value: "financing" });
    useConnection(old, { key, fingerprints: [old] });
    expect(describeAccountingRuleScope().storage_notice).toBeUndefined();
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(fingerprintDir(old), "annual-report", "cash-flow-category.md"), later, later);
    resetCompanyBundleMigrationState(); // a later process
    useConnection(old, { key, fingerprints: [old] });
    expect(describeAccountingRuleScope().storage_notice).toContain(`${fingerprintDir(old)} was changed after it was copied`);
  });

  it("finishes a migration interrupted after the copy was put in place, and redoes one interrupted before", () => {
    const k1 = fp("k1");
    mkdirSync(join(config, scopeOf(k1)), { recursive: true });
    const legacy = "# Accounting Rules\n\n## Cash Flow Category\n| account_id | category |\n| --- | --- |\n| 2410 | investing |\n";
    writeFileSync(join(config, scopeOf(k1), "accounting-rules.md"), legacy);
    useConnection(k1, { key, fingerprints: [k1] });
    expect(getCashFlowCategoryRule(2410)).toBe("investing");
    const companyDir = companyBundleDir(config, key);
    const companyLegacy = join(config, key, "accounting-rules.md");
    expect(readFileSync(companyLegacy, "utf8")).toBe(legacy);
    expect(existsSync(join(companyDir, "legacy-accounting-rules.pending"))).toBe(false);

    // Crash after the rename, before the legacy file was moved out.
    renameSync(companyLegacy, join(companyDir, "legacy-accounting-rules.pending"));
    resetCompanyBundleMigrationState();
    useConnection(k1, { key, fingerprints: [k1] });
    expect(getCashFlowCategoryRule(2410)).toBe("investing");
    expect(readFileSync(companyLegacy, "utf8")).toBe(legacy);

    // Crash before the rename: only the staging dir exists; the copy is redone.
    rmSync(companyDir, { recursive: true });
    rmSync(join(config, key), { recursive: true });
    mkdirSync(`${companyDir}.migrating`);
    writeFileSync(join(`${companyDir}.migrating`, "partial.md"), "partial");
    resetCompanyBundleMigrationState();
    useConnection(k1, { key, fingerprints: [k1] });
    expect(getCashFlowCategoryRule(2410)).toBe("investing");
    expect(existsSync(join(companyDir, "partial.md"))).toBe(false);
    expect(existsSync(`${companyDir}.migrating`)).toBe(false);
  });

  it("keeps an unresolved connection on its per-key store next to company stores", () => {
    const k1 = fp("k1");
    useConnection(k1, { key, fingerprints: [k1] });
    saveAnnualReportAccountRule({ rule_type: "cash_flow_category", account_id: 2410, value: "financing" });
    expect(existsSync(companyBundleDir(config, key))).toBe(true);
    const other = fp("other");
    useConnection(other);
    expect(getAccountingRulesPath()).toBe(fingerprintDir(other));
    expect(getCashFlowCategoryRule(2410)).toBeUndefined();
  });

  it("migrates a per-key legacy accounting-rules.md too", () => {
    const k1 = fp("k1");
    mkdirSync(join(config, scopeOf(k1)), { recursive: true });
    writeFileSync(join(config, scopeOf(k1), "accounting-rules.md"),
      "# Accounting Rules\n\n## Cash Flow Category\n| account_id | category |\n| --- | --- |\n| 2410 | investing |\n");
    useConnection(k1, { key, fingerprints: [k1] });
    expect(getCashFlowCategoryRule(2410)).toBe("investing");
    expect(existsSync(join(config, scopeOf(k1), "accounting-rules.md"))).toBe(true);
  });
});

describe("record stamps follow the company", () => {
  const key = companyKeyOf(SERVER, "14417608");
  const status = (value: string) => ({ kind: "status", key: "company_vat_status", status: value, effective_from: "2026-01-01", set_at: "2026-01-02T00:00:00.000Z", vat_number: null }) as unknown as LimitedVatStoreRecord;

  it("accepts records written under an earlier key of the same company and stamps new ones with the company", () => {
    const shared = mkdtempSync(join(tmpdir(), "shared-rules-"));
    process.env.EARVELDAJA_RULES_DIR = shared;
    const old = fp("old");
    useConnection(old, undefined, 2);
    limitedVatStore.upsert([status("limited")]);

    const fresh = fp("new");
    useConnection(fresh, { key, fingerprints: [old, fresh] }, 2);
    expect(limitedVatStore.read()).toEqual([status("limited")]);
    limitedVatStore.upsert([status("full")]);
    const raw = JSON.parse(readFileSync(resolve(shared, "limited-vat.json"), "utf8")) as Array<{ connectionIdentity: string }>;
    expect(raw.map(r => r.connectionIdentity)).toEqual([companyRecordStamp(key)]);

    // Another company on the same shared store sees none of them.
    const other = fp("other");
    useConnection(other, { key: companyKeyOf(SERVER, "10234957"), fingerprints: [other] }, 2);
    expect(limitedVatStore.read()).toEqual([]);
    // Nor does an unresolved connection.
    useConnection(fp("unresolved"), undefined, 2);
    expect(limitedVatStore.read()).toEqual([]);
  });
});

describe("server wiring", () => {
  it("resolves the company at the first tool call and saves rules into the company store", async () => {
    const { createMcpServer } = await import("./server/create-server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const paths = await import("./paths.js");
    vi.spyOn(paths, "getProjectRoot").mockReturnValue(join(config, "project"));
    const emtaFake = fakeEmtaFetch(emtaAnswerHtml([LIMITED_ROW]));
    vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("apps.emta.ee")) return emtaFake.impl(url, init as never);
      const path = new URL(url).pathname;
      const body = path === "/v1/vat_info" ? { vat_number: "EE103050067" } : path === "/v1/invoice_info" ? { invoice_company_name: "Näidis OÜ" } : {};
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof fetch);
    const configs = [{ name: "acme", config: { apiKeyId: "id", apiPublicValue: "pub", apiPassword: "pw", baseUrl: SERVER } }];
    const bootstrap = await createMcpServer({ configs, toolProfile: "standard", connect: false });
    const client = new Client({ name: "company-identity-test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), bootstrap.server.connect(st)]);
    try {
      const saved = await client.callTool({ name: "save_auto_booking_rule", arguments: { match: "Zone Media", purchase_accounts_id: 5230 } });
      expect(saved.isError).not.toBe(true);
      const text = (saved.content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain(join("accounting-rules", key14417608()));
      expect(text).toContain("this_company");
      expect(Object.values(readCompanyIdentityMapping())).toEqual([expect.objectContaining({ registry_code: "14417608", source: "emta_kmkr" })]);
    } finally {
      await Promise.allSettled([client.close(), bootstrap.server.close()]);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});

function key14417608(): string {
  return companyKeyOf(SERVER, "14417608");
}
