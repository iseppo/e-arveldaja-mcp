// GitHub #63 test double: a small in-memory e-arveldaja behind a fake HttpClient,
// so the real PurchaseInvoicesApi / ReferenceDataApi run end to end (POST, GET,
// PATCH, register, invalidate, document upload, the accounts chart).
import { vi } from "vitest";
import type { HttpClient } from "../http-client.js";
import { PurchaseInvoicesApi } from "../api/purchase-invoices.api.js";
import { ReferenceDataApi, readonlyCache } from "../api/readonly.api.js";
import { cache } from "../api/base-resource.js";
import { fixtureAccount } from "./accounting-workflow.js";
import type { Account } from "../types/api.js";

/** The live Seppo OÜ evidence row (2026-10-18): cost account 7910 / dimension 942283, article 11, rate 9. */
export const COST_ACCOUNT = 7910;
export const COST_DIMENSION = 942283;

export const nonDeductibleItem = (overrides: Record<string, unknown> = {}) => ({
  custom_title: "Delfi tellimus",
  cl_purchase_articles_id: 45,
  purchase_accounts_id: COST_ACCOUNT,
  purchase_accounts_dimensions_id: COST_DIMENSION,
  vat_accounts_id: COST_ACCOUNT,
  vat_accounts_dimensions_id: COST_DIMENSION,
  cl_vat_articles_id: 11,
  vat_rate_dropdown: "9",
  total_net_price: 11.92,
  amount: 1,
  ...overrides,
});

export const chart = (overrides: { costIsVatAccount?: boolean } = {}): Account[] => [
  fixtureAccount({ id: COST_ACCOUNT, name_est: "Muud kulud", allows_dimensions: true, is_vat_account: overrides.costIsVatAccount ?? false }),
  fixtureAccount({ id: 6000, name_est: "Teenused", is_vat_account: false }),
  fixtureAccount({ id: 1510, name_est: "Sisendkäibemaks", is_vat_account: true }),
];

const round2 = (value: number) => Math.round(value * 100) / 100;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type Row = Record<string, any>;

/** What the server stores for a written row: item VAT from the gross override, else net × rate (the API's own computation). */
function serveItem(item: Row, index: number): Row {
  const net = item.total_net_price ?? round2((item.unit_net_price ?? 0) * (item.amount ?? 1));
  const rate = Number(String(item.vat_rate_dropdown ?? "0").replace(",", ".")) || 0;
  const vat = item.project_no_vat_gross_price != null ? round2(item.project_no_vat_gross_price - net) : round2(net * rate / 100);
  return { unit_net_price: null, base_total_net_price: net, vat_rate: rate, ...item, id: item.id ?? 7000 + index, total_net_price: net, vat_amount: vat };
}

export interface FakeEarveldajaOptions {
  vatNumber?: string | null;
  accounts?: Account[];
  /** Rewrites the n-th (1-based) GET of an invoice before it is returned (tamper hooks for P2/P3/P4). */
  onGet?: (invoice: Row, nth: number) => Row;
}

export function fakeEarveldaja(options: FakeEarveldajaOptions = {}) {
  const state = {
    vatNumber: options.vatNumber === undefined ? null : options.vatNumber,
    accounts: options.accounts ?? chart(),
    dimensions: [{ id: COST_DIMENSION, accounts_id: COST_ACCOUNT, title_est: "Meedia", is_deleted: false }],
    invoices: new Map<number, Row>(),
    getCounts: new Map<number, number>(),
    nextId: 5208707,
    calls: [] as Array<{ method: string; path: string; body?: unknown }>,
  };

  const store = (id: number, header: Row, items: Row[]) => {
    const served = items.map(serveItem);
    const net = round2(served.reduce((sum, item) => sum + item.total_net_price, 0));
    const previous = state.invoices.get(id);
    const vat = header.vat_price ?? previous?.vat_price ?? 0;
    const gross = header.gross_price ?? previous?.gross_price ?? 0;
    state.invoices.set(id, {
      ...previous, ...header, id, status: previous?.status ?? "PROJECT",
      cl_currencies_id: header.cl_currencies_id ?? previous?.cl_currencies_id ?? "EUR", currency_rate: header.currency_rate ?? previous?.currency_rate ?? 1,
      net_price: net, vat_price: vat, gross_price: gross,
      base_net_price: header.base_net_price ?? net, base_vat_price: header.base_vat_price ?? vat, base_gross_price: header.base_gross_price ?? gross,
      items: served,
    });
  };

  const get = vi.fn(async (path: string, params?: Record<string, unknown>) => {
    state.calls.push({ method: "GET", path, ...(params ? { body: params } : {}) });
    if (path === "/vat_info") return { vat_number: state.vatNumber };
    if (path === "/accounts") return clone(state.accounts);
    if (path === "/account_dimensions") return clone(state.dimensions);
    if (path === "/purchase_articles") return [];
    if (path === "/purchase_invoices") return { current_page: 1, total_pages: 1, items: [...state.invoices.values()].map(clone) };
    const match = /^\/purchase_invoices\/(\d+)$/.exec(path);
    if (match) {
      const id = Number(match[1]);
      const invoice = state.invoices.get(id);
      if (!invoice) throw new Error(`Missing purchase invoice ${id}`);
      const nth = (state.getCounts.get(id) ?? 0) + 1;
      state.getCounts.set(id, nth);
      return options.onGet ? options.onGet(clone(invoice), nth) : clone(invoice);
    }
    throw new Error(`fake e-arveldaja: unexpected GET ${path}`);
  });
  const post = vi.fn(async (path: string, body: Row) => {
    state.calls.push({ method: "POST", path, body: clone(body) });
    if (path !== "/purchase_invoices") throw new Error(`fake e-arveldaja: unexpected POST ${path}`);
    const id = state.nextId++;
    const { items, vat_price: _vat, gross_price: _gross, ...header } = body;
    store(id, header, items ?? []);
    return { code: 200, created_object_id: id, messages: [] };
  });
  const patch = vi.fn(async (path: string, body: Row) => {
    state.calls.push({ method: "PATCH", path, body: clone(body) });
    const action = /^\/purchase_invoices\/(\d+)\/(register|invalidate)$/.exec(path);
    if (action) {
      state.invoices.get(Number(action[1]))!.status = action[2] === "register" ? "CONFIRMED" : "VOID";
      return { code: 200, messages: [] };
    }
    const match = /^\/purchase_invoices\/(\d+)$/.exec(path);
    if (!match) throw new Error(`fake e-arveldaja: unexpected PATCH ${path}`);
    const { items, ...header } = body;
    store(Number(match[1]), header, items ?? state.invoices.get(Number(match[1]))!.items);
    return { code: 200, messages: [] };
  });
  const request = vi.fn(async (path: string, init: { method?: string; body?: unknown }) => {
    state.calls.push({ method: init.method ?? "GET", path });
    return { code: 200, messages: [] };
  });
  const client = {
    cacheNamespace: `nondeductible-${Math.random().toString(16).slice(2)}`,
    connectionFingerprint: "fake",
    apiBaseUrl: "https://fake.invalid",
    get, post, patch, request, delete: vi.fn(),
  } as unknown as HttpClient;

  const purchaseInvoices = new PurchaseInvoicesApi(client);
  const readonly = new ReferenceDataApi(client);

  /** Adds a stored draft directly (as the e-arveldaja UI would have saved it). */
  const seed = (header: Row, items: Row[]): number => {
    const id = state.nextId++;
    store(id, header, items);
    return id;
  };

  const writes = () => state.calls.filter((call) => call.method !== "GET");
  const posts = () => state.calls.filter((call) => call.method === "POST");
  const totalsPatches = () => state.calls.filter((call) => call.method === "PATCH" && /^\/purchase_invoices\/\d+$/.test(call.path));
  const registers = () => state.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/register"));
  const invalidations = () => state.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/invalidate"));
  const accountReads = () => state.calls.filter((call) => call.method === "GET" && call.path === "/accounts");

  return { state, client, purchaseInvoices, readonly, seed, writes, posts, totalsPatches, registers, invalidations, accountReads, get, post, patch };
}

export type FakeEarveldaja = ReturnType<typeof fakeEarveldaja>;

/** Drops the response and reference-data caches the real API classes share across tests. */
export function resetApiCaches(): void {
  cache.invalidate();
  readonlyCache.invalidate();
}
