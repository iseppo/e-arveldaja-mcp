import { describe, expect, it } from "vitest";
import {
  buildBaseline,
  compareToBaseline,
  parseDiagnostics,
  planBaselineUpdate,
  serializeBaseline,
  summarizeDiagnostics,
  summaryLine,
} from "../scripts/check-test-typecheck.js";

const TSC_OUTPUT = [
  "src/a.test.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
  "  Types of property 'x' are incompatible.",
  "    Type 'boolean | undefined' is not assignable to type 'boolean'.",
  "src/a.test.ts(40,7): error TS18046: 'payload' is of type 'unknown'.",
  "src\\tools\\b.test.ts(5,1): error TS18046: 'payload' is of type 'unknown'.",
  "/repo/src/c.test.ts(1,1): error TS2307: Cannot find module './types.js'.",
  "",
].join("\n");

function countsOf(text: string) {
  return summarizeDiagnostics(parseDiagnostics(text, "/repo").diagnostics);
}

describe("parseDiagnostics", () => {
  it("parses headers, ignores continuation lines and normalizes Windows and absolute paths", () => {
    const { diagnostics, unparseable } = parseDiagnostics(TSC_OUTPUT, "/repo");
    expect(unparseable).toEqual([]);
    expect(diagnostics).toEqual([
      { file: "src/a.test.ts", line: 12, column: 3, code: "TS2322" },
      { file: "src/a.test.ts", line: 40, column: 7, code: "TS18046" },
      { file: "src/tools/b.test.ts", line: 5, column: 1, code: "TS18046" },
      { file: "src/c.test.ts", line: 1, column: 1, code: "TS2307" },
    ]);
  });

  it("rejects an error TS line without a file position as unparseable", () => {
    const text = "error TS5083: Cannot read file '/repo/tsconfig.base.json'.\nsrc/a.test.ts(1,1): error TS2322: x\n";
    const { diagnostics, unparseable } = parseDiagnostics(text, "/repo");
    expect(unparseable).toEqual(["error TS5083: Cannot read file '/repo/tsconfig.base.json'."]);
    expect(diagnostics).toHaveLength(1);
  });
});

describe("baseline serialization", () => {
  it("sorts keys at every level and ends with a newline", () => {
    const baseline = buildBaseline({ "src/z.test.ts": { TS2322: 1 }, "src/a.test.ts": { TS2551: 2, TS18046: 3 } });
    expect(baseline).toEqual({
      version: 1,
      total: 6,
      by_code: { TS18046: 3, TS2322: 1, TS2551: 2 },
      errors: { "src/a.test.ts": { TS18046: 3, TS2551: 2 }, "src/z.test.ts": { TS2322: 1 } },
    });
    const text = serializeBaseline(baseline);
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(["by_code", "errors", "total", "version"]);
    expect(Object.keys(JSON.parse(text).errors)).toEqual(["src/a.test.ts", "src/z.test.ts"]);
    expect(serializeBaseline(buildBaseline({}))).toBe('{\n  "by_code": {},\n  "errors": {},\n  "total": 0,\n  "version": 1\n}\n');
  });
});

describe("compareToBaseline", () => {
  const baseline = countsOf(TSC_OUTPUT);

  it("fails on a per-key increase", () => {
    const current = countsOf(`${TSC_OUTPUT}src/a.test.ts(99,1): error TS2322: again\n`);
    const result = compareToBaseline(current, baseline);
    expect(result.ok).toBe(false);
    expect(result.increases).toEqual(["+1 src/a.test.ts TS2322"]);
    expect(result.stale).toBe(false);
  });

  it("fails on a key the baseline does not have", () => {
    const current = countsOf(`${TSC_OUTPUT}src/new.test.ts(1,1): error TS2339: missing\n`);
    const result = compareToBaseline(current, baseline);
    expect(result.ok).toBe(false);
    expect(result.increases).toEqual(["+1 src/new.test.ts TS2339"]);
  });

  it("reports a decrease or a vanished key as stale", () => {
    const current = countsOf("src/a.test.ts(12,3): error TS2322: x\nsrc/a.test.ts(40,7): error TS18046: y\n");
    const result = compareToBaseline(current, baseline);
    expect(result.ok).toBe(false);
    expect(result.increases).toEqual([]);
    expect(result.stale).toBe(true);
  });

  it("passes on an exact match even when lines and columns move", () => {
    const moved = TSC_OUTPUT.replace("(12,3)", "(14,9)").replace("(40,7)", "(2,2)");
    expect(compareToBaseline(countsOf(moved), baseline)).toEqual({ ok: true, increases: [], stale: false });
  });
});

describe("planBaselineUpdate", () => {
  const baseline = buildBaseline(countsOf(TSC_OUTPUT));

  it("refuses an update when the total rises", () => {
    const current = countsOf(`${TSC_OUTPUT}src/a.test.ts(99,1): error TS2322: again\n`);
    expect(planBaselineUpdate(current, baseline)).toEqual({ allowed: false, warnings: [] });
  });

  it("allows an equal total with a redistribution and warns about the per-key increase", () => {
    const renamed = TSC_OUTPUT.replace("/repo/src/c.test.ts", "src/d.test.ts");
    const plan = planBaselineUpdate(countsOf(renamed), baseline);
    expect(plan).toEqual({ allowed: true, warnings: ["+1 src/d.test.ts TS2307"] });
  });

  it("creates a baseline when none exists", () => {
    expect(planBaselineUpdate(countsOf(TSC_OUTPUT), null)).toEqual({ allowed: true, warnings: [] });
  });
});

describe("summaryLine", () => {
  it("prints the machine-greppable totals", () => {
    expect(summaryLine(1259, 941, 1259)).toBe("TEST_TYPECHECK total=1259 ts18046=941 other=318 baseline_total=1259");
  });
});
