import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError } from "./http-client.js";
import { getAuthBrakeStates, resetAuthBrakes } from "./api-health.js";
import { getServerStatus } from "./server/release-notices.js";

const LIVE = "https://rmp-api.rik.ee/v1";
const DEMO = "https://demo-rmp-api.rik.ee/v1";

function configFor(baseUrl: string, keyId = "test-key-id") {
  return { apiKeyId: keyId, apiPublicValue: "test-public-value", apiPassword: "test-password", baseUrl };
}

function json(status: number, body: unknown = { messages: ["x"] }): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clientFor(baseUrl: string, index: number): HttpClient {
  return new HttpClient(configFor(baseUrl, `key-${index}`), `connection:${index}`);
}

/** Run fake timers until the promise settles; return its rejection (or fail). */
async function rejectionOf(promise: Promise<unknown>): Promise<HttpError> {
  const settled = promise.then(
    () => { throw new Error("expected rejection"); },
    (error: unknown) => error,
  );
  await vi.runAllTimersAsync();
  const error = await settled;
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

const BLOCK_ADVICE =
  "If several connections fail at once, or this connection worked moments ago, suspect a server- or IP-side block: " +
  "wait and retry, do not change API keys.";

const API_DOWN_ADVICE =
  "The e-arveldaja API did not answer (timeout, network/TLS error or server error); it may be down or unreachable " +
  "from this machine. This is probably not a credentials problem — retry in a few minutes.";

beforeEach(() => {
  resetAuthBrakes();
  vi.useFakeTimers({ now: new Date("2026-11-04T10:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("failure advice comes from the failing request alone", () => {
  it("401: troubleshooting list plus the server/IP-side block sentence; no other request is sent", async () => {
    const fetchMock = vi.fn(async () => json(401));
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejectionOf(new HttpClient(configFor(LIVE)).get("/clients"));

    expect(error.status).toBe(401);
    expect(error.message).toContain("Troubleshooting 401 Unauthorized");
    expect(error.message).toContain("Lubatud IP-aadressid");
    expect(error.message).toContain("Is this computer's clock correct?");
    expect(error.message).toContain(BLOCK_ADVICE);
    expect(error.message).not.toMatch(/server is responding|health check/);
    expect(error.recovery_hint).toContain(BLOCK_ADVICE);
    expect(error.next_actions?.map(a => a.tool)).toEqual(["get_setup_instructions", "list_connections"]);
    expect(error).not.toHaveProperty("api_health");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`${LIVE}/clients`);
  });

  it("5xx on a POST (no retry): outage advice as recovery hint, message unchanged, one request", async () => {
    const fetchMock = vi.fn(async () => json(503));
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejectionOf(new HttpClient(configFor(LIVE)).post("/journals", {}));

    expect(error.status).toBe(503);
    expect(error.message).toBe("API request failed: POST /journals → 503");
    expect(error.recovery_hint).toBe(API_DOWN_ADVICE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5xx on a GET: one request per attempt (initial + 3 retries), never an extra probe", async () => {
    const fetchMock = vi.fn(async () => json(502));
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejectionOf(new HttpClient(configFor(LIVE)).get("/clients"));

    expect(error.status).toBe(502);
    expect(error.recovery_hint).toBe(API_DOWN_ADVICE);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.every(call => String((call as unknown[])[0]) === `${LIVE}/clients`)).toBe(true);
  });

  it("network error: outage advice, one request for a POST", async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError("fetch failed"); });
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejectionOf(new HttpClient(configFor(LIVE)).post("/journals", {}));

    expect(error.status).toBe("network");
    expect(error.recovery_hint).toBe(API_DOWN_ADVICE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("other errors (e.g. 404) keep their own advice", async () => {
    const fetchMock = vi.fn(async () => json(404));
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejectionOf(new HttpClient(configFor(LIVE)).get("/clients/5"));

    expect(error.status).toBe(404);
    expect(error.recovery_hint).toContain("Verify that the referenced record still exists");
    expect(error.message).not.toContain(BLOCK_ADVICE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("401 brake shared per API server", () => {
  it("3×401 on one connection trips it and refuses the next request locally without sending it", async () => {
    const fetchMock = vi.fn(async () => json(401));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient(configFor(LIVE));

    for (let i = 0; i < 3; i++) {
      expect((await rejectionOf(client.get("/clients"))).code).toBeUndefined();
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const refused = await rejectionOf(client.get("/clients"));

    expect(refused.code).toBe("auth_cooldown");
    expect(refused.status).toBe(401);
    expect(refused.cooldown_seconds_remaining).toBe(60);
    expect(refused.distinct_connections_401).toBe(1);
    expect(refused.message).toContain("on one connection");
    expect(refused.message).not.toContain("server- or IP-side problem");
    expect(refused.message).toContain("Nothing was sent");
    expect(refused.message).toContain("server-side lockout");
    expect(refused.recovery_hint).toContain("do not loop over connections");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("3×401 across different connections on one server trips it for every connection, counting them", async () => {
    const fetchMock = vi.fn(async () => json(401));
    vi.stubGlobal("fetch", fetchMock);
    const clients = [0, 1, 2, 3].map(i => clientFor(LIVE, i));

    for (let i = 0; i < 3; i++) {
      expect((await rejectionOf(clients[i]!.get("/clients"))).code).toBeUndefined();
    }

    for (const client of clients) {
      const refused = await rejectionOf(client.get("/clients"));
      expect(refused.code).toBe("auth_cooldown");
      expect(refused.distinct_connections_401).toBe(3);
      expect(refused.message).toContain("3 different connections got 401 Unauthorized from this API server");
      expect(refused.message).toContain("server- or IP-side problem, not one stale API key");
      expect(refused.recovery_hint).toContain("do not loop over connections");
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("the same connection counted twice is one distinct connection", async () => {
    const fetchMock = vi.fn(async () => json(401));
    vi.stubGlobal("fetch", fetchMock);
    const a = clientFor(LIVE, 0);
    const b = clientFor(LIVE, 1);

    await rejectionOf(a.get("/clients"));
    await rejectionOf(b.get("/clients"));
    await rejectionOf(a.get("/clients"));

    const refused = await rejectionOf(b.get("/clients"));
    expect(refused.distinct_connections_401).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a different server is unaffected", async () => {
    const fetchMock = vi.fn(async () => json(401));
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 3; i++) await rejectionOf(clientFor(LIVE, i).get("/clients"));
    expect((await rejectionOf(clientFor(LIVE, 9).get("/clients"))).code).toBe("auth_cooldown");

    const demo = await rejectionOf(clientFor(DEMO, 0).get("/clients"));
    expect(demo.code).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("a trailing slash on the base URL is the same server", async () => {
    const fetchMock = vi.fn(async () => json(401));
    vi.stubGlobal("fetch", fetchMock);

    await rejectionOf(clientFor(LIVE, 0).get("/clients"));
    await rejectionOf(clientFor(`${LIVE}/`, 1).get("/clients"));
    await rejectionOf(clientFor(` ${LIVE}// `, 2).get("/clients"));

    expect((await rejectionOf(clientFor(LIVE, 3).get("/clients"))).code).toBe("auth_cooldown");
  });

  it("refuses writes too while cooling down, and sends again after the 60 s cooldown", async () => {
    const fetchMock = vi.fn(async () => json(401));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient(configFor(LIVE));
    for (let i = 0; i < 3; i++) await rejectionOf(client.get("/clients"));

    // The third 401 lands ~200 ms in (100 ms request spacing), so the cooldown
    // ends ~10:01:00.2; at 10:00:30.5 about 29.7 s remain → reported as 30.
    vi.setSystemTime(new Date("2026-11-04T10:00:30.500Z"));
    const midway = await rejectionOf(client.post("/journals", {}));
    expect(midway.code).toBe("auth_cooldown");
    expect(midway.cooldown_seconds_remaining).toBe(30);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    vi.setSystemTime(new Date("2026-11-04T10:01:01Z"));
    fetchMock.mockImplementation(async () => json(200, { ok: true }));
    const promise = client.get("/clients");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("after the cooldown the streak starts over (one more 401 does not re-trip)", async () => {
    const fetchMock = vi.fn(async () => json(401));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient(configFor(LIVE));
    for (let i = 0; i < 3; i++) await rejectionOf(client.get("/clients"));

    vi.setSystemTime(new Date("2026-11-04T10:01:01Z"));
    expect((await rejectionOf(client.get("/clients"))).code).toBeUndefined();
    expect((await rejectionOf(client.get("/clients"))).code).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("a success resets only that connection's own 401 history", async () => {
    const answers = [401, 401, 200, 401, 401];
    const fetchMock = vi.fn(async () => json(answers.shift() ?? 500, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const a = clientFor(LIVE, 0);

    await rejectionOf(a.get("/clients"));
    await rejectionOf(a.get("/clients"));
    const ok = a.get("/clients");
    await vi.runAllTimersAsync();
    await expect(ok).resolves.toEqual({ ok: true });
    await rejectionOf(a.get("/clients"));
    const fifth = await rejectionOf(a.get("/clients"));

    expect(fifth.code).toBeUndefined();
    expect(fifth.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("a success on another connection does not clear a stale connection's 401s", async () => {
    const answers = [401, 401, 200, 401];
    const fetchMock = vi.fn(async () => json(answers.shift() ?? 500, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const a = clientFor(LIVE, 0);
    const b = clientFor(LIVE, 1);

    await rejectionOf(a.get("/clients"));
    await rejectionOf(a.get("/clients"));
    const ok = b.get("/clients");
    await vi.runAllTimersAsync();
    await expect(ok).resolves.toEqual({ ok: true });
    await rejectionOf(a.get("/clients"));

    expect((await rejectionOf(b.get("/clients"))).code).toBe("auth_cooldown");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("interleaved A→401, B→401, C→200 cycles still trip the brake", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const key = String((init?.headers as Record<string, string>)["X-AUTH-KEY"] ?? "");
      return key.startsWith("healthy") ? json(200, { ok: true }) : json(401);
    });
    vi.stubGlobal("fetch", fetchMock);
    const a = clientFor(LIVE, 0);
    const b = clientFor(LIVE, 1);
    const c = new HttpClient({ ...configFor(LIVE, "key-2"), apiPublicValue: "healthy" }, "connection:2");

    await rejectionOf(a.get("/clients"));
    await rejectionOf(b.get("/clients"));
    const ok = c.get("/clients");
    await vi.runAllTimersAsync();
    await expect(ok).resolves.toEqual({ ok: true });
    await rejectionOf(a.get("/clients"));

    for (const client of [a, b, c]) {
      const refused = await rejectionOf(client.get("/clients"));
      expect(refused.code).toBe("auth_cooldown");
      expect(refused.distinct_connections_401).toBe(2);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("requests queued for their rate-limit turn are refused once the brake trips, without being sent", async () => {
    const fetchMock = vi.fn(async () => json(401));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient(configFor(LIVE));

    const settled = Array.from({ length: 6 }, () => client.get("/clients").then(
      () => { throw new Error("expected rejection"); },
      (error: unknown) => error as HttpError,
    ));
    await vi.runAllTimersAsync();
    const errors = await Promise.all(settled);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(errors.slice(0, 3).map(e => e.code)).toEqual([undefined, undefined, undefined]);
    for (const refused of errors.slice(3)) {
      expect(refused).toBeInstanceOf(HttpError);
      expect(refused.code).toBe("auth_cooldown");
      expect(refused.cooldown_seconds_remaining).toBeGreaterThan(0);
      expect(refused.distinct_connections_401).toBe(1);
      expect(refused.message).not.toContain("Troubleshooting 401 Unauthorized");
    }
    // The local refusals were not counted as upstream 401s: the cooldown still
    // carries the one connection's three real 401s and ends 60 s after the third.
    const [state] = getAuthBrakeStates();
    expect(state?.distinct_connections_401).toBe(1);
  });

  it("a retry delayed by 429 is refused if the brake tripped during the delay", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const key = String((init?.headers as Record<string, string>)["X-AUTH-KEY"] ?? "");
      return key.startsWith("throttled") ? json(429) : json(401);
    });
    vi.stubGlobal("fetch", fetchMock);
    const throttled = new HttpClient({ ...configFor(LIVE, "key-9"), apiPublicValue: "throttled" }, "connection:9");

    const retrying = throttled.get("/clients").then(
      () => { throw new Error("expected rejection"); },
      (error: unknown) => error as HttpError,
    );
    // Let the first attempt get its 429 and start the 1 s retry delay.
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Three other connections get 401 while the retry sleeps (fresh clients
    // need no rate-limit wait, so 10 ms suffices and the 1 s delay is not reached).
    const others = [0, 1, 2].map(i => clientFor(LIVE, i).get("/clients").catch((error: unknown) => error as HttpError));
    await vi.advanceTimersByTimeAsync(10);
    expect((await Promise.all(others)).map(e => (e as HttpError).status)).toEqual([401, 401, 401]);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await vi.runAllTimersAsync();
    const refused = await retrying;
    expect(refused).toBeInstanceOf(HttpError);
    expect(refused.code).toBe("auth_cooldown");
    expect(refused.distinct_connections_401).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("401s spread over more than 60 s do not trip the brake", async () => {
    const fetchMock = vi.fn(async () => json(401));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient(configFor(LIVE));

    await rejectionOf(client.get("/clients"));
    await rejectionOf(client.get("/clients"));
    vi.setSystemTime(new Date("2026-11-04T10:01:30Z"));
    const third = await rejectionOf(client.get("/clients"));
    const fourth = await rejectionOf(client.get("/clients"));

    expect(third.code).toBeUndefined();
    expect(fourth.code).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("is never applied to non-401 errors", async () => {
    const fetchMock = vi.fn(async () => json(500));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient(configFor(LIVE));

    for (let i = 0; i < 5; i++) {
      expect((await rejectionOf(client.post("/journals", {}))).status).toBe(500);
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("get_server_status shows the brake state without calling the network", async () => {
    expect(getServerStatus({ version: "1.0.0", profile: "standard" }).auth_brakes).toBeUndefined();

    const fetchMock = vi.fn(async () => json(401));
    vi.stubGlobal("fetch", fetchMock);
    await rejectionOf(clientFor(LIVE, 0).get("/clients"));
    await rejectionOf(clientFor(LIVE, 1).get("/clients"));

    const streak = getServerStatus({ version: "1.0.0", profile: "standard" });
    expect(streak.auth_brakes).toEqual([{ server: LIVE, cooldown_until: null, distinct_connections_401: 2 }]);

    await rejectionOf(clientFor(LIVE, 0).get("/clients"));
    const callsBefore = fetchMock.mock.calls.length;
    const [state] = getAuthBrakeStates();
    expect(state?.cooldown_until).not.toBeNull();
    expect(state?.distinct_connections_401).toBe(2);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);

    vi.setSystemTime(new Date("2026-11-04T10:01:01Z"));
    expect(getServerStatus({ version: "1.0.0", profile: "standard" }).auth_brakes).toBeUndefined();
  });

  it("get_server_status drops a sub-threshold 401 streak once its 60 s window has passed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(401)));
    await rejectionOf(clientFor(LIVE, 0).get("/clients"));
    expect(getAuthBrakeStates()).toEqual([{ server: LIVE, cooldown_until: null, distinct_connections_401: 1 }]);

    vi.setSystemTime(new Date("2026-11-04T10:01:01Z"));
    expect(getAuthBrakeStates()).toEqual([]);
    expect(getServerStatus({ version: "1.0.0", profile: "standard" }).auth_brakes).toBeUndefined();
  });
});
