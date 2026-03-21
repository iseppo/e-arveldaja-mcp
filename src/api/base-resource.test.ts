import { describe, it, expect, beforeEach, vi } from "vitest";
import { BaseResource, cache } from "./base-resource.js";
import type { PaginatedResponse, ApiResponse } from "../types/api.js";
import type { HttpClient } from "../http-client.js";

// Mock logger and progress so tests don't write to stderr or fail on missing context
vi.mock("../logger.js", () => ({ log: vi.fn() }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));

type Item = { id: number; name: string };

function makeClient(namespace = "connection:0"): HttpClient {
  return {
    cacheNamespace: namespace,
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
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
});
