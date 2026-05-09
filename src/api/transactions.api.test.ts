import { beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionsApi } from "./transactions.api.js";
import { cache } from "./base-resource.js";
import type { HttpClient } from "../http-client.js";

vi.mock("../logger.js", () => ({ log: vi.fn() }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));

interface PatchCall {
  path: string;
  body: unknown;
}

function makeClient(options: {
  getById?: (path: string) => unknown;
  patchHandler?: (call: PatchCall) => unknown;
} = {}): { client: HttpClient; patchCalls: PatchCall[] } {
  const patchCalls: PatchCall[] = [];
  const client = {
    cacheNamespace: "test",
    get: vi.fn(async (path: string) => options.getById?.(path)),
    post: vi.fn(),
    patch: vi.fn(async (path: string, body: unknown) => {
      patchCalls.push({ path, body });
      return options.patchHandler ? options.patchHandler({ path, body }) : { code: 200, messages: [] };
    }),
    delete: vi.fn(),
  } as unknown as HttpClient;
  return { client, patchCalls };
}

describe("TransactionsApi.confirm", () => {
  beforeEach(() => cache.invalidate());

  it("registers without auto-fix when clients_id is already set", async () => {
    const { client, patchCalls } = makeClient({
      getById: () => ({ id: 1, clients_id: 7 }),
    });
    const api = new TransactionsApi(client);

    await api.confirm(1, [{ related_table: "purchase_invoices", related_id: 88, amount: 25 }]);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]!.path).toBe("/transactions/1/register");
  });

  it("auto-fixes missing clients_id from a purchase_invoice distribution before registering", async () => {
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/1") return { id: 1, clients_id: null };
        if (path === "/purchase_invoices/88") return { id: 88, clients_id: 42 };
        return undefined;
      },
    });
    const api = new TransactionsApi(client);

    await api.confirm(1, [{ related_table: "purchase_invoices", related_id: 88, amount: 25 }]);

    expect(patchCalls).toEqual([
      { path: "/transactions/1", body: { clients_id: 42 } },
      { path: "/transactions/1/register", body: [{ related_table: "purchase_invoices", related_id: 88, amount: 25 }] },
    ]);
  });

  it("auto-fixes missing clients_id from a sale_invoice distribution before registering", async () => {
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/2") return { id: 2, clients_id: null };
        if (path === "/sale_invoices/55") return { id: 55, clients_id: 99 };
        return undefined;
      },
    });
    const api = new TransactionsApi(client);

    await api.confirm(2, [{ related_table: "sale_invoices", related_id: 55, amount: 50 }]);

    expect(patchCalls[0]).toEqual({ path: "/transactions/2", body: { clients_id: 99 } });
    expect(patchCalls[1]!.path).toBe("/transactions/2/register");
  });

  it("rolls back clients_id when the register call fails after the auto-fix", async () => {
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/3") return { id: 3, clients_id: null };
        if (path === "/purchase_invoices/88") return { id: 88, clients_id: 42 };
        return undefined;
      },
      patchHandler: ({ path }) => {
        if (path === "/transactions/3/register") throw new Error("upstream rejected register");
        return { code: 200, messages: [] };
      },
    });
    const api = new TransactionsApi(client);

    await expect(api.confirm(3, [{ related_table: "purchase_invoices", related_id: 88, amount: 10 }]))
      .rejects.toThrow("upstream rejected register");

    expect(patchCalls).toEqual([
      { path: "/transactions/3", body: { clients_id: 42 } },
      { path: "/transactions/3/register", body: expect.any(Array) },
      { path: "/transactions/3", body: { clients_id: null } },
    ]);
  });

  it("throws a compound error mentioning manual review when both register and rollback fail", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { client } = makeClient({
      getById: (path) => {
        if (path === "/transactions/4") return { id: 4, clients_id: null };
        if (path === "/purchase_invoices/88") return { id: 88, clients_id: 42 };
        return undefined;
      },
      patchHandler: ({ path, body }) => {
        if (path === "/transactions/4/register") throw new Error("register failed");
        if (path === "/transactions/4" && (body as Record<string, unknown>).clients_id === null) {
          throw new Error("rollback failed");
        }
        return { code: 200, messages: [] };
      },
    });
    const api = new TransactionsApi(client);

    await expect(api.confirm(4, [{ related_table: "purchase_invoices", related_id: 88, amount: 10 }]))
      .rejects.toThrow(/Transaction 4 confirmation failed: register failed.*Rollback of clients_id also failed: rollback failed.*manual review required/s);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Failed to roll back clients_id on transaction 4"));
    stderr.mockRestore();
  });

  it("does not attempt rollback when the register fails but no auto-fix happened", async () => {
    const { client, patchCalls } = makeClient({
      getById: () => ({ id: 5, clients_id: 7 }),
      patchHandler: ({ path }) => {
        if (path === "/transactions/5/register") throw new Error("register failed");
        return { code: 200, messages: [] };
      },
    });
    const api = new TransactionsApi(client);

    await expect(api.confirm(5, [{ related_table: "purchase_invoices", related_id: 88, amount: 10 }]))
      .rejects.toThrow("register failed");

    // Only the register attempt — no preceding update, no rollback.
    expect(patchCalls).toEqual([
      { path: "/transactions/5/register", body: expect.any(Array) },
    ]);
  });

  it("busts /journals cache after a successful confirm", async () => {
    const { client } = makeClient({
      getById: () => ({ id: 6, clients_id: 7 }),
    });
    const api = new TransactionsApi(client);
    cache.set("test:/journals:list:page=1", { stale: true });
    cache.set("test:/transactions:list:page=1", { stale: true });

    await api.confirm(6, [{ related_table: "purchase_invoices", related_id: 88, amount: 10 }]);

    expect(cache.get("test:/journals:list:page=1")).toBeUndefined();
    expect(cache.get("test:/transactions:list:page=1")).toBeUndefined();
  });
});

describe("TransactionsApi.invalidate", () => {
  beforeEach(() => cache.invalidate());

  it("busts /journals and /transactions caches when invalidating a confirmed transaction", async () => {
    const { client, patchCalls } = makeClient();
    const api = new TransactionsApi(client);
    cache.set("test:/journals:list:page=1", { stale: true });
    cache.set("test:/transactions:list:page=1", { stale: true });

    await api.invalidate(7);

    expect(patchCalls).toEqual([{ path: "/transactions/7/invalidate", body: {} }]);
    expect(cache.get("test:/journals:list:page=1")).toBeUndefined();
    expect(cache.get("test:/transactions:list:page=1")).toBeUndefined();
  });
});
