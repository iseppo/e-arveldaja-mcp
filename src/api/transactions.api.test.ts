import { beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionsApi } from "./transactions.api.js";
import { cache } from "./base-resource.js";
import type { HttpClient } from "../http-client.js";
import { HttpError } from "../http-client.js";

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

  it("recovers a committed registration on a network error without rolling back clients_id", async () => {
    let txReads = 0;
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/6") {
          txReads += 1;
          // First read (auto-fix check) sees no client; the post-error re-read
          // sees the registration committed (CONFIRMED) with the client set.
          return txReads === 1
            ? { id: 6, clients_id: null }
            : { id: 6, clients_id: 42, status: "CONFIRMED" };
        }
        if (path === "/purchase_invoices/88") return { id: 88, clients_id: 42 };
        return undefined;
      },
      patchHandler: ({ path }) => {
        if (path === "/transactions/6/register") {
          throw new HttpError("fetch failed", "network", "PATCH", "/transactions/6/register");
        }
        return { code: 200, messages: [] };
      },
    });
    const api = new TransactionsApi(client);

    const result = await api.confirm(6, [{ related_table: "purchase_invoices", related_id: 88, amount: 10 }]);

    // Reports success (recovered) rather than throwing; no created_object_id.
    expect(result.created_object_id).toBeUndefined();
    // clients_id auto-fix + register attempt, but NO rollback (no clients_id:null).
    expect(patchCalls).toEqual([
      { path: "/transactions/6", body: { clients_id: 42 } },
      { path: "/transactions/6/register", body: expect.any(Array) },
    ]);
  });

  it("rolls back and rethrows when the re-read shows the registration did not commit", async () => {
    let txReads = 0;
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/7") {
          txReads += 1;
          return txReads === 1
            ? { id: 7, clients_id: null }
            : { id: 7, clients_id: 42, status: "PROJECT" };
        }
        if (path === "/purchase_invoices/88") return { id: 88, clients_id: 42 };
        return undefined;
      },
      patchHandler: ({ path }) => {
        if (path === "/transactions/7/register") {
          throw new HttpError("fetch failed", "network", "PATCH", "/transactions/7/register");
        }
        return { code: 200, messages: [] };
      },
    });
    const api = new TransactionsApi(client);

    await expect(api.confirm(7, [{ related_table: "purchase_invoices", related_id: 88, amount: 10 }]))
      .rejects.toThrow(HttpError);

    // Not committed → clients_id is rolled back to null.
    expect(patchCalls).toEqual([
      { path: "/transactions/7", body: { clients_id: 42 } },
      { path: "/transactions/7/register", body: expect.any(Array) },
      { path: "/transactions/7", body: { clients_id: null } },
    ]);
  });

  it("does NOT roll back clients_id when the state is indeterminate (re-read also fails)", async () => {
    // Network error on register AND the status re-read throws → we cannot tell
    // whether the journal committed. Rolling back clients_id could corrupt a
    // committed journal's buyer/supplier, so it must be LEFT AS SET and the
    // error must flag the indeterminate state (never a silent rollback).
    let txReads = 0;
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/9") {
          txReads += 1;
          if (txReads === 1) return { id: 9, clients_id: null }; // pre-fix read
          throw new HttpError("fetch failed", "network", "GET", "/transactions/9"); // re-read fails
        }
        if (path === "/purchase_invoices/88") return { id: 88, clients_id: 42 };
        return undefined;
      },
      patchHandler: ({ path }) => {
        if (path === "/transactions/9/register") {
          throw new HttpError("fetch failed", "network", "PATCH", "/transactions/9/register");
        }
        return { code: 200, messages: [] };
      },
    });
    const api = new TransactionsApi(client);

    await expect(api.confirm(9, [{ related_table: "purchase_invoices", related_id: 88, amount: 10 }]))
      .rejects.toThrow(/indeterminate/i);

    // clients_id was set by the auto-fix, register was attempted, but there is
    // NO rollback patch ({ clients_id: null }) — the mutation stays intact.
    expect(patchCalls).toEqual([
      { path: "/transactions/9", body: { clients_id: 42 } },
      { path: "/transactions/9/register", body: expect.any(Array) },
    ]);
  });

  it("does not verify or recover on a non-network HTTP error", async () => {
    let txReads = 0;
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/8") {
          txReads += 1;
          return { id: 8, clients_id: null };
        }
        if (path === "/purchase_invoices/88") return { id: 88, clients_id: 42 };
        return undefined;
      },
      patchHandler: ({ path }) => {
        if (path === "/transactions/8/register") {
          throw new HttpError("bad request", 400, "PATCH", "/transactions/8/register");
        }
        return { code: 200, messages: [] };
      },
    });
    const api = new TransactionsApi(client);

    await expect(api.confirm(8, [{ related_table: "purchase_invoices", related_id: 88, amount: 10 }]))
      .rejects.toThrow(HttpError);

    // Only the auto-fix read happened — no post-error re-read for verification.
    expect(txReads).toBe(1);
    // Rollback still occurs on the definite failure.
    expect(patchCalls).toContainEqual({ path: "/transactions/8", body: { clients_id: null } });
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
