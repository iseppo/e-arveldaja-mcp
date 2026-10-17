// Step-5 reader runs on the corpus (plan step 5): N-S and N-T × 3 readers over every corpus document, then I-S
// and I-T × 3 readers over family (a) with 1:1 clean controls. The held-out set is never touched here.
// Guards:
//   - OQ-P1-9: after every case the step-5 consumption (pilot + step 5 so far + the remaining planned cases at
//     the running mean per reader × form + the legacy estimate) is projected; above 30M input / 4M output no
//     new case starts and the run stops for owner approval.
//   - Leakage: a failed audit whose failures are transport-only (Codex reconnect/transport error events, a
//     runner error without any leak signal) is re-staged by restage.ts; any other failure stops the run.
// Re-running a mode skips cases already staged under the step-5 tag (key in the registry meta).
// Usage: npx tsx scripts/reading-p1/step5.ts natural|injected|status [--concurrency 6]

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formCase, loadFamilyA, READERS, type CaseItem } from "./cases.js";
import type { CollectedCase } from "./collect.js";
import { SCRIPTS_DIR, argValue, dataPath, manifest, readJson, writeJson } from "./common.js";
import { rng, shuffle } from "./mutate.js";
import { runCases, type CaseOutcome } from "./run-cases.js";
import type { StagedCase } from "./stage.js";

export const TAG = "step5";
const CEILING = { input: 30_000_000, output: 4_000_000 };
const LEGACY = { input: 150_000, output: 50_000 };
const TRANSPORT_RE = /reconnect|websocket|transport|stream|disconnect|timed? ?out|rate.?limit|\b429\b|\b5\d\d\b|overloaded|network|connection|routing discovery/i;
/** Failure codes that can only come from a leak or an isolation fault: these stop the run. */
const LEAK_RE = /sentinel|tool_use|attachment|instruction_fragment|outside_path|mcp_server|codex_home|_model$|session_changed|thread_changed|prompt_hash/;

type Registry = StagedCase & { restaged_as?: string };

function registries(): Registry[] {
  return readdirSync(dataPath("staging")).filter((name) => /^c-[0-9a-f]{12}\.json$/.test(name)).map((name) => readJson<Registry>(dataPath("staging", name)));
}

function readingsOf(tags: string[]): CollectedCase[] {
  return readdirSync(dataPath("readings")).filter((name) => name.endsWith(".json")).map((name) => readJson<CollectedCase>(dataPath("readings", name)))
    .filter((reading) => tags.includes(String(reading.meta?.run)));
}

const sumUsage = (reading: CollectedCase) => reading.turns.reduce((acc, turn) => ({ input: acc.input + (turn.usage?.input ?? 0), output: acc.output + (turn.usage?.output ?? 0) }), { input: 0, output: 0 });

export function naturalItems(): CaseItem[] {
  const docs = manifest("corpus").map((entry) => entry.id);
  const items: CaseItem[] = [];
  for (const reader of READERS) for (const form of ["N-S", "N-T"] as const) for (const doc of docs) {
    const item = formCase(reader, form, doc, undefined, null, TAG);
    item.spec.meta = { ...item.spec.meta, key: `${reader}|${form}|${doc}` };
    items.push(item);
  }
  return shuffle(items, rng(5));
}

export function injectedItems(): CaseItem[] {
  const family = loadFamilyA();
  const items: CaseItem[] = [];
  for (const reader of READERS) for (const form of ["I-S", "I-T"] as const) for (const candidate of family.sampled) {
    const base = family.admitted_bases.find((entry) => entry.doc_id === candidate.doc_id)!;
    const id = `${candidate.doc_id}|${candidate.field}|${candidate.value}|${candidate.line}`;
    for (const mutated of [true, false]) {
      const item = formCase(reader, form, candidate.doc_id, base, mutated ? candidate : null, TAG);
      item.spec.meta = { ...item.spec.meta, key: `${reader}|${form}|${id}|${mutated ? "mutated" : "clean"}` };
      items.push(item);
    }
  }
  return shuffle(items, rng(6));
}

/** Projected step-5 consumption: done so far + the not-yet-staged planned cases at the running means. */
export function projection(planned: CaseItem[]) {
  const done = readingsOf(["pilot", TAG]);
  const consumed = done.reduce((acc, reading) => {
    const usage = sumUsage(reading);
    return { input: acc.input + usage.input, output: acc.output + usage.output };
  }, { input: 0, output: 0 });
  const means = new Map<string, { input: number; output: number; n: number }>();
  for (const reading of done.filter((entry) => entry.leakage_pass)) {
    const key = `${reading.reader}|${reading.form}`;
    const usage = sumUsage(reading);
    const entry = means.get(key) ?? { input: 0, output: 0, n: 0 };
    means.set(key, { input: entry.input + usage.input, output: entry.output + usage.output, n: entry.n + 1 });
  }
  const staged = new Set(registries().filter((entry) => entry.meta?.run === TAG).map((entry) => String(entry.meta?.key)));
  const remaining = planned.filter((item) => !staged.has(String(item.spec.meta?.key)));
  const projected = { ...consumed };
  for (const item of remaining) {
    const mean = means.get(`${item.spec.reader}|${item.spec.form}`);
    if (!mean) continue;
    projected.input += mean.input / mean.n;
    projected.output += mean.output / mean.n;
  }
  const legacyDone = existsSync(dataPath("legacy", "review_own_B_codex.json"));
  if (!legacyDone) {
    projected.input += LEGACY.input;
    projected.output += LEGACY.output;
  }
  return { consumed, projected, remaining: remaining.length, exceeds: projected.input > CEILING.input || projected.output > CEILING.output };
}

/** "transport" when the failed audit shows no leak signal and every error event is a transport message. */
export function classifyFailure(caseId: string): "transport" | "stop" {
  const leakage = readJson<{ failures: string[] }>(dataPath("leakage", `${caseId}.json`));
  if (leakage.failures.some((failure) => LEAK_RE.test(failure))) return "stop";
  for (const failure of leakage.failures) {
    const forbidden = /^turn\d_forbidden:(.*)$/.exec(failure);
    if (forbidden && forbidden[1]!.split(",").some((entry) => entry !== "event:error" && entry !== "item:error")) return "stop";
  }
  const staged = readJson<Registry>(dataPath("staging", `${caseId}.json`));
  for (const turn of [1, 2]) {
    const path = join(staged.dir, `events${turn}.jsonl`);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
      const event = JSON.parse(line) as { type?: string; message?: string; item?: { type?: string; message?: string } };
      const message = event.type === "error" ? event.message : event.item?.type === "error" ? event.item.message : undefined;
      if (message !== undefined && !TRANSPORT_RE.test(message)) return "stop";
    }
  }
  return "transport";
}

async function runSuite(name: string, planned: CaseItem[], concurrency: number): Promise<void> {
  const staged = new Set(registries().filter((entry) => entry.meta?.run === TAG).map((entry) => String(entry.meta?.key)));
  const todo = planned.filter((item) => !staged.has(String(item.spec.meta?.key)));
  const all = [...naturalItems(), ...(existsSync(dataPath("mutations", "a.json")) ? injectedItems() : [])];
  const start = projection(all);
  process.stdout.write(`${name}: ${todo.length} to run; projection ${JSON.stringify(start)}\n`);
  if (start.exceeds) {
    process.stdout.write("STOP: projection exceeds OQ-P1-9 before starting\n");
    process.exitCode = 3;
    return;
  }
  let stop: string | null = null;
  let done = 0;
  await runCases(todo, concurrency, (outcome: CaseOutcome) => {
    done += 1;
    if (!outcome.leakage_pass) {
      const kind = classifyFailure(outcome.case_id);
      if (kind === "stop") stop = `leakage:${outcome.case_id}:${outcome.failures.join(",")}`;
      process.stdout.write(`  ${outcome.case_id} leakage FAIL (${kind}) ${outcome.failures.join(",")}\n`);
    }
    if (done % 10 === 0 || stop) {
      const current = projection(all);
      process.stdout.write(`  ${done}/${todo.length} consumed ${current.consumed.input}/${current.consumed.output} projected ${Math.round(current.projected.input)}/${Math.round(current.projected.output)}\n`);
      if (current.exceeds) stop = stop ?? "projection exceeds OQ-P1-9";
    }
  }, () => stop !== null);
  if (stop) {
    process.stdout.write(`STOP: ${stop}\n`);
    writeJson(dataPath("step5", `stop-${name}.json`), { stop, at: new Date().toISOString() });
    process.exitCode = 3;
    return;
  }
  // Transport-only failures: re-stage (restage.ts re-checks every failed case of the tag).
  const output = execFileSync("npx", ["tsx", join(SCRIPTS_DIR, "restage.ts"), "--run", TAG, "--max", "2"], { encoding: "utf8" });
  process.stdout.write(output);
  const stillFailed = registries().filter((entry) => entry.meta?.run === TAG && !entry.restaged_as &&
    existsSync(dataPath("leakage", `${entry.case_id}.json`)) && !readJson<{ pass: boolean }>(dataPath("leakage", `${entry.case_id}.json`)).pass);
  for (const entry of stillFailed) {
    const kind = classifyFailure(entry.case_id);
    process.stdout.write(`  after re-stage: ${entry.case_id} still failing (${kind})\n`);
    if (kind === "stop") process.exitCode = 3;
  }
  process.stdout.write(`${name}: done; projection ${JSON.stringify(projection(all))}\n`);
}

if (process.argv[1]?.endsWith("/step5.ts")) {
  const [mode, ...rest] = process.argv.slice(2);
  const concurrency = Number(argValue(rest, "--concurrency") ?? "6");
  if (mode === "natural") await runSuite("natural", naturalItems(), concurrency);
  else if (mode === "injected") await runSuite("injected", injectedItems(), concurrency);
  else if (mode === "status") process.stdout.write(`${JSON.stringify(projection([...naturalItems(), ...injectedItems()]), null, 2)}\n`);
  else {
    process.stderr.write("usage: step5.ts natural|injected|status\n");
    process.exitCode = 1;
  }
}
