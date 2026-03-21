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

  it("does not retry POST requests after network errors", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config);

    await expect(client.post("/transactions", { amount: 10 })).rejects.toThrow(
      /API request failed: POST \/transactions → network error: fetch failed/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry POST requests after 5xx responses", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: ["temporary failure"] }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config);

    await expect(client.post("/transactions", { amount: 10 })).rejects.toThrow(
      /API request failed: POST \/transactions → 502: temporary failure/,
    );
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
});
