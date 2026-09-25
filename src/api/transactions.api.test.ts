import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LinkedInvoiceClientMismatchError,
  LinkedInvoiceClientsAmbiguousError,
  StoredTypeDirectionMismatchError,
  TransactionsApi,
} from "./transactions.api.js";
import { cache } from "./base-resource.js";
import type { HttpClient } from "../http-client.js";
import { HttpError } from "../http-client.js";
import { MutationIndeterminateError } from "../mutation-outcome.js";

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

  it("skips the clients_id auto-fix when autoFixClientsId is false, even with a null client", async () => {
    const { client, patchCalls } = makeClient({
      getById: (path: string) => (path === "/transactions/9" ? { id: 9, clients_id: null } : undefined),
    });
    const api = new TransactionsApi(client);

    // The plan-bound reconciliation executor books the clients_id fix as its own
    // enumerated command, so confirm() must NOT silently look up and set it here.
    await api.confirm(9, [{ related_table: "purchase_invoices", related_id: 88, amount: 25 }], { autoFixClientsId: false });

    expect(client.get).not.toHaveBeenCalledWith("/purchase_invoices/88");
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]!.path).toBe("/transactions/9/register");
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

  it("H03 API preserves an auto-set client when register and reread are ambiguous", async () => {
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
    cache.set("test:/transactions:list:page=1", { stale: true });
    cache.set("test:/journals:list:page=1", { stale: true });

    const outcome = api.confirm(9, [{ related_table: "purchase_invoices", related_id: 88, amount: 10 }]);
    await expect(outcome).rejects.toBeInstanceOf(MutationIndeterminateError);
    await expect(outcome).rejects.toMatchObject({
        name: "MutationIndeterminateError",
        category: "mutation_indeterminate",
        mutationMayHaveOccurred: true,
        operation: "confirm",
        entity: "transaction",
        entityId: 9,
        businessKey: "transaction:9",
        affectedCaches: ["/transactions", "/journals"],
        cause: {
          name: "HttpError",
          message: "fetch failed",
          status: "network",
          method: "GET",
          path: "/transactions/9",
        },
      });

    expect(patchCalls).toEqual([
      { path: "/transactions/9", body: { clients_id: 42 } },
      { path: "/transactions/9/register", body: expect.any(Array) },
    ]);
    expect(patchCalls).not.toContainEqual({ path: "/transactions/9", body: { clients_id: null } });
    expect(cache.get("test:/transactions:list:page=1")).toBeUndefined();
    expect(cache.get("test:/journals:list:page=1")).toBeUndefined();
  });

  it("H03 API preserves an already-set explicit client when register and reread are ambiguous", async () => {
    let txReads = 0;
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/10") {
          txReads += 1;
          if (txReads === 1) return { id: 10, clients_id: 42 };
          throw new HttpError("read lost", "network", "GET", "/transactions/10");
        }
        return undefined;
      },
      patchHandler: ({ path }) => {
        if (path === "/transactions/10/register") {
          throw new HttpError("register lost", "network", "PATCH", "/transactions/10/register");
        }
        return { code: 200, messages: [] };
      },
    });
    const api = new TransactionsApi(client);

    await expect(api.confirm(10, [{ related_table: "accounts", related_id: 4000, amount: 10 }]))
      .rejects.toMatchObject({
        category: "mutation_indeterminate",
        mutationMayHaveOccurred: true,
        operation: "confirm",
        entity: "transaction",
        entityId: 10,
        businessKey: "transaction:10",
        affectedCaches: ["/transactions", "/journals"],
        cause: {
          name: "HttpError",
          message: "read lost",
          status: "network",
          method: "GET",
          path: "/transactions/10",
        },
      });

    expect(patchCalls).toEqual([
      { path: "/transactions/10/register", body: expect.any(Array) },
    ]);
  });

  it("H03 API preserves the client when a fresh reread has an unexpected status", async () => {
    let txReads = 0;
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/11") {
          txReads += 1;
          return txReads === 1
            ? { id: 11, clients_id: null }
            : { id: 11, clients_id: 42, status: "VOID" };
        }
        if (path === "/purchase_invoices/88") return { id: 88, clients_id: 42 };
        return undefined;
      },
      patchHandler: ({ path }) => {
        if (path === "/transactions/11/register") {
          throw new HttpError("register lost", "network", "PATCH", "/transactions/11/register");
        }
        return { code: 200, messages: [] };
      },
    });
    const api = new TransactionsApi(client);
    cache.set("test:/transactions:list:page=1", { stale: true });
    cache.set("test:/journals:list:page=1", { stale: true });

    await expect(api.confirm(11, [{ related_table: "purchase_invoices", related_id: 88, amount: 10 }]))
      .rejects.toMatchObject({
        category: "mutation_indeterminate",
        mutationMayHaveOccurred: true,
        operation: "confirm",
        entity: "transaction",
        entityId: 11,
        businessKey: "transaction:11",
        affectedCaches: ["/transactions", "/journals"],
        cause: {
          name: "HttpError",
          message: "register lost",
          status: "network",
          method: "PATCH",
          path: "/transactions/11/register",
        },
      });

    expect(patchCalls).toEqual([
      { path: "/transactions/11", body: { clients_id: 42 } },
      { path: "/transactions/11/register", body: expect.any(Array) },
    ]);
    expect(cache.get("test:/transactions:list:page=1")).toBeUndefined();
    expect(cache.get("test:/transactions:11")).toBeUndefined();
    expect(cache.get("test:/journals:list:page=1")).toBeUndefined();
  });

  it("H03 API exposes ambiguous API-auto cleanup as rollback and invalidates transactions", async () => {
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/12") return { id: 12, clients_id: null };
        if (path === "/purchase_invoices/88") return { id: 88, clients_id: 42 };
        return undefined;
      },
      patchHandler: ({ path, body }) => {
        if (path === "/transactions/12/register") {
          throw new HttpError("rejected", 409, "PATCH", "/transactions/12/register");
        }
        if (path === "/transactions/12" && (body as Record<string, unknown>).clients_id === null) {
          cache.set("test:/transactions:12", { stale: true });
          throw new HttpError("cleanup lost", "network", "PATCH", "/transactions/12");
        }
        return { code: 200, messages: [] };
      },
    });
    const api = new TransactionsApi(client);

    await expect(api.confirm(12, [{ related_table: "purchase_invoices", related_id: 88, amount: 10 }]))
      .rejects.toMatchObject({
        name: "MutationIndeterminateError",
        category: "mutation_indeterminate",
        mutationMayHaveOccurred: true,
        operation: "rollback",
        entity: "transaction",
        entityId: 12,
        businessKey: "transaction:12",
        affectedCaches: ["/transactions"],
        cause: {
          name: "HttpError",
          message: "cleanup lost",
          status: "network",
          method: "PATCH",
          path: "/transactions/12",
        },
        nextAction: "Freshly read transaction 12; clients_id cleanup may or may not have committed.",
      });

    expect(patchCalls).toEqual([
      { path: "/transactions/12", body: { clients_id: 42 } },
      { path: "/transactions/12/register", body: expect.any(Array) },
      { path: "/transactions/12", body: { clients_id: null } },
    ]);
    expect(cache.get("test:/transactions:12")).toBeUndefined();
  });

  it("M01 H03 leaves an incomplete structural cleanup ambiguity on the compound-failure path", async () => {
    const incomplete = Object.assign(new Error("incomplete cleanup ambiguity"), {
      category: "mutation_indeterminate" as const,
      mutationMayHaveOccurred: true as const,
      operation: "update" as const,
      entity: "transaction",
      entityId: 13,
      businessKey: "/transactions:13",
      affectedCaches: ["/transactions"],
      cause: {
        name: "HttpError",
        message: "cleanup lost",
        status: "network" as const,
        method: "TRACE",
        path: "/transactions/13",
      },
      nextAction: "Intermediate M01 recovery.",
    });
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/13") return { id: 13, clients_id: null };
        if (path === "/purchase_invoices/88") return { id: 88, clients_id: 42 };
        return undefined;
      },
      patchHandler: ({ path, body }) => {
        if (path === "/transactions/13/register") {
          throw new HttpError("rejected", 409, "PATCH", "/transactions/13/register");
        }
        if (path === "/transactions/13" && (body as Record<string, unknown>).clients_id === null) {
          throw incomplete;
        }
        return { code: 200, messages: [] };
      },
    });
    const api = new TransactionsApi(client);

    await expect(api.confirm(13, [{ related_table: "purchase_invoices", related_id: 88, amount: 10 }]))
      .rejects.toThrow(
        /Transaction 13 confirmation failed: rejected.*Rollback of clients_id also failed: incomplete cleanup ambiguity.*manual review required/s,
      );

    expect(patchCalls).toEqual([
      { path: "/transactions/13", body: { clients_id: 42 } },
      { path: "/transactions/13/register", body: expect.any(Array) },
      { path: "/transactions/13", body: { clients_id: null } },
    ]);
  });

  it("M01 H03 contains a throwing cleanup cause getter on the compound-failure path", async () => {
    const getterBacked = Object.assign(new Error("getter-backed cleanup ambiguity"), {
      category: "mutation_indeterminate" as const,
      mutationMayHaveOccurred: true as const,
      operation: "update" as const,
      entity: "transaction",
      entityId: 14,
      businessKey: "/transactions:14",
      affectedCaches: ["/transactions"],
      nextAction: "Intermediate M01 recovery.",
    });
    Object.defineProperty(getterBacked, "cause", {
      enumerable: false,
      get() {
        throw new Error("malicious cause getter");
      },
    });
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/14") return { id: 14, clients_id: null };
        if (path === "/purchase_invoices/88") return { id: 88, clients_id: 42 };
        return undefined;
      },
      patchHandler: ({ path, body }) => {
        if (path === "/transactions/14/register") {
          throw new HttpError("rejected", 409, "PATCH", "/transactions/14/register");
        }
        if (path === "/transactions/14" && (body as Record<string, unknown>).clients_id === null) {
          throw getterBacked;
        }
        return { code: 200, messages: [] };
      },
    });
    const api = new TransactionsApi(client);

    await expect(api.confirm(14, [{ related_table: "purchase_invoices", related_id: 88, amount: 10 }]))
      .rejects.toThrow(
        /Transaction 14 confirmation failed: rejected.*Rollback of clients_id also failed: getter-backed cleanup ambiguity.*manual review required/s,
      );

    expect(patchCalls).toEqual([
      { path: "/transactions/14", body: { clients_id: 42 } },
      { path: "/transactions/14/register", body: expect.any(Array) },
      { path: "/transactions/14", body: { clients_id: null } },
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

describe("TransactionsApi.confirm linked-invoice client guard", () => {
  beforeEach(() => cache.invalidate());

  function makeMismatchClient(txId: number, options: { patchHandler?: (call: PatchCall) => unknown } = {}) {
    // Live EIS shape: the payer (Rahandusministeerium) is not the invoice's
    // client (EIS), so the journal would land in the payer's sub-ledger.
    return makeClient({
      getById: (path) => {
        if (path === `/transactions/${txId}`) return { id: txId, clients_id: 2309260 };
        if (path === "/sale_invoices/77") return { id: 77, clients_id: 2327264 };
        return undefined;
      },
      patchHandler: options.patchHandler,
    });
  }

  const saleDistribution = [{ related_table: "sale_invoices", related_id: 77, amount: 1488 }];

  it("refuses to register when the payer differs from the linked invoice's client", async () => {
    const { client, patchCalls } = makeMismatchClient(20);
    const api = new TransactionsApi(client);

    const outcome = api.confirm(20, saleDistribution);
    await expect(outcome).rejects.toBeInstanceOf(LinkedInvoiceClientMismatchError);
    await expect(outcome).rejects.toMatchObject({
      name: "LinkedInvoiceClientMismatchError",
      category: "linked_invoice_client_mismatch",
      transaction_id: 20,
      transaction_clients_id: 2309260,
      invoice_table: "sale_invoices",
      invoice_id: 77,
      invoice_clients_id: 2327264,
      next_action: expect.stringContaining("reassign_client_to_invoice: true"),
    });

    // Refused before any mutation — no client update, no register call.
    expect(patchCalls).toEqual([]);
  });

  it("exposes the guard fields as enumerable own properties for toolError", () => {
    const error = new LinkedInvoiceClientMismatchError({
      transactionId: 20,
      transactionClientsId: 2309260,
      invoiceTable: "sale_invoices",
      invoiceId: 77,
      invoiceClientsId: 2327264,
    });

    expect(Object.keys(error).sort()).toEqual([
      "category",
      "invoice_clients_id",
      "invoice_id",
      "invoice_table",
      "name",
      "next_action",
      "transaction_clients_id",
      "transaction_id",
    ]);
  });

  it("reassigns the transaction to the invoice client before registering when approved", async () => {
    const { client, patchCalls } = makeMismatchClient(21);
    const api = new TransactionsApi(client);

    await api.confirm(21, saleDistribution, { reassignClientToInvoice: true });

    expect(patchCalls).toEqual([
      { path: "/transactions/21", body: { clients_id: 2327264 } },
      { path: "/transactions/21/register", body: saleDistribution },
    ]);
    // Only the client moves — the payer's name on the statement row is untouched.
    expect(Object.keys(patchCalls[0]!.body as Record<string, unknown>)).toEqual(["clients_id"]);
  });

  it("restores the original payer client when the register call fails after reassignment", async () => {
    const { client, patchCalls } = makeMismatchClient(22, {
      patchHandler: ({ path }) => {
        if (path === "/transactions/22/register") throw new Error("upstream rejected register");
        return { code: 200, messages: [] };
      },
    });
    const api = new TransactionsApi(client);

    await expect(api.confirm(22, saleDistribution, { reassignClientToInvoice: true }))
      .rejects.toThrow("upstream rejected register");

    expect(patchCalls).toEqual([
      { path: "/transactions/22", body: { clients_id: 2327264 } },
      { path: "/transactions/22/register", body: expect.any(Array) },
      { path: "/transactions/22", body: { clients_id: 2309260 } },
    ]);
  });

  it("makes no update call when the transaction already carries the invoice client", async () => {
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/23") return { id: 23, clients_id: 2327264 };
        if (path === "/sale_invoices/77") return { id: 77, clients_id: 2327264 };
        return undefined;
      },
    });
    const api = new TransactionsApi(client);

    await api.confirm(23, saleDistribution, { reassignClientToInvoice: true });

    expect(patchCalls).toEqual([
      { path: "/transactions/23/register", body: saleDistribution },
    ]);
  });

  it("refuses before any mutation when the linked invoices belong to different clients, even with reassignment", async () => {
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/24") return { id: 24, clients_id: 2309260 };
        if (path === "/sale_invoices/77") return { id: 77, clients_id: 2327264 };
        if (path === "/sale_invoices/78") return { id: 78, clients_id: 999 };
        return undefined;
      },
    });
    const api = new TransactionsApi(client);

    const distribution = [
      { related_table: "sale_invoices", related_id: 77, amount: 1000 },
      { related_table: "sale_invoices", related_id: 78, amount: 488 },
    ];

    // One journal has one client (the transaction's), so invoice 78's receipt
    // would land in client 2309260's sub-ledger — whichever client is set.
    await expect(api.confirm(24, distribution)).rejects.toMatchObject({
      name: "LinkedInvoiceClientsAmbiguousError",
      category: "linked_invoice_clients_ambiguous",
      invoice_clients_ids: [2327264, 999],
    });
    await expect(api.confirm(24, distribution, { reassignClientToInvoice: true }))
      .rejects.toBeInstanceOf(LinkedInvoiceClientsAmbiguousError);
    expect(patchCalls).toEqual([]);
  });

  it("refuses when a client-less invoice sits next to another client's invoice", async () => {
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/26") return { id: 26, clients_id: 2309260 };
        if (path === "/sale_invoices/77") return { id: 77, clients_id: null };
        if (path === "/sale_invoices/78") return { id: 78, clients_id: 999 };
        return undefined;
      },
    });
    const api = new TransactionsApi(client);

    await expect(api.confirm(26, [
      { related_table: "sale_invoices", related_id: 77, amount: 10 },
      { related_table: "sale_invoices", related_id: 78, amount: 20 },
    ])).rejects.toMatchObject({ name: "LinkedInvoiceClientMismatchError", invoice_id: 78 });
    expect(patchCalls).toEqual([]);
  });

  it("does not block when the linked invoice carries no client of its own", async () => {
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/25") return { id: 25, clients_id: 2309260 };
        if (path === "/purchase_invoices/88") return { id: 88, clients_id: null };
        return undefined;
      },
    });
    const api = new TransactionsApi(client);

    await api.confirm(25, [{ related_table: "purchase_invoices", related_id: 88, amount: 25 }]);

    expect(patchCalls).toEqual([
      { path: "/transactions/25/register", body: expect.any(Array) },
    ]);
  });

  it("leaves an account-only distribution unguarded and unread", async () => {
    const { client, patchCalls } = makeClient({
      getById: (path) => (path === "/transactions/26" ? { id: 26, clients_id: 2309260 } : undefined),
    });
    const api = new TransactionsApi(client);

    await api.confirm(26, [{ related_table: "accounts", related_id: 5120, amount: 25 }]);

    expect(patchCalls).toEqual([
      { path: "/transactions/26/register", body: expect.any(Array) },
    ]);
  });
});

describe("TransactionsApi.confirm stored-type direction guard", () => {
  beforeEach(() => cache.invalidate());

  const accountDist = [{ related_table: "accounts", related_id: 1020, related_sub_id: 200, amount: 500 }];

  it.each([
    ["CAMT CRDT stored as C", "C", "Salary\n[e-arveldaja-mcp:camt d=CRDT s=abc123abc123abcd]", "incoming"],
    ["Wise OUT stored as D", "D", "WISE:T1 Vendor [source_direction=OUT]", "outgoing"],
  ])("refuses to register %s before any mutation, on every distribution kind", async (_label, type, description, direction) => {
    for (const options of [undefined, { autoFixClientsId: false }]) {
      cache.invalidate();
      const { client, patchCalls } = makeClient({
        getById: (path) => (path === "/transactions/40" ? { id: 40, clients_id: null, type, description } : undefined),
      });
      const api = new TransactionsApi(client);
      const outcome = api.confirm(40, accountDist, options);
      await expect(outcome).rejects.toBeInstanceOf(StoredTypeDirectionMismatchError);
      await expect(outcome).rejects.toMatchObject({
        category: "stored_type_direction_mismatch",
        transaction_id: 40,
        stored_type: type,
        signed_direction: direction,
      });
      expect(patchCalls).toEqual([]);
    }
  });

  it.each([
    ["signed CRDT stored as D", "D", "x\n[e-arveldaja-mcp:camt d=CRDT s=abc123abc123abcd]"],
    ["signed OUT stored as C", "C", "WISE:T2 Vendor [source_direction=OUT]"],
    ["legacy unsigned C", "C", "card payment"],
    ["unsigned lookalike", "C", "note source_direction=IN"],
  ])("registers a consistent or unsigned row (%s)", async (_label, type, description) => {
    const { client, patchCalls } = makeClient({
      getById: (path) => (path === "/transactions/41" ? { id: 41, clients_id: 5, type, description } : undefined),
    });
    const api = new TransactionsApi(client);
    await api.confirm(41, accountDist, { autoFixClientsId: false });
    expect(patchCalls.map(c => c.path)).toEqual(["/transactions/41/register"]);
  });
});

describe("TransactionsApi.confirm client auto-fix safety", () => {
  beforeEach(() => cache.invalidate());

  it("never writes clients_id null when the linked invoice has no client", async () => {
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/50") return { id: 50, clients_id: null };
        if (path === "/purchase_invoices/88") return { id: 88, clients_id: null };
        if (path === "/purchase_invoices/89") return { id: 89, clients_id: 42 };
        return undefined;
      },
    });
    const api = new TransactionsApi(client);
    await api.confirm(50, [
      { related_table: "purchase_invoices", related_id: 88, amount: 10 },
      { related_table: "purchase_invoices", related_id: 89, amount: 15 },
    ]);
    expect(patchCalls.map(c => c.body)).not.toContainEqual({ clients_id: null });
    expect(patchCalls[0]).toEqual({ path: "/transactions/50", body: { clients_id: 42 } });
  });

  it("refuses instead of picking the first client when invoices belong to several clients", async () => {
    const { client, patchCalls } = makeClient({
      getById: (path) => {
        if (path === "/transactions/51") return { id: 51, clients_id: null };
        if (path === "/sale_invoices/77") return { id: 77, clients_id: 1 };
        if (path === "/sale_invoices/78") return { id: 78, clients_id: 2 };
        return undefined;
      },
    });
    const api = new TransactionsApi(client);
    const outcome = api.confirm(51, [
      { related_table: "sale_invoices", related_id: 77, amount: 10 },
      { related_table: "sale_invoices", related_id: 78, amount: 15 },
    ]);
    await expect(outcome).rejects.toBeInstanceOf(LinkedInvoiceClientsAmbiguousError);
    await expect(outcome).rejects.toMatchObject({ category: "linked_invoice_clients_ambiguous", invoice_clients_ids: [1, 2] });
    expect(patchCalls).toEqual([]);
  });
});
