// API health probe + per-connection 401 brake.
//
// When an authenticated API request fails with 401, 5xx or a network/timeout
// error, ONE unauthenticated GET is sent to the same API server to tell "the
// server is responding" apart from "the server is down or unreachable"
// (timeout, network/TLS error, 5xx). An unauthenticated probe cannot tell a
// healthy API apart from one that rejects every key: both may answer it with
// 401. The probe only enriches the original error; it never changes its outcome.

/**
 * Single place for the probe target.
 * LIVE-VERIFIED 2026-11-04: the healthy live API answers an unauthenticated
 * `GET https://rmp-api.rik.ee/v1/openapi.yaml` with 401 in ~0.2 s (while an
 * authenticated request on a valid key got 200). So any HTTP answer below 500
 * means "reachable"; only a timeout, network/TLS error or 5xx means
 * "unreachable" (the outages seen that day hung after TLS without answering).
 */
export const API_HEALTH_PROBE = Object.freeze({
  /** Appended to the connection's base URL (which already ends in `/v1`). */
  path: "/openapi.yaml",
  timeoutMs: 5_000,
  /** At most one probe per server per window; the outcome is reused inside it. */
  cacheWindowMs: 60_000,
});

/** Consecutive-401 brake: N 401s within the window → refuse locally for the cooldown. */
export const AUTH_BRAKE = Object.freeze({
  threshold: 3,
  windowMs: 60_000,
  cooldownMs: 60_000,
});

/**
 * "reachable": the server answered the probe with a non-5xx status (401 is the
 * normal answer). "unreachable": timeout, network/TLS error or 5xx.
 * "unknown": no probe outcome.
 */
export type ApiHealth = "reachable" | "unreachable" | "unknown";

export interface ApiHealthProbeOutcome {
  readonly api_health: ApiHealth;
  /** HTTP status of the probe, `"network"` when it got none, null when no probe ran. */
  readonly probe_status: number | "network" | null;
  /** ISO-8601 time the probe finished. */
  readonly checked_at: string;
}

export interface ApiHealthStatusEntry extends ApiHealthProbeOutcome {
  readonly server: string;
}

interface CacheEntry {
  at: number;
  outcome?: ApiHealthProbeOutcome;
  pending?: Promise<ApiHealthProbeOutcome>;
}

const probeCache = new Map<string, CacheEntry>();

function normalizeServer(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

async function runProbe(server: string): Promise<ApiHealthProbeOutcome> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_HEALTH_PROBE.timeoutMs);
  try {
    // No auth headers, no credentials, no company data: a plain public GET.
    const response = await fetch(`${server}${API_HEALTH_PROBE.path}`, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
    });
    // Only the status matters; never buffer the body.
    try { await response.body?.cancel(); } catch { /* ignore */ }
    const status = response.status;
    return {
      api_health: status >= 500 ? "unreachable" : "reachable",
      probe_status: status,
      checked_at: new Date().toISOString(),
    };
  } catch {
    return { api_health: "unreachable", probe_status: "network", checked_at: new Date().toISOString() };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Probe outcome for `baseUrl`, rate-limited to one probe per server per
 * `cacheWindowMs` (concurrent callers share one in-flight probe). Never throws.
 */
export async function probeApiHealth(baseUrl: string): Promise<ApiHealthProbeOutcome> {
  try {
    const server = normalizeServer(baseUrl);
    const now = Date.now();
    const cached = probeCache.get(server);
    if (cached && now - cached.at < API_HEALTH_PROBE.cacheWindowMs) {
      if (cached.outcome) return cached.outcome;
      if (cached.pending) return await cached.pending;
    }
    const entry: CacheEntry = { at: now };
    entry.pending = runProbe(server).then((outcome) => {
      entry.outcome = outcome;
      entry.pending = undefined;
      return outcome;
    });
    probeCache.set(server, entry);
    return await entry.pending;
  } catch {
    return { api_health: "unknown", probe_status: null, checked_at: new Date().toISOString() };
  }
}

/** Most recent cached probe outcome per server (no network). */
export function getLastApiHealthProbes(): ApiHealthStatusEntry[] {
  const entries: ApiHealthStatusEntry[] = [];
  for (const [server, entry] of probeCache) {
    if (entry.outcome) entries.push({ server, ...entry.outcome });
  }
  return entries;
}

/** Test hook: forget every cached probe outcome. */
export function resetApiHealthProbes(): void {
  probeCache.clear();
}

/** Consecutive-401 brake for one connection + server (one instance per HttpClient). */
export class AuthBrake {
  private streak = 0;
  private streakStartedAt = 0;
  private blockedUntil = 0;

  /** Milliseconds of cooldown left, 0 when requests may be sent. */
  remainingMs(now = Date.now()): number {
    if (this.blockedUntil > now) return this.blockedUntil - now;
    if (this.blockedUntil !== 0) {
      this.blockedUntil = 0;
      this.streak = 0;
    }
    return 0;
  }

  recordUnauthorized(now = Date.now()): void {
    if (this.streak === 0 || now - this.streakStartedAt > AUTH_BRAKE.windowMs) {
      this.streak = 0;
      this.streakStartedAt = now;
    }
    this.streak += 1;
    if (this.streak >= AUTH_BRAKE.threshold) {
      this.blockedUntil = now + AUTH_BRAKE.cooldownMs;
      this.streak = 0;
    }
  }

  /** A successful (2xx) answer on this connection resets the streak. */
  recordSuccess(): void {
    this.streak = 0;
  }
}
