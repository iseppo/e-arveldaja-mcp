import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "./http-client.js";

const config = {
  apiKeyId: "test-key-id",
  apiPublicValue: "test-public-value",
  apiPassword: "test-password",
  baseUrl: "https://rmp-api.rik.ee/v1",
};

describe("HttpClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("retries 429 and 5xx responses with exponential backoff", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: ["rate limited"] }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: ["temporary failure"] }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config);
    const promise = client.get<{ ok: boolean }>("/clients");

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 1_000)).toBe(true);
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 2_000)).toBe(true);
  });

  it("retries retryable network errors for GET requests", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config);
    const promise = client.get<{ ok: boolean }>("/clients");

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries POST requests after network errors", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config);
    let caughtError: Error | undefined;
    const promise = client.post("/transactions", { amount: 10 }).catch((e: Error) => { caughtError = e; });

    await vi.runAllTimersAsync();
    await promise;

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toMatch(/API request failed: POST \/transactions → network error: fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    vi.useRealTimers();
  });

  it("does not retry POST requests after 5xx responses", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: ["temporary failure"] }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config);

    // Error.message now carries only the clean top-line (audit-log-safe);
    // upstream body text lives on HttpError.upstream_detail, sandbox-wrapped.
    try {
      await client.post("/transactions", { amount: 10 });
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as Error & { upstream_detail?: string };
      expect(e.message).toBe("API request failed: POST /transactions → 502");
      expect(e.upstream_detail).toMatch(/^<<UNTRUSTED_OCR_START:[0-9a-f]+>>\ntemporary failure\n<<UNTRUSTED_OCR_END:[0-9a-f]+>>$/);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries POST requests on 429 responses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: ["rate limited"] }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config);
    const promise = client.post<{ ok: boolean }>("/transactions", { amount: 10 });

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps 401 troubleshooting local without extra outbound lookups", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: ["Unauthorized"] }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config);
    const promise = client.get("/clients");
    const expectation = expect(promise).rejects.toThrow(/https:\/\/api\.ipify\.org/);

    await vi.runAllTimersAsync();

    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, "/purchase_invoices", "Validate the request body", "list_account_dimensions"],
    [422, "/journals", "Validate the request body", "list_accounts"],
    [403, "/clients", "Check API token permissions", "get_setup_instructions"],
    [404, "/clients/123", "Verify that the referenced record still exists", "search_client"],
    [409, "/purchase_invoices", "Resolve the conflict before retrying", "detect_duplicate_purchase_invoice"],
  ])("adds recovery hints and next actions for HTTP %i", async (status, path, hintText, nextTool) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: ["Upstream validation text"] }), {
        status,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config);

    try {
      await client.get(path);
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as Error & { recovery_hint?: string; next_actions?: Array<{ tool: string }> };
      expect(e.recovery_hint).toContain(hintText);
      expect(e.next_actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ tool: nextTool }),
      ]));
    }
  });

  it("adds a rate-limit recovery hint without advertising a non-existent retry tool", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValue(new Response(JSON.stringify({ messages: ["rate limited"] }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config);
    const promise = client.post("/transactions", { amount: 10 });
    const expectation = expect(promise).rejects.toMatchObject({
      recovery_hint: expect.stringContaining("Wait before retrying"),
      next_actions: undefined,
    });

    await vi.runAllTimersAsync();

    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("blocks a request before fetch when the request guard rejects", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config, "connection:0", () => {
      throw new Error("Active connection changed during tool execution.");
    });

    await expect(client.get("/clients")).rejects.toThrow(/Active connection changed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry an aborted GET once the request guard starts rejecting", async () => {
    let switched = false;
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";

    const fetchMock = vi.fn().mockImplementationOnce(async () => {
      switched = true;
      throw abortError;
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config, "connection:0", () => {
      if (switched) {
        throw new Error("Active connection changed during tool execution.");
      }
    });

    await expect(client.get("/clients")).rejects.toThrow(/Active connection changed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
