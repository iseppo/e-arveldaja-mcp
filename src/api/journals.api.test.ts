import { describe, it, expect, beforeEach, vi } from "vitest";
import { JournalsApi } from "./journals.api.js";
import { cache } from "./base-resource.js";
import type { HttpClient } from "../http-client.js";
import type { CreateJournalRequest, UpdateJournalRequest } from "../types/mutations.js";

vi.mock("../logger.js", () => ({ log: vi.fn() }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));

function makeClient(namespace = "connection:0"): HttpClient {
  return {
    cacheNamespace: namespace,
    connectionFingerprint: "fp:0",
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ code: 200, created_object_id: 7, messages: [] }),
    patch: vi.fn().mockResolvedValue({ code: 200, messages: [] }),
    delete: vi.fn(),
  } as unknown as HttpClient;
}

describe("JournalsApi.create (narrowed request boundary)", () => {
  beforeEach(() => cache.invalidate());

  it("POSTs the caller payload to /journals and returns the ApiResponse", async () => {
    const client = makeClient();
    const api = new JournalsApi(client);
    const request: CreateJournalRequest = {
      title: "Manual entry",
      effective_date: "2026-07-24",
      document_number: "BANK:stmt-1",
      cl_currencies_id: "EUR",
      postings: [{ accounts_id: 1020, type: "D", amount: 10 }],
    };
    const result = await api.create(request);
    expect(client.post).toHaveBeenCalledWith("/journals", request);
    expect(result.created_object_id).toBe(7);
  });

  it("invalidates the journals cache after a successful create", async () => {
    const client = makeClient();
    const api = new JournalsApi(client);
    cache.set("connection:0:/journals:list:page=1", { stale: true });
    await api.create({
      effective_date: "2026-07-24",
      postings: [{ accounts_id: 1020, type: "D", amount: 10 }],
    });
    expect(cache.get("connection:0:/journals:list:page=1")).toBeUndefined();
  });
});

describe("JournalsApi.update (narrowed request boundary)", () => {
  beforeEach(() => cache.invalidate());

  it("PATCHes /journals/{id} with the update request and busts the id cache", async () => {
    const client = makeClient();
    const api = new JournalsApi(client);
    cache.set("connection:0:/journals:55", { stale: true });
    const request: UpdateJournalRequest = { title: "renamed" };
    await api.update(55, request);
    expect(client.patch).toHaveBeenCalledWith("/journals/55", request);
    expect(cache.get("connection:0:/journals:55")).toBeUndefined();
  });
});

describe("JournalsApi.confirm / invalidate", () => {
  beforeEach(() => cache.invalidate());

  it("confirm calls PATCH /journals/{id}/register and busts /transactions", async () => {
    const client = makeClient();
    const api = new JournalsApi(client);
    cache.set("connection:0:/transactions:list:page=1", { stale: true });
    await api.confirm(9);
    expect(client.patch).toHaveBeenCalledWith("/journals/9/register", {});
    expect(cache.get("connection:0:/transactions:list:page=1")).toBeUndefined();
  });

  it("invalidate calls PATCH /journals/{id}/invalidate", async () => {
    const client = makeClient();
    const api = new JournalsApi(client);
    await api.invalidate(9);
    expect(client.patch).toHaveBeenCalledWith("/journals/9/invalidate", {});
  });
});
