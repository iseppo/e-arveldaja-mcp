// 401 brake, shared per API server.
//
// Every connection to the same server (base URL) feeds one brake, so a burst of
// 401s across several connections — e.g. stale connections all refused at once,
// or an all-401 incident / IP block — trips it, and switching connections does
// not bypass it. No extra request is ever sent: advice is derived from the
// failing request alone (an unauthenticated probe cannot tell a healthy API
// from one that refuses every key — both answer 401, live-verified 2026-11-04).

/** 401 brake: N 401s on one server within the window → refuse locally for the cooldown. */
export const AUTH_BRAKE = Object.freeze({
  threshold: 3,
  windowMs: 60_000,
  cooldownMs: 60_000,
});

export interface AuthBrakeState {
  readonly server: string;
  /** ISO-8601 end of the local cooldown, null when requests may be sent. */
  readonly cooldown_until: string | null;
  /** Distinct connections with a 401 in the current window (or in the window that tripped the cooldown). */
  readonly distinct_connections_401: number;
}

/**
 * 401 brake for one API server, shared by every connection to it.
 *
 * Each connection keeps its own 401 history; a success resets only that
 * connection's history, so a healthy connection cannot erase a stale one's
 * failures. The brake trips when the server has `threshold` 401s within
 * `windowMs`, counted across all connections' histories.
 */
export class AuthBrake {
  private blockedUntil = 0;
  /** Connection label (never a secret) → timestamps of its 401s since its last success. */
  private histories = new Map<string, number[]>();
  /** Distinct connections of the window that tripped the active cooldown. */
  private trippedConnections = 0;

  constructor(readonly server: string) {}

  /** Milliseconds of cooldown left, 0 when requests may be sent. */
  remainingMs(now = Date.now()): number {
    if (this.blockedUntil > now) return this.blockedUntil - now;
    if (this.blockedUntil !== 0) {
      this.blockedUntil = 0;
      this.trippedConnections = 0;
      this.histories.clear();
    }
    return 0;
  }

  /** Distinct connections that got 401 in the window behind the active cooldown. */
  get distinctConnections401(): number {
    return this.trippedConnections;
  }

  recordUnauthorized(connection: string, now = Date.now()): void {
    this.expire(now);
    const history = this.histories.get(connection) ?? [];
    history.push(now);
    this.histories.set(connection, history);
    let total = 0;
    for (const timestamps of this.histories.values()) total += timestamps.length;
    if (total >= AUTH_BRAKE.threshold) {
      this.blockedUntil = now + AUTH_BRAKE.cooldownMs;
      this.trippedConnections = this.histories.size;
      this.histories.clear();
    }
  }

  /** A successful (2xx) answer resets only that connection's 401 history. */
  recordSuccess(connection: string): void {
    this.histories.delete(connection);
  }

  state(now = Date.now()): AuthBrakeState {
    const blocked = this.remainingMs(now) > 0;
    if (!blocked) this.expire(now);
    return {
      server: this.server,
      cooldown_until: blocked ? new Date(this.blockedUntil).toISOString() : null,
      distinct_connections_401: blocked ? this.trippedConnections : this.histories.size,
    };
  }

  /** Drop 401s older than the window, and connections left with none. */
  private expire(now: number): void {
    for (const [connection, timestamps] of this.histories) {
      const recent = timestamps.filter(at => now - at <= AUTH_BRAKE.windowMs);
      if (recent.length > 0) this.histories.set(connection, recent);
      else this.histories.delete(connection);
    }
  }
}

const brakes = new Map<string, AuthBrake>();

function normalizeServer(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** The one brake shared by every connection to `baseUrl`'s server. */
export function authBrakeFor(baseUrl: string): AuthBrake {
  const server = normalizeServer(baseUrl);
  let brake = brakes.get(server);
  if (!brake) {
    brake = new AuthBrake(server);
    brakes.set(server, brake);
  }
  return brake;
}

/** Brakes that are cooling down or hold unexpired 401s (no network). */
export function getAuthBrakeStates(now = Date.now()): AuthBrakeState[] {
  return [...brakes.values()]
    .map(brake => brake.state(now))
    .filter(state => state.cooldown_until !== null || state.distinct_connections_401 > 0);
}

/** Test hook: forget every brake. */
export function resetAuthBrakes(): void {
  brakes.clear();
}
