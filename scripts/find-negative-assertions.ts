#!/usr/bin/env node
// Lists negative test assertions (`expect(x).not.…`, `toHaveBeenCalledTimes(0)`,
// `toHaveLength(0)`, `expect.not.*Containing`, and `toBeUndefined()` /
// `toBeNull()` / `toBeFalsy()` on an optional chain) so they can be audited for
// vacuity: an absence check that could never fail guards nothing. Parses the
// AST, so multi-line `expect(` calls are found, and flags a subject that is a
// parameter of an enclosing helper (the helper's callers decide what is checked).
//
//   npx tsx scripts/find-negative-assertions.ts [--json] [--min-score N] [path ...]
//
// Score (higher = more suspicious): +2 no positive assertion on the same
// subject in the test, +2 helper-parameterized subject, +1 multi-line,
// +1 mock-not-called, +1 literal absence (not.toContain / not.toMatch on a
// literal), +3 optional-chain absence (`x.find(...)?.y` is undefined both when
// y is absent and when nothing was found). It ranks for manual review; it
// proves nothing by itself.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";

interface Node {
  type: string;
  start: number;
  end: number;
  loc: { start: { line: number }; end: { line: number } };
  [key: string]: unknown;
}

interface Hit {
  file: string;
  line: number;
  score: number;
  matcher: string;
  subject: string;
  test: string;
  flags: string[];
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const minScoreIndex = args.indexOf("--min-score");
const minScore = minScoreIndex >= 0 ? Number(args[minScoreIndex + 1]) : 0;
const roots = args.filter((arg, index) => !arg.startsWith("--") && (minScoreIndex < 0 || index !== minScoreIndex + 1));
if (roots.length === 0) roots.push("src");

function testFiles(path: string): string[] {
  if (statSync(path).isFile()) return path.endsWith(".test.ts") ? [path] : [];
  return readdirSync(path).flatMap(entry =>
    entry === "node_modules" || entry.startsWith(".") ? [] : testFiles(join(path, entry)));
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    if (Array.isArray(value)) out.push(...value.filter(isNode));
    else if (isNode(value)) out.push(value);
  }
  return out;
}

const parentOf = new WeakMap<Node, Node>();
const helpersOf = new WeakMap<Node, Node[]>();

const FUNCTION_TYPES = new Set(["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration", "ObjectMethod", "ClassMethod"]);
const TEST_CALLS = new Set(["it", "test", "each", "only", "skip", "concurrent"]);
const ZERO_MATCHERS = new Set(["toHaveBeenCalledTimes", "toHaveLength"]);
const ABSENCE_MATCHERS = new Set(["toBeUndefined", "toBeNull", "toBeFalsy"]);

const identName = (node: unknown): string | undefined =>
  isNode(node) && node.type === "Identifier" ? (node.name as string) : undefined;

// Walks callee/object links down to the `expect(...)` call at the chain root.
function expectRoot(node: Node): Node | undefined {
  let current: Node = node;
  while (true) {
    if (current.type === "MemberExpression") current = current.object as Node;
    else if (current.type === "CallExpression") {
      const callee = current.callee as Node;
      if (identName(callee) === "expect") return current;
      if (callee.type === "MemberExpression" && identName(callee.object) === "expect") {
        return identName(callee.property) === "soft" ? current : undefined;
      }
      current = callee;
    } else return undefined;
  }
}

function chainNames(node: Node): string[] {
  const names: string[] = [];
  let current: Node = node;
  while (current.type === "MemberExpression" || current.type === "CallExpression") {
    if (current.type === "MemberExpression") {
      const name = identName(current.property);
      if (name) names.unshift(name);
      current = current.object as Node;
    } else current = current.callee as Node;
  }
  return names;
}

function isTestCallback(fn: Node): boolean {
  const call = parentOf.get(fn);
  if (!call || call.type !== "CallExpression") return false;
  let callee = call.callee as Node;
  if (callee.type === "CallExpression") callee = callee.callee as Node; // it.each(rows)(name, fn)
  while (callee.type === "MemberExpression") {
    if (TEST_CALLS.has(identName(callee.property) ?? "")) return true;
    callee = callee.object as Node;
  }
  return TEST_CALLS.has(identName(callee) ?? "");
}

function rootIdentifier(expr: Node | undefined): string | undefined {
  let current = expr;
  while (current) {
    if (current.type === "Identifier") return current.name as string;
    if (["MemberExpression", "OptionalMemberExpression"].includes(current.type)) current = current.object as Node;
    else if (["TSNonNullExpression", "TSAsExpression", "ParenthesizedExpression", "TSSatisfiesExpression", "AwaitExpression"].includes(current.type)) {
      current = current.expression as Node;
    } else if (current.type === "CallExpression" || current.type === "OptionalCallExpression") {
      // vi.mocked(api.x) / JSON.stringify(x) / desandboxText(x): follow the first argument
      current = (current.arguments as Node[])[0];
    } else return undefined;
  }
  return undefined;
}

function zeroMatcher(matcher: string, call: Node): boolean {
  const arg = (call.arguments as Node[])[0];
  return ZERO_MATCHERS.has(matcher) && arg?.type === "NumericLiteral" && arg.value === 0;
}

function paramNames(fn: Node): string[] {
  const names: string[] = [];
  const collect = (node: Node | undefined): void => {
    if (!node) return;
    if (node.type === "Identifier") names.push(node.name as string);
    else children(node).forEach(child => collect(child.type === "TSTypeAnnotation" ? undefined : child));
  };
  (fn.params as Node[]).forEach(collect);
  return names;
}

const hits: Hit[] = [];
for (const root of roots) {
  for (const file of testFiles(root)) {
    const source = readFileSync(file, "utf8");
    const ast = parse(source, { sourceType: "module", plugins: ["typescript"] }) as unknown as { program: Node };
    const text = (node: Node) => source.slice(node.start, node.end).replace(/\s+/g, " ");
    const assertions: Array<{ call: Node; subjectRoot: string | undefined; negative: boolean; optionalAbsence: boolean; test: Node | undefined }> = [];

    const visit = (node: Node, parent: Node | undefined, test: Node | undefined, helpers: Node[]): void => {
      if (parent) parentOf.set(node, parent);
      let nextTest = test;
      let nextHelpers = helpers;
      if (FUNCTION_TYPES.has(node.type)) {
        if (isTestCallback(node)) { nextTest = node; nextHelpers = []; } else nextHelpers = [...helpers, node];
      }
      helpersOf.set(node, nextHelpers);
      for (const child of children(node)) visit(child, node, nextTest, nextHelpers);
      if (node.type !== "CallExpression") return;
      const callee = node.callee as Node;
      // asymmetric matcher: expect.not.stringContaining(...)
      if (callee.type === "MemberExpression" && (callee.object as Node).type === "MemberExpression"
        && identName((callee.object as Node).property) === "not" && identName((callee.object as Node).object) === "expect") {
        hits.push({
          file: relative(process.cwd(), file), line: node.loc.start.line, score: 1,
          matcher: `expect.not.${identName(callee.property)}`, subject: (node.arguments as Node[]).map(text).join(", ").slice(0, 80),
          test: testName(nextTest), flags: ["asymmetric"],
        });
        return;
      }
      if (callee.type !== "MemberExpression") return;
      const expectCall = expectRoot(callee);
      if (!expectCall) return;
      if (parent && parent.type === "MemberExpression" && parent.object === node) return; // not the outermost call
      const names = chainNames(callee);
      const matcher = names.at(-1) ?? "";
      const subject = (expectCall.arguments as Node[])[0];
      const optionalAbsence = !names.includes("not") && ABSENCE_MATCHERS.has(matcher)
        && subject !== undefined && source.slice(subject.start, subject.end).includes("?.");
      const negative = names.includes("not") || zeroMatcher(matcher, node) || optionalAbsence;
      assertions.push({ call: node, subjectRoot: rootIdentifier(subject), negative, optionalAbsence, test: nextTest });
    };

    const testName = (testFn: Node | undefined): string => {
      const first = testFn ? ((parentOf.get(testFn)!).arguments as Node[])[0] : undefined;
      if (!first) return "?";
      return first.type === "StringLiteral" ? (first.value as string) : text(first).slice(0, 60);
    };

    visit(ast.program, undefined, undefined, []);

    for (const assertion of assertions.filter(entry => entry.negative)) {
      const { call, subjectRoot, test, optionalAbsence } = assertion;
      const callee = call.callee as Node;
      const expectCall = expectRoot(callee)!;
      const names = chainNames(callee);
      const matcher = names.at(-1) ?? "";
      const args = call.arguments as Node[];
      const flags: string[] = [];
      let score = 0;
      const positive = subjectRoot !== undefined && assertions.some(other =>
        !other.negative && other.test === test && other.subjectRoot === subjectRoot);
      if (!positive) { flags.push("no_positive_control"); score += 2; }
      if (subjectRoot && helpersOf.get(call)!.some(fn => paramNames(fn).includes(subjectRoot))) {
        flags.push("helper_param"); score += 2;
      }
      if (call.loc.start.line !== call.loc.end.line) { flags.push("multiline"); score += 1; }
      if (optionalAbsence) { flags.push("optional_chain_absence"); score += 3; }
      if (matcher.startsWith("toHaveBeenCalled")) { flags.push("mock_not_called"); score += 1; }
      if ((matcher === "toContain" || matcher === "toMatch") && args[0]
        && ["StringLiteral", "RegExpLiteral", "TemplateLiteral"].includes(args[0].type)) {
        flags.push("literal_absence"); score += 1;
      }
      const subjectNode = (expectCall.arguments as Node[])[0];
      hits.push({
        file: relative(process.cwd(), file), line: call.loc.start.line, score,
        matcher: `${names.includes("not") ? "not." : ""}${matcher}(${args.map(text).join(", ").slice(0, 60)})`,
        subject: subjectNode ? text(subjectNode).slice(0, 100) : "", test: testName(test), flags,
      });
    }
  }
}

const selected = hits.filter(hit => hit.score >= minScore)
  .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
if (json) {
  process.stdout.write(`${JSON.stringify(selected, null, 2)}\n`);
} else {
  for (const hit of selected) {
    process.stdout.write(`${hit.score}\t${hit.file}:${hit.line}\t${hit.matcher}\texpect(${hit.subject})\t[${hit.flags.join(",")}]\t${hit.test}\n`);
  }
  process.stdout.write(`${selected.length} negative assertion(s)\n`);
}
