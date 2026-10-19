import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./create-server.js";
import { fakeEarveldaja, resetApiCaches } from "../__fixtures__/nondeductible-vat.js";
import { TOOL_SURFACE_SETUP_INFO } from "../__fixtures__/tool-surface.js";
import { parseMcpResponse } from "../mcp-json.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { registerPdfWorkflowTools } from "../tools/pdf-workflow.js";
import { registerPurchaseInvoiceTools } from "../tools/crud/purchase-invoices.js";
import { issuePurchaseInvoiceConfirmPlan } from "../purchase-invoice-confirm-plan.js";
import { readingApi } from "../__fixtures__/document-reading/verified-draft.js";

vi.mock("../audit-log.js", async importOriginal => ({ ...await importOriginal<typeof import("../audit-log.js")>(), logAudit: vi.fn() }));

const dirs: string[] = [];
beforeEach(resetApiCaches);
afterEach(() => {
  vi.unstubAllGlobals();
  dirs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }));
});
const payload = (response: any): any => parseMcpResponse(response.content[0].text);
function sourceArgs(number = "PDF-REVIEW-1") {
  const dir = mkdtempSync(join(tmpdir(), "pdf-confirm-plan-"));
  dirs.push(dir);
  const file = join(dir, "invoice.pdf");
  const bytes = "%PDF-1.4 synthetic";
  writeFileSync(file, bytes);
  return { supplier_client_id: 42, invoice_number: number, invoice_date: "2026-03-15", journal_date: "2026-03-15", term_days: 0,
    items: [{ custom_title: "Service", cl_purchase_articles_id: 45, purchase_accounts_id: 6000, total_net_price: 100, amount: 1,
      cl_vat_articles_id: 11, vat_rate_dropdown: "-" }], vat_price: 0, gross_price: 100,
    file_path: file, source_sha256: createHash("sha256").update(bytes).digest("hex"), require_confirm_plan: true };
}
async function connect(profile: "standard" | "custom", verifiedCompanyName: string | null = "Synthetic Review") {
  const bootstrap = await createMcpServer({
    configs: [{ name: "synthetic", ...(verifiedCompanyName === null ? {} : { verifiedCompanyName }), config: {
      apiKeyId: "synthetic-id", apiPublicValue: "synthetic-public", apiPassword: "synthetic-secret", baseUrl: "https://demo-rmp-api.rik.ee/v1",
    } }], toolProfile: profile, connect: false, setupInfo: TOOL_SURFACE_SETUP_INFO,
  });
  const client = new Client({ name: "pdf-confirm-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), bootstrap.server.connect(st)]);
  return { client, close: () => Promise.allSettled([client.close(), bootstrap.server.close()]) };
}
function fetchAdapter(fake: ReturnType<typeof fakeEarveldaja>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    let data: unknown;
    if (method === "GET" && path === "/invoice_info") data = { invoice_company_name: "Synthetic Review" };
    else if (method === "GET" && path === "/clients/42") data = { id: 42, name: "Synthetic Supplier" };
    else if (method === "GET" && path === "/journals") data = { items: [], current_page: 1, total_pages: 1 };
    else if (method === "GET") data = await fake.get(path);
    else if (method === "POST") data = await fake.post(path, body);
    else if (method === "PATCH") data = await fake.patch(path, body);
    else if (method === "PUT" && /^\/purchase_invoices\/\d+\/document_user$/.test(path)) data = await fake.client.request(path, { method, body });
    else throw new Error(`Unexpected synthetic fetch ${method} ${path}`);
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("actual public PDF create → reviewed confirm registration", () => {
  it("permits only audit identity metadata before invalid-handle denial on an unverified connection", async () => {
    const fake = fakeEarveldaja();
    const fetchMock = fetchAdapter(fake);
    vi.stubGlobal("fetch", fetchMock);
    const server = await connect("standard", null);
    const urls = () => fetchMock.mock.calls.map(([url, init]) => ({ method: init?.method ?? "GET", path: new URL(String(url)).pathname }));
    try {
      const invalid = await server.client.callTool({ name: "confirm_purchase_invoice", arguments: { id: 123, plan_handle: "a".repeat(43) } });
      expect(invalid.isError).toBe(true);
      expect(urls()).toEqual([{ method: "GET", path: "/v1/invoice_info" }]);
      expect(fake.state.calls).toHaveLength(0);
      expect(fake.writes()).toHaveLength(0);

      const created = payload(await server.client.callTool({ name: "create_purchase_invoice_from_pdf", arguments: sourceArgs("UNVERIFIED-PLAN") }));
      expect(created).toMatchObject({ confirmation_status: "ready_for_review" });
      fetchMock.mockClear();
      fake.state.calls.length = 0;
      const handle = created.confirm_plan.plan_handle;
      expect((await server.client.callTool({ name: "confirm_purchase_invoice", arguments: { id: created.created_invoice_id + 1, plan_handle: handle } })).isError).toBe(true);
      expect((await server.client.callTool({ name: "confirm_purchase_invoice", arguments: { id: created.created_invoice_id, plan_handle: handle } })).isError).toBe(true);
      expect(urls()).toEqual([]);
      expect(fake.state.calls).toHaveLength(0);
      expect(fake.writes()).toHaveLength(0);
    } finally { await server.close(); }
  });
  it.each(["standard", "custom"] as const)("forwards one runtime through %s PDF and CRUD registration", async profile => {
    const fake = fakeEarveldaja();
    vi.stubGlobal("fetch", fetchAdapter(fake));
    const first = await connect(profile);
    const second = await connect(profile);
    try {
      const created = payload(await first.client.callTool({ name: "create_purchase_invoice_from_pdf", arguments: sourceArgs() }));
      expect(created, JSON.stringify(created)).toMatchObject({ confirmation_status: "ready_for_review", draft_readback_verified: true });
      const args = { id: created.created_invoice_id, plan_handle: created.confirm_plan.plan_handle };
      const foreign = await second.client.callTool({ name: "confirm_purchase_invoice", arguments: args });
      expect(foreign.isError).toBe(true);
      expect(fake.registers()).toHaveLength(0);
      const confirmed = await first.client.callTool({ name: "confirm_purchase_invoice", arguments: args });
      expect(confirmed.isError, JSON.stringify(payload(confirmed))).not.toBe(true);
      expect(fake.registers()).toHaveLength(1);
      expect((await first.client.callTool({ name: "confirm_purchase_invoice", arguments: args })).isError).toBe(true);
      expect(fake.registers()).toHaveLength(1);

      const another = payload(await first.client.callTool({ name: "create_purchase_invoice_from_pdf", arguments: sourceArgs("PDF-REVIEW-2") }));
      fake.state.invoices.get(another.created_invoice_id)!.notes = "external drift";
      const drift = await first.client.callTool({ name: "confirm_purchase_invoice", arguments: {
        id: another.created_invoice_id, plan_handle: another.confirm_plan.plan_handle,
      } });
      expect(drift.isError).toBe(true);
      expect(payload(drift)).toMatchObject({ category: "draft_changed" });
      expect(fake.registers()).toHaveLength(1);
    } finally { await Promise.all([first.close(), second.close()]); }
  });
});

function directWorld(runtime = createTestRuntimeSafetyContext()) {
  const fake = fakeEarveldaja();
  const api = readingApi({ withHistory: false });
  Object.assign(api, { purchaseInvoices: fake.purchaseInvoices, readonly: fake.readonly });
  const server = { registerTool: vi.fn() };
  registerPdfWorkflowTools(server as never, api, runtime);
  registerPurchaseInvoiceTools(server as never, api, runtime);
  const handler = (name: string) => server.registerTool.mock.calls.find(([key]) => key === name)![2] as (args: any) => Promise<any>;
  return { fake, api, handler, runtime };
}

describe("PDF plan failure ownership and consume guards", () => {
  it.each(["read-error", "mismatch", "capacity"])("retains the created/uploaded draft on %s", async mode => {
    const runtime = createTestRuntimeSafetyContext({ planStore: { maxActive: 1 } });
    const w = directWorld(runtime);
    if (mode === "capacity") {
      const id = w.fake.seed({ number: "existing" }, []);
      issuePurchaseInvoiceConfirmPlan(runtime, w.fake.state.invoices.get(id) as any);
    }
    if (mode === "read-error") {
      const upload = w.fake.purchaseInvoices.uploadDocument.bind(w.fake.purchaseInvoices);
      vi.spyOn(w.fake.purchaseInvoices, "uploadDocument").mockImplementation(async (...args) => {
        const result = await upload(...args);
        vi.spyOn(w.fake.purchaseInvoices, "get").mockRejectedValue(new Error("unavailable"));
        return result;
      });
    }
    if (mode === "mismatch") {
      const original = w.fake.purchaseInvoices.get.bind(w.fake.purchaseInvoices);
      vi.spyOn(w.fake.purchaseInvoices, "get").mockImplementation(async id => ({ ...await original(id), notes: "unexpected" }));
    }
    const result = payload(await w.handler("create_purchase_invoice_from_pdf")(sourceArgs()));
    expect(result, JSON.stringify(result)).toMatchObject({ confirmation_status: "held", mutation_occurred: true,
      automatic_retry_forbidden: true, document_uploaded: true });
    expect(result.created_invoice_id).toBeTypeOf("number");
    expect(result.confirm_plan).toBeUndefined();
    expect(w.fake.state.invoices.has(result.created_invoice_id)).toBe(true);
    expect(w.fake.posts()).toHaveLength(1);
    expect(w.fake.invalidations()).toHaveLength(0);
    expect(w.fake.registers()).toHaveLength(0);
  });
  it.each([
    { connectionIndex: 1 }, { connectionGeneration: 1 }, { connectionFingerprint: "new-credentials" },
    { baseUrl: "https://rmp-api.rik.ee/v1" }, { profile: "full" as const }, { features: { enableSales: false } },
  ])("burns scope drift %j without any API call", async scope => {
    const w = directWorld();
    const id = w.fake.seed({ number: "scope" }, []);
    const handle = issuePurchaseInvoiceConfirmPlan(w.runtime, w.fake.state.invoices.get(id) as any);
    w.runtime.setScope(scope);
    expect((await w.handler("confirm_purchase_invoice")({ id, plan_handle: handle })).isError).toBe(true);
    expect(w.fake.state.calls).toHaveLength(0);
  });
  it("rejects expired and wrong-domain handles before API calls", async () => {
    const w = directWorld();
    const id = w.fake.seed({ number: "expiry" }, []);
    const expired = issuePurchaseInvoiceConfirmPlan(w.runtime, w.fake.state.invoices.get(id) as any);
    w.runtime.advanceTime(600_001);
    expect((await w.handler("confirm_purchase_invoice")({ id, plan_handle: expired })).isError).toBe(true);
    const foreign = w.runtime.planStore.issue("different_domain", { normalizedArgs: {}, sourceIdentities: [], liveSnapshot: null,
      commands: [], counts: {}, totals: {}, exclusions: [], reviews: [], privatePayload: null });
    expect((await w.handler("confirm_purchase_invoice")({ id, plan_handle: foreign })).isError).toBe(true);
    expect(w.fake.state.calls).toHaveLength(0);
  });
  it("does not resurrect a handle after a register result is unknown", async () => {
    const w = directWorld();
    const id = w.fake.seed({ number: "unknown", vat_price: 0, gross_price: 0 }, []);
    const handle = issuePurchaseInvoiceConfirmPlan(w.runtime, w.fake.state.invoices.get(id) as any);
    w.fake.patch.mockRejectedValueOnce(new Error("register network result unknown"));
    await expect(w.handler("confirm_purchase_invoice")({ id, plan_handle: handle })).rejects.toThrow();
    expect((await w.handler("confirm_purchase_invoice")({ id, plan_handle: handle })).isError).toBe(true);
    expect(w.fake.patch).toHaveBeenCalledTimes(1);
  });
  it("refuses missing runtime before any API access", async () => {
    const server = { registerTool: vi.fn() };
    registerPdfWorkflowTools(server as never, {} as never);
    const handler = server.registerTool.mock.calls.find(([name]) => name === "create_purchase_invoice_from_pdf")![2] as any;
    expect(payload(await handler(sourceArgs()))).toMatchObject({ category: "runtime_safety_context_required", mutation_occurred: false });
  });
  it.each(["wrong-id", "correction", "approved-correction"])("burns %s plan before API reads", async mode => {
    const w = directWorld();
    const id = w.fake.seed({ number: "X" }, []);
    const handle = issuePurchaseInvoiceConfirmPlan(w.runtime, w.fake.state.invoices.get(id) as any);
    const response = await w.handler("confirm_purchase_invoice")({ id: mode === "wrong-id" ? id + 1 : id, plan_handle: handle,
      ...(mode === "correction" ? { recalculate_totals: true } : {}), ...(mode === "approved-correction" ? { approved_correction: {} } : {}) });
    expect(response.isError).toBe(true);
    expect(w.fake.state.calls).toHaveLength(0);
    expect(() => w.runtime.planStore.consume(handle, "purchase_invoice_pdf_confirm")).toThrow();
  });
});
