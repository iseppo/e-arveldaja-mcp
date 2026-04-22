import { describe, it, expect, beforeEach, vi } from "vitest";
import { SaleInvoicesApi } from "./sale-invoices.api.js";
import { cache } from "./base-resource.js";
import type { HttpClient } from "../http-client.js";

vi.mock("../logger.js", () => ({ log: vi.fn() }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));

function makeClient(namespace = "connection:0"): HttpClient {
  return {
    cacheNamespace: namespace,
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn().mockResolvedValue({ code: 200, messages: [] }),
    delete: vi.fn(),
  } as unknown as HttpClient;
}

describe("SaleInvoicesApi.confirm", () => {
  beforeEach(() => cache.invalidate());

  it("calls PATCH /sale_invoices/{id}/register", async () => {
    const client = makeClient();
    const api = new SaleInvoicesApi(client);
    await api.confirm(42);
    expect(client.patch).toHaveBeenCalledWith("/sale_invoices/42/register", {});
  });

  it("busts /journals cache so trial balance doesn't serve stale data", async () => {
    const client = makeClient();
    const api = new SaleInvoicesApi(client);
    cache.set("connection:0:/journals:list:page=1", { stale: true });
    cache.set("connection:0:/sale_invoices:list:page=1", { stale: true });

    await api.confirm(42);

    expect(cache.get("connection:0:/journals:list:page=1")).toBeUndefined();
    expect(cache.get("connection:0:/sale_invoices:list:page=1")).toBeUndefined();
  });
});

describe("SaleInvoicesApi.invalidate", () => {
  beforeEach(() => cache.invalidate());

  it("calls PATCH /sale_invoices/{id}/invalidate", async () => {
    const client = makeClient();
    const api = new SaleInvoicesApi(client);
    await api.invalidate(17);
    expect(client.patch).toHaveBeenCalledWith("/sale_invoices/17/invalidate", {});
  });

  it("busts /journals cache so the reversed journal entry is not hidden by stale cache", async () => {
    const client = makeClient();
    const api = new SaleInvoicesApi(client);
    cache.set("connection:0:/journals:list:page=1", { stale: true });
    cache.set("connection:0:/sale_invoices:17", { stale: true });

    await api.invalidate(17);

    expect(cache.get("connection:0:/journals:list:page=1")).toBeUndefined();
    expect(cache.get("connection:0:/sale_invoices:17")).toBeUndefined();
  });
});
