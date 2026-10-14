import { describe, expect, it } from "vitest";
import { groupCamtStatementFiles, type CamtStatementFingerprint } from "./statement-duplicates.js";
import { normalizeAccountIdentity } from "./executor.js";
import { camtDateDay, preflightCamt053Xml } from "./parser.js";
import { fixtureCamtStatementXml } from "../__fixtures__/accounting-workflow.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const KEY = "EE637700771011212909:EUR";

function file(index: number, overrides: Partial<CamtStatementFingerprint> = {}): CamtStatementFingerprint {
  return {
    index,
    path: `/statements/${index}.xml`,
    modifiedAt: "2026-10-01T10:00:00.000Z",
    digest: DIGEST_A,
    accountKey: KEY,
    period: { from: "2026-09-01", to: "2026-09-30" },
    ...overrides,
  };
}

describe("groupCamtStatementFiles", () => {
  it("keeps the newest of an identical pair", () => {
    const result = groupCamtStatementFiles([
      file(0, { modifiedAt: "2026-10-01T10:00:00.000Z" }),
      file(1, { modifiedAt: "2026-10-02T10:00:00.000Z" }),
    ]);
    expect(result).toEqual([
      { index: 0, duplicate_of: 1 },
      { index: 1, stands_in_for: [0] },
    ]);
  });

  it("keeps the lowest path on a modified_at tie", () => {
    const result = groupCamtStatementFiles([
      file(0, { path: "/statements/b.xml" }),
      file(1, { path: "/statements/a.xml" }),
    ]);
    expect(result).toEqual([
      { index: 0, duplicate_of: 1 },
      { index: 1, stands_in_for: [0] },
    ]);
  });

  it("keeps one of a triple and references the other two", () => {
    const result = groupCamtStatementFiles([
      file(0, { modifiedAt: "2026-10-03T10:00:00.000Z" }),
      file(1),
      file(2),
    ]);
    expect(result).toEqual([
      { index: 0, stands_in_for: [1, 2] },
      { index: 1, duplicate_of: 0 },
      { index: 2, duplicate_of: 0 },
    ]);
  });

  it("keeps both of a same-period pair with different bytes and reports the overlap; identical files never overlap each other", () => {
    const result = groupCamtStatementFiles([
      file(0, { digest: DIGEST_A, modifiedAt: "2026-10-03T10:00:00.000Z" }),
      file(1, { digest: DIGEST_A }),
      file(2, { digest: DIGEST_B }),
    ]);
    expect(result).toEqual([
      { index: 0, stands_in_for: [1], overlaps_with: [{ index: 2, from: "2026-09-01", to: "2026-09-30" }] },
      { index: 1, duplicate_of: 0 },
      { index: 2, overlaps_with: [{ index: 0, from: "2026-09-01", to: "2026-09-30" }] },
    ]);
  });

  it.each([
    ["another account", { accountKey: "EE111111111111111111:EUR" }],
    ["another currency", { accountKey: "EE637700771011212909:USD" }],
    ["a disjoint period", { period: { from: "2026-10-01", to: "2026-10-31" } }],
    ["no analyzable statement (e.g. an invalid account identity)", { accountKey: undefined, period: undefined }],
  ])("reports no overlap for %s", (_case, overrides) => {
    const result = groupCamtStatementFiles([file(0, { digest: DIGEST_A }), file(1, { digest: DIGEST_B, ...overrides })]);
    expect(result).toEqual([{ index: 0 }, { index: 1 }]);
  });

  it("reports a month inside a quarter as overlap only: neither file is a duplicate", () => {
    const result = groupCamtStatementFiles([
      file(0, { digest: DIGEST_A, period: { from: "2026-07-01", to: "2026-09-30" } }),
      file(1, { digest: DIGEST_B, period: { from: "2026-08-01", to: "2026-08-31" } }),
      file(2, { digest: DIGEST_C, period: { from: "2026-10-01", to: "2026-10-31" } }),
    ]);
    expect(result).toEqual([
      { index: 0, overlaps_with: [{ index: 1, from: "2026-08-01", to: "2026-08-31" }] },
      { index: 1, overlaps_with: [{ index: 0, from: "2026-07-01", to: "2026-09-30" }] },
      { index: 2 },
    ]);
  });

  it("leaves an unread file (no digest) alone", () => {
    const result = groupCamtStatementFiles([file(0, { digest: undefined }), file(1, { digest: undefined })]);
    expect(result).toEqual([
      { index: 0, overlaps_with: [{ index: 1, from: "2026-09-01", to: "2026-09-30" }] },
      { index: 1, overlaps_with: [{ index: 0, from: "2026-09-01", to: "2026-09-30" }] },
    ]);
  });
});

describe("statement inputs to the grouping", () => {
  it("an account identity with punctuation is invalid, so overlap is not analyzed", () => {
    expect(normalizeAccountIdentity("EE63 7700 7710 1121 2909")).toBe("EE637700771011212909");
    expect(normalizeAccountIdentity("EE63-7700-7710-1121-2909")).toBeUndefined();
  });

  it("takes the validated day of a period date-time and refuses an impossible date", () => {
    expect(camtDateDay("2026-09-30T23:59:59+03:00")).toBe("2026-09-30");
    expect(camtDateDay("2026-02-31")).toBeUndefined();
    expect(camtDateDay(undefined)).toBeUndefined();
  });

  it("a statement without FrToDt falls back to its entry range", () => {
    const xml = fixtureCamtStatementXml({ entries: [
      { date: "2026-09-12", amount: "5.00" },
      { date: "2026-09-03", amount: "7.00" },
    ] });
    const preflight = preflightCamt053Xml(xml);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    expect(preflight.value.statement_metadata.period).toEqual({ from: undefined, to: undefined });
    expect(preflight.value.entries.map(entry => entry.date).sort()).toEqual(["2026-09-03", "2026-09-12"]);
  });
});
