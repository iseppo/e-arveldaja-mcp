import { describe, expect, it, vi } from "vitest";
import { createSaleInvoiceOperations } from "./invoice-operations.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import type { ApiContext } from "../tools/crud/shared.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

function makeApi(
  saleInvoices: Record<string, unknown> = {},
  readonlyApi: Record<string, unknown> = {},
  clientsApi: Record<string, unknown> = {},
): ApiContext {
  return {
    saleInvoices: {
      list: vi.fn().mockResolvedValue({ current_page: 1, total_pages: 1, items: [] }),
      get: vi.fn().mockResolvedValue({ id: 1, status: "PROJECT" }),
      create: vi.fn().mockResolvedValue({ created_object_id: 500 }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      confirm: vi.fn().mockResolvedValue({}),
      invalidate: vi.fn().mockResolvedValue({}),
      sendEinvoice: vi.fn().mockResolvedValue({ delivered: true }),
      getSystemPdf: vi.fn().mockResolvedValue({ name: "inv.pdf", contents: "AAA" }),
      getSystemXml: vi.fn().mockResolvedValue({ name: "inv.xml", contents: "BBB" }),
      getDeliveryOptions: vi.fn().mockResolvedValue({ options: ["einvoice"] }),
      ...saleInvoices,
    },
    readonly: {
      getAccounts: vi.fn().mockResolvedValue([]),
      getAccountDimensions: vi.fn().mockResolvedValue([]),
      getVatInfo: vi.fn().mockResolvedValue({}),
      getInvoiceInfo: vi.fn().mockResolvedValue({}),
      ...readonlyApi,
    },
    clients: {
      listAll: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ created_object_id: 42 }),
      get: vi.fn().mockResolvedValue({ id: 42, name: "New Buyer OÜ" }),
      ...clientsApi,
    },
  } as unknown as ApiContext;
}

describe("SaleInvoiceOperations read mode", () => {
  it("lists when no id, gets when id present", async () => {
    const api = makeApi();
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const listed = await ops.run({ mode: "read" });
    expect(listed.ok && listed.value.action).toBe("list");
    const got = await ops.run({ mode: "read", id: 7 });
    expect(got.ok && got.value.action).toBe("get");
    expect(api.saleInvoices.get).toHaveBeenCalledWith(7);
  });
});

describe("SaleInvoiceOperations plan-handle two-call gate", () => {
  it("execute without a plan_handle is refused before any API call (send)", async () => {
    const send = vi.fn();
    const api = makeApi({ sendEinvoice: send });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const outcome = await ops.run({ mode: "execute", action: "send", id: 9, planHandle: undefined });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_handle_required");
    expect(send).not.toHaveBeenCalled();
  });

  it("send runs only through prepare -> execute (real e-invoice never one-shot)", async () => {
    const send = vi.fn().mockResolvedValue({ delivered: true });
    const api = makeApi({ sendEinvoice: send });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createSaleInvoiceOperations(api, runtime);
    const prepared = await ops.run({ mode: "prepare", action: "send", id: 9 });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || prepared.value.mode !== "prepare") return;
    expect(prepared.value.projection.destructive).toBe(true);
    const executed = await ops.run({ mode: "execute", action: "send", id: 9, planHandle: prepared.value.planHandle, payload: { send_einvoice: true } });
    expect(executed.ok).toBe(true);
    expect(send).toHaveBeenCalledWith(9, expect.objectContaining({ send_einvoice: true }));
  });

  it("a plan_handle is consume-once — replaying it fails the second execute", async () => {
    const del = vi.fn().mockResolvedValue({});
    const api = makeApi({ delete: del });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createSaleInvoiceOperations(api, runtime);
    const prepared = await ops.run({ mode: "prepare", action: "delete", id: 3 });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const handle = prepared.value.planHandle;
    const first = await ops.run({ mode: "execute", action: "delete", id: 3, planHandle: handle });
    expect(first.ok).toBe(true);
    const second = await ops.run({ mode: "execute", action: "delete", id: 3, planHandle: handle });
    expect(second.ok).toBe(false);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("rejects execute action drift — a confirm plan cannot authorize a send (plan_drift, no send fired)", async () => {
    const send = vi.fn().mockResolvedValue({ delivered: true });
    const confirm = vi.fn().mockResolvedValue({});
    const api = makeApi({ sendEinvoice: send, confirm });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createSaleInvoiceOperations(api, runtime);
    const prepared = await ops.run({ mode: "prepare", action: "confirm", id: 5 });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const outcome = await ops.run({ mode: "execute", action: "send", id: 99, planHandle: prepared.value.planHandle, payload: { send_einvoice: true } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_drift");
    expect(send).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("rejects execute id drift — a confirm id=5 plan cannot authorize delete id=7 (plan_drift, no delete fired)", async () => {
    const del = vi.fn().mockResolvedValue({});
    const confirm = vi.fn().mockResolvedValue({});
    const api = makeApi({ delete: del, confirm });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createSaleInvoiceOperations(api, runtime);
    const prepared = await ops.run({ mode: "prepare", action: "confirm", id: 5 });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const outcome = await ops.run({ mode: "execute", action: "delete", id: 7, planHandle: prepared.value.planHandle });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_drift");
    expect(del).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("matching prepare -> execute (confirm id=5) still succeeds", async () => {
    const confirm = vi.fn().mockResolvedValue({});
    const api = makeApi({ confirm });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createSaleInvoiceOperations(api, runtime);
    const prepared = await ops.run({ mode: "prepare", action: "confirm", id: 5 });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const outcome = await ops.run({ mode: "execute", action: "confirm", id: 5, planHandle: prepared.value.planHandle });
    expect(outcome.ok).toBe(true);
    expect(confirm).toHaveBeenCalledWith(5);
  });

  it("recurring: prepare returns the dry-run preview + a plan handle without cloning", async () => {
    const source = { id: 1, status: "CONFIRMED", create_date: "2026-01-15", number: "SI-1", client_name: "Acme OU",
      sale_invoice_type: "INVOICE", number_prefix: "ARV", items: [{ products_id: 9, custom_title: "svc", amount: 1, unit_net_price: 100, total_net_price: 100 }] };
    const create = vi.fn().mockResolvedValue({ created_object_id: 900 });
    const listAll = vi.fn().mockResolvedValue([source]);
    const get = vi.fn().mockResolvedValue(source);
    const api = makeApi({ listAll, get, create });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const prepared = await ops.run({ mode: "prepare", action: "recurring", payload: { source_month: "2026-01", target_date: "2026-02-01", target_journal_date: "2026-02-01" } });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    expect(typeof prepared.value.planHandle).toBe("string");
    expect(prepared.value.projection.mode).toBe("DRY_RUN");
    expect(create).not.toHaveBeenCalled();
  });

  it("recurring: execute with the handle runs the real clone (dryRun=false), invoices created", async () => {
    const source = { id: 1, status: "CONFIRMED", create_date: "2026-01-15", number: "SI-1", client_name: "Acme OU",
      sale_invoice_type: "INVOICE", number_prefix: "ARV", items: [{ products_id: 9, custom_title: "svc", amount: 1, unit_net_price: 100, total_net_price: 100 }] };
    const create = vi.fn().mockResolvedValue({ created_object_id: 900 });
    const api = makeApi({ listAll: vi.fn().mockResolvedValue([source]), get: vi.fn().mockResolvedValue(source), create });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createSaleInvoiceOperations(api, runtime);
    const params = { source_month: "2026-01", target_date: "2026-02-01", target_journal_date: "2026-02-01" };
    const prepared = await ops.run({ mode: "prepare", action: "recurring", payload: params });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const executed = await ops.run({ mode: "execute", action: "recurring", planHandle: prepared.value.planHandle, payload: params });
    expect(executed.ok).toBe(true);
    if (!executed.ok || executed.value.mode !== "execute") throw new Error("execute failed");
    expect((executed.value.result as Record<string, unknown>).created).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("recurring: execute with DIFFERENT params than reviewed → plan_drift, no clone", async () => {
    const source = { id: 1, status: "CONFIRMED", create_date: "2026-01-15", number: "SI-1", client_name: "Acme OU",
      sale_invoice_type: "INVOICE", number_prefix: "ARV", items: [{ products_id: 9, custom_title: "svc", amount: 1, unit_net_price: 100, total_net_price: 100 }] };
    const create = vi.fn().mockResolvedValue({ created_object_id: 900 });
    const api = makeApi({ listAll: vi.fn().mockResolvedValue([source]), get: vi.fn().mockResolvedValue(source), create });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createSaleInvoiceOperations(api, runtime);
    const prepared = await ops.run({ mode: "prepare", action: "recurring", payload: { source_month: "2026-01", target_date: "2026-02-01", target_journal_date: "2026-02-01" } });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const outcome = await ops.run({ mode: "execute", action: "recurring", planHandle: prepared.value.planHandle, payload: { source_month: "2026-01", target_date: "2026-03-01", target_journal_date: "2026-03-01" } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_drift");
    expect(create).not.toHaveBeenCalled();
  });

  it("recurring: execute without a plan_handle is refused before any clone", async () => {
    const create = vi.fn();
    const api = makeApi({ listAll: vi.fn().mockResolvedValue([]), create });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const outcome = await ops.run({ mode: "execute", action: "recurring", planHandle: undefined, payload: { source_month: "2026-01", target_date: "2026-02-01", target_journal_date: "2026-02-01" } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_handle_required");
    expect(create).not.toHaveBeenCalled();
  });

  it("create with an existing-matching client resolves to its id — invoice created, NO new client", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 500 });
    const clientCreate = vi.fn();
    const api = makeApi(
      { create },
      {},
      { listAll: vi.fn().mockResolvedValue([{ id: 42, name: "Acme OÜ", code: "17133416", is_deleted: false }]), create: clientCreate },
    );
    const runtime = createTestRuntimeSafetyContext();
    const ops = createSaleInvoiceOperations(api, runtime);
    const prepared = await ops.run({ mode: "prepare", action: "create", payload: { client: { name: "Acme OÜ", reg_code: "17133416" }, items: [] } });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const executed = await ops.run({ mode: "execute", action: "create", planHandle: prepared.value.planHandle, payload: { client: { name: "Acme OÜ", reg_code: "17133416" }, items: [] } });
    expect(executed.ok).toBe(true);
    expect(clientCreate).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const sent = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.clients_id).toBe(42);
    expect(sent.client).toBeUndefined();
  });

  it("create with a brand-NEW client creates the client, then the invoice against the new id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => "0" }, text: () => Promise.resolve("") });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const create = vi.fn().mockResolvedValue({ created_object_id: 500 });
      const clientCreate = vi.fn().mockResolvedValue({ created_object_id: 77 });
      const clientGet = vi.fn().mockResolvedValue({ id: 77, name: "New Buyer OÜ" });
      const api = makeApi(
        { create },
        {},
        { listAll: vi.fn().mockResolvedValue([]), create: clientCreate, get: clientGet },
      );
      const runtime = createTestRuntimeSafetyContext();
      const ops = createSaleInvoiceOperations(api, runtime);
      const payload = { client: { name: "New Buyer OÜ", reg_code: "17133416", country: "EST" }, items: [] };
      const prepared = await ops.run({ mode: "prepare", action: "create", payload });
      if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
      const executed = await ops.run({ mode: "execute", action: "create", planHandle: prepared.value.planHandle, payload });
      expect(executed.ok).toBe(true);
      expect(clientCreate).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      const sent = create.mock.calls[0]![0] as Record<string, unknown>;
      expect(sent.clients_id).toBe(77);
      // A sales-created customer must be persisted as a CLIENT (not supplier-only)
      // so it shows up in customer lists.
      const persistedClient = clientCreate.mock.calls[0]![0] as Record<string, unknown>;
      expect(persistedClient.is_client).toBe(true);
      expect(persistedClient.is_supplier).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("P17: an H13 strong-identifier conflict creates NEITHER client NOR invoice", async () => {
    const create = vi.fn();
    const clientCreate = vi.fn();
    const api = makeApi(
      { create },
      {},
      { listAll: vi.fn().mockResolvedValue([{ id: 50, name: "Twin OÜ", code: "10000000", is_deleted: false }]), create: clientCreate },
    );
    const runtime = createTestRuntimeSafetyContext();
    const ops = createSaleInvoiceOperations(api, runtime);
    const payload = { client: { name: "Twin OÜ", reg_code: "17133416" }, items: [] };
    const prepared = await ops.run({ mode: "prepare", action: "create", payload });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const executed = await ops.run({ mode: "execute", action: "create", planHandle: prepared.value.planHandle, payload });
    expect(executed.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(clientCreate).not.toHaveBeenCalled();
  });

  it("create with neither clients_id nor client.name is a validation error", async () => {
    const create = vi.fn();
    const api = makeApi({ create });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createSaleInvoiceOperations(api, runtime);
    const prepared = await ops.run({ mode: "prepare", action: "create", payload: { items: [] } });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const executed = await ops.run({ mode: "execute", action: "create", planHandle: prepared.value.planHandle, payload: { items: [] } });
    expect(executed.ok).toBe(false);
    if (executed.ok) return;
    expect(executed.error.code).toBe("client_required");
    expect(create).not.toHaveBeenCalled();
  });

  it("prepare with a new-customer client resolves read-only — projection shows would_create, no client persisted", async () => {
    const clientCreate = vi.fn();
    const api = makeApi({}, {}, { listAll: vi.fn().mockResolvedValue([]), create: clientCreate });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createSaleInvoiceOperations(api, runtime);
    const prepared = await ops.run({ mode: "prepare", action: "create", payload: { client: { name: "Brand New Buyer OÜ" }, items: [] } });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    expect(prepared.value.projection.client_resolution).toBe("would_create");
    expect(String(prepared.value.projection.client_name)).toContain("Brand New Buyer");
    expect(clientCreate).not.toHaveBeenCalled();
  });

  it("create with an explicit clients_id is unchanged — no client resolution, no clients.listAll", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 500 });
    const listAll = vi.fn().mockResolvedValue([]);
    const api = makeApi({ create }, {}, { listAll });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createSaleInvoiceOperations(api, runtime);
    const prepared = await ops.run({ mode: "prepare", action: "create", payload: { clients_id: 9, items: [] } });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const executed = await ops.run({ mode: "execute", action: "create", planHandle: prepared.value.planHandle, payload: { clients_id: 9, items: [] } });
    expect(executed.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0]![0] as Record<string, unknown>).clients_id).toBe(9);
    expect(listAll).not.toHaveBeenCalled();
  });

  it("update strips sandbox markers at the write boundary and blocks confirmed edits", async () => {
    const update = vi.fn().mockResolvedValue({});
    const get = vi.fn().mockResolvedValue({ id: 4, status: "PROJECT" });
    const api = makeApi({ update, get });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createSaleInvoiceOperations(api, runtime);
    const prepared = await ops.run({ mode: "prepare", action: "update", id: 4 });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const wrapped = "<<UNTRUSTED_OCR_START:abc>>Clean note<<UNTRUSTED_OCR_END:abc>>";
    await ops.run({ mode: "execute", action: "update", id: 4, planHandle: prepared.value.planHandle, payload: { notes: wrapped } });
    expect(update).toHaveBeenCalledWith(4, expect.objectContaining({ notes: "Clean note" }));

    const confirmedGet = vi.fn().mockResolvedValue({ id: 5, status: "CONFIRMED" });
    const confApi = makeApi({ update, get: confirmedGet });
    const ops2 = createSaleInvoiceOperations(confApi, runtime);
    const prepared2 = await ops2.run({ mode: "prepare", action: "update", id: 5 });
    if (!prepared2.ok || prepared2.value.mode !== "prepare") throw new Error("prepare failed");
    const blocked = await ops2.run({ mode: "execute", action: "update", id: 5, planHandle: prepared2.value.planHandle, payload: { gross_price: 1 } });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error.code).toBe("confirmed_record_immutable");
  });
});
