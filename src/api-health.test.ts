import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError } from "./http-client.js";
import { getLastApiHealthProbes, resetApiHealthProbes } from "./api-health.js";
import { getServerStatus } from "./server/release-notices.js";

const LIVE = "https://rmp-api.rik.ee/v1";
const DEMO = "https://demo-rmp-api.rik.ee/v1";
const PROBE_URL = `${LIVE}/openapi.yaml`;

function configFor(baseUrl: string, keyId = "test-key-id") {
  return { apiKeyId: keyId, apiPublicValue: "test-public-value", apiPassword: "test-password", baseUrl };
}

function json(status: number, body: unknown = { messages: ["x"] }): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Responder = (init?: RequestInit) => Response | Promise<Response>;

/** fetch mock that answers the probe URL and API URLs separately. */
function routedFetch(api: Responder, probe: Responder) {
  return vi.fn(async (url: string | URL, init?: RequestInit) =>
    String(url).endsWith("/openapi.yaml") ? probe(init) : api(init));
}

function probeCalls(fetchMock: ReturnType<typeof routedFetch>): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/openapi.yaml")).length;
}

function apiCallCount(fetchMock: ReturnType<typeof routedFetch>): number {
  return fetchMock.mock.calls.filter(([url]) => !String(url).endsWith("/openapi.yaml")).length;
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

describe("API health probe on failed requests", () => {
  beforeEach(() => {
    resetApiHealthProbes();
    vi.useFakeTimers({ now: new Date("2026-11-04T10:00:00Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // LIVE FACT (verified 2026-11-04): the healthy live API answers the
  // unauthenticated `GET https://rmp-api.rik.ee/v1/openapi.yaml` with 401 in
  // ~0.2 s while an authenticated GET /v1/invoice_info on a valid key got 200.
  // So a 401 (or any other non-5xx answer) to the probe means "reachable",
  // never "down"; an all-401 incident looks the same and is not claimed either way.
  it.each([
    ["401 (the live healthy answer)", 401],
    ["404", 404],
    ["403", 403],
    ["200", 200],
    ["302", 302],
  ])("probe answering %s is reachable: a 401 gets credential/IP/clock advice, never outage advice", async (_label, probeStatus) => {
    const fetchMock = routedFetch(() => json(401), () => new Response(null, { status: probeStatus as number }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejectionOf(new HttpClient(configFor(LIVE)).get("/clients"));

    expect(error.status).toBe(401);
    expect(error.api_health).toBe("reachable");
    expect(error.probe_status).toBe(probeStatus);
    expect(error.probe_checked_at).toBe("2026-11-04T10:00:00.000Z");
    expect(error.message).toContain(
      "The e-arveldaja API server is responding, so this 401 most likely concerns this connection: " +
      "check the API key (expired, replaced, or for a different company), the allowed IP address list, " +
      "and this computer's clock.",
    );
    expect(error.message).toContain("it does not indicate an outage");
    expect(error.message).toContain("Troubleshooting 401 Unauthorized");
    expect(error.message).toContain("Lubatud IP-aadressid");
    expect(error.message).toContain("Is this computer's clock correct?");
    expect(error.message).not.toMatch(/appears to be down|retry in a few minutes/);
    expect(error.recovery_hint).toContain("The e-arveldaja API server is responding");
    expect(error.recovery_hint).not.toMatch(/appears to be down/);
    expect(error.next_actions?.map(a => a.tool)).toEqual(["get_setup_instructions", "list_connections"]);
  });

  it("probe sent without auth headers or body to the same server's openapi.yaml", async () => {
    const fetchMock = routedFetch(() => json(401), () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await rejectionOf(new HttpClient(configFor(LIVE)).get("/clients"));

    const probe = fetchMock.mock.calls.find(([url]) => String(url) === PROBE_URL);
    expect(probe).toBeDefined();
    const init = probe![1]!;
    expect(init.method).toBe("GET");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  const API_DOWN_TEXT =
    "The e-arveldaja API server did not answer a health check either (timeout, network/TLS error or server error), " +
    "so the API appears to be down or unreachable from this machine right now. " +
    "This is probably not a credentials problem — do not change the API key; retry in a few minutes.";

  const hangingProbe: Responder = (init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

  it.each<[string, Responder, number | "network"]>([
    ["503", () => json(503), 503],
    ["500", () => json(500), 500],
    ["a timeout", hangingProbe, "network"],
    ["a network/TLS error", () => { throw new TypeError("fetch failed"); }, "network"],
  ])("probe failing with %s on a 401 gives outage advice and drops setup next_actions", async (_label, probe, probeStatus) => {
    const fetchMock = routedFetch(() => json(401), probe);
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejectionOf(new HttpClient(configFor(LIVE)).get("/clients"));

    expect(error.status).toBe(401);
    expect(error.api_health).toBe("unreachable");
    expect(error.probe_status).toBe(probeStatus);
    expect(error.message).toContain(API_DOWN_TEXT);
    expect(error.message).not.toContain("Troubleshooting 401 Unauthorized");
    expect(error.message).not.toContain("api.ipify.org");
    expect(error.message).not.toContain("API server is responding");
    expect(error.recovery_hint).toBe(API_DOWN_TEXT);
    expect(error.next_actions).toBeUndefined();
  });

  it("5xx request with an unreachable probe gets the outage advice as recovery hint", async () => {
    const fetchMock = routedFetch(() => json(503), () => json(503));
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejectionOf(new HttpClient(configFor(LIVE)).post("/journals", {}));

    expect(error.status).toBe(503);
    expect(error.message).toBe("API request failed: POST /journals → 503");
    expect(error.api_health).toBe("unreachable");
    expect(error.recovery_hint).toBe(API_DOWN_TEXT);
  });

  it("5xx request with a reachable (401) probe keeps its own advice and claims no outage", async () => {
    const fetchMock = routedFetch(() => json(502), () => json(401));
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejectionOf(new HttpClient(configFor(LIVE)).post("/journals", {}));

    expect(error.status).toBe(502);
    expect(error.message).toBe("API request failed: POST /journals → 502");
    expect(error.api_health).toBe("reachable");
    expect(error.recovery_hint ?? "").not.toMatch(/appears to be down|API server is responding/);
  });

  it("unreachable probe on a 5xx POST marks the error unreachable without changing its status or message", async () => {
    const fetchMock = routedFetch(() => json(503), () => { throw new TypeError("fetch failed"); });
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejectionOf(new HttpClient(configFor(LIVE)).post("/journals", { a: 1 }));

    expect(error.status).toBe(503);
    expect(error.message).toBe("API request failed: POST /journals → 503");
    expect(error.api_health).toBe("unreachable");
    expect(error.probe_status).toBe("network");
    expect(apiCallCount(fetchMock)).toBe(1);
  });

  it("network error on the request itself is probed too", async () => {
    const fetchMock = routedFetch(() => { throw new TypeError("fetch failed"); }, () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejectionOf(new HttpClient(configFor(LIVE)).post("/journals", {}));

    expect(error.status).toBe("network");
    expect(error.api_health).toBe("reachable");
  });

  it("does not probe on errors that are not 401/5xx/network (e.g. 404)", async () => {
    const fetchMock = routedFetch(() => json(404), () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejectionOf(new HttpClient(configFor(LIVE)).get("/clients/5"));

    expect(error.status).toBe(404);
    expect(error.api_health).toBeUndefined();
    expect(probeCalls(fetchMock)).toBe(0);
  });

  it("sends at most one probe per server per 60 s window, then probes again", async () => {
    const fetchMock = routedFetch(() => json(500), () => json(503));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient(configFor(LIVE));

    for (let i = 0; i < 5; i++) {
      const error = await rejectionOf(client.post("/journals", {}));
      expect(error.api_health).toBe("unreachable");
    }
    expect(probeCalls(fetchMock)).toBe(1);

    // A second connection on the same server shares the cached outcome.
    await rejectionOf(new HttpClient(configFor(LIVE, "other-key")).post("/journals", {}));
    expect(probeCalls(fetchMock)).toBe(1);

    vi.setSystemTime(new Date("2026-11-04T10:01:01Z"));
    await rejectionOf(client.post("/journals", {}));
    expect(probeCalls(fetchMock)).toBe(2);
  });

  it("concurrent failures share one in-flight probe", async () => {
    const fetchMock = routedFetch(() => json(500), () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient(configFor(LIVE));

    const settled = Promise.allSettled([client.post("/a", {}), client.post("/b", {}), client.post("/c", {})]);
    await vi.runAllTimersAsync();
    const results = await settled;

    expect(results.every(r => r.status === "rejected")).toBe(true);
    expect(probeCalls(fetchMock)).toBe(1);
  });

  it("probes demo and live servers separately", async () => {
    const fetchMock = routedFetch(() => json(500), () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await rejectionOf(new HttpClient(configFor(LIVE)).post("/a", {}));
    await rejectionOf(new HttpClient(configFor(DEMO)).post("/a", {}));

    const probed = fetchMock.mock.calls.map(([url]) => String(url)).filter(url => url.endsWith("/openapi.yaml"));
    expect(probed).toEqual([PROBE_URL, `${DEMO}/openapi.yaml`]);
  });

  it("a hanging probe times out after 5 s and the original error still comes through", async () => {
    const fetchMock = routedFetch(
      () => json(401),
      // Never answers; only the probe's own abort signal ends it.
      (init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const startedAt = Date.now();

    const error = await rejectionOf(new HttpClient(configFor(LIVE)).get("/clients"));

    expect(error.status).toBe(401);
    expect(error.api_health).toBe("unreachable");
    expect(Date.now() - startedAt).toBeLessThanOrEqual(5_000 + 200);
  });

  it("a probe that throws a non-Error never breaks the original error path", async () => {
    const fetchMock = routedFetch(() => json(502), () => { throw "boom"; });
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejectionOf(new HttpClient(configFor(LIVE)).post("/journals", {}));

    expect(error.status).toBe(502);
    expect(error.message).toBe("API request failed: POST /journals → 502");
    expect(error.api_health).toBe("unreachable");
  });

  it("successful requests never probe", async () => {
    const fetchMock = routedFetch(() => json(200, { ok: true }), () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = new HttpClient(configFor(LIVE)).get("/clients");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ ok: true });
    expect(probeCalls(fetchMock)).toBe(0);
  });

  it("get_server_status reports the cached probe outcome with its timestamp, without calling the network", async () => {
    expect(getServerStatus({ version: "1.0.0", profile: "standard" }).api_health_probes).toBeUndefined();

    const fetchMock = routedFetch(() => json(401), () => json(403));
    vi.stubGlobal("fetch", fetchMock);
    await rejectionOf(new HttpClient(configFor(LIVE)).get("/clients"));
    const callsBefore = fetchMock.mock.calls.length;

    const status = getServerStatus({ version: "1.0.0", profile: "standard" });

    expect(status.api_health_probes).toEqual([{
      server: LIVE,
      api_health: "reachable",
      probe_status: 403,
      checked_at: "2026-11-04T10:00:00.000Z",
    }]);
    expect(getLastApiHealthProbes()).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});

describe("consecutive-401 brake per connection", () => {
  beforeEach(() => {
    resetApiHealthProbes();
    vi.useFakeTimers({ now: new Date("2026-11-04T10:00:00Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("trips after 3 consecutive 401s and refuses the next request locally without sending it", async () => {
    const fetchMock = routedFetch(() => json(401), () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient(configFor(LIVE));

    for (let i = 0; i < 3; i++) {
      expect((await rejectionOf(client.get("/clients"))).code).toBeUndefined();
    }
    expect(apiCallCount(fetchMock)).toBe(3);

    const refused = await rejectionOf(client.get("/clients"));

    expect(refused.code).toBe("auth_cooldown");
    expect(refused.status).toBe(401);
    expect(refused.cooldown_seconds_remaining).toBe(60);
    expect(refused.message).toContain("Nothing was sent");
    expect(refused.message).toContain("server-side lockout");
    expect(apiCallCount(fetchMock)).toBe(3);
  });

  it("refuses writes too while cooling down, and sends again after the 60 s cooldown", async () => {
    const fetchMock = routedFetch(() => json(401), () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient(configFor(LIVE));
    for (let i = 0; i < 3; i++) await rejectionOf(client.get("/clients"));

    // The third 401 lands ~200 ms in (100 ms request spacing), so the cooldown
    // ends ~10:01:00.2; at 10:00:30.5 about 29.7 s remain → reported as 30.
    vi.setSystemTime(new Date("2026-11-04T10:00:30.500Z"));
    const midway = await rejectionOf(client.post("/journals", {}));
    expect(midway.code).toBe("auth_cooldown");
    expect(midway.cooldown_seconds_remaining).toBe(30);
    expect(apiCallCount(fetchMock)).toBe(3);

    vi.setSystemTime(new Date("2026-11-04T10:01:01Z"));
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/openapi.yaml") ? new Response("", { status: 200 }) : json(200, { ok: true }));
    const promise = client.get("/clients");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ ok: true });
    expect(apiCallCount(fetchMock)).toBe(4);
  });

  it("after the cooldown the streak starts over (one more 401 does not re-trip)", async () => {
    const fetchMock = routedFetch(() => json(401), () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient(configFor(LIVE));
    for (let i = 0; i < 3; i++) await rejectionOf(client.get("/clients"));

    vi.setSystemTime(new Date("2026-11-04T10:01:01Z"));
    expect((await rejectionOf(client.get("/clients"))).code).toBeUndefined();
    expect((await rejectionOf(client.get("/clients"))).code).toBeUndefined();
    expect(apiCallCount(fetchMock)).toBe(5);
  });

  it("a success resets the counter", async () => {
    const answers = [401, 401, 200, 401, 401];
    const fetchMock = routedFetch(() => json(answers.shift() ?? 500, { ok: true }), () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient(configFor(LIVE));

    await rejectionOf(client.get("/clients"));
    await rejectionOf(client.get("/clients"));
    const ok = client.get("/clients");
    await vi.runAllTimersAsync();
    await expect(ok).resolves.toEqual({ ok: true });
    await rejectionOf(client.get("/clients"));
    const fifth = await rejectionOf(client.get("/clients"));

    expect(fifth.code).toBeUndefined();
    expect(fifth.status).toBe(401);
    expect(apiCallCount(fetchMock)).toBe(5);
  });

  it("401s spread over more than 60 s do not trip the brake", async () => {
    const fetchMock = routedFetch(() => json(401), () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient(configFor(LIVE));

    await rejectionOf(client.get("/clients"));
    await rejectionOf(client.get("/clients"));
    vi.setSystemTime(new Date("2026-11-04T10:01:30Z"));
    const third = await rejectionOf(client.get("/clients"));
    const fourth = await rejectionOf(client.get("/clients"));

    expect(third.code).toBeUndefined();
    expect(fourth.code).toBeUndefined();
    expect(apiCallCount(fetchMock)).toBe(4);
  });

  it("is never applied to non-401 errors", async () => {
    const fetchMock = routedFetch(() => json(500), () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpClient(configFor(LIVE));

    for (let i = 0; i < 5; i++) {
      expect((await rejectionOf(client.post("/journals", {}))).status).toBe(500);
    }
    expect(apiCallCount(fetchMock)).toBe(5);
  });

  it("is independent per connection: a tripped connection does not block another", async () => {
    const fetchMock = routedFetch(() => json(401), () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const first = new HttpClient(configFor(LIVE, "key-a"), "connection:0");
    const second = new HttpClient(configFor(LIVE, "key-b"), "connection:1");

    for (let i = 0; i < 3; i++) await rejectionOf(first.get("/clients"));
    expect((await rejectionOf(first.get("/clients"))).code).toBe("auth_cooldown");

    const other = await rejectionOf(second.get("/clients"));
    expect(other.code).toBeUndefined();
    expect(apiCallCount(fetchMock)).toBe(4);

    // Still cooling down on the first connection after using the second.
    expect((await rejectionOf(first.get("/clients"))).code).toBe("auth_cooldown");
    expect(apiCallCount(fetchMock)).toBe(4);
  });
});
