#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseSource } from "@babel/parser";

export type DiagnosticCounts = Record<string, Record<string, number>>;

export interface TestTypecheckBaseline {
  version: 1;
  total: number;
  by_code: Record<string, number>;
  errors: DiagnosticCounts;
}

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
}

export interface ParseResult {
  diagnostics: Diagnostic[];
  unparseable: string[];
}

export interface BaselineComparison {
  ok: boolean;
  increases: string[];
  stale: boolean;
}

export interface UpdatePlan {
  allowed: boolean;
  /** Per-key increases; they block the update unless forced, and are warnings when forced. */
  increases: string[];
}

/** Pseudo-codes counted next to the tsc codes: they ratchet the same way, so loose typing can only shrink. */
export const ANY_CODE = "ANY";
export const UNTYPED_PAYLOAD_CODE = "UNTYPED_PAYLOAD";
const UNTYPED_PAYLOAD_MODULE = "src/__fixtures__/mcp-response";
const TSC_CODE_RE = /^TS\d+$/;

const HEADER_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): /;
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:\//;

export function normalizeDiagnosticPath(file: string, repoRoot: string): string {
  let normalized = file.replace(/\\/g, "/");
  const root = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.startsWith("/") || WINDOWS_ABSOLUTE_RE.test(normalized)) {
    if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      normalized = normalized.slice(root.length + 1);
    }
  }
  return normalized.replace(/^(?:\.\/)+/, "");
}

/** Parse `tsc --pretty false` output into diagnostics; indented lines continue the previous diagnostic. */
export function parseDiagnostics(text: string, repoRoot = ""): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const unparseable: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === "") continue;
    if (/^\s/.test(rawLine)) continue;
    const match = HEADER_RE.exec(rawLine);
    if (match) {
      diagnostics.push({
        file: normalizeDiagnosticPath(match[1]!, repoRoot),
        line: Number(match[2]),
        column: Number(match[3]),
        code: match[4]!,
      });
      continue;
    }
    if (rawLine.includes("error TS")) unparseable.push(rawLine);
  }
  return { diagnostics, unparseable };
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key]!;
  return sorted;
}

/** Count diagnostics per (file, code), ignoring line and column so edits do not churn the baseline. */
export function summarizeDiagnostics(diagnostics: readonly Diagnostic[]): DiagnosticCounts {
  const counts: DiagnosticCounts = {};
  for (const diagnostic of diagnostics) {
    const byCode = (counts[diagnostic.file] ??= {});
    byCode[diagnostic.code] = (byCode[diagnostic.code] ?? 0) + 1;
  }
  const sorted: DiagnosticCounts = {};
  for (const file of Object.keys(counts).sort()) sorted[file] = sortedRecord(counts[file]!);
  return sorted;
}

export function buildBaseline(counts: DiagnosticCounts): TestTypecheckBaseline {
  const byCode: Record<string, number> = {};
  let total = 0;
  for (const codes of Object.values(counts)) {
    for (const [code, n] of Object.entries(codes)) {
      byCode[code] = (byCode[code] ?? 0) + n;
      total += n;
    }
  }
  const errors: DiagnosticCounts = {};
  for (const file of Object.keys(counts).sort()) errors[file] = sortedRecord(counts[file]!);
  return { version: 1, total, by_code: sortedRecord(byCode), errors };
}

/** Deterministic serialization: keys sorted at every level, 2-space indent, trailing newline. */
export function serializeBaseline(baseline: TestTypecheckBaseline): string {
  const ordered = sortedRecord<unknown>({
    version: baseline.version,
    total: baseline.total,
    by_code: sortedRecord(baseline.by_code),
    errors: buildBaseline(baseline.errors).errors,
  });
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function countAt(counts: DiagnosticCounts, file: string, code: string): number | undefined {
  return counts[file]?.[code];
}

/** Per-key increases against the baseline, formatted as `+n file code`. */
export function findIncreases(current: DiagnosticCounts, baseline: DiagnosticCounts): string[] {
  const increases: string[] = [];
  for (const file of Object.keys(current).sort()) {
    for (const code of Object.keys(current[file]!).sort()) {
      const now = current[file]![code]!;
      const before = countAt(baseline, file, code) ?? 0;
      if (now > before) increases.push(`+${now - before} ${file} ${code}`);
    }
  }
  return increases;
}

/** Check mode: pass only on an exact match; lowered or vanished keys mean the baseline is stale. */
export function compareToBaseline(current: DiagnosticCounts, baseline: DiagnosticCounts): BaselineComparison {
  const increases = findIncreases(current, baseline);
  let stale = false;
  for (const file of Object.keys(baseline)) {
    for (const code of Object.keys(baseline[file]!)) {
      const now = countAt(current, file, code) ?? 0;
      if (now < baseline[file]![code]!) stale = true;
    }
  }
  return { ok: increases.length === 0 && !stale, increases, stale };
}

export function hasTscErrors(counts: DiagnosticCounts): boolean {
  return Object.values(counts).some(codes => Object.keys(codes).some(code => TSC_CODE_RE.test(code)));
}

/**
 * Update mode: never when the total rises. A per-key increase at an equal or lower total (one error
 * fixed, a new one added elsewhere) is also refused unless `force` is set, so it cannot slip in unreviewed.
 */
export function planBaselineUpdate(
  current: DiagnosticCounts,
  baseline: TestTypecheckBaseline | null,
  force = false,
): UpdatePlan {
  // tsc errors are never baselined: not by --init, and not traded for removed loose typing under --force.
  if (hasTscErrors(current)) return { allowed: false, increases: findIncreases(current, baseline?.errors ?? {}) };
  if (baseline === null) return { allowed: true, increases: [] };
  const increases = findIncreases(current, baseline.errors);
  if (buildBaseline(current).total > baseline.total) return { allowed: false, increases };
  return { allowed: increases.length === 0 || force, increases };
}

/**
 * Test files that vitest runs (every `*.test.ts` under src/) but the tsc program does not contain. A narrowed
 * `include` or a widened `exclude` in tsconfig.test.json would otherwise report 0 errors and pass.
 */
export function findUncheckedTestFiles(programFiles: readonly string[], testFiles: readonly string[]): string[] {
  const inProgram = new Set(programFiles);
  return testFiles.filter(file => !inProgram.has(file)).sort();
}

type AstNode = { type: string; [key: string]: unknown };

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/** Whether an import specifier in `file` (repo-relative) resolves to the untyped fixture module, any extension. */
function importsUntypedFixture(specifier: string, file: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
  return target.replace(/\.[cm]?[jt]s$/, "") === UNTYPED_PAYLOAD_MODULE;
}

/**
 * Loose typing in one test source: explicit `any` annotations (`as any`, `: any`, `any[]`, ...) and every
 * reference to the any-returning `parseMcpResponse` of __fixtures__/mcp-response (named, aliased or via a
 * namespace import; calls, `.map(parse)` and re-bindings alike). Typed code uses parseToolPayload<T>.
 */
export function countLooseTyping(source: string, file: string): { any: number; untypedPayload: number } {
  const ast = parseSource(source, { sourceType: "module", plugins: ["typescript"] }) as unknown as { program: AstNode };
  const untypedNames = new Set<string>();
  const namespaces = new Set<string>();
  let untypedPayload = 0;
  for (const statement of ast.program.body as AstNode[]) {
    const from = (statement.source as { value?: unknown } | undefined)?.value;
    if (typeof from !== "string" || !importsUntypedFixture(from, file)) continue;
    // A re-export hands the any on: `export *`, `export * as ns`, or a specifier naming parseMcpResponse.
    const reexportsUntyped = statement.type === "ExportAllDeclaration"
      || (statement.type === "ExportNamedDeclaration" && (statement.specifiers as AstNode[]).some(specifier =>
        specifier.type === "ExportNamespaceSpecifier"
        || ((specifier.local as { name?: string; value?: string } | undefined)?.name ?? (specifier.local as { value?: string } | undefined)?.value) === "parseMcpResponse"));
    if (reexportsUntyped) untypedPayload += 1;
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers as AstNode[]) {
      const imported = specifier.imported as { name?: string; value?: string } | undefined;
      const local = (specifier.local as { name: string }).name;
      if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(local);
      else if (specifier.type === "ImportSpecifier" && (imported?.name ?? imported?.value) === "parseMcpResponse") untypedNames.add(local);
    }
  }
  let any = 0;
  const visit = (node: AstNode, parent: AstNode | undefined, key: string): void => {
    if (node.type === "ImportDeclaration") return;
    if (node.type === "TSAnyKeyword") any += 1;
    if (node.type === "Identifier" && untypedNames.has(node.name as string)) {
      const isPropertyName = (parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression")
        && key === "property" && parent.computed !== true;
      // Shorthand `{ name }` and `export { name }` hold two Identifier nodes; count the value / local side only.
      const isObjectKey = parent?.type === "ObjectProperty" && key === "key" && parent.computed !== true;
      const isExportedName = parent?.type === "ExportSpecifier" && key === "exported";
      if (!isPropertyName && !isObjectKey && !isExportedName) untypedPayload += 1;
    }
    if ((node.type === "MemberExpression" || node.type === "OptionalMemberExpression")
      && (node.object as AstNode).type === "Identifier" && namespaces.has((node.object as AstNode).name as string)
      && (node.property as AstNode).type === "Identifier" && (node.property as AstNode).name === "parseMcpResponse") {
      untypedPayload += 1;
    }
    for (const [childKey, value] of Object.entries(node)) {
      if (childKey === "loc" || childKey.endsWith("Comments")) continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isAstNode(child)) visit(child, node, childKey);
      }
    }
  };
  visit(ast.program, undefined, "");
  return { any, untypedPayload };
}

/** Test-support sources (tests, fixtures, integration) whose loose typing is ratcheted. */
export function isTestSupportFile(file: string): boolean {
  return file.startsWith("src/") && file.endsWith(".ts")
    && (file.endsWith(".test.ts") || file.includes("/__fixtures__/") || file.includes("/__integration__/"));
}

/** Add the loose-typing pseudo-codes to the per-(file, code) counts. */
export function addLooseTypingCounts(
  counts: DiagnosticCounts,
  files: ReadonlyArray<{ file: string; any: number; untypedPayload: number }>,
): DiagnosticCounts {
  const merged: DiagnosticCounts = {};
  for (const [file, codes] of Object.entries(counts)) merged[file] = { ...codes };
  for (const { file, any, untypedPayload } of files) {
    if (any > 0) (merged[file] ??= {})[ANY_CODE] = any;
    if (untypedPayload > 0) (merged[file] ??= {})[UNTYPED_PAYLOAD_CODE] = untypedPayload;
  }
  return buildBaseline(merged).errors;
}

export function summaryLine(counts: {
  tsc: number;
  ts18046: number;
  any: number;
  untypedPayload: number;
}, baselineTotal: number | string): string {
  const total = counts.tsc + counts.any + counts.untypedPayload;
  return `TEST_TYPECHECK total=${total} tsc=${counts.tsc} ts18046=${counts.ts18046} other=${counts.tsc - counts.ts18046}`
    + ` any=${counts.any} untyped_payload=${counts.untypedPayload} baseline_total=${baselineTotal}`;
}

const thisPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(thisPath), "..");
const baselinePath = resolve(repoRoot, "scripts/test-typecheck-baseline.json");

function runTsc(...extraArgs: string[]): { status: number | null; output: string } {
  const tscPath = resolve(repoRoot, "node_modules/typescript/bin/tsc");
  const result = spawnSync(process.execPath, [tscPath, "-p", "tsconfig.test.json", "--pretty", "false", ...extraArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Repo-relative paths of every `*.test.ts` under src/, matching vitest's include in vitest.config.ts. */
function listTestFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".test.ts")) files.push(normalizeDiagnosticPath(relative(repoRoot, path), repoRoot));
    }
  };
  walk(resolve(repoRoot, "src"));
  return files;
}

function main(): number {
  const update = process.argv.includes("--update");
  const force = process.argv.includes("--force");
  const init = process.argv.includes("--init");
  const baseline: TestTypecheckBaseline | null = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, "utf8")) as TestTypecheckBaseline
    : null;
  const baselineTotal: number | string = baseline?.total ?? "missing";

  const testFiles = listTestFiles();
  const listed = runTsc("--listFilesOnly");
  const programFiles = listed.output.split(/\r?\n/).filter(Boolean).map(file => normalizeDiagnosticPath(file, repoRoot));
  const unchecked = findUncheckedTestFiles(programFiles, testFiles);
  if (listed.status !== 0 || testFiles.length === 0 || unchecked.length > 0) {
    console.error(`tsconfig.test.json does not cover every test file (tsc --listFilesOnly status ${listed.status}, ${testFiles.length} test files):`);
    for (const file of unchecked) console.error(`  not in program: ${file}`);
    console.log(summaryLine({ tsc: 0, ts18046: 0, any: 0, untypedPayload: 0 }, baselineTotal));
    return 2;
  }

  const { status, output } = runTsc();
  const { diagnostics, unparseable } = parseDiagnostics(output, repoRoot);
  const loose = programFiles.filter(isTestSupportFile).sort()
    .map(file => ({ file, ...countLooseTyping(readFileSync(resolve(repoRoot, file), "utf8"), file) }));
  const current = addLooseTypingCounts(summarizeDiagnostics(diagnostics), loose);
  const total = buildBaseline(current).total;
  const counts = {
    tsc: diagnostics.length,
    ts18046: diagnostics.filter(d => d.code === "TS18046").length,
    any: loose.reduce((sum, file) => sum + file.any, 0),
    untypedPayload: loose.reduce((sum, file) => sum + file.untypedPayload, 0),
  };
  const finish = (code: number, baselineShown: number | string = baselineTotal): number => {
    console.log(summaryLine(counts, baselineShown));
    return code;
  };

  if (unparseable.length > 0) {
    console.error("Unparseable tsc error output:");
    for (const line of unparseable) console.error(line);
    return finish(2);
  }
  if (diagnostics.length > 0) {
    for (const d of diagnostics) console.error(`${d.file}(${d.line},${d.column}): ${d.code}`);
    console.error("Test sources must typecheck: tsc errors are never baselined (--force and --init do not apply).");
    return finish(1);
  }
  if (update && baseline === null && !init) {
    console.error(`Baseline file not found: ${baselinePath}. Seeding a new one resets every count; pass --init to do that deliberately.`);
    return finish(2);
  }
  if (status !== 0 && diagnostics.length === 0) {
    console.error(`tsc exited with status ${status} but reported no parseable diagnostics:`);
    console.error(output);
    return finish(2);
  }

  if (update) {
    const plan = planBaselineUpdate(current, baseline, force);
    if (!plan.allowed) {
      console.error(total > (baseline?.total ?? 0)
        ? `Refusing to update: total ${total} is above the baseline total ${baselineTotal}.`
        : "Refusing to update: new errors replace fixed ones. Fix them, or rerun with --force after review.");
      for (const line of plan.increases) console.error(line);
      return finish(1);
    }
    for (const increase of plan.increases) console.warn(`warning (forced): ${increase}`);
    writeFileSync(baselinePath, serializeBaseline(buildBaseline(current)));
    console.log(`Wrote ${baselinePath}`);
    return finish(0, total);
  }

  if (baseline === null) {
    console.error(`Baseline file not found: ${baselinePath}`);
    return finish(2);
  }
  const comparison = compareToBaseline(current, baseline.errors);
  for (const line of comparison.increases) console.error(line);
  if (comparison.stale) console.error("baseline stale (fewer errors or loose types than recorded): run npm run typecheck:tests:update");
  return finish(comparison.ok ? 0 : 1);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === thisPath) {
  process.exitCode = main();
}
