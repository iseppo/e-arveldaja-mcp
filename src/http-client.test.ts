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

  it("retries retryable network errors", async () => {
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

  it("preserves 401 troubleshooting with public IP disclosure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: ["Unauthorized"] }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("203.0.113.42", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpClient(config);
    const promise = client.get("/clients");
    const expectation = expect(promise).rejects.toThrow(/Your public IP: 203\.0\.113\.42/);

    await vi.runAllTimersAsync();

    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.ipify.org");
  });
});
