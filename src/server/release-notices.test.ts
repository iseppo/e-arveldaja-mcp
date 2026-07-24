import { describe, expect, it } from "vitest";
import {
  RELEASE_NOTICES,
  getActiveNotices,
  getActiveNoticesForFlow,
  getServerStatus,
  isNoticeActive,
} from "./release-notices.js";

const REGRESSION_ID = "v0.22.0-incoming-direction-regression";
const DURING = new Date("2026-07-24T00:00:00Z");
const BEFORE = new Date("2026-07-01T00:00:00Z");
const AFTER = new Date("2027-01-01T00:00:00Z");

describe("release notices", () => {
  it("carries the v0.22.0 incoming-direction regression as a stable-id bank notice", () => {
    const notice = RELEASE_NOTICES.find((n) => n.id === REGRESSION_ID);
    expect(notice).toBeDefined();
    expect(notice!.affectedFlows).toEqual(expect.arrayContaining(["camt", "wise"]));
    expect(notice!.severity).toBe("warning");
    expect(notice!.message).toContain("0.22.0");
  });

  it("surfaces the bank notice for camt and wise flows within its window", () => {
    expect(getActiveNoticesForFlow("camt", DURING).map((n) => n.id)).toContain(REGRESSION_ID);
    expect(getActiveNoticesForFlow("wise", DURING).map((n) => n.id)).toContain(REGRESSION_ID);
  });

  it("never surfaces a bank notice in an unrelated flow (operational relevance)", () => {
    expect(getActiveNoticesForFlow("receipt", DURING)).toEqual([]);
    expect(getActiveNoticesForFlow("sales", DURING)).toEqual([]);
  });

  it("gates by window: absent before it opens and after it closes", () => {
    const notice = RELEASE_NOTICES.find((n) => n.id === REGRESSION_ID)!;
    expect(isNoticeActive(notice, BEFORE)).toBe(false);
    expect(isNoticeActive(notice, AFTER)).toBe(false);
    expect(isNoticeActive(notice, DURING)).toBe(true);
    expect(getActiveNoticesForFlow("camt", BEFORE)).toEqual([]);
    expect(getActiveNoticesForFlow("camt", AFTER)).toEqual([]);
    expect(getActiveNotices(AFTER)).toEqual([]);
  });

  it("reports version, profile, and active notices in the status payload", () => {
    const status = getServerStatus({ version: "9.9.9", profile: "standard", now: DURING });
    expect(status.version).toBe("9.9.9");
    expect(status.profile).toBe("standard");
    expect(status.active_notices.map((n) => n.id)).toContain(REGRESSION_ID);
    for (const notice of status.active_notices) {
      expect(typeof notice.id).toBe("string");
      expect(typeof notice.message).toBe("string");
      expect(Array.isArray(notice.affected_flows)).toBe(true);
    }
    // Past the window, status carries no active notices but still reports metadata.
    const quiet = getServerStatus({ version: "9.9.9", profile: "full", now: AFTER });
    expect(quiet.active_notices).toEqual([]);
    expect(quiet.profile).toBe("full");
  });
});
