// Point-of-use release notices. A bounded, static list of first-party advisories
// bound to specific operational flows. A notice surfaces ONLY where its
// `affectedFlows` matches the current flow and only inside its active window —
// never in unrelated sessions/flows. These are first-party release text, not
// external/OCR content, so callers emit them UNWRAPPED (no wrapUntrustedOcr).

export type ReleaseFlow = "camt" | "wise" | "bank";
export type ReleaseSeverity = "info" | "warning";

export interface ReleaseNotice {
  /** Stable identifier — safe to key on across releases. */
  readonly id: string;
  /** Flows this notice is operationally relevant to. */
  readonly affectedFlows: readonly ReleaseFlow[];
  readonly severity: ReleaseSeverity;
  readonly message: string;
  /** Half-open [start, end) ISO-8601 window during which the notice is active. */
  readonly window: { readonly start: string; readonly end: string };
}

/** Advisory payload shape exposed to MCP clients (snake_case, notice-relevant fields only). */
export interface ActiveNotice {
  readonly id: string;
  readonly severity: ReleaseSeverity;
  readonly message: string;
  readonly affected_flows: readonly ReleaseFlow[];
}

export interface ServerStatus {
  readonly version: string;
  readonly profile: string;
  readonly active_notices: readonly ActiveNotice[];
}

export const RELEASE_NOTICES: readonly ReleaseNotice[] = Object.freeze([
  Object.freeze({
    id: "v0.22.0-incoming-direction-regression",
    affectedFlows: Object.freeze(["camt", "wise"] as const),
    severity: "warning" as const,
    message:
      "⚠️ v0.22.0 regression window: if you ran an e-arveldaja-mcp session between Sunday 2026-07-19 22:30 and Monday 2026-07-20 04:15 (while 0.22.0 was the latest version), any bank-statement entries created during that window are very likely wrong — incoming transactions were booked backwards. Check what e-arveldaja reports as the bank-account balance against the real bank-account balance; if they differ, re-importing the affected bank statements fixes it.",
    // Opens at the regression window and sunsets after a reconciliation grace
    // period so operators still see the advisory long enough to check their books.
    window: Object.freeze({ start: "2026-07-19T00:00:00Z", end: "2026-10-19T00:00:00Z" }),
  }),
]);

export function isNoticeActive(notice: ReleaseNotice, now: Date = new Date()): boolean {
  const t = now.getTime();
  return t >= Date.parse(notice.window.start) && t < Date.parse(notice.window.end);
}

function toActive(notice: ReleaseNotice): ActiveNotice {
  return {
    id: notice.id,
    severity: notice.severity,
    message: notice.message,
    affected_flows: notice.affectedFlows,
  };
}

/** Active notices whose `affectedFlows` include `flow`. Never returns notices for unrelated flows. */
export function getActiveNoticesForFlow(flow: string, now: Date = new Date()): ActiveNotice[] {
  return RELEASE_NOTICES
    .filter((notice) => isNoticeActive(notice, now) && notice.affectedFlows.includes(flow as ReleaseFlow))
    .map(toActive);
}

/** All currently-active notices, regardless of flow (used by the status report). */
export function getActiveNotices(now: Date = new Date()): ActiveNotice[] {
  return RELEASE_NOTICES.filter((notice) => isNoticeActive(notice, now)).map(toActive);
}

export function getServerStatus(input: { version: string; profile: string; now?: Date }): ServerStatus {
  return {
    version: input.version,
    profile: input.profile,
    active_notices: getActiveNotices(input.now ?? new Date()),
  };
}
