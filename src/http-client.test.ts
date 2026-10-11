import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError, isNotFoundHttpError } from "./http-client.js";

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

  it("does not retry POST requests after network errors (ambiguous commit → duplicate-booking risk)", async () => {
    // A timed-out or connection-dropped POST is ambiguous: the server may have
    // already committed the mutation. Retrying would risk a duplicate booking,
    // so the network-error path throws immediately for non-idempotent methods.
    const fetchMock = vi.fn()
      .mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config);
    let caughtError: Error | undefined;
    await client.post("/transactions", { amount: 10 }).catch((e: Error) => { caughtError = e; });

    expect(caughtError).toBeDefined();
    // The message carries the error NAME/CODE only — never the raw fetch
    // message, which for some failures (invalid header value) echoes the
    // offending value and could leak the auth public value / signature.
    expect(caughtError!.message).toMatch(/API request failed: POST \/transactions → network error: TypeError/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry for POST
  });

  it("does not leak a raw fetch error message (only the error name/code)", async () => {
    // Node echoes the offending header value into an invalid-header error's
    // message; surfacing it would leak the public value / HMAC signature.
    const fetchMock = vi.fn().mockRejectedValue(
      new TypeError("Invalid header value SECRETpublicvalue:SIGNATUREbase64=="),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config);
    let caught: Error | undefined;
    // POST: non-idempotent, so it throws immediately (no retry/timer dance).
    await client.post("/transactions", { amount: 1 }).catch((e: Error) => { caught = e; });

    expect(caught).toBeDefined();
    expect(caught!.message).not.toMatch(/SECRET|SIGNATURE/);
    expect(caught!.message).toContain("network error: TypeError");
  });

  it("does not retry PATCH mutations after network errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config);
    await client.patch("/transactions/5/register", {}).catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry DELETE mutations after network errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config);
    await client.delete("/transactions/5").catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still retries idempotent PUT requests after network errors", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config);
    const promise = client.request<{ ok: boolean }>("/purchase_invoices/1/document_user", { method: "PUT", body: {} });

    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  describe("409 \"No such object.\" is flagged as upstream not-found (F7)", () => {
    async function rejectWith(
      method: "DELETE" | "PATCH" | "GET",
      path: string,
      body: string,
    ): Promise<HttpError> {
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response(body, {
        status: 409,
        headers: { "content-type": "application/json" },
      }));
      vi.stubGlobal("fetch", fetchMock);
      const client = new HttpClient(config);
      const call = method === "DELETE"
        ? client.delete(path)
        : method === "PATCH" ? client.patch(path, {}) : client.get(path);
      try {
        await call;
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        return err as HttpError;
      }
      return expect.fail("should have thrown");
    }

    it.each([
      ["DELETE", "/transactions/14090193"],
      ["PATCH", "/transactions/14090193/invalidate"],
    ] as const)("%s %s answering 409 [\"No such object.\"] gets not-found advice, status stays 409", async (method, path) => {
      const e = await rejectWith(method, path, JSON.stringify({ code: 409, messages: ["No such object."] }));
      expect(e.status).toBe(409);
      expect(e.upstream_not_found).toBe(true);
      expect(e.recovery_hint).toContain("Verify that the referenced record still exists");
      expect(e.next_actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ tool: "get_transaction", args: { id: 14090193 } }),
      ]));
      expect(e.next_actions!.map(action => action.tool)).not.toContain("reconcile_bank_transactions");
      expect(isNotFoundHttpError(e)).toBe(true);
    });

    it.each([
      ["every message matches", ["No such object.", "No such object."]],
      ["no trailing period", ["No such object"]],
      ["surrounding whitespace", ["  No such object.  "]],
      ["case-insensitive", ["no such object."]],
    ])("flags a 409 whose messages are all \"No such object.\" (%s)", async (_label, messages) => {
      const e = await rejectWith("DELETE", "/transactions/1", JSON.stringify({ messages }));
      expect(e.status).toBe(409);
      expect(e.upstream_not_found).toBe(true);
      expect(isNotFoundHttpError(e)).toBe(true);
    });

    it.each([
      ["a mixed message list", JSON.stringify({ messages: ["No such object.", "Other"] })],
      ["a message that only contains the phrase", JSON.stringify({ messages: ["Record is locked. No such object."] })],
      ["the document-missing conflict", JSON.stringify({ messages: ["No file found."] })],
      ["an empty message list", JSON.stringify({ messages: [] })],
      ["a missing message list", JSON.stringify({ code: 409 })],
      ["a non-array messages value", JSON.stringify({ messages: "No such object." })],
      ["a non-string message element", JSON.stringify({ messages: [null] })],
      ["a mixed string / non-string list", JSON.stringify({ messages: ["No such object.", 42] })],
      ["a nested-array element that stringifies to the phrase", JSON.stringify({ messages: [["No such object."]] })],
      ["a malformed JSON body", "{not json"],
    ])("keeps the conflict advice for %s", async (_label, body) => {
      const e = await rejectWith("DELETE", "/transactions/1", body);
      expect(e.status).toBe(409);
      expect(e.upstream_not_found).toBeUndefined();
      expect(e.recovery_hint).toContain("Resolve the conflict before retrying");
      expect(isNotFoundHttpError(e)).toBe(false);
    });

    it("only a 409 is flagged: a 422 \"No such object.\" keeps validation advice", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ messages: ["No such object."] }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }));
      vi.stubGlobal("fetch", fetchMock);
      const client = new HttpClient(config);
      const err = await client.delete("/transactions/1").catch((e: unknown) => e) as HttpError;
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(422);
      expect(err.upstream_not_found).toBeUndefined();
      expect(err.recovery_hint).toContain("Validate the request body");
      expect(isNotFoundHttpError(err)).toBe(false);
    });

    it("isNotFoundHttpError truth table", () => {
      expect(isNotFoundHttpError(new HttpError("x", 404, "GET", "/transactions/1"))).toBe(true);
      expect(isNotFoundHttpError(new HttpError("x", 409, "GET", "/transactions/1", { upstream_not_found: true }))).toBe(true);
      expect(isNotFoundHttpError(new HttpError("x", 409, "GET", "/transactions/1"))).toBe(false);
      expect(isNotFoundHttpError(new HttpError("x", 500, "GET", "/transactions/1"))).toBe(false);
      expect(isNotFoundHttpError(new HttpError("x", "network", "GET", "/transactions/1"))).toBe(false);
      expect(isNotFoundHttpError(Object.assign(new Error("x"), { status: 404 }))).toBe(false);
      expect(isNotFoundHttpError(undefined)).toBe(false);
    });
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
