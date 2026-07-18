import { describe, it, expect, beforeEach, vi } from "vitest";
import { BaseResource, cache } from "./base-resource.js";
import type { PaginatedResponse, ApiResponse } from "../types/api.js";
import { HttpError, type HttpClient } from "../http-client.js";
import { MutationIndeterminateError } from "../mutation-outcome.js";
import { reportProgress } from "../progress.js";
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

function pageCacheKey(page: number): string {
  return `connection:0:/items:list:page=${String(page)}`;
}

const paginationSentinels = {
  "connection:0:/items:list:": "default-page",
  "connection:0:/items:list:page=1": "page-one",
  "connection:0:/items:list:page=10": "page-ten",
  "connection:0:/items:listAll": "aggregate",
  "connection:0:/products:list:": "products",
  "connection:1:/items:list:page=2": "other-connection",
} as const;

function seedPaginationSentinels(except?: string): void {
  for (const [key, value] of Object.entries(paginationSentinels)) {
    if (key !== except) cache.set(key, value);
  }
}

function expectPaginationSentinels(except?: string): void {
  for (const [key, value] of Object.entries(paginationSentinels)) {
    if (key !== except) expect(cache.get(key)).toBe(value);
  }
}

describe("BaseResource", () => {
  beforeEach(() => {
    cache.invalidate(); // clear all entries between tests
    vi.mocked(reportProgress).mockReset().mockResolvedValue(undefined);
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
      const page2 = paginated([{ id: 2, name: "b" }], 2, 2);
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

  describe("M02 page validation", () => {
    const responseCases = [
      {
        label: "null response",
        requestedPage: 2,
        response: null,
        message: "Pagination page 2: response must be a non-null object; received null",
      },
      {
        label: "primitive response",
        requestedPage: 2,
        response: 7,
        message: "Pagination page 2: response must be a non-null object; received 7",
      },
      {
        label: "array response",
        requestedPage: 2,
        response: [],
        message: "Pagination page 2: response must be a non-null object; received []",
      },
      {
        label: "missing items",
        requestedPage: 2,
        response: { current_page: 2, total_pages: 2 },
        message: "Pagination page 2: items must be an array; received undefined",
      },
      {
        label: "non-array items",
        requestedPage: 2,
        response: { current_page: 2, total_pages: 2, items: "not-an-array" },
        message: "Pagination page 2: items must be an array; received \"not-an-array\"",
      },
      {
        label: "mismatched current page",
        requestedPage: 2,
        response: { current_page: 1, total_pages: 2, items: [] },
        message: "Pagination page 2: current_page must equal requested page 2; received 1",
      },
      {
        label: "noninteger current page",
        requestedPage: 2,
        response: { current_page: 2.5, total_pages: 3, items: [] },
        message: "Pagination page 2: current_page must equal requested page 2; received 2.5",
      },
      {
        label: "zero total pages",
        requestedPage: 1,
        response: { current_page: 1, total_pages: 0, items: [] },
        message: "Pagination page 1: total_pages must be a positive integer at least 1; received 0",
      },
      {
        label: "total pages below requested page",
        requestedPage: 2,
        response: { current_page: 2, total_pages: 1, items: [] },
        message: "Pagination page 2: total_pages must be a positive integer at least 2; received 1",
      },
      {
        label: "fractional total pages",
        requestedPage: 2,
        response: { current_page: 2, total_pages: 2.5, items: [] },
        message: "Pagination page 2: total_pages must be a positive integer at least 2; received 2.5",
      },
      {
        label: "NaN total pages",
        requestedPage: 2,
        response: { current_page: 2, total_pages: Number.NaN, items: [] },
        message: "Pagination page 2: total_pages must be a positive integer at least 2; received NaN",
      },
      {
        label: "infinite total pages",
        requestedPage: 2,
        response: { current_page: 2, total_pages: Number.POSITIVE_INFINITY, items: [] },
        message: "Pagination page 2: total_pages must be a positive integer at least 2; received Infinity",
      },
    ] as const;

    it.each(responseCases)(
      "M02 rejects a fresh $label and removes only its exact cache key",
      async ({ requestedPage, response, message }) => {
        const client = makeClient();
        const resource = new BaseResource<Item>(client, "/items");
        const exactKey = pageCacheKey(requestedPage);
        seedPaginationSentinels(exactKey);
        vi.mocked(client.get).mockResolvedValueOnce(response as PaginatedResponse<Item>);

        const thrown = await resource.list({ page: requestedPage }).catch(error => error);

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.constructor.name).toBe("PaginationMetadataError");
        expect(thrown.message).toBe(message);
        expect(client.get).toHaveBeenCalledTimes(1);
        expect(cache.get(exactKey)).toBeUndefined();
        expectPaginationSentinels(exactKey);
      },
    );

    it.each(responseCases)(
      "M02 rejects a cached $label and removes only its exact cache key",
      async ({ requestedPage, response, message }) => {
        const client = makeClient();
        const resource = new BaseResource<Item>(client, "/items");
        const exactKey = pageCacheKey(requestedPage);
        seedPaginationSentinels(exactKey);
        cache.set(exactKey, response);

        const thrown = await resource.list({ page: requestedPage }).catch(error => error);

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.constructor.name).toBe("PaginationMetadataError");
        expect(thrown.message).toBe(message);
        expect(client.get).not.toHaveBeenCalled();
        expect(cache.get(exactKey)).toBeUndefined();
        expectPaginationSentinels(exactKey);
      },
    );

    it.each([
      [0, "Pagination page 0: requested page must be a positive integer; received 0"],
      [-1, "Pagination page -1: requested page must be a positive integer; received -1"],
      [1.5, "Pagination page 1.5: requested page must be a positive integer; received 1.5"],
      [Number.NaN, "Pagination page NaN: requested page must be a positive integer; received NaN"],
      [Number.POSITIVE_INFINITY, "Pagination page Infinity: requested page must be a positive integer; received Infinity"],
    ] as const)("M02 rejects requested page %s before cache or transport access", async (requestedPage, message) => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");
      const exactKey = pageCacheKey(requestedPage);
      seedPaginationSentinels(exactKey);
      const generation = cache.generation;
      const cacheGetSpy = vi.spyOn(cache, "get");

      const thrown = await resource.list({ page: requestedPage }).catch(error => error);

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.constructor.name).toBe("PaginationMetadataError");
      expect(thrown.message).toBe(message);
      expect(client.get).not.toHaveBeenCalled();
      expect(cache.generation).toBe(generation);
      expect(cacheGetSpy).not.toHaveBeenCalled();
      cacheGetSpy.mockRestore();
      expect(cache.get(exactKey)).toBeUndefined();
      expectPaginationSentinels(exactKey);
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

  describe("M02 traversal stability", () => {
    const traversalCases = [
      {
        label: "shrinking total_pages",
        firstTotal: 3,
        secondPage: 2,
        secondTotal: 2,
        message: "Pagination page 2: total_pages changed from 3 to 2",
        checksStableTotalBeforeItems: true,
      },
      {
        label: "expanding total_pages",
        firstTotal: 2,
        secondPage: 2,
        secondTotal: 3,
        message: "Pagination page 2: total_pages changed from 2 to 3",
        checksStableTotalBeforeItems: true,
      },
      {
        label: "repeated current_page metadata",
        firstTotal: 2,
        secondPage: 1,
        secondTotal: 2,
        message: "Pagination page 2: current_page must equal requested page 2; received 1",
        checksStableTotalBeforeItems: false,
      },
    ] as const;

    const traversalModes = (["fresh", "cached"] as const).flatMap(mode =>
      traversalCases.map(row => ({ mode, ...row })),
    );

    it.each(traversalModes)(
      "M02 rejects $label during a $mode traversal before consuming the bad page and cleans only this resource",
      async ({ mode, ...row }) => {
        const client = makeClient();
        const resource = new BaseResource<Item>(client, "/items");
        const secondItems = [{ id: 2, name: "must-not-be-consumed" }];
        const iterator = vi.spyOn(secondItems, Symbol.iterator);
        const first = paginated([{ id: 1, name: "first" }], 1, row.firstTotal);
        const second = paginated(secondItems, row.secondPage, row.secondTotal);
        const third = paginated([{ id: 3, name: "third" }], 3, 3);
        cache.set("connection:0:/items:listAll", "stale-aggregate");
        cache.set("connection:0:/items:list:page=99", "stale-page");
        cache.set("connection:0:/products:list:", "products");
        cache.set("connection:1:/items:list:page=1", "other-connection");

        if (mode === "cached") {
          cache.set(pageCacheKey(1), first);
          cache.set(pageCacheKey(2), second);
          cache.set(pageCacheKey(3), third);
        } else {
          vi.mocked(client.get)
            .mockResolvedValueOnce(first)
            .mockResolvedValueOnce(second)
            .mockResolvedValueOnce(third);
        }
        const invalidateSpy = vi.spyOn(cache, "invalidate");
        invalidateSpy.mockClear();

        const thrown = await resource.listAll().catch(error => error);

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.constructor.name).toBe("PaginationMetadataError");
        expect(thrown.message).toBe(row.message);
        expect(client.get).toHaveBeenCalledTimes(mode === "fresh" ? 2 : 0);
        if (row.checksStableTotalBeforeItems) expect(iterator).not.toHaveBeenCalled();
        expect(invalidateSpy).toHaveBeenCalledTimes(1);
        expect(invalidateSpy).toHaveBeenCalledWith("connection:0:/items");
        expect(cache.get("connection:0:/items:listAll")).toBeUndefined();
        expect(cache.get(pageCacheKey(1))).toBeUndefined();
        expect(cache.get(pageCacheKey(2))).toBeUndefined();
        expect(cache.get(pageCacheKey(3))).toBeUndefined();
        expect(cache.get("connection:0:/items:list:page=99")).toBeUndefined();
        expect(cache.get("connection:0:/products:list:")).toBe("products");
        expect(cache.get("connection:1:/items:list:page=1")).toBe("other-connection");
      },
    );

    it("M02 listAllCached does not write an aggregate after typed traversal failure", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");
      vi.mocked(client.get)
        .mockResolvedValueOnce(paginated([{ id: 1, name: "first" }], 1, 2))
        .mockResolvedValueOnce(paginated([{ id: 2, name: "second" }], 2, 3))
        .mockResolvedValueOnce(paginated([{ id: 3, name: "third" }], 3, 3));
      cache.set("connection:0:/products:list:", "products");
      cache.set("connection:1:/items:list:page=1", "other-connection");

      const thrown = await resource.listAllCached().catch(error => error);

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.constructor.name).toBe("PaginationMetadataError");
      expect(thrown.message).toBe("Pagination page 2: total_pages changed from 2 to 3");
      expect(client.get).toHaveBeenCalledTimes(2);
      expect(cache.get("connection:0:/items:listAll")).toBeUndefined();
      expect(cache.get(pageCacheKey(1))).toBeUndefined();
      expect(cache.get(pageCacheKey(2))).toBeUndefined();
      expect(cache.get("connection:0:/products:list:")).toBe("products");
      expect(cache.get("connection:1:/items:list:page=1")).toBe("other-connection");
    });

    function seedNegativeControlSentinels(): void {
      cache.set("connection:0:/items:listAll", "aggregate", 600);
      cache.set("connection:0:/items:list:page=99", "page-99", 600);
      cache.set("connection:0:/items:42", "item-42", 600);
      cache.set("connection:0:/products:list:", "products", 600);
      cache.set("connection:1:/items:list:page=1", "other-connection", 600);
    }

    function expectNegativeControlSentinels(): void {
      expect(cache.get("connection:0:/items:listAll")).toBe("aggregate");
      expect(cache.get("connection:0:/items:list:page=99")).toBe("page-99");
      expect(cache.get("connection:0:/items:42")).toBe("item-42");
      expect(cache.get("connection:0:/products:list:")).toBe("products");
      expect(cache.get("connection:1:/items:list:page=1")).toBe("other-connection");
    }

    it("M02 preserves raw upstream error identity and resource caches", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");
      const upstreamError = new Error("upstream unavailable");
      seedNegativeControlSentinels();
      vi.mocked(client.get).mockRejectedValueOnce(upstreamError);
      const generation = cache.generation;

      const thrown = await resource.listAll().catch(error => error);

      expect(thrown).toBe(upstreamError);
      expect(cache.generation).toBe(generation);
      expectNegativeControlSentinels();
    });

    it("M02 preserves reportProgress error identity and resource caches", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");
      const progressError = new Error("progress channel closed");
      seedNegativeControlSentinels();
      vi.mocked(client.get).mockResolvedValueOnce(paginated([{ id: 1, name: "first" }], 1, 2));
      vi.mocked(reportProgress).mockRejectedValueOnce(progressError);
      const generation = cache.generation;

      const thrown = await resource.listAll().catch(error => error);

      expect(thrown).toBe(progressError);
      expect(cache.generation).toBe(generation);
      expectNegativeControlSentinels();
      expect(cache.get(pageCacheKey(1))).toEqual(paginated([{ id: 1, name: "first" }], 1, 2));
    });

    it("M02 preserves caches on deadline timeout", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
        const client = makeClient();
        const resource = new BaseResource<Item>(client, "/items");
        seedNegativeControlSentinels();
        vi.mocked(client.get).mockImplementationOnce(async () => {
          vi.advanceTimersByTime(300_001);
          return paginated([{ id: 1, name: "first" }], 1, 2);
        });
        const generation = cache.generation;

        const thrown = await resource.listAll().catch(error => error);

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.message).toContain("pagination timed out after 5 minutes");
        expect(cache.generation).toBe(generation);
        expectNegativeControlSentinels();
        expect(cache.get(pageCacheKey(1))).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("M02 preserves caches on max-page breach", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");
      seedNegativeControlSentinels();
      vi.mocked(client.get).mockResolvedValueOnce(paginated([{ id: 1, name: "first" }], 1, 2));
      const generation = cache.generation;

      const thrown = await resource.listAll(undefined, 1).catch(error => error);

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).toContain("Data exceeds 1 pages");
      expect(cache.generation).toBe(generation);
      expectNegativeControlSentinels();
      expect(cache.get(pageCacheKey(1))).toBeDefined();
    });

    it("M02 preserves caches on max-item breach", async () => {
      const client = makeClient();
      const resource = new BaseResource<Item>(client, "/items");
      seedNegativeControlSentinels();
      vi.mocked(client.get).mockResolvedValueOnce(paginated([
        { id: 1, name: "first" },
        { id: 2, name: "second" },
      ]));
      const generation = cache.generation;

      const thrown = await resource.listAll(undefined, 200, 1).catch(error => error);

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).toContain("item count (2) exceeds limit of 1");
      expect(cache.generation).toBe(generation);
      expectNegativeControlSentinels();
      expect(cache.get(pageCacheKey(1))).toBeDefined();
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
