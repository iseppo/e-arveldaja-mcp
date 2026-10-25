#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * Update mode: never when the total rises. A per-key increase at an equal or lower total (one error
 * fixed, a new one added elsewhere) is also refused unless `force` is set, so it cannot slip in unreviewed.
 */
export function planBaselineUpdate(
  current: DiagnosticCounts,
  baseline: TestTypecheckBaseline | null,
  force = false,
): UpdatePlan {
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

export function summaryLine(total: number, ts18046: number, baselineTotal: number | string): string {
  return `TEST_TYPECHECK total=${total} ts18046=${ts18046} other=${total - ts18046} baseline_total=${baselineTotal}`;
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
    console.log(summaryLine(0, 0, baselineTotal));
    return 2;
  }

  const { status, output } = runTsc();
  const { diagnostics, unparseable } = parseDiagnostics(output, repoRoot);
  const current = summarizeDiagnostics(diagnostics);
  const total = diagnostics.length;
  const ts18046 = diagnostics.filter(d => d.code === "TS18046").length;
  const finish = (code: number, baselineShown: number | string = baselineTotal): number => {
    console.log(summaryLine(total, ts18046, baselineShown));
    return code;
  };

  if (unparseable.length > 0) {
    console.error("Unparseable tsc error output:");
    for (const line of unparseable) console.error(line);
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
  if (comparison.stale) console.error("baseline stale: run npm run typecheck:tests:update");
  return finish(comparison.ok ? 0 : 1);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === thisPath) {
  process.exitCode = main();
}
