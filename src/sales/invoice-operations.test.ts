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
    const prepared = await ops.run({ mode: "prepare", action: "send", id: 9, payload: { send_einvoice: true } });
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

  it("recurring: execute with auto_confirm=true against an auto_confirm-absent preview → plan_drift, no clone (no silent DRAFT→register escalation)", async () => {
    const source = { id: 1, status: "CONFIRMED", create_date: "2026-01-15", number: "SI-1", client_name: "Acme OU",
      sale_invoice_type: "INVOICE", number_prefix: "ARV", items: [{ products_id: 9, custom_title: "svc", amount: 1, unit_net_price: 100, total_net_price: 100 }] };
    const create = vi.fn().mockResolvedValue({ created_object_id: 900 });
    const confirm = vi.fn().mockResolvedValue({ status: "CONFIRMED" });
    const api = makeApi({ listAll: vi.fn().mockResolvedValue([source]), get: vi.fn().mockResolvedValue(source), create, confirm });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createSaleInvoiceOperations(api, runtime);
    // Preview reviewed WITHOUT auto_confirm → DRAFT-only clones on the approval card.
    const prepared = await ops.run({ mode: "prepare", action: "recurring", payload: { source_month: "2026-01", target_date: "2026-02-01", target_journal_date: "2026-02-01" } });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    // Execute tries to escalate to auto_confirm=true (create AND register) via the same handle.
    const outcome = await ops.run({ mode: "execute", action: "recurring", planHandle: prepared.value.planHandle, payload: { source_month: "2026-01", target_date: "2026-02-01", target_journal_date: "2026-02-01", auto_confirm: true } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_drift");
    expect(create).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("recurring: execute with auto_confirm matching the reviewed preview runs the real clone", async () => {
    const source = { id: 1, status: "CONFIRMED", create_date: "2026-01-15", number: "SI-1", client_name: "Acme OU",
      sale_invoice_type: "INVOICE", number_prefix: "ARV", items: [{ products_id: 9, custom_title: "svc", amount: 1, unit_net_price: 100, total_net_price: 100 }] };
    const create = vi.fn().mockResolvedValue({ created_object_id: 900 });
    const confirm = vi.fn().mockResolvedValue({ status: "CONFIRMED" });
    const api = makeApi({ listAll: vi.fn().mockResolvedValue([source]), get: vi.fn().mockResolvedValue(source), create, confirm });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const params = { source_month: "2026-01", target_date: "2026-02-01", target_journal_date: "2026-02-01", auto_confirm: true };
    const prepared = await ops.run({ mode: "prepare", action: "recurring", payload: params });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const executed = await ops.run({ mode: "execute", action: "recurring", planHandle: prepared.value.planHandle, payload: params });
    expect(executed.ok).toBe(true);
    if (!executed.ok || executed.value.mode !== "execute") throw new Error("execute failed");
    expect(create).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
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

  it("P17: an H13 strong-identifier conflict is refused at prepare (no handle) — NEITHER client NOR invoice", async () => {
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
    // Fix B: the read-only preview resolves needs_input, so prepare refuses
    // BEFORE issuing a handle — the operator can never approve an unresolvable
    // customer. (A fail outcome carries no `value`, hence no planHandle.)
    const prepared = await ops.run({ mode: "prepare", action: "create", payload });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error.code).toBe("client_identifier_conflict");
    expect(create).not.toHaveBeenCalled();
    expect(clientCreate).not.toHaveBeenCalled();
  });

  it("P17 (TOCTOU): a would_create at prepare that becomes an H13 conflict at execute is refused by executeCreate — NEITHER client NOR invoice", async () => {
    // Defense-in-depth for the narrow race the two-call gate cannot see: prepare
    // resolves the inline customer read-only to would_create (handle issued), then
    // between prepare and execute another client appears that makes the same
    // identity an H13 strong-identifier conflict. The prepare-time gate (Fix B)
    // already refuses unresolvable customers up front, so this exercises the
    // execute-side refusal branch (executeCreate) directly.
    const create = vi.fn();
    const clientCreate = vi.fn();
    const listAll = vi.fn().mockResolvedValue([]); // prepare: no match → would_create
    const api = makeApi({ create }, {}, { listAll, create: clientCreate });
    const runtime = createTestRuntimeSafetyContext();
    const ops = createSaleInvoiceOperations(api, runtime);
    const payload = { client: { name: "Twin OÜ", reg_code: "17133416" }, items: [] };
    const prepared = await ops.run({ mode: "prepare", action: "create", payload });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare should succeed as would_create");
    expect(prepared.value.projection.client_resolution).toBe("would_create");
    expect(clientCreate).not.toHaveBeenCalled();
    // The client set changes underneath us: a same-name client with a DIFFERENT
    // strong identifier now exists → resolving with creation enabled hits H13.
    listAll.mockResolvedValue([{ id: 50, name: "Twin OÜ", code: "10000000", is_deleted: false }]);
    const executed = await ops.run({ mode: "execute", action: "create", planHandle: prepared.value.planHandle, payload });
    expect(executed.ok).toBe(false);
    if (executed.ok) return;
    expect(executed.error.code).toBe("client_identifier_conflict");
    expect(create).not.toHaveBeenCalled(); // no invoice
    expect(clientCreate).not.toHaveBeenCalled(); // no client
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
    // Payload fingerprint is bound at prepare, so the same payload must be
    // presented at prepare and execute (a wrapped OCR nonce desandboxes to the
    // same clean value on both sides).
    const wrapped = "<<UNTRUSTED_OCR_START:abc>>Clean note<<UNTRUSTED_OCR_END:abc>>";
    const prepared = await ops.run({ mode: "prepare", action: "update", id: 4, payload: { notes: wrapped } });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    await ops.run({ mode: "execute", action: "update", id: 4, planHandle: prepared.value.planHandle, payload: { notes: wrapped } });
    expect(update).toHaveBeenCalledWith(4, expect.objectContaining({ notes: "Clean note" }));

    const confirmedGet = vi.fn().mockResolvedValue({ id: 5, status: "CONFIRMED" });
    const confApi = makeApi({ update, get: confirmedGet });
    const ops2 = createSaleInvoiceOperations(confApi, runtime);
    const prepared2 = await ops2.run({ mode: "prepare", action: "update", id: 5, payload: { gross_price: 1 } });
    if (!prepared2.ok || prepared2.value.mode !== "prepare") throw new Error("prepare failed");
    const blocked = await ops2.run({ mode: "execute", action: "update", id: 5, planHandle: prepared2.value.planHandle, payload: { gross_price: 1 } });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error.code).toBe("confirmed_record_immutable");
  });

  // Fix 1 — validation must run BEFORE the inline customer is resolve-or-created.
  it("Fix1: a bad-dimension item fails validation BEFORE the inline customer is created — no orphan client, no invoice", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => "0" }, text: () => Promise.resolve("") });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const create = vi.fn().mockResolvedValue({ created_object_id: 500 });
      const clientCreate = vi.fn().mockResolvedValue({ created_object_id: 77 });
      const clientGet = vi.fn().mockResolvedValue({ id: 77, name: "New Buyer OÜ" });
      const api = makeApi(
        { create },
        { getAccounts: vi.fn().mockResolvedValue([]), getAccountDimensions: vi.fn().mockResolvedValue([]) },
        { listAll: vi.fn().mockResolvedValue([]), create: clientCreate, get: clientGet },
      );
      const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
      // Brand-new resolvable client + an item referencing an unknown sale account (accounts=[]).
      const payload = { client: { name: "New Buyer OÜ", reg_code: "17133416", country: "EST" }, items: [{ products_id: 1, custom_title: "x", amount: 1, sale_accounts_id: 9999 }] };
      const prepared = await ops.run({ mode: "prepare", action: "create", payload });
      if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
      const executed = await ops.run({ mode: "execute", action: "create", planHandle: prepared.value.planHandle, payload });
      expect(executed.ok).toBe(false);
      if (executed.ok) return;
      expect(executed.error.code).toBe("account_validation_failed");
      expect(clientCreate).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Fix 2 — clients_id + inline client is a hard conflict in BOTH paths.
  it("Fix2: prepare create with BOTH clients_id and inline client is a hard validation error — no plan issued", async () => {
    const api = makeApi();
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const outcome = await ops.run({ mode: "prepare", action: "create", payload: { clients_id: 9, client: { name: "Acme OÜ" }, items: [] } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("client_input_conflict");
  });

  it("Fix2: execute create with BOTH clients_id and inline client is rejected — no invoice, no client created", async () => {
    const create = vi.fn();
    const clientCreate = vi.fn();
    const api = makeApi({ create }, {}, { listAll: vi.fn().mockResolvedValue([]), create: clientCreate });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const outcome = await ops.run({ mode: "execute", action: "create", planHandle: "anything", payload: { clients_id: 9, client: { name: "Acme OÜ" }, items: [] } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("client_input_conflict");
    expect(create).not.toHaveBeenCalled();
    expect(clientCreate).not.toHaveBeenCalled();
  });

  // Fix 3 — bind the mutation payload fingerprint into the plan.
  it("Fix3 update: execute with a DIFFERENT amount than reviewed → plan_drift, no update", async () => {
    const update = vi.fn();
    const get = vi.fn().mockResolvedValue({ id: 9, status: "PROJECT" });
    const api = makeApi({ update, get });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const prepared = await ops.run({ mode: "prepare", action: "update", id: 9, payload: { gross_price: 100 } });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const outcome = await ops.run({ mode: "execute", action: "update", id: 9, planHandle: prepared.value.planHandle, payload: { gross_price: 200 } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_drift");
    expect(update).not.toHaveBeenCalled();
  });

  it("Fix3 update: UNCHANGED payload still executes (positive control)", async () => {
    const update = vi.fn().mockResolvedValue({});
    const get = vi.fn().mockResolvedValue({ id: 9, status: "PROJECT" });
    const api = makeApi({ update, get });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const payload = { gross_price: 100, vat_price: 20 };
    const prepared = await ops.run({ mode: "prepare", action: "update", id: 9, payload });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const executed = await ops.run({ mode: "execute", action: "update", id: 9, planHandle: prepared.value.planHandle, payload });
    expect(executed.ok).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("Fix3 send: execute with DIFFERENT send params than reviewed → plan_drift, no send", async () => {
    const send = vi.fn();
    const api = makeApi({ sendEinvoice: send });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const prepared = await ops.run({ mode: "prepare", action: "send", id: 9, payload: { send_einvoice: true, send_email: false } });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const outcome = await ops.run({ mode: "execute", action: "send", id: 9, planHandle: prepared.value.planHandle, payload: { send_einvoice: true, send_email: true, email_addresses: ["x@y.z"] } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_drift");
    expect(send).not.toHaveBeenCalled();
  });

  it("Fix3 send: UNCHANGED send params still execute (positive control)", async () => {
    const send = vi.fn().mockResolvedValue({ delivered: true });
    const api = makeApi({ sendEinvoice: send });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const payload = { send_einvoice: true, send_email: true, email_addresses: ["x@y.z"] };
    const prepared = await ops.run({ mode: "prepare", action: "send", id: 9, payload });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const executed = await ops.run({ mode: "execute", action: "send", id: 9, planHandle: prepared.value.planHandle, payload });
    expect(executed.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("Fix3 create: execute with a DIFFERENT inline client than reviewed → plan_drift, no invoice, no client", async () => {
    const create = vi.fn();
    const clientCreate = vi.fn();
    const api = makeApi({ create }, {}, { listAll: vi.fn().mockResolvedValue([]), create: clientCreate });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const prepared = await ops.run({ mode: "prepare", action: "create", payload: { client: { name: "Client A OÜ" }, items: [] } });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const outcome = await ops.run({ mode: "execute", action: "create", planHandle: prepared.value.planHandle, payload: { client: { name: "Client B OÜ" }, items: [] } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_drift");
    expect(create).not.toHaveBeenCalled();
    expect(clientCreate).not.toHaveBeenCalled();
  });

  // ---- FIX A — recurring format validation must run in the façade too, not
  // only on the standalone tool's Zod schema. Malformed input must be rejected
  // BEFORE any clone / API read.
  const recurringSource = {
    id: 1, status: "CONFIRMED", create_date: "2026-01-15", number: "SI-1", client_name: "Acme OU",
    sale_invoice_type: "INVOICE", number_prefix: "ARV",
    items: [{ products_id: 9, custom_title: "svc", amount: 1, unit_net_price: 100, total_net_price: 100 }],
  };

  it("FixA: recurring PREPARE with malformed invoice_ids is rejected before any clone/API read (recurring_params_invalid)", async () => {
    const create = vi.fn();
    const listAll = vi.fn().mockResolvedValue([recurringSource]);
    const api = makeApi({ create, listAll, get: vi.fn().mockResolvedValue(recurringSource) });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const outcome = await ops.run({ mode: "prepare", action: "recurring", payload: { source_month: "2026-01", target_date: "2026-02-01", target_journal_date: "2026-02-01", invoice_ids: "1oops" } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("recurring_params_invalid");
    expect(listAll).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("FixA: recurring PREPARE with malformed source_month (2026-13) is rejected (recurring_params_invalid)", async () => {
    const create = vi.fn();
    const listAll = vi.fn().mockResolvedValue([recurringSource]);
    const api = makeApi({ create, listAll, get: vi.fn().mockResolvedValue(recurringSource) });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const outcome = await ops.run({ mode: "prepare", action: "recurring", payload: { source_month: "2026-13", target_date: "2026-02-01", target_journal_date: "2026-02-01" } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("recurring_params_invalid");
    expect(listAll).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("FixA: recurring EXECUTE with malformed invoice_ids is rejected before any clone (recurring_params_invalid, no create)", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 900 });
    const api = makeApi({ listAll: vi.fn().mockResolvedValue([recurringSource]), get: vi.fn().mockResolvedValue(recurringSource), create });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const validParams = { source_month: "2026-01", target_date: "2026-02-01", target_journal_date: "2026-02-01" };
    const prepared = await ops.run({ mode: "prepare", action: "recurring", payload: validParams });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const outcome = await ops.run({ mode: "execute", action: "recurring", planHandle: prepared.value.planHandle, payload: { ...validParams, invoice_ids: "1oops" } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("recurring_params_invalid");
    expect(create).not.toHaveBeenCalled();
  });

  // ---- FIX B — a create whose inline customer resolves to needs_input (P17
  // refusal) must NOT be shown as ready-for-approval: no plan handle is issued.
  it("FixB: prepare create with an inline client that resolves needs_input issues NO plan handle", async () => {
    const create = vi.fn();
    const clientCreate = vi.fn();
    const api = makeApi(
      { create },
      {},
      { listAll: vi.fn().mockResolvedValue([{ id: 50, name: "Twin OÜ", code: "10000000", is_deleted: false }]), create: clientCreate },
    );
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    // Twin name + a contradicting strong identifier (reg_code) → H13 conflict → needs_input.
    const outcome = await ops.run({ mode: "prepare", action: "create", payload: { client: { name: "Twin OÜ", reg_code: "17133416" }, items: [] } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return; // a fail outcome carries no `value`, so no planHandle can be issued
    expect(outcome.error.code).toBe("client_identifier_conflict");
    expect(clientCreate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("FixB: prepare create with a would_create client STILL issues a plan handle (positive control)", async () => {
    const clientCreate = vi.fn();
    const api = makeApi({}, {}, { listAll: vi.fn().mockResolvedValue([]), create: clientCreate });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const prepared = await ops.run({ mode: "prepare", action: "create", payload: { client: { name: "Brand New Buyer OÜ" }, items: [] } });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    expect(typeof prepared.value.planHandle).toBe("string");
    expect(prepared.value.projection.client_resolution).toBe("would_create");
    expect(clientCreate).not.toHaveBeenCalled();
  });

  it("FixB: prepare create with an explicit clients_id still issues a plan handle (positive control)", async () => {
    const api = makeApi({}, {}, { listAll: vi.fn().mockResolvedValue([]) });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const prepared = await ops.run({ mode: "prepare", action: "create", payload: { clients_id: 9, items: [] } });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    expect(typeof prepared.value.planHandle).toBe("string");
  });

  // ---- P2 §9 — inline client creation must not orphan master data. When the
  // customer was CREATED here and the subsequent invoice create fails, the new
  // client must be compensated (deactivated); a pre-existing client is untouched.
  function newClientCreateApi(over: {
    saleCreate: ReturnType<typeof vi.fn>;
    deactivate?: ReturnType<typeof vi.fn>;
  }) {
    return makeApi(
      { create: over.saleCreate },
      {},
      {
        listAll: vi.fn().mockResolvedValue([]), // no match → resolver creates a new client
        create: vi.fn().mockResolvedValue({ created_object_id: 77 }),
        get: vi.fn().mockResolvedValue({ id: 77, name: "New Buyer OÜ" }),
        ...(over.deactivate ? { deactivate: over.deactivate } : { deactivate: vi.fn().mockResolvedValue({}) }),
      },
    );
  }
  const newClientPayload = { client: { name: "New Buyer OÜ", reg_code: "17133416", country: "EST" }, items: [] };

  it("P2 §9: created client + invoice create fails + cleanup succeeds → deactivate called, structured rollback failure, no active orphan", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => "0" }, text: () => Promise.resolve("") });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const saleCreate = vi.fn().mockRejectedValue(new Error("invoice boom"));
      const deactivate = vi.fn().mockResolvedValue({});
      const api = newClientCreateApi({ saleCreate, deactivate });
      const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
      const prepared = await ops.run({ mode: "prepare", action: "create", payload: newClientPayload });
      if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
      const executed = await ops.run({ mode: "execute", action: "create", planHandle: prepared.value.planHandle, payload: newClientPayload });
      expect(executed.ok).toBe(false);
      if (executed.ok) return;
      expect(executed.error.code).toBe("invoice_create_failed_client_rolled_back");
      expect(executed.error.message).toContain("77");
      expect(deactivate).toHaveBeenCalledWith(77);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("P2 §9: created client + invoice create fails + cleanup ALSO fails → indeterminate partial outcome carrying the client id + next action", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => "0" }, text: () => Promise.resolve("") });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const saleCreate = vi.fn().mockRejectedValue(new Error("invoice boom"));
      const deactivate = vi.fn().mockRejectedValue(new Error("network down"));
      const api = newClientCreateApi({ saleCreate, deactivate });
      const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
      const prepared = await ops.run({ mode: "prepare", action: "create", payload: newClientPayload });
      if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
      const executed = await ops.run({ mode: "execute", action: "create", planHandle: prepared.value.planHandle, payload: newClientPayload });
      expect(executed.ok).toBe(false);
      if (executed.ok) return;
      expect(executed.error.code).toBe("client_rollback_indeterminate");
      expect(executed.error.message).toContain("77");
      expect(executed.error.message).toContain("network down");
      expect(deactivate).toHaveBeenCalledWith(77);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("P2 §9: EXISTING client + invoice create fails → NO cleanup (the pre-existing client is never deactivated)", async () => {
    const saleCreate = vi.fn().mockRejectedValue(new Error("invoice boom"));
    const deactivate = vi.fn();
    const api = makeApi(
      { create: saleCreate },
      {},
      { listAll: vi.fn().mockResolvedValue([{ id: 42, name: "Acme OÜ", code: "17133416", is_deleted: false }]), create: vi.fn(), deactivate },
    );
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const payload = { client: { name: "Acme OÜ", reg_code: "17133416" }, items: [] };
    const prepared = await ops.run({ mode: "prepare", action: "create", payload });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    // The invoice-create error propagates unchanged (no client was created here,
    // so there is nothing to roll back) and deactivate is never called.
    await expect(
      ops.run({ mode: "execute", action: "create", planHandle: prepared.value.planHandle, payload }),
    ).rejects.toThrow("invoice boom");
    expect(deactivate).not.toHaveBeenCalled();
  });

  it("P2 §9: clients_id path + invoice create fails → NO cleanup", async () => {
    const saleCreate = vi.fn().mockRejectedValue(new Error("invoice boom"));
    const deactivate = vi.fn();
    const api = makeApi({ create: saleCreate }, {}, { listAll: vi.fn().mockResolvedValue([]), deactivate });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const prepared = await ops.run({ mode: "prepare", action: "create", payload: { clients_id: 9, items: [] } });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    await expect(
      ops.run({ mode: "execute", action: "create", planHandle: prepared.value.planHandle, payload: { clients_id: 9, items: [] } }),
    ).rejects.toThrow("invoice boom");
    expect(deactivate).not.toHaveBeenCalled();
  });

  // ---- P3 §14.2 — clients_id + inline client conflict must be detected from the
  // RAW key presence; a malformed/empty inline client must never be silently
  // dropped.
  it("P3 §14.2: clients_id + an EMPTY inline client object is a hard conflict (not silently dropped)", async () => {
    const create = vi.fn();
    const clientCreate = vi.fn();
    const api = makeApi({ create }, {}, { listAll: vi.fn().mockResolvedValue([]), create: clientCreate });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const outcome = await ops.run({ mode: "prepare", action: "create", payload: { clients_id: 9, client: {}, items: [] } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("client_input_conflict");
    expect(create).not.toHaveBeenCalled();
    expect(clientCreate).not.toHaveBeenCalled();
  });

  it("P3 §14.2: a malformed inline client alone (no clients_id, no name) is an explicit error, not a silent skip", async () => {
    const create = vi.fn();
    const clientCreate = vi.fn();
    const api = makeApi({ create }, {}, { listAll: vi.fn().mockResolvedValue([]), create: clientCreate });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const outcome = await ops.run({ mode: "prepare", action: "create", payload: { client: {}, items: [] } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("client_invalid");
    expect(create).not.toHaveBeenCalled();
    expect(clientCreate).not.toHaveBeenCalled();
  });

  // ---- P3 §14.3 — the create fingerprint binds the EFFECTIVE payload (after
  // defaulting), so an omitted-vs-explicit default does NOT drift, while a
  // changed real field DOES.
  it("P3 §14.3: omitted default at prepare vs explicit same default at execute does NOT drift", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 500 });
    const api = makeApi({ create }, {}, { listAll: vi.fn().mockResolvedValue([]) });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    // prepare omits all defaults
    const prepared = await ops.run({ mode: "prepare", action: "create", payload: { clients_id: 9, items: [] } });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    // execute supplies the SAME values the server would have defaulted
    const executed = await ops.run({
      mode: "execute", action: "create", planHandle: prepared.value.planHandle,
      payload: { clients_id: 9, items: [], cl_currencies_id: "EUR", cl_countries_id: "EST", sale_invoice_type: "INVOICE", show_client_balance: false, number_suffix: "" },
    });
    expect(executed.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("P3 §14.3: a changed real field (gross_price) DOES drift with zero API calls", async () => {
    const create = vi.fn();
    const api = makeApi({ create }, {}, { listAll: vi.fn().mockResolvedValue([]) });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const prepared = await ops.run({ mode: "prepare", action: "create", payload: { clients_id: 9, items: [], gross_price: 100 } });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const outcome = await ops.run({ mode: "execute", action: "create", planHandle: prepared.value.planHandle, payload: { clients_id: 9, items: [], gross_price: 200 } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("plan_drift");
    expect(create).not.toHaveBeenCalled();
  });

  // ---- P2 §10 — strict calendar-date validation on the read=list date filters.
  it("P2 §10: read=list with a non-existent date_from (2026-02-31) is rejected before the API list call", async () => {
    const list = vi.fn();
    const api = makeApi({ list });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const outcome = await ops.run({ mode: "read", action: "list", filters: { date_from: "2026-02-31" } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("invalid_date_filter");
    expect(list).not.toHaveBeenCalled();
  });

  it("P2 §10: recurring EXECUTE with a non-existent date does NOT consume the plan handle (rejected pre-consume)", async () => {
    const source = { id: 1, status: "CONFIRMED", create_date: "2026-01-15", number: "SI-1", client_name: "Acme OU",
      sale_invoice_type: "INVOICE", number_prefix: "ARV", items: [{ products_id: 9, custom_title: "svc", amount: 1, unit_net_price: 100, total_net_price: 100 }] };
    const create = vi.fn().mockResolvedValue({ created_object_id: 900 });
    const api = makeApi({ listAll: vi.fn().mockResolvedValue([source]), get: vi.fn().mockResolvedValue(source), create });
    const ops = createSaleInvoiceOperations(api, createTestRuntimeSafetyContext());
    const validParams = { source_month: "2026-01", target_date: "2026-02-01", target_journal_date: "2026-02-01" };
    const prepared = await ops.run({ mode: "prepare", action: "recurring", payload: validParams });
    if (!prepared.ok || prepared.value.mode !== "prepare") throw new Error("prepare failed");
    const handle = prepared.value.planHandle;
    // Execute with a non-existent target_date → rejected on syntax before consume.
    const bad = await ops.run({ mode: "execute", action: "recurring", planHandle: handle, payload: { ...validParams, target_date: "2026-02-31" } });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.code).toBe("recurring_params_invalid");
    expect(create).not.toHaveBeenCalled();
    // Because the handle was NOT consumed, a correct execute still succeeds.
    const good = await ops.run({ mode: "execute", action: "recurring", planHandle: handle, payload: validParams });
    expect(good.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
