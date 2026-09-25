import { describe, it, expect, beforeEach, vi } from "vitest";
import { ReferenceDataApi, readonlyCache } from "./readonly.api.js";
import { HttpError, type HttpClient } from "../http-client.js";
import { MutationIndeterminateError } from "../mutation-outcome.js";

function makeClient(): HttpClient {
  return {
    cacheNamespace: "connection:0",
    connectionFingerprint: "test-connection-fingerprint",
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
  } as unknown as HttpClient;
}

const OK = { code: 200, messages: [] };

type WriteCase = {
  label: string;
  method: "post" | "patch" | "delete";
  cacheKey: string;
  entity: string;
  operation: string;
  entityId?: number;
  businessKey: string;
  call: (api: ReferenceDataApi) => Promise<unknown>;
};

const writeCases: WriteCase[] = [
  { label: "updateInvoiceInfo", method: "patch", cacheKey: "connection:0:/invoice_info", entity: "invoice_info", operation: "update", businessKey: "/invoice_info:update", call: api => api.updateInvoiceInfo({}) },
  { label: "createInvoiceSeries", method: "post", cacheKey: "connection:0:/invoice_series:all", entity: "invoice_series", operation: "create", businessKey: "/invoice_series:create", call: api => api.createInvoiceSeries({}) },
  { label: "updateInvoiceSeries", method: "patch", cacheKey: "connection:0:/invoice_series:all", entity: "invoice_series", operation: "update", entityId: 7, businessKey: "/invoice_series:7", call: api => api.updateInvoiceSeries(7, {}) },
  { label: "deleteInvoiceSeries", method: "delete", cacheKey: "connection:0:/invoice_series:all", entity: "invoice_series", operation: "delete", entityId: 7, businessKey: "/invoice_series:7", call: api => api.deleteInvoiceSeries(7) },
  { label: "createBankAccount", method: "post", cacheKey: "connection:0:/bank_accounts:all", entity: "bank_account", operation: "create", businessKey: "/bank_accounts:create", call: api => api.createBankAccount({}) },
  { label: "updateBankAccount", method: "patch", cacheKey: "connection:0:/bank_accounts:all", entity: "bank_account", operation: "update", entityId: 3, businessKey: "/bank_accounts:3", call: api => api.updateBankAccount(3, {}) },
  { label: "deleteBankAccount", method: "delete", cacheKey: "connection:0:/bank_accounts:all", entity: "bank_account", operation: "delete", entityId: 3, businessKey: "/bank_accounts:3", call: api => api.deleteBankAccount(3) },
];

describe("ReferenceDataApi writes use the shared mutation-outcome classifier", () => {
  beforeEach(() => {
    readonlyCache.invalidate();
  });

  it.each(writeCases)("$label success invalidates the affected readonly cache", async row => {
    const client = makeClient();
    vi.mocked(client[row.method]).mockResolvedValue(OK);
    readonlyCache.set(row.cacheKey, "stale");
    readonlyCache.set("connection:0:/accounts:all", "unrelated");

    await expect(row.call(new ReferenceDataApi(client))).resolves.toEqual(OK);

    expect(readonlyCache.get(row.cacheKey)).toBeUndefined();
    expect(readonlyCache.get("connection:0:/accounts:all")).toBe("unrelated");
  });

  it.each(writeCases)("$label 500 → MutationIndeterminateError with cache eviction", async row => {
    const client = makeClient();
    vi.mocked(client[row.method]).mockRejectedValue(new HttpError("server error", 500, row.method.toUpperCase(), "/x"));
    readonlyCache.set(row.cacheKey, "stale");

    const error = await row.call(new ReferenceDataApi(client)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MutationIndeterminateError);
    expect(error).toMatchObject({
      category: "mutation_indeterminate",
      mutationMayHaveOccurred: true,
      operation: row.operation,
      entity: row.entity,
      entityId: row.entityId,
      businessKey: row.businessKey,
      cause: { status: 500 },
    });
    expect((error as MutationIndeterminateError).nextAction).toMatch(/^Re-read .* before deciding whether to retry/);
    expect(readonlyCache.get(row.cacheKey)).toBeUndefined();
  });

  it("classifies network drops and 408 as indeterminate", async () => {
    for (const status of ["network", 408] as const) {
      const client = makeClient();
      vi.mocked(client.post).mockRejectedValue(new HttpError("drop", status, "POST", "/bank_accounts"));
      await expect(new ReferenceDataApi(client).createBankAccount({})).rejects.toBeInstanceOf(MutationIndeterminateError);
    }
  });

  it.each(writeCases)("$label 422 is definitive: rethrown unchanged, cache kept", async row => {
    const client = makeClient();
    const rejection = new HttpError("unprocessable", 422, row.method.toUpperCase(), "/x");
    vi.mocked(client[row.method]).mockRejectedValue(rejection);
    readonlyCache.set(row.cacheKey, "cached");

    await expect(row.call(new ReferenceDataApi(client))).rejects.toBe(rejection);
    expect(readonlyCache.get(row.cacheKey)).toBe("cached");
  });
});
