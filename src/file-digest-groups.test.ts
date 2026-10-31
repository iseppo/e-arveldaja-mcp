import { describe, expect, it } from "vitest";
import { coveredBy, findSupersededFiles, groupByDigest } from "./file-digest-groups.js";

describe("groupByDigest", () => {
  it("keeps the newest copy, then the lowest path, and lists the rest as its copies", () => {
    const groups = groupByDigest([
      { index: 0, path: "/in/b.csv", modifiedAt: "2026-10-01T00:00:00Z", digest: "x" },
      { index: 1, path: "/in/a.csv", modifiedAt: "2026-10-01T00:00:00Z", digest: "x" },
      { index: 2, path: "/in/c.csv", modifiedAt: "2026-10-02T00:00:00Z", digest: "y" },
      { index: 3, path: "/in/d.csv", modifiedAt: "2026-09-01T00:00:00Z", digest: "y" },
      { index: 4, path: "/in/e.csv", modifiedAt: "2026-09-01T00:00:00Z", digest: "z" },
    ]);
    expect(groups).toEqual([
      { index: 0, duplicate_of: 1 },
      { index: 1, stands_in_for: [0] },
      { index: 2, stands_in_for: [3] },
      { index: 3, duplicate_of: 2 },
      { index: 4 },
    ]);
  });

  it("does not depend on input order", () => {
    const files = [
      { index: 0, path: "/in/x (1).csv", modifiedAt: "2026-10-01T00:00:00Z", digest: "d" },
      { index: 1, path: "/in/x.csv", modifiedAt: "2026-10-01T00:00:00Z", digest: "d" },
    ];
    const byIndex = (list: ReturnType<typeof groupByDigest>) => [...list].sort((left, right) => left.index - right.index);
    expect(byIndex(groupByDigest([...files].reverse()))).toEqual(byIndex(groupByDigest(files)));
  });
});

describe("coveredBy / findSupersededFiles", () => {
  it("is multiset containment", () => {
    expect(coveredBy(["a", "a"], ["a", "b", "a"])).toBe(true);
    expect(coveredBy(["a", "a"], ["a", "b"])).toBe(false);
    expect(coveredBy([], [])).toBe(true);
  });

  const file = (index: number, identities: string[], period: { from: string; to: string }, extra: Partial<{ path: string; digest: string; scopeKey: string }> = {}) => ({
    index, path: extra.path ?? `/in/${index}.xml`, modifiedAt: "2026-10-01T00:00:00Z", digest: extra.digest ?? `d${index}`,
    scopeKey: extra.scopeKey ?? "acct", period, identities,
  });

  it("points every edge at a retained file and needs scope, period and identity containment", () => {
    const superseded = findSupersededFiles([
      file(0, ["x", "y"], { from: "2026-09-01", to: "2026-09-10" }),
      file(1, ["x", "y", "z"], { from: "2026-09-01", to: "2026-09-30" }),
      file(2, ["x"], { from: "2026-09-01", to: "2026-09-05" }),
      file(3, ["x"], { from: "2026-09-01", to: "2026-09-05" }, { scopeKey: "other" }),
      file(4, ["x"], { from: "2026-08-31", to: "2026-09-05" }),
    ]);
    expect([...superseded.entries()].sort()).toEqual([[0, 1], [2, 1]]);
  });

  it("keeps one of two equal-content files, independent of input order", () => {
    const files = [file(0, ["x"], { from: "2026-09-01", to: "2026-09-30" }, { path: "/in/b.xml" }), file(1, ["x"], { from: "2026-09-01", to: "2026-09-30" }, { path: "/in/a.xml" })];
    expect([...findSupersededFiles(files)]).toEqual([[0, 1]]);
    expect([...findSupersededFiles([...files].reverse())]).toEqual([[0, 1]]);
  });
});
