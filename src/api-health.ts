// Consecutive-401 brake, shared per API server.
//
// Every connection to the same server (base URL) shares one brake, so a burst of
// 401s across several connections — e.g. stale connections all refused at once,
// or an all-401 incident / IP block — trips it, and switching connections does
// not bypass it. No extra request is ever sent: advice is derived from the
// failing request alone (an unauthenticated probe cannot tell a healthy API
// from one that refuses every key — both answer 401, live-verified 2026-11-04).

/** Consecutive-401 brake: N 401s within the window → refuse locally for the cooldown. */
export const AUTH_BRAKE = Object.freeze({
  threshold: 3,
  windowMs: 60_000,
  cooldownMs: 60_000,
});

export interface AuthBrakeState {
  readonly server: string;
  /** ISO-8601 end of the local cooldown, null when requests may be sent. */
  readonly cooldown_until: string | null;
  /** Distinct connections that got 401 in the current streak (or the streak that tripped the cooldown). */
  readonly distinct_connections_401: number;
}

/** Consecutive-401 brake for one API server, shared by every connection to it. */
export class AuthBrake {
  private streak = 0;
  private streakStartedAt = 0;
  private blockedUntil = 0;
  /** Connection labels (never secrets) that got 401 in the current streak. */
  private connections = new Set<string>();
  /** Distinct connections of the streak that tripped the active cooldown. */
  private trippedConnections = 0;

  constructor(readonly server: string) {}

  /** Milliseconds of cooldown left, 0 when requests may be sent. */
  remainingMs(now = Date.now()): number {
    if (this.blockedUntil > now) return this.blockedUntil - now;
    if (this.blockedUntil !== 0) {
      this.blockedUntil = 0;
      this.trippedConnections = 0;
      this.resetStreak();
    }
    return 0;
  }

  /** Distinct connections that got 401 in the streak behind the active cooldown. */
  get distinctConnections401(): number {
    return this.trippedConnections;
  }

  recordUnauthorized(connection: string, now = Date.now()): void {
    if (this.streak === 0 || now - this.streakStartedAt > AUTH_BRAKE.windowMs) {
      this.resetStreak();
      this.streakStartedAt = now;
    }
    this.streak += 1;
    this.connections.add(connection);
    if (this.streak >= AUTH_BRAKE.threshold) {
      this.blockedUntil = now + AUTH_BRAKE.cooldownMs;
      this.trippedConnections = this.connections.size;
      this.resetStreak();
    }
  }

  /** A successful (2xx) answer from this server resets the streak. */
  recordSuccess(): void {
    this.resetStreak();
  }

  state(now = Date.now()): AuthBrakeState {
    const blocked = this.remainingMs(now) > 0;
    return {
      server: this.server,
      cooldown_until: blocked ? new Date(this.blockedUntil).toISOString() : null,
      distinct_connections_401: blocked ? this.trippedConnections : this.connections.size,
    };
  }

  private resetStreak(): void {
    this.streak = 0;
    this.connections = new Set();
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

/** Brakes that are cooling down or hold a 401 streak (no network). */
export function getAuthBrakeStates(now = Date.now()): AuthBrakeState[] {
  return [...brakes.values()]
    .map(brake => brake.state(now))
    .filter(state => state.cooldown_until !== null || state.distinct_connections_401 > 0);
}

/** Test hook: forget every brake. */
export function resetAuthBrakes(): void {
  brakes.clear();
}
