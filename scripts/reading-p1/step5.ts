// Reader runs (plan step 5; throughput round T5 as run `step5b`): N-S and N-T × 3 readers over every corpus
// document, then I-S and I-T × 3 readers over family (a) with 1:1 clean controls. The held-out set is touched
// only by a tag bound to `--scope heldout` (step 6: natural only).
// Guards:
//   - B9 (throughput round): every run has its own tag (`--run`, required; `step5` is refused, it is frozen) and
//     its own caps (`--cap-input/--cap-output`, required, at most the OQ-P1-9 ceiling 30M / 4M). Accounting counts
//     only the cases of that tag: consumed tokens, the projection (the not-yet-staged planned cases at the tag's
//     running mean per reader × form, the step-5 mean until the tag has its own, plus a reserved mean for every
//     staged case without a reading yet (in flight) and every failed case still due a replacement) and the
//     stop files under
//     <data>/<tag>/. The I-case plan is recomputed from the current mutations/a.json (2 × sampled per reader ×
//     form). Above a cap no new case starts, re-stages included.
//   - Leakage (B7): a failed case is re-staged only on positive transport evidence (restage.ts classifyEvidence),
//     checked before every retry; any other failure stops the run.
// Re-running a mode skips cases already staged under the same tag (key in the registry meta).
// Step 6: `--scope heldout` binds a new tag to the held-out manifest (natural only; runs/<tag>.scope); a bound tag
// never changes scope, and its accounting, preflight and re-stages see only its own scope's rows.
// A sub-run (`--doc <id>`, `--form <form>`) plans, runs and projects only that slice under its own tag and caps.
// Usage: npx tsx scripts/reading-p1/step5.ts natural|injected|status --run <tag> --cap-input <n> --cap-output <n> [--doc <id>] [--form <form>] [--injected-reader <reader>] [--scope corpus|heldout] [--concurrency 6]

import { existsSync } from "node:fs";
import { formCase, loadFamilyA, READERS, type CaseItem } from "./cases.js";
import type { CollectedCase } from "./collect.js";
import { SCOPES, argValue, dataPath, manifest, readJson, writeJson, type Scope } from "./common.js";
import { rng, shuffle, type FamilyA } from "./mutate.js";
import { MAX_RESTAGE_ROUNDS, classifyFailure, preflightRun, restageRun, retryEligible, runRegistries, withAttempts, type Registry } from "./restage.js";
import { runCases, type CaseOutcome } from "./run-cases.js";
import { bindRunScope, loadStaged, registryPath, scopedRunIndex } from "./stage.js";

/** The frozen step-5 tag: its readings seed the per-case means of a new run, never its accounting. */
export const FROZEN_TAG = "step5";
const CEILING = { input: 30_000_000, output: 4_000_000 };
export const LEGACY = { input: 150_000, output: 50_000 };

export interface RunArgs { tag: string; caps: { input: number; output: number }; scope: Scope; only?: { doc?: string; form?: string; injectedReader?: string } }

/**
 * A sub-run (`--doc`, `--form`, `--injected-reader`) plans, runs and projects only its slice of the cases;
 * `--injected-reader` keeps every natural case and the I-cases of that reader only.
 */
export function scoped(items: CaseItem[], run: Pick<RunArgs, "only">): CaseItem[] {
  const injected = (item: CaseItem) => item.spec.form === "I-S" || item.spec.form === "I-T";
  return items.filter((item) => (!run.only?.doc || item.spec.doc_id === run.only.doc) && (!run.only?.form || item.spec.form === run.only.form) &&
    (!run.only?.injectedReader || !injected(item) || item.spec.reader === run.only.injectedReader));
}

/** B9: --run (not the frozen tag) and both caps are required; caps may not exceed the OQ-P1-9 ceiling. */
export function parseRunArgs(argv: readonly string[]): RunArgs | { error: string } {
  let tag: string | undefined;
  let capInput: string | undefined;
  let capOutput: string | undefined;
  let doc: string | undefined;
  let form: string | undefined;
  let injectedReader: string | undefined;
  let scope: string | undefined;
  try {
    tag = argValue(argv, "--run");
    capInput = argValue(argv, "--cap-input");
    capOutput = argValue(argv, "--cap-output");
    doc = argValue(argv, "--doc");
    form = argValue(argv, "--form");
    injectedReader = argValue(argv, "--injected-reader");
    scope = argValue(argv, "--scope");
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!tag) return { error: "--run <tag> is required" };
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(tag)) return { error: `--run ${tag}: lower-case letters, digits and - only` };
  if (tag === FROZEN_TAG) return { error: `--run ${FROZEN_TAG} is frozen; use a new tag` };
  if (capInput === undefined || capOutput === undefined) return { error: "--cap-input <n> and --cap-output <n> are required" };
  const input = Number(capInput);
  const output = Number(capOutput);
  if (!Number.isInteger(input) || !Number.isInteger(output) || input <= 0 || output <= 0) return { error: "caps must be positive integers" };
  if (input > CEILING.input || output > CEILING.output) return { error: `caps exceed the OQ-P1-9 ceiling ${CEILING.input} / ${CEILING.output}` };
  if (form !== undefined && !["N-S", "N-T", "I-S", "I-T"].includes(form)) return { error: `--form ${form}: N-S, N-T, I-S or I-T` };
  if (injectedReader !== undefined && !(READERS as readonly string[]).includes(injectedReader)) return { error: `--injected-reader ${injectedReader}: one of ${READERS.join(", ")}` };
  const only = { ...(doc ? { doc } : {}), ...(form ? { form } : {}), ...(injectedReader ? { injectedReader } : {}) };
  if (scope !== undefined && !(SCOPES as readonly string[]).includes(scope)) return { error: `--scope ${scope}: one of ${SCOPES.join(", ")}` };
  return { tag, caps: { input, output }, scope: (scope ?? "corpus") as Scope, ...(Object.keys(only).length ? { only } : {}) };
}

/** The run's registries, from the corpus rows of its run index only (no other case record is opened). */
function registries(tag: string): Registry[] {
  return withAttempts(scopedRunIndex(tag).filter((entry) => existsSync(registryPath(entry.case_id))).map((entry) => loadStaged(entry.case_id) as Registry));
}

const readingPath = (caseId: string) => dataPath("readings", `${caseId}.json`);

function readingsOf(tag: string): CollectedCase[] {
  return scopedRunIndex(tag).filter((entry) => existsSync(readingPath(entry.case_id))).map((entry) => readJson<CollectedCase>(readingPath(entry.case_id)));
}

const sumUsage = (reading: CollectedCase) => reading.turns.reduce((acc, turn) => ({ input: acc.input + (turn.usage?.input ?? 0), output: acc.output + (turn.usage?.output ?? 0) }), { input: 0, output: 0 });

/** N-S and N-T × 3 readers over every document of the scope's manifest (the held-out scope: step 6). */
export function naturalItems(tag: string, scope: Scope = "corpus"): CaseItem[] {
  const docs = manifest(scope).map((entry) => entry.id);
  const items: CaseItem[] = [];
  for (const reader of READERS) for (const form of ["N-S", "N-T"] as const) for (const doc of docs) {
    const item = formCase(reader, form, doc, undefined, null, tag);
    item.spec.meta = { ...item.spec.meta, key: `${reader}|${form}|${doc}` };
    items.push(item);
  }
  return shuffle(items, rng(5));
}

/** I-S and I-T: 2 × sampled(a) per reader × form, from the given (by default the current) family (a). */
export function injectedItems(tag: string, family: FamilyA = loadFamilyA()): CaseItem[] {
  const items: CaseItem[] = [];
  for (const reader of READERS) for (const form of ["I-S", "I-T"] as const) for (const candidate of family.sampled) {
    const base = family.admitted_bases.find((entry) => entry.doc_id === candidate.doc_id)!;
    const id = `${candidate.doc_id}|${candidate.field}|${candidate.value}|${candidate.line}`;
    for (const mutated of [true, false]) {
      const item = formCase(reader, form, candidate.doc_id, base, mutated ? candidate : null, tag);
      item.spec.meta = { ...item.spec.meta, key: `${reader}|${form}|${id}|${mutated ? "mutated" : "clean"}` };
      items.push(item);
    }
  }
  return shuffle(items, rng(6));
}

/** The held-out scope is natural only: family (a) is built from the corpus. */
export function allPlanned(tag: string, scope: Scope = "corpus"): CaseItem[] {
  if (scope !== "corpus") return naturalItems(tag, scope);
  return [...naturalItems(tag), ...(existsSync(dataPath("mutations", "a.json")) ? injectedItems(tag) : [])];
}

/** The planned cases not yet staged under `tag` (registries of other tags never count). */
export function todoItems(planned: CaseItem[], staged: ReadonlyArray<{ meta?: Record<string, unknown>; abandoned?: boolean }>, tag: string): CaseItem[] {
  // An abandoned (staged, never launched) case frees its plan key: it is run again under a new id.
  const keys = new Set(staged.filter((entry) => entry.meta?.run === tag && !entry.abandoned).map((entry) => String(entry.meta?.key)));
  return planned.filter((item) => !keys.has(String(item.spec.meta?.key)));
}

export type Means = Map<string, { input: number; output: number; n: number }>;

export function meansOf(readings: CollectedCase[]): Means {
  const means: Means = new Map();
  for (const reading of readings.filter((entry) => entry.leakage_pass)) {
    const key = `${reading.reader}|${reading.form}`;
    const usage = sumUsage(reading);
    const entry = means.get(key) ?? { input: 0, output: 0, n: 0 };
    means.set(key, { input: entry.input + usage.input, output: entry.output + usage.output, n: entry.n + 1 });
  }
  return means;
}

/**
 * Reader × form keys of the cases that will still consume tokens without being planned-and-unstaged: a staged
 * case with no reading yet (in flight, or its replacement), and a failed case that restage.ts may still retry
 * (retryEligible, the same predicate restage uses) with no live replacement staged yet. An abandoned
 * (interrupted) replacement never runs again and is not reserved.
 */
export function reservedKeys(regs: ReadonlyArray<Pick<Registry, "case_id" | "reader" | "form" | "meta" | "attempt" | "abandoned">>, hasReading: (caseId: string) => boolean, failed: (caseId: string) => boolean): string[] {
  const live = regs.filter((entry) => !entry.abandoned);
  const replaced = new Set(live.map((entry) => entry.meta?.restaged_from).filter((id): id is string => typeof id === "string"));
  const keys: string[] = [];
  for (const entry of live) {
    if (entry.form === "planted" || entry.form === "canary") continue;
    if (!hasReading(entry.case_id)) keys.push(`${entry.reader}|${entry.form}`);
    else if (failed(entry.case_id) && !replaced.has(entry.case_id) && retryEligible(entry)) keys.push(`${entry.reader}|${entry.form}`);
  }
  return keys;
}

/** consumed + one mean per estimated key (+ the legacy estimate while it is pending), against the caps. */
export function projectTotals(input: { consumed: { input: number; output: number }; keys: string[]; own: Means; prior: Means; legacyPending: boolean; caps: RunArgs["caps"] }) {
  const projected = { ...input.consumed };
  let unestimated = 0;
  for (const key of input.keys) {
    const mean = input.own.get(key) ?? input.prior.get(key);
    if (!mean) {
      unestimated += 1;
      continue;
    }
    projected.input += mean.input / mean.n;
    projected.output += mean.output / mean.n;
  }
  if (input.legacyPending) {
    projected.input += LEGACY.input;
    projected.output += LEGACY.output;
  }
  return { projected, unestimated, exceeds: unestimated > 0 || projected.input > input.caps.input || projected.output > input.caps.output };
}

/** Projected consumption of `run.tag`: its own cases so far + unstaged planned cases + reserved in-flight/retries. */
export function projection(planned: CaseItem[], run: RunArgs) {
  const done = readingsOf(run.tag);
  const consumed = done.reduce((acc, reading) => {
    const usage = sumUsage(reading);
    return { input: acc.input + usage.input, output: acc.output + usage.output };
  }, { input: 0, output: 0 });
  const regs = registries(run.tag);
  const remaining = todoItems(planned, regs, run.tag);
  const reserved = reservedKeys(regs, (caseId) => existsSync(readingPath(caseId)),
    (caseId) => existsSync(dataPath("leakage", `${caseId}.json`)) && !readJson<{ pass: boolean }>(dataPath("leakage", `${caseId}.json`)).pass);
  const totals = projectTotals({
    consumed,
    keys: [...remaining.map((item) => `${item.spec.reader}|${item.spec.form}`), ...reserved],
    own: meansOf(done),
    prior: meansOf(readingsOf(FROZEN_TAG)),
    legacyPending: !existsSync(dataPath("legacy", "review_own_B_codex.json")),
    caps: run.caps,
  });
  const iCases = planned.filter((item) => item.spec.form === "I-S" || item.spec.form === "I-T").length;
  return { run: run.tag, caps: run.caps, consumed, ...totals, remaining: remaining.length, reserved: reserved.length, planned_i_cases: iCases };
}

async function runSuite(name: string, planned: CaseItem[], run: RunArgs, concurrency: number): Promise<void> {
  const writeStop = (stop: string) => {
    process.stdout.write(`STOP: ${stop}\n`);
    writeJson(dataPath(run.tag, `stop-${name}.json`), { stop, at: new Date().toISOString() });
    process.exitCode = 3;
  };
  // The tag is bound to its scope before anything of it is read or staged.
  const bound = bindRunScope(run.tag, run.scope);
  if (bound) {
    writeStop(bound);
    return;
  }
  // The pre-launch rule runs before the todo list and the projection are computed, so both see the ledger.
  const preflight = preflightRun(run.tag);
  if (preflight) {
    writeStop(preflight);
    return;
  }
  const todo = todoItems(scoped(planned, run), registries(run.tag), run.tag);
  const all = scoped(allPlanned(run.tag, run.scope), run);
  const start = projection(all, run);
  process.stdout.write(`${name}: ${todo.length} to run; projection ${JSON.stringify(start)}\n`);
  if (start.exceeds) {
    writeStop(`projection exceeds the ${run.tag} caps before starting`);
    return;
  }
  let stop: string | null = null;
  let done = 0;
  await runCases(todo, concurrency, (outcome: CaseOutcome) => {
    done += 1;
    if (!outcome.leakage_pass) {
      const kind = classifyFailure(outcome.case_id);
      if (kind === "stop") stop = stop ?? `leakage:${outcome.case_id}:${outcome.failures.join(",")}`;
      process.stdout.write(`  ${outcome.case_id} leakage FAIL (${kind}) ${outcome.failures.join(",")}\n`);
    }
    const current = projection(all, run);
    if (done % 10 === 0 || stop) process.stdout.write(`  ${done}/${todo.length} consumed ${current.consumed.input}/${current.consumed.output} projected ${Math.round(current.projected.input)}/${Math.round(current.projected.output)}\n`);
    if (current.exceeds) stop = stop ?? `projection exceeds the ${run.tag} caps`;
  }, (inFlight) => {
    if (stop === null) stop = preflightRun(run.tag, inFlight);
    if (stop === null && projection(all, run).exceeds) stop = `projection exceeds the ${run.tag} caps`;
    return stop !== null;
  });
  if (stop) {
    writeStop(stop);
    return;
  }
  // Transport-only failures: re-stage in-process, classified before every retry, under the same caps.
  const restageStop = await restageRun({ tag: run.tag, max: MAX_RESTAGE_ROUNDS, exceeds: () => projection(all, run).exceeds });
  if (restageStop) {
    writeStop(restageStop);
    return;
  }
  const stillFailed = runRegistries(run.tag).filter((entry) => !entry.restaged_as &&
    existsSync(dataPath("leakage", `${entry.case_id}.json`)) && !readJson<{ pass: boolean }>(dataPath("leakage", `${entry.case_id}.json`)).pass);
  for (const entry of stillFailed) {
    const kind = classifyFailure(entry.case_id);
    process.stdout.write(`  after re-stage: ${entry.case_id} still failing (${kind})\n`);
    if (kind === "stop") process.exitCode = 3;
  }
  process.stdout.write(`${name}: done; projection ${JSON.stringify(projection(all, run))}\n`);
}

if (process.argv[1]?.endsWith("/step5.ts")) {
  const [mode, ...rest] = process.argv.slice(2);
  const concurrency = Number(argValue(rest, "--concurrency") ?? "6");
  const run = parseRunArgs(rest);
  if ("error" in run || !["natural", "injected", "status"].includes(mode ?? "")) {
    process.stderr.write(`${"error" in run ? `${run.error}\n` : ""}usage: step5.ts natural|injected|status --run <tag> --cap-input <n> --cap-output <n> [--doc <id>] [--form <form>] [--injected-reader <reader>] [--scope corpus|heldout] [--concurrency 6]\n`);
    process.exitCode = 1;
  } else if (mode === "injected" && run.scope !== "corpus") {
    process.stderr.write(`injected cases are corpus only (family (a)); --scope ${run.scope} runs natural only\n`);
    process.exitCode = 1;
  } else if (mode === "natural") await runSuite("natural", naturalItems(run.tag, run.scope), run, concurrency);
  else if (mode === "injected") await runSuite("injected", injectedItems(run.tag), run, concurrency);
  else process.stdout.write(`${JSON.stringify(projection(scoped(allPlanned(run.tag, run.scope), run), run), null, 2)}\n`);
}
