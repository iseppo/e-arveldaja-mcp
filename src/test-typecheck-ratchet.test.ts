import { describe, expect, it } from "vitest";
import {
  addLooseTypingCounts,
  buildBaseline,
  countLooseTyping,
  isTestSupportFile,
  compareToBaseline,
  findUncheckedTestFiles,
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
    expect(planBaselineUpdate(current, baseline)).toEqual({ allowed: false, increases: ["+1 src/a.test.ts TS2322"] });
    expect(planBaselineUpdate(current, baseline, true).allowed).toBe(false);
  });

  it("refuses an equal total that swaps fixed loose typing for new loose typing unless forced", () => {
    const loose = buildBaseline({ "src/a.test.ts": { ANY: 2 } });
    const swapped = { "src/a.test.ts": { ANY: 1 }, "src/b.test.ts": { ANY: 1 } };
    expect(planBaselineUpdate(swapped, loose)).toEqual({ allowed: false, increases: ["+1 src/b.test.ts ANY"] });
    expect(planBaselineUpdate(swapped, loose, true)).toEqual({ allowed: true, increases: ["+1 src/b.test.ts ANY"] });
  });

  it("refuses a swapped tsc error even when forced", () => {
    const renamed = TSC_OUTPUT.replace("/repo/src/c.test.ts", "src/d.test.ts");
    expect(planBaselineUpdate(countsOf(renamed), baseline, true)).toEqual({ allowed: false, increases: ["+1 src/d.test.ts TS2307"] });
  });

  it("never seeds tsc errors into a new baseline, and refuses a decrease that still leaves tsc errors", () => {
    expect(planBaselineUpdate({ "src/a.test.ts": { TS2322: 1, ANY: 3 } }, null).allowed).toBe(false);
    expect(planBaselineUpdate({ "src/a.test.ts": { TS2322: 1 } }, baseline, true).allowed).toBe(false);
    expect(planBaselineUpdate({ "src/a.test.ts": { ANY: 3 } }, null)).toEqual({ allowed: true, increases: [] });
  });

  it("never lets a tsc error in, even forced in exchange for removed loose typing", () => {
    const loose = buildBaseline({ "src/a.test.ts": { ANY: 2 } });
    const traded = { "src/a.test.ts": { ANY: 1 }, "src/b.test.ts": { TS2322: 1 } };
    expect(planBaselineUpdate(traded, loose, true)).toEqual({ allowed: false, increases: ["+1 src/b.test.ts TS2322"] });
  });

  it("allows a pure decrease without force", () => {
    const loose = buildBaseline({ "src/a.test.ts": { ANY: 2, UNTYPED_PAYLOAD: 1 } });
    expect(planBaselineUpdate({ "src/a.test.ts": { ANY: 1 } }, loose)).toEqual({ allowed: true, increases: [] });
  });

  it("creates a baseline when none exists", () => {
    expect(planBaselineUpdate({ "src/a.test.ts": { ANY: 2 } }, null)).toEqual({ allowed: true, increases: [] });
  });
});

describe("findUncheckedTestFiles", () => {
  it("lists test files missing from the tsc program, sorted", () => {
    const program = ["src/a.ts", "src/a.test.ts", "node_modules/x/index.d.ts"];
    expect(findUncheckedTestFiles(program, ["src/z.test.ts", "src/a.test.ts", "src/b/c.test.ts"]))
      .toEqual(["src/b/c.test.ts", "src/z.test.ts"]);
  });

  it("passes when every test file is in the program", () => {
    expect(findUncheckedTestFiles(["src/a.test.ts", "src/b.test.ts"], ["src/a.test.ts", "src/b.test.ts"])).toEqual([]);
  });
});

describe("countLooseTyping", () => {
  it("counts every explicit any annotation, not the word in strings or comments", () => {
    const source = [
      "// any comment mentioning any",
      "const a = value as any;",
      "function f(x: any): any[] { return [x]; }",
      "const r: Record<string, any> = {};",
      "const s = 'any';",
    ].join("\n");
    expect(countLooseTyping(source, "src/tools/x.test.ts")).toEqual({ any: 4, untypedPayload: 0 });
  });

  it("counts calls to the fixture's untyped parseMcpResponse, following an import alias", () => {
    const source = [
      'import { parseMcpResponse as parse } from "../__fixtures__/mcp-response.js";',
      'import { parseToolPayload } from "../__fixtures__/mcp-response.js";',
      "const a = parse(text) as any;",
      "const b = parse(other);",
      "const c = parseToolPayload<{ ok: boolean }>(text);",
    ].join("\n");
    expect(countLooseTyping(source, "src/tools/x.test.ts")).toEqual({ any: 1, untypedPayload: 2 });
  });

  it("counts .ts specifiers, sibling imports, namespace members, references and re-exports", () => {
    const tsExt = 'import { parseMcpResponse } from "../__fixtures__/mcp-response.ts";\nparseMcpResponse(a);\n';
    expect(countLooseTyping(tsExt, "src/tools/x.test.ts").untypedPayload).toBe(1);
    const sibling = 'import { parseMcpResponse as p } from "./mcp-response.js";\nexport const q = (t: string) => p(t);\n';
    expect(countLooseTyping(sibling, "src/__fixtures__/other.ts").untypedPayload).toBe(1);
    const namespace = 'import * as m from "../__fixtures__/mcp-response.js";\nm.parseMcpResponse(a);\nm.parseToolPayload<number>(a);\n';
    expect(countLooseTyping(namespace, "src/tools/x.test.ts").untypedPayload).toBe(1);
    const references = [
      'import { parseMcpResponse } from "../__fixtures__/mcp-response.js";',
      "const all = texts.map(parseMcpResponse);",
      "const p = parseMcpResponse;",
      "parseMcpResponse.call(null, a);",
      "const o = { parseMcpResponse: 1 }; o.parseMcpResponse;",
    ].join("\n");
    expect(countLooseTyping(references, "src/tools/x.test.ts").untypedPayload).toBe(3);
    const reexport = 'export { parseMcpResponse as parse } from "./mcp-response.js";\n';
    expect(countLooseTyping(reexport, "src/__fixtures__/other.ts").untypedPayload).toBe(1);
    expect(countLooseTyping('export * from "./mcp-response.js";\n', "src/__fixtures__/other.ts").untypedPayload).toBe(1);
    expect(countLooseTyping('export { parseToolPayload } from "./mcp-response.js";\n', "src/__fixtures__/other.ts").untypedPayload).toBe(0);
    const once = 'import { parseMcpResponse } from "./mcp-response.js";\nexport { parseMcpResponse };\nconst o = { parseMcpResponse };\n';
    expect(countLooseTyping(once, "src/__fixtures__/other.ts").untypedPayload).toBe(2);
  });

  it("does not resolve a same-named module elsewhere", () => {
    const elsewhere = 'import { parseMcpResponse } from "./mcp-response.js";\nparseMcpResponse(a);\n';
    expect(countLooseTyping(elsewhere, "src/tools/x.test.ts").untypedPayload).toBe(0);
  });

  it("ignores parseMcpResponse imported from the production module (it returns unknown)", () => {
    const source = 'import { parseMcpResponse } from "./mcp-json.js";\nconst a = parseMcpResponse(text);\n';
    expect(countLooseTyping(source, "src/tools/x.test.ts")).toEqual({ any: 0, untypedPayload: 0 });
  });
});

describe("isTestSupportFile", () => {
  it("covers tests, fixtures and integration sources only", () => {
    expect(isTestSupportFile("src/a.test.ts")).toBe(true);
    expect(isTestSupportFile("src/__fixtures__/mcp-response.ts")).toBe(true);
    expect(isTestSupportFile("src/__integration__/helpers.ts")).toBe(true);
    expect(isTestSupportFile("src/tools/bank-reconciliation.ts")).toBe(false);
    expect(isTestSupportFile("scripts/check-test-typecheck.ts")).toBe(false);
    expect(isTestSupportFile("node_modules/x/a.test.ts")).toBe(false);
  });
});

describe("addLooseTypingCounts", () => {
  it("merges the pseudo-codes into the tsc counts, sorted, skipping zeros", () => {
    const merged = addLooseTypingCounts({ "src/b.test.ts": { TS2322: 1 } }, [
      { file: "src/b.test.ts", any: 2, untypedPayload: 0 },
      { file: "src/a.test.ts", any: 0, untypedPayload: 3 },
      { file: "src/c.test.ts", any: 0, untypedPayload: 0 },
    ]);
    expect(merged).toEqual({ "src/a.test.ts": { UNTYPED_PAYLOAD: 3 }, "src/b.test.ts": { ANY: 2, TS2322: 1 } });
  });

  it("makes a new any an increase and a removed any a stale baseline", () => {
    const baseline = addLooseTypingCounts({}, [{ file: "src/a.test.ts", any: 2, untypedPayload: 0 }]);
    const more = addLooseTypingCounts({}, [{ file: "src/a.test.ts", any: 3, untypedPayload: 0 }]);
    const fewer = addLooseTypingCounts({}, [{ file: "src/a.test.ts", any: 1, untypedPayload: 0 }]);
    expect(compareToBaseline(more, baseline).increases).toEqual(["+1 src/a.test.ts ANY"]);
    expect(compareToBaseline(fewer, baseline)).toEqual({ ok: false, increases: [], stale: true });
  });
});

describe("summaryLine", () => {
  it("prints the machine-greppable totals", () => {
    expect(summaryLine({ tsc: 1259, ts18046: 941, any: 10, untypedPayload: 5 }, 1274))
      .toBe("TEST_TYPECHECK total=1274 tsc=1259 ts18046=941 other=318 any=10 untyped_payload=5 baseline_total=1274");
  });
});
