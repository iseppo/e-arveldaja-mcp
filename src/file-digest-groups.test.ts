import { describe, expect, it } from "vitest";
import { groupByDigest } from "./file-digest-groups.js";

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
