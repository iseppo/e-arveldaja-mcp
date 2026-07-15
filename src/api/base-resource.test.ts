import { describe, it, expect, beforeEach, vi } from "vitest";
import { BaseResource, cache } from "./base-resource.js";
import type { PaginatedResponse, ApiResponse } from "../types/api.js";
import { HttpError, type HttpClient } from "../http-client.js";
import { MutationIndeterminateError } from "../mutation-outcome.js";
import { ClientsApi } from "./clients.api.js";
import { ProductsApi } from "./products.api.js";
import { JournalsApi } from "./journals.api.js";
import { TransactionsApi } from "./transactions.api.js";
import { SaleInvoicesApi } from "./sale-invoices.api.js";
import { PurchaseInvoicesApi } from "./purchase-invoices.api.js";

// Mock logger and progress so tests don't write to stderr or fail on missing context
vi.mock("../logger.js", () => ({ log: vi.fn() }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));

type Item = { id: number; name: string };

function makeClient(namespace = "connection:0"): HttpClient {
  return {
    cacheNamespace: namespace,
    connectionFingerprint: "test-connection-fingerprint",
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
  } as unknown as HttpClient;
}

function paginated(items: Item[], page = 1, totalPages = 1): PaginatedResponse<Item> {
  return { current_page: page, total_pages: totalPages, items };
}

function apiResponse(): ApiResponse {
  return { code: 200, messages: [] };
}

describe("BaseResource", () => {
  beforeEach(() => {
    cache.invalidate(); // clear all entries between tests
  });

  it("H06-A exposes the client connection fingerprint", () => {
    expect(new BaseResource<Item>(makeClient(), "/items").connectionFingerprint)
      .toBe("test-connection-fingerprint");
  });

  // ── list() caching ────────────────────────────────────────────────────────

  describe("list()", () => {
    it("returns data from API on first call", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");
      const page = paginated([{ id: 1, name: "a" }]);
      vi.mocked(client.get).mockResolvedValueOnce(page);

      const result = await resource.list();
      expect(result).toEqual(page);
      expect(client.get).toHaveBeenCalledTimes(1);
    });

    it("returns cached result on second call without hitting API again", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");
      const page = paginated([{ id: 1, name: "a" }]);
      vi.mocked(client.get).mockResolvedValueOnce(page);

      await resource.list();
      const second = await resource.list();

      expect(second).toEqual(page);
      expect(client.get).toHaveBeenCalledTimes(1); // not called again
    });

    it("caches different param combinations separately", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");
      const page1 = paginated([{ id: 1, name: "a" }]);
      const page2 = paginated([{ id: 2, name: "b" }]);
      vi.mocked(client.get).mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

      const r1 = await resource.list({ page: 1 });
      const r2 = await resource.list({ page: 2 });

      expect(r1.items[0].id).toBe(1);
      expect(r2.items[0].id).toBe(2);
      expect(client.get).toHaveBeenCalledTimes(2);

      // Both are now cached
      const r1Again = await resource.list({ page: 1 });
      expect(r1Again.items[0].id).toBe(1);
      expect(client.get).toHaveBeenCalledTimes(2);
    });
  });

  // ── get() caching ─────────────────────────────────────────────────────────

  describe("get()", () => {
    it("fetches from API on first call", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");
      const item: Item = { id: 42, name: "thing" };
      vi.mocked(client.get).mockResolvedValueOnce(item);

      const result = await resource.get(42);
      expect(result).toEqual(item);
      expect(client.get).toHaveBeenCalledWith("/items/42");
    });

    it("returns cached result on second call", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");
      const item: Item = { id: 42, name: "thing" };
      vi.mocked(client.get).mockResolvedValueOnce(item);

      await resource.get(42);
      const second = await resource.get(42);

      expect(second).toEqual(item);
      expect(client.get).toHaveBeenCalledTimes(1);
    });

    it("caches different IDs independently", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");
      vi.mocked(client.get)
        .mockResolvedValueOnce({ id: 1, name: "one" })
        .mockResolvedValueOnce({ id: 2, name: "two" });

      await resource.get(1);
      await resource.get(2);

      const r1 = await resource.get(1);
      const r2 = await resource.get(2);

      expect(r1).toEqual({ id: 1, name: "one" });
      expect(r2).toEqual({ id: 2, name: "two" });
      expect(client.get).toHaveBeenCalledTimes(2); // not 4
    });
  });

  // ── create() / update() / delete() cache invalidation ────────────────────

  describe("create()", () => {
    it("invalidates cache before making API call", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");

      // Prime the cache
      vi.mocked(client.get).mockResolvedValueOnce(paginated([{ id: 1, name: "a" }]));
      await resource.list();
      expect(client.get).toHaveBeenCalledTimes(1);

      // create should clear the cache
      vi.mocked(client.post).mockResolvedValueOnce(apiResponse());
      await resource.create({ name: "b" });

      // Next list() must hit the API again
      vi.mocked(client.get).mockResolvedValueOnce(paginated([{ id: 1, name: "a" }, { id: 2, name: "b" }]));
      await resource.list();
      expect(client.get).toHaveBeenCalledTimes(2);
    });
  });

  describe("update()", () => {
    it("invalidates cache before making API call", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");

      vi.mocked(client.get)
        .mockResolvedValueOnce({ id: 5, name: "old" })
        .mockResolvedValueOnce({ id: 5, name: "new" });
      await resource.get(5);

      vi.mocked(client.patch).mockResolvedValueOnce(apiResponse());
      await resource.update(5, { name: "new" });

      // Cache was cleared — next get hits API
      await resource.get(5);
      expect(client.get).toHaveBeenCalledTimes(2);
    });
  });

  describe("delete()", () => {
    it("invalidates cache before making API call", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");

      vi.mocked(client.get)
        .mockResolvedValueOnce(paginated([{ id: 3, name: "x" }]))
        .mockResolvedValueOnce(paginated([]));
      await resource.list();

      vi.mocked(client.delete).mockResolvedValueOnce(apiResponse());
      await resource.delete(3);

      await resource.list();
      expect(client.get).toHaveBeenCalledTimes(2);
    });
  });

  // ── document_user (getDocument / uploadDocument / deleteDocument) ─────────

  describe("document_user methods", () => {
    it("getDocument GETs /{basePath}/{id}/document_user", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/journals");
      const file = { name: "receipt.pdf", contents: "YmFzZTY0" };
      vi.mocked(client.get).mockResolvedValueOnce(file);

      const result = await resource.getDocument(7);
      expect(result).toEqual(file);
      expect(client.get).toHaveBeenCalledWith("/journals/7/document_user");
    });

    it("uploadDocument PUTs {name, contents} and invalidates the cache", async () => {
      const client = makeClient();
      (client as unknown as { request: ReturnType<typeof vi.fn> }).request = vi.fn().mockResolvedValue(apiResponse());
      const resource = new BaseResource<Item>(client, "/transactions");

      // Prime the cache, then upload should clear it.
      vi.mocked(client.get).mockResolvedValueOnce({ id: 9, name: "x" });
      await resource.get(9);
      expect(client.get).toHaveBeenCalledTimes(1);

      await resource.uploadDocument(9, "scan.png", "Zm9v");
      expect((client as unknown as { request: ReturnType<typeof vi.fn> }).request).toHaveBeenCalledWith(
        "/transactions/9/document_user",
        { method: "PUT", body: { name: "scan.png", contents: "Zm9v" } },
      );

      // Cache cleared — next get hits the API again.
      vi.mocked(client.get).mockResolvedValueOnce({ id: 9, name: "x" });
      await resource.get(9);
      expect(client.get).toHaveBeenCalledTimes(2);
    });

    it("deleteDocument DELETEs the document_user path and invalidates the cache", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/sale_invoices");

      vi.mocked(client.get).mockResolvedValueOnce({ id: 4, name: "y" });
      await resource.get(4);

      vi.mocked(client.delete).mockResolvedValueOnce(apiResponse());
      await resource.deleteDocument(4);
      expect(client.delete).toHaveBeenCalledWith("/sale_invoices/4/document_user");

      vi.mocked(client.get).mockResolvedValueOnce({ id: 4, name: "y" });
      await resource.get(4);
      expect(client.get).toHaveBeenCalledTimes(2);
    });
  });

  // ── listAll() pagination ──────────────────────────────────────────────────

  describe("listAll()", () => {
    it("returns all items from a single page", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");
      vi.mocked(client.get).mockResolvedValueOnce(paginated([{ id: 1, name: "a" }], 1, 1));

      const items = await resource.listAll();
      expect(items).toEqual([{ id: 1, name: "a" }]);
      expect(client.get).toHaveBeenCalledTimes(1);
    });

    it("fetches all pages and concatenates items when total_pages > 1", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");

      vi.mocked(client.get)
        .mockResolvedValueOnce(paginated([{ id: 1, name: "a" }], 1, 3))
        .mockResolvedValueOnce(paginated([{ id: 2, name: "b" }], 2, 3))
        .mockResolvedValueOnce(paginated([{ id: 3, name: "c" }], 3, 3));

      const items = await resource.listAll();
      expect(items).toEqual([
        { id: 1, name: "a" },
        { id: 2, name: "b" },
        { id: 3, name: "c" },
      ]);
      expect(client.get).toHaveBeenCalledTimes(3);
    });

    it("throws when page count exceeds 200-page cap", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");

      // Simulate API always reporting 999 total pages — will trigger cap after 200 iterations
      vi.mocked(client.get).mockImplementation((_path, params) => {
        const page = (params as Record<string, number>)?.page ?? 1;
        return Promise.resolve(paginated([{ id: page, name: `item-${page}` }], page, 999));
      });

      await expect(resource.listAll()).rejects.toThrow(/200 pages/);
    });

    it("respects a custom maxPages cap", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");

      vi.mocked(client.get).mockImplementation((_path, params) => {
        const page = (params as Record<string, number>)?.page ?? 1;
        return Promise.resolve(paginated([{ id: page, name: `p${page}` }], page, 999));
      });

      await expect(resource.listAll(undefined, 5)).rejects.toThrow(/5 pages/);
    });
  });

  // ── cacheKey namespace scoping ────────────────────────────────────────────

  describe("cacheKey / namespace scoping", () => {
    it("does not share cache between different connection namespaces", async () => {
      const clientA = makeClient("connection:0");
      const clientB = makeClient("connection:1");
      const resourceA = new BaseResource<Item>(clientA, "/items");
      const resourceB = new BaseResource<Item>(clientB, "/items");

      const pageA = paginated([{ id: 1, name: "company-a" }]);
      const pageB = paginated([{ id: 2, name: "company-b" }]);
      vi.mocked(clientA.get).mockResolvedValue(pageA);
      vi.mocked(clientB.get).mockResolvedValue(pageB);

      const rA = await resourceA.list();
      const rB = await resourceB.list();

      expect(rA.items[0].name).toBe("company-a");
      expect(rB.items[0].name).toBe("company-b");

      // Both resources should have been queried (separate cache keys)
      expect(clientA.get).toHaveBeenCalledTimes(1);
      expect(clientB.get).toHaveBeenCalledTimes(1);
    });

    it("invalidation on one namespace does not evict another namespace's cache", async () => {
      const clientA = makeClient("connection:0");
      const clientB = makeClient("connection:1");
      const resourceA = new BaseResource<Item>(clientA, "/items");
      const resourceB = new BaseResource<Item>(clientB, "/items");

      vi.mocked(clientA.get).mockResolvedValue(paginated([{ id: 1, name: "a" }]));
      vi.mocked(clientB.get).mockResolvedValue(paginated([{ id: 2, name: "b" }]));

      await resourceA.list();
      await resourceB.list();

      // Invalidate only connection:0
      vi.mocked(clientA.post).mockResolvedValueOnce(apiResponse());
      await resourceA.create({ name: "new" });

      // connection:0 cache cleared, must hit API
      vi.mocked(clientA.get).mockResolvedValueOnce(paginated([{ id: 1, name: "a" }, { id: 3, name: "new" }]));
      await resourceA.list();
      expect(clientA.get).toHaveBeenCalledTimes(2);

      // connection:1 cache still intact
      await resourceB.list();
      expect(clientB.get).toHaveBeenCalledTimes(1); // not called again
    });
  });

  describe("M01 ambiguous inherited mutations", () => {
    it("M01 evicts only the affected namespace resource caches after a raw network update", async () => {
      const client = makeClient();
      const resource = new ClientsApi(client);
      cache.set("connection:0:/clients:list:page=1", "client-list");
      cache.set("connection:0:/clients:listAll", "all-clients");
      cache.set("connection:0:/clients:5", "client-five");
      cache.set("connection:0:/products:list:", "products");
      cache.set("connection:1:/clients:list:", "other-company-clients");
      const networkError = new HttpError(
        "request failed after retries",
        "network",
        "PATCH",
        "/clients/5",
      );
      vi.mocked(client.patch).mockRejectedValueOnce(networkError);

      const thrown = await resource.update(5, { name: "updated" }).catch(error => error);

      expect(thrown).toBeInstanceOf(MutationIndeterminateError);
      expect(thrown).toMatchObject({
        category: "mutation_indeterminate",
        mutationMayHaveOccurred: true,
        operation: "update",
        entity: "client",
        entityId: 5,
        businessKey: "/clients:5",
        affectedCaches: ["/clients"],
        cause: {
          name: "HttpError",
          message: "request failed after retries",
          status: "network",
          method: "PATCH",
          path: "/clients/5",
        },
      });
      expect(cache.get("connection:0:/clients:list:page=1")).toBeUndefined();
      expect(cache.get("connection:0:/clients:listAll")).toBeUndefined();
      expect(cache.get("connection:0:/clients:5")).toBeUndefined();
      expect(cache.get("connection:0:/products:list:")).toBe("products");
      expect(cache.get("connection:1:/clients:list:")).toBe("other-company-clients");
    });

    const inheritedCases = [
      {
        label: "create",
        operation: "create",
        entityId: undefined,
        businessKey: "/clients:create",
        method: "POST",
        path: "/clients",
        invoke: (resource: ClientsApi) => resource.create({ name: "new" }),
        requestMock: (client: HttpClient) => client.post,
      },
      {
        label: "update",
        operation: "update",
        entityId: 5,
        businessKey: "/clients:5",
        method: "PATCH",
        path: "/clients/5",
        invoke: (resource: ClientsApi) => resource.update(5, { name: "updated" }),
        requestMock: (client: HttpClient) => client.patch,
      },
      {
        label: "delete",
        operation: "delete",
        entityId: 5,
        businessKey: "/clients:5",
        method: "DELETE",
        path: "/clients/5",
        invoke: (resource: ClientsApi) => resource.delete(5),
        requestMock: (client: HttpClient) => client.delete,
      },
      {
        label: "upload document",
        operation: "upload",
        entityId: 5,
        businessKey: "/clients:5:document_user",
        method: "PUT",
        path: "/clients/5/document_user",
        invoke: (resource: ClientsApi) => resource.uploadDocument(5, "scan.pdf", "base64"),
        requestMock: (client: HttpClient) => client.request,
      },
      {
        label: "delete document",
        operation: "delete",
        entityId: 5,
        businessKey: "/clients:5:document_user",
        method: "DELETE",
        path: "/clients/5/document_user",
        invoke: (resource: ClientsApi) => resource.deleteDocument(5),
        requestMock: (client: HttpClient) => client.delete,
      },
    ] as const;

    it.each(inheritedCases)("M01 serializes raw network metadata for inherited $label", async row => {
      const client = makeClient();
      const resource = new ClientsApi(client);
      cache.set("connection:0:/clients:list:", "clients");
      cache.set("connection:0:/products:list:", "products");
      const networkError = new HttpError("ambiguous transport", "network", row.method, row.path);
      vi.mocked(row.requestMock(client)).mockRejectedValueOnce(networkError);

      const thrown = await row.invoke(resource).catch(error => error);

      expect(thrown).toBeInstanceOf(MutationIndeterminateError);
      expect(thrown).toMatchObject({
        operation: row.operation,
        entity: "client",
        businessKey: row.businessKey,
        affectedCaches: ["/clients"],
        cause: {
          name: "HttpError",
          message: "ambiguous transport",
          status: "network",
          method: row.method,
          path: row.path,
        },
      });
      expect(thrown.entityId).toBe(row.entityId);
      expect(thrown.nextAction).toContain(row.businessKey);
      expect(thrown.nextAction).toMatch(/do not repeat/i);
      expect(row.requestMock(client)).toHaveBeenCalledTimes(1);
      expect(cache.get("connection:0:/clients:list:")).toBeUndefined();
      expect(cache.get("connection:0:/products:list:")).toBe("products");
    });

    it.each([
      ["400", new HttpError("bad request", 400, "PATCH", "/clients/5")],
      ["409", new HttpError("conflict", 409, "PATCH", "/clients/5")],
      ["503", new HttpError("unavailable", 503, "PATCH", "/clients/5")],
      ["ordinary", new Error("ordinary failure")],
    ] as const)("M01 preserves a definite %s failure without cache eviction", async (_label, failure) => {
      const client = makeClient();
      const resource = new ClientsApi(client);
      cache.set("connection:0:/clients:list:", "clients");
      const generation = cache.generation;
      vi.mocked(client.patch).mockRejectedValueOnce(failure);

      const thrown = await resource.update(5, { name: "updated" }).catch(error => error);

      expect(thrown).toBe(failure);
      expect(cache.get("connection:0:/clients:list:")).toBe("clients");
      expect(cache.generation).toBe(generation);
    });

    it("M01 rethrows structured ambiguity by identity and invalidates the deduplicated cache union", async () => {
      const client = makeClient();
      const resource = new ClientsApi(client);
      cache.set("connection:0:/clients:list:", "clients");
      cache.set("connection:0:/products:list:", "products");
      cache.set("connection:0:/journals:list:", "journals");
      const structured = new MutationIndeterminateError({
        operation: "update",
        entity: "client",
        entityId: 5,
        businessKey: "external-client-key",
        affectedCaches: ["/clients", "/products", "/products"],
        cause: new HttpError("socket closed", "network", "PATCH", "/clients/5"),
        nextAction: "Use the original recovery action.",
      });
      const originalFields = {
        entityId: structured.entityId,
        businessKey: structured.businessKey,
        cause: structured.cause,
        nextAction: structured.nextAction,
        affectedCaches: [...structured.affectedCaches],
      };
      const generation = cache.generation;
      vi.mocked(client.patch).mockRejectedValueOnce(structured);

      const thrown = await resource.update(5, { name: "updated" }).catch(error => error);

      expect(thrown).toBe(structured);
      expect(structured).toMatchObject(originalFields);
      expect(structured.affectedCaches).toEqual(["/clients", "/products", "/products"]);
      expect(cache.generation).toBe(generation + 2);
      expect(cache.get("connection:0:/clients:list:")).toBeUndefined();
      expect(cache.get("connection:0:/products:list:")).toBeUndefined();
      expect(cache.get("connection:0:/journals:list:")).toBe("journals");
    });

    it("M01 ignores empty unknown and noncanonical declared cache prefixes", async () => {
      const client = makeClient();
      const resource = new ClientsApi(client);
      cache.set("connection:0:/clients:list:", "clients");
      cache.set("connection:0:/products:list:", "products");
      cache.set("connection:0:/journals:list:", "journals");
      cache.set("connection:1:/clients:list:", "other-company-clients");
      const structural = {
        category: "mutation_indeterminate",
        mutationMayHaveOccurred: true,
        operation: "update",
        entity: "client",
        entityId: 5,
        businessKey: "external-client-key",
        affectedCaches: [
          "",
          "/",
          "/unknown",
          "connection:0:",
          "/products/5",
          "/products",
          "/products",
        ],
        cause: { name: "HttpError", message: "network", status: "network" },
        nextAction: "Inspect state.",
      };
      const generation = cache.generation;
      vi.mocked(client.patch).mockRejectedValueOnce(structural);

      const thrown = await resource.update(5, { name: "updated" }).catch(error => error);

      expect(thrown).toBe(structural);
      expect(cache.generation).toBe(generation + 2);
      expect(cache.get("connection:0:/clients:list:")).toBeUndefined();
      expect(cache.get("connection:0:/products:list:")).toBeUndefined();
      expect(cache.get("connection:0:/journals:list:")).toBe("journals");
      expect(cache.get("connection:1:/clients:list:")).toBe("other-company-clients");
    });

    it("M01 invalidates the mandatory local prefix when affectedCaches access throws", async () => {
      const client = makeClient();
      const resource = new ClientsApi(client);
      cache.set("connection:0:/clients:list:", "clients");
      cache.set("connection:0:/products:list:", "products");
      const structural = {
        category: "mutation_indeterminate",
        mutationMayHaveOccurred: true,
        operation: "update",
        entity: "client",
        entityId: 5,
        businessKey: "external-client-key",
        get affectedCaches(): string[] {
          throw new Error("malicious cache getter");
        },
        cause: { name: "HttpError", message: "network", status: "network" },
        nextAction: "Inspect state.",
      };
      const generation = cache.generation;
      vi.mocked(client.patch).mockRejectedValueOnce(structural);

      const thrown = await resource.update(5, { name: "updated" }).catch(error => error);

      expect(thrown).toBe(structural);
      expect(cache.generation).toBe(generation + 1);
      expect(cache.get("connection:0:/clients:list:")).toBeUndefined();
      expect(cache.get("connection:0:/products:list:")).toBe("products");
    });

    it.each([
      [ClientsApi, "/clients", "client"],
      [ProductsApi, "/products", "product"],
      [JournalsApi, "/journals", "journal"],
      [TransactionsApi, "/transactions", "transaction"],
      [SaleInvoicesApi, "/sale_invoices", "sale_invoice"],
      [PurchaseInvoicesApi, "/purchase_invoices", "purchase_invoice"],
    ] as const)("M01 maps inherited ambiguity for %s to singular %s metadata", async (Api, path, entity) => {
      const client = makeClient();
      const resource = new Api(client);
      vi.mocked(client.patch).mockRejectedValueOnce(
        new HttpError("network ambiguity", "network", "PATCH", `${path}/5`),
      );

      const thrown = await resource.update(5, {}).catch(error => error);

      expect(thrown).toBeInstanceOf(MutationIndeterminateError);
      expect(thrown).toMatchObject({
        operation: "update",
        entity,
        entityId: 5,
        businessKey: `${path}:5`,
        affectedCaches: [path],
      });
    });
  });
});
