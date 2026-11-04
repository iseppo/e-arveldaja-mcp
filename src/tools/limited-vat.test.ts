import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerLimitedVatTool, type LimitedVatGuidePayload, type LimitedVatMonthPayload, type LimitedVatSetStatusPreviewPayload, type LimitedVatSetStatusSavedPayload, type LimitedVatStatusPayload } from "./limited-vat.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { parseToolPayload } from "../__fixtures__/mcp-response.js";
import { makeAccount } from "../__fixtures__/accounting.js";
import { LIMITED_VAT_STORE_FILE, isCompanyVatRegistered, limitedVatStore, resolveCompanyVatStatus, type LimitedVatStoreRecord } from "../company-vat-status.js";
import { createConnectionScopedBundleStore } from "../connection-scoped-bundle-store.js";
import { resolveBundleStorePath } from "../accounting-rules.js";
import { applyReverseChargeAutoDetection } from "./receipt-inbox.js";
import type { ApiContext } from "./crud-tools.js";
import type { Account, Client, Journal, PurchaseInvoice, Transaction } from "../types/api.js";
import type { EcbFetch } from "../fx/ecb-rates.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface FakeState {
  vatNumber?: string;
  accounts: Account[];
  clients: Client[];
  invoices: PurchaseInvoice[];
  transactions: Transaction[];
  journals: Journal[];
  writes: string[];
}

function supplier(id: number, name: string, country: string): Client {
  return { id, name, cl_code_country: country, is_client: false, is_supplier: true, is_member: false, send_invoice_to_email: false, send_invoice_to_accounting_email: false };
}

function invoice(id: number, clientsId: number, date: string, net: number, extra: Partial<PurchaseInvoice> = {}): PurchaseInvoice {
  return {
    id, clients_id: clientsId, client_name: "x", number: `INV-${id}`, create_date: date, journal_date: date, term_days: 0,
    cl_currencies_id: "EUR", status: "CONFIRMED", net_price: net, vat_price: 0, gross_price: net,
    items: [{ custom_title: "Cloud", total_net_price: net, purchase_accounts_id: 5000, purchase_accounts_dimensions_id: null }],
    ...extra,
  };
}

function fakeApi(state: FakeState): ApiContext {
  let nextJournalId = 900;
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const noop = () => undefined;
  return {
    readonly: {
      getVatInfo: async () => (state.vatNumber ? { vat_number: state.vatNumber } : {}),
      getAccounts: async () => state.accounts,
    },
    clients: { listAll: async () => state.clients, invalidateListCache: noop },
    purchaseInvoices: {
      listAll: async () => state.invoices.map(({ items: _items, ...rest }) => rest),
      get: async (id: number) => clone(state.invoices.find(entry => entry.id === id)!),
      invalidateListCache: noop,
    },
    transactions: {
      get: async (id: number) => clone(state.transactions.find(entry => entry.id === id)!),
      invalidateListCache: noop,
    },
    journals: {
      connectionFingerprint: "test-connection",
      apiBaseUrl: "https://demo",
      listAll: async () => state.journals.map(clone),
      get: async (id: number) => clone(state.journals.find(entry => entry.id === id)!),
      invalidateListCache: noop,
      create: async (data: Partial<Journal>) => {
        const id = nextJournalId++;
        state.writes.push(`create:${data.document_number}`);
        state.journals.push({ ...(data as Journal), id, registered: false });
        return { code: 200, messages: [], created_object_id: id };
      },
      confirm: async (id: number) => {
        state.writes.push(`confirm:${id}`);
        state.journals.find(entry => entry.id === id)!.registered = true;
        return { code: 200, messages: [] };
      },
    },
  } as unknown as ApiContext;
}

const csv = (date: string, value: string) =>
  `KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${date},${value},A\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-03-11,1.0900,A\n`;

function setup(state: FakeState, fetchImpl?: EcbFetch) {
  const handlers = new Map<string, Handler>();
  const server = { registerTool: vi.fn((name: string, _config: unknown, cb: Handler) => handlers.set(name, cb)) } as unknown as McpServer;
  const ctx = createTestRuntimeSafetyContext();
  const api = fakeApi(state);
  registerLimitedVatTool(server, api, ctx, fetchImpl ? { ecb: { fetch: fetchImpl, cache: new Map() } } : {});
  const call = async (args: Record<string, unknown>) => {
    const result = await handlers.get("limited_vat")!(args);
    return { result, text: (result.content[0] as { text: string }).text };
  };
  return { call, api, ctx };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limited-vat-"));
  process.env.EARVELDAJA_RULES_DIR = join(dir, "rules");
  process.env.EARVELDAJA_LOCK_DIR = join(dir, "locks");
  limitedVatStore.reset();
});
afterEach(() => {
  delete process.env.EARVELDAJA_RULES_DIR;
  delete process.env.EARVELDAJA_RULES_FILE;
  delete process.env.EARVELDAJA_LOCK_DIR;
  limitedVatStore.reset();
  rmSync(dir, { recursive: true, force: true });
});

const chart = () => [
  makeAccount(5000, "D", "Kulud", "Tarkvara ja IT-teenused"),
  makeAccount(2410, "C", "Kohustused", "Käibemaksukohustis"),
];

function baseState(extra: Partial<FakeState> = {}): FakeState {
  return {
    vatNumber: "EE102345678",
    accounts: chart(),
    clients: [supplier(10, "Amazon Web Services EMEA SARL", "LUX"), supplier(11, "OpenAI, LLC", "USA")],
    invoices: [invoice(1, 10, "2026-03-05", 50)],
    transactions: [],
    journals: [],
    writes: [],
    ...extra,
  };
}

async function setLimited(call: ReturnType<typeof setup>["call"]) {
  const preview = parseToolPayload<LimitedVatSetStatusPreviewPayload>((await call({ mode: "set_status", status: "limited", effective_from: "2026-01-01" })).text);
  await call({ mode: "set_status", status: "limited", effective_from: "2026-01-01", execute: true, plan_handle: preview.plan_handle });
}

describe("company VAT status", () => {
  it("derives full from a VAT number and none without one", async () => {
    expect((await resolveCompanyVatStatus(fakeApi(baseState()))).status).toBe("full");
    expect((await resolveCompanyVatStatus(fakeApi(baseState({ vatNumber: undefined })))).status).toBe("none");
  });

  it("set_status needs owner approval: preview writes nothing, execute with the plan handle stores limited", async () => {
    const state = baseState();
    const { call, api } = setup(state);
    const preview = parseToolPayload<LimitedVatSetStatusPreviewPayload>((await call({ mode: "set_status", status: "limited", effective_from: "2026-01-01" })).text);
    expect(preview.status).toBe("ready_for_approval");
    expect(await isCompanyVatRegistered(api)).toBe(true);

    const drift = await call({ mode: "set_status", status: "limited", effective_from: "2026-02-01", execute: true, plan_handle: preview.plan_handle });
    expect(drift.result.isError).toBe(true);
    expect(drift.text).toContain("plan_drift");
    expect(await isCompanyVatRegistered(api)).toBe(true);

    const second = parseToolPayload<LimitedVatSetStatusPreviewPayload>((await call({ mode: "set_status", status: "limited", effective_from: "2026-01-01" })).text);
    const saved = parseToolPayload<LimitedVatSetStatusSavedPayload>((await call({ mode: "set_status", status: "limited", effective_from: "2026-01-01", execute: true, plan_handle: second.plan_handle })).text);
    expect(saved).toMatchObject({ status: "saved", saved: { status: "limited", effective_from: "2026-01-01" } });
    const replay = await call({ mode: "set_status", status: "limited", effective_from: "2026-01-01", execute: true, plan_handle: second.plan_handle });
    expect(replay.result.isError).toBe(true);

    const status = parseToolPayload<LimitedVatStatusPayload>((await call({ mode: "status" })).text);
    expect(status).toMatchObject({ status: "limited", source: "setting", vat_number: "EE102345678", effective_from: "2026-01-01" });
    // A limited taxpayer with a VAT number is never treated as VAT-registered.
    expect(await isCompanyVatRegistered(api)).toBe(false);
  });

  it("limited is unavailable in single-file rules mode", async () => {
    delete process.env.EARVELDAJA_RULES_DIR;
    process.env.EARVELDAJA_RULES_FILE = join(dir, "accounting-rules.md");
    const { call } = setup(baseState());
    const refused = await call({ mode: "set_status", status: "limited", effective_from: "2026-01-01" });
    expect(refused.result.isError).toBe(true);
    expect(refused.text).toContain("limited_vat_store_unavailable");
    const status = parseToolPayload<LimitedVatStatusPayload>((await call({ mode: "status" })).text);
    expect(status).toMatchObject({ status: "full", store_available: false });
  });

  it("does not apply a reverse charge for a company that is not fully VAT-registered (foreign default or supplier history)", () => {
    const suggestion = { item: { reversed_vat_id: undefined as number | null | undefined } } as unknown as Parameters<typeof applyReverseChargeAutoDetection>[0];
    const resolution = { client: { cl_code_country: "USA" } } as unknown as Parameters<typeof applyReverseChargeAutoDetection>[2];
    const notes: string[] = [];
    applyReverseChargeAutoDetection(suggestion, { raw_text: "reverse charge" } as Parameters<typeof applyReverseChargeAutoDetection>[1], resolution, false, notes);
    expect(suggestion.item.reversed_vat_id).toBeUndefined();
    const fromHistory = { item: { reversed_vat_id: 1 } } as unknown as Parameters<typeof applyReverseChargeAutoDetection>[0];
    applyReverseChargeAutoDetection(fromHistory, { raw_text: "" } as Parameters<typeof applyReverseChargeAutoDetection>[1], resolution, false, notes);
    expect(fromHistory.item.reversed_vat_id).toBeNull();
    applyReverseChargeAutoDetection(suggestion, { raw_text: "" } as Parameters<typeof applyReverseChargeAutoDetection>[1], resolution, true, notes);
    expect(suggestion.item.reversed_vat_id).toBe(1);
  });
});

describe("limited_vat mode guide and status", () => {
  it("renders the Estonian guidance with the registration path, § 21 lg 1, the 3-working-day rule, no deduction, the EX exception and the OSS caveat", async () => {
    const { call } = setup(baseState());
    const payload = parseToolPayload<LimitedVatGuidePayload>((await call({ mode: "guide" })).text);
    const text = JSON.stringify(payload.guidance);
    expect(text).toContain("\\\"Registrid ja päringud\\\" → \\\"Registreerimine\\\" → \\\"Käibemaksukohustuslaseks registreerimine\\\"");
    expect(text).toContain("KMS § 21 lg 1");
    expect(text).toContain("3 tööpäeva");
    expect(text).toContain("Sisendkäibemaksu maha arvata ei saa");
    expect(text).toContain("\\\"EX\\\"");
    expect(text).toContain("Küsi seda EMTA-lt kirjalikult");
    expect(payload.tax_rules.map(rule => rule.code)).toContain("KMS § 21 lg 1");
  });

  it("for status none reports foreign-service candidates since the first service date, read-only", async () => {
    const state = baseState({ vatNumber: undefined, invoices: [invoice(1, 10, "2026-03-05", 50), invoice(2, 10, "2026-02-10", 10)] });
    const { call } = setup(state);
    const status = parseToolPayload<LimitedVatStatusPayload>((await call({ mode: "status" })).text);
    expect(status.status).toBe("none");
    expect(status.registration_check).toMatchObject({ candidate_invoice_count: 2, first_service_date: "2026-02-10" });
    expect(status.registration_check!.months).toEqual([
      { month: "2026-02", invoice_count: 1, base_eur_estimate: 10, vat_estimate: 2.4, unvalued_invoice_count: 0 },
      { month: "2026-03", invoice_count: 1, base_eur_estimate: 50, vat_estimate: 12, unvalued_invoice_count: 0 },
    ]);
    expect(state.writes).toEqual([]);
  });
});

describe("limited_vat mode month", () => {
  it("refuses unless the company is a limited taxpayer", async () => {
    const state = baseState();
    const { call } = setup(state);
    const refused = await call({ mode: "month", month: "2026-03" });
    expect(refused.text).toContain("limited_vat_status_not_limited");
    expect(state.writes).toEqual([]);
  });

  it("refuses with a request for liability_account when no VAT liability account resolves", async () => {
    const state = baseState({ accounts: [makeAccount(5000, "D", "Kulud", "Tarkvara")] });
    const { call } = setup(state);
    await setLimited(call);
    const refused = await call({ mode: "month", month: "2026-03" });
    expect(refused.text).toContain("limited_vat_liability_account_unresolved");
    expect(refused.text).toContain("liability_account");
  });

  it("dry run → approval → execute creates and confirms PKM-YYYY-MM once; a re-run is already_booked", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => csv("2026-03-10", "1.0800") })) as unknown as EcbFetch;
    const state = baseState({ invoices: [invoice(1, 10, "2026-03-05", 50), invoice(2, 11, "2026-03-10", 100, { cl_currencies_id: "USD" })] });
    const { call } = setup(state, fetchImpl);
    await setLimited(call);
    const classifications = [{ clients_id: 10, classification: "counts" }, { clients_id: 11, classification: "counts" }];
    const dry = parseToolPayload<LimitedVatMonthPayload>((await call({ mode: "month", month: "2026-03", supplier_classifications: classifications })).text);
    expect(dry.status).toBe("ready_for_approval");
    expect(dry.proposed_journal).toMatchObject({ document_number: "PKM-2026-03", effective_date: "2026-03-31" });
    expect(dry.proposed_journal!.postings).toEqual([
      { accounts_id: 5000, accounts_dimensions_id: null, type: "D", amount: 34.22 },
      { accounts_id: 2410, accounts_dimensions_id: null, type: "C", amount: 34.22 },
    ]);
    expect(dry.kmd).toMatchObject({ row_1_taxable_value: 142.59, row_4_vat: 34.22, row_6_eu_services_value: 50, row_7_non_eu_services_value: 92.59 });
    expect(dry.payment_deadline).toBe("2026-04-20");
    expect(state.writes).toEqual([]);

    const booked = parseToolPayload<LimitedVatMonthPayload>((await call({ mode: "month", month: "2026-03", supplier_classifications: classifications, execute: true, plan_handle: dry.plan_handle })).text);
    expect(booked.status).toBe("booked");
    expect(state.writes).toEqual(["create:PKM-2026-03", "confirm:900"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const stale = await call({ mode: "month", month: "2026-03", supplier_classifications: classifications, execute: true, plan_handle: dry.plan_handle });
    expect(stale.result.isError).toBe(true);

    // Classifications were saved on approval: the re-run needs none.
    const rerun = parseToolPayload<LimitedVatMonthPayload>((await call({ mode: "month", month: "2026-03" })).text);
    expect(rerun).toMatchObject({ status: "already_booked", journal_ids: [900] });
    expect(state.writes).toHaveLength(2);
  });

  it("keeps an unclassified supplier out of the journal as a review item", async () => {
    const state = baseState({ invoices: [invoice(1, 10, "2026-03-05", 50), invoice(3, 11, "2026-03-06", 20)] });
    const { call } = setup(state);
    await setLimited(call);
    const dry = parseToolPayload<LimitedVatMonthPayload>((await call({ mode: "month", month: "2026-03", supplier_classifications: [{ clients_id: 10, classification: "counts" }] })).text);
    expect(dry.review_items.map(review => [review.code, review.invoice_id])).toEqual([["limited_vat_supplier_unclassified", 3]]);
    expect(dry.proposed_journal!.postings[0]!.amount).toBe(12);
  });

  it("refuses execute with a foreign plan handle or after drift, with zero writes", async () => {
    const state = baseState();
    const { call } = setup(state);
    await setLimited(call);
    const statusPreview = parseToolPayload<LimitedVatSetStatusPreviewPayload>((await call({ mode: "set_status", status: "limited", effective_from: "2026-01-01" })).text);
    const args = { mode: "month", month: "2026-03", supplier_classifications: [{ clients_id: 10, classification: "counts" }] };
    const foreign = await call({ ...args, execute: true, plan_handle: statusPreview.plan_handle });
    expect(foreign.result.isError).toBe(true);
    expect(foreign.text).toContain("plan_domain_mismatch");

    const dry = parseToolPayload<LimitedVatMonthPayload>((await call(args)).text);
    state.invoices.push(invoice(4, 10, "2026-03-20", 10));
    const drift = await call({ ...args, execute: true, plan_handle: dry.plan_handle });
    expect(drift.text).toContain("plan_drift");
    expect(state.writes).toEqual([]);
  });

  it("proposes a correction delta for a late invoice and refuses a changed booked journal", async () => {
    const state = baseState();
    const { call } = setup(state);
    await setLimited(call);
    const args = { mode: "month", month: "2026-03", supplier_classifications: [{ clients_id: 10, classification: "counts" }] };
    const dry = parseToolPayload<LimitedVatMonthPayload>((await call(args)).text);
    await call({ ...args, execute: true, plan_handle: dry.plan_handle });

    state.invoices.push(invoice(5, 10, "2026-03-25", 10));
    const delta = parseToolPayload<LimitedVatMonthPayload>((await call({ mode: "month", month: "2026-03" })).text);
    expect(delta).toMatchObject({ state: "delta", document_number: "PKM-2026-03-P1" });
    expect(delta.proposed_journal!.postings.map(posting => posting.amount)).toEqual([2.4, 2.4]);

    state.journals[0]!.postings = [
      { accounts_id: 5000, type: "D", amount: 13, accounts_dimensions_id: null },
      { accounts_id: 2410, type: "C", amount: 13, accounts_dimensions_id: null },
    ];
    const conflict = await call({ mode: "month", month: "2026-03" });
    expect(conflict.text).toContain("limited_vat_journal_conflict");
  });

  it("makes an ECB failure a review item and books nothing for it", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); }) as unknown as EcbFetch;
    const state = baseState({ invoices: [invoice(2, 11, "2026-03-10", 100, { cl_currencies_id: "USD" })] });
    const { call } = setup(state, fetchImpl);
    await setLimited(call);
    const dry = parseToolPayload<LimitedVatMonthPayload>((await call({ mode: "month", month: "2026-03", supplier_classifications: [{ clients_id: 11, classification: "counts" }] })).text);
    expect(dry.review_items.map(review => review.code)).toEqual(["limited_vat_fx_unavailable"]);
    expect(dry.proposed_journal).toBeUndefined();
  });
});

describe("limited_vat review fixes (fail closed)", () => {
  const writeStoreFile = (content: string) => {
    const path = resolveBundleStorePath(LIMITED_VAT_STORE_FILE)!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };

  it("F1: an unreadable status store makes the status unknown and refuses VAT decisions, never full", async () => {
    const state = baseState();
    const { call, api } = setup(state);
    writeStoreFile("{ not json");
    expect((await resolveCompanyVatStatus(api)).status).toBe("unknown");
    await expect(isCompanyVatRegistered(api)).rejects.toThrow(/company_vat_status_unknown/);
    const status = parseToolPayload<LimitedVatStatusPayload>((await call({ mode: "status" })).text);
    expect(status.status).toBe("unknown");
    const refused = await call({ mode: "set_status", status: "limited", effective_from: "2026-01-01" });
    expect(refused.result.isError).toBe(true);
    expect(refused.text).toContain("company_vat_status_unknown");
  });

  it("F2: sees a status saved by another process at the next VAT decision", async () => {
    const { api } = setup(baseState());
    expect(await isCompanyVatRegistered(api)).toBe(true);
    const otherProcess = createConnectionScopedBundleStore<LimitedVatStoreRecord>({
      fileName: LIMITED_VAT_STORE_FILE, label: "other process", maxEntries: 10, keyOf: record => record.key,
    });
    otherProcess.upsert([{ kind: "status", key: "company_vat_status", status: "limited", effective_from: "2026-01-01", set_at: "x" }]);
    expect(await isCompanyVatRegistered(api)).toBe(false);
  });

  it("F3: refuses a future effective_from", async () => {
    const state = baseState();
    const { call } = setup(state);
    const refused = await call({ mode: "set_status", status: "limited", effective_from: "2099-01-01" });
    expect(refused.result.isError).toBe(true);
    expect(refused.text).toContain("limited_vat_effective_from_in_future");
  });

  it("F4: execute refuses an existing draft PKM journal found at create time instead of recording it", async () => {
    const state = baseState();
    const { call, api } = setup(state);
    await setLimited(call);
    const args = { mode: "month", month: "2026-03", supplier_classifications: [{ clients_id: 10, classification: "counts" }] };
    const dry = parseToolPayload<LimitedVatMonthPayload>((await call(args)).text);
    const journals = api.journals as unknown as { listAll: () => Promise<Journal[]> };
    const realListAll = journals.listAll;
    let calls = 0;
    journals.listAll = async () => {
      calls += 1;
      if (calls === 2) {
        state.journals.push({
          id: 777, document_number: "PKM-2026-03", effective_date: "2026-03-31", registered: false,
          postings: [{ accounts_id: 5000, type: "D", amount: 12, accounts_dimensions_id: null }, { accounts_id: 2410, type: "C", amount: 12, accounts_dimensions_id: null }],
        });
      }
      return realListAll();
    };
    const executed = await call({ ...args, execute: true, plan_handle: dry.plan_handle });
    expect(executed.result.isError).toBe(true);
    expect(executed.text).toContain("limited_vat_journal_conflict");
    limitedVatStore.reset();
    expect(limitedVatStore.read()!.some(record => record.kind === "booking")).toBe(false);
  });

  it("F4: a lost create whose recovered draft has the wrong date is never confirmed", async () => {
    const state = baseState();
    const { call, api } = setup(state);
    await setLimited(call);
    const args = { mode: "month", month: "2026-03", supplier_classifications: [{ clients_id: 10, classification: "counts" }] };
    const dry = parseToolPayload<LimitedVatMonthPayload>((await call(args)).text);
    const journals = api.journals as unknown as { create: (data: Partial<Journal>) => Promise<unknown> };
    journals.create = async (data: Partial<Journal>) => {
      state.writes.push(`create:${data.document_number}`);
      state.journals.push({ ...(data as Journal), id: 777, effective_date: "2025-03-31", registered: false });
      throw new Error("socket hang up"); // the create may have happened: indeterminate
    };
    const executed = await call({ ...args, execute: true, plan_handle: dry.plan_handle });
    expect(executed.result.isError).toBe(true);
    expect(executed.text).toContain("limited_vat_journal_conflict");
    expect(state.writes).toEqual(["create:PKM-2026-03"]);
    expect(state.journals.find(journal => journal.id === 777)!.registered).toBe(false);
  });

  it("F5: includes an invoice dated months later but prepaid in the month", async () => {
    const state = baseState({
      invoices: [invoice(1, 10, "2026-07-15", 50, { transactions: [70] })],
      transactions: [{ id: 70, date: "2026-03-15", status: "CONFIRMED" } as Transaction],
    });
    const { call } = setup(state);
    await setLimited(call);
    const dry = parseToolPayload<LimitedVatMonthPayload>((await call({ mode: "month", month: "2026-03", supplier_classifications: [{ clients_id: 10, classification: "counts" }] })).text);
    expect(dry.included_invoices.map(row => [row.invoice_id, row.service_date])).toEqual([[1, "2026-03-15"]]);
  });

  it("F5: reports later invoices beyond the read budget as limited_vat_coverage_incomplete, never a silent omission", async () => {
    const later = Array.from({ length: 300 }, (_, index) => invoice(100 + index, 10, "2026-05-10", 1));
    const state = baseState({ invoices: [invoice(1, 10, "2026-03-05", 50), ...later] });
    const { call } = setup(state);
    await setLimited(call);
    const dry = parseToolPayload<LimitedVatMonthPayload>((await call({ mode: "month", month: "2026-03", supplier_classifications: [{ clients_id: 10, classification: "counts" }] })).text);
    expect(dry.review_items.filter(review => review.code === "limited_vat_coverage_incomplete").map(review => review.invoice_id)).toEqual([399]);
  });

  it("F8: execute refuses when per-invoice amounts are swapped with equal totals", async () => {
    const state = baseState({ invoices: [invoice(1, 10, "2026-03-05", 50), invoice(2, 10, "2026-03-06", 100)] });
    const { call } = setup(state);
    await setLimited(call);
    const args = { mode: "month", month: "2026-03", supplier_classifications: [{ clients_id: 10, classification: "counts" }] };
    const dry = parseToolPayload<LimitedVatMonthPayload>((await call(args)).text);
    state.invoices = [invoice(1, 10, "2026-03-05", 100), invoice(2, 10, "2026-03-06", 50)];
    const drift = await call({ ...args, execute: true, plan_handle: dry.plan_handle });
    expect(drift.text).toContain("plan_drift");
    expect(state.writes).toEqual([]);
  });

  it("F8: execute refuses when a supplier moves from EU to non-EU (KMD split changes, postings do not)", async () => {
    const state = baseState();
    const { call } = setup(state);
    await setLimited(call);
    const args = { mode: "month", month: "2026-03", supplier_classifications: [{ clients_id: 10, classification: "counts" }] };
    const dry = parseToolPayload<LimitedVatMonthPayload>((await call(args)).text);
    state.clients[0] = supplier(10, "Amazon Web Services EMEA SARL", "USA");
    const drift = await call({ ...args, execute: true, plan_handle: dry.plan_handle });
    expect(drift.text).toContain("plan_drift");
    expect(state.writes).toEqual([]);
  });

  it("F9: an older status plan cannot overwrite a newer owner decision", async () => {
    const { call } = setup(baseState());
    const older = parseToolPayload<LimitedVatSetStatusPreviewPayload>((await call({ mode: "set_status", status: "limited", effective_from: "2026-01-01" })).text);
    const newer = parseToolPayload<LimitedVatSetStatusPreviewPayload>((await call({ mode: "set_status", status: "limited", effective_from: "2026-02-01" })).text);
    await call({ mode: "set_status", status: "limited", effective_from: "2026-02-01", execute: true, plan_handle: newer.plan_handle });
    const stale = await call({ mode: "set_status", status: "limited", effective_from: "2026-01-01", execute: true, plan_handle: older.plan_handle });
    expect(stale.result.isError).toBe(true);
    expect(stale.text).toContain("plan_drift");
    const status = parseToolPayload<LimitedVatStatusPayload>((await call({ mode: "status" })).text);
    expect(status.effective_from).toBe("2026-02-01");
  });

  it("F10: the guidance does not claim foreign services are the only taxable transactions", async () => {
    const { call } = setup(baseState());
    const payload = parseToolPayload<LimitedVatGuidePayload>((await call({ mode: "guide" })).text);
    expect(JSON.stringify(payload.guidance)).not.toMatch(/maksab käibemaksu ainult/);
  });
});
