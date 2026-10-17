// Re-stages the leakage-failed cases of a run (plan §5.3: a failed case is discarded and re-staged, never
// scored). Each failed case is rebuilt from its staged PROMPT.md and schemas under a fresh case id and its own
// fresh directory. Planted and canary cases are never re-staged.
// Throughput round B7/B9:
//   - every failed case is classified BEFORE every retry, including each link of a retry chain; only positive
//     transport evidence, per turn, re-stages, anything else stops the run;
//   - the cap callback runs before the round and before each launch; the projection reserves the pending and
//     in-flight replacements (step5.ts reservedKeys), so retries count against the same run-tag caps;
//   - the original records `restaged_as` only after its replacement has run; a replacement found without that
//     link (a crash in between) is linked on resume, and a link to a missing replacement is dropped, so a stop
//     never loses a case;
//   - a replacement interrupted before its audit (staged, no leakage record and no reading) is marked
//     `abandoned` on resume and its original is unlinked, so the original is classified and re-staged again;
//   - one predicate (retryEligible) decides both whether a failed case may be re-staged and whether the
//     projection reserves its retry.
// Usage: npx tsx scripts/reading-p1/restage.ts --run <tag> --cap-input <n> --cap-output <n> [--max 2]

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacketFile } from "./cases.js";
import { argValue, dataPath, readJson, writeJson } from "./common.js";
import { newCaseId, runCases } from "./run-cases.js";
import { corpusRunIndex, loadStaged, registryPath, type CaseSpec, type StagedCase } from "./stage.js";

export type Registry = StagedCase & { restaged_as?: string; attempt?: number; restage_evidence?: string[]; abandoned?: boolean };

/** Re-stage rounds per run: a case of attempt ≤ MAX_RESTAGE_ROUNDS may still be replaced. */
export const MAX_RESTAGE_ROUNDS = 2;

/** B9: a failed case may be re-staged, and its retry is reserved, only while this holds (planted/canary never). */
export function retryEligible(entry: Pick<Registry, "form" | "attempt" | "abandoned">): boolean {
  return entry.form !== "planted" && entry.form !== "canary" && !entry.abandoned && (entry.attempt ?? 1) <= MAX_RESTAGE_ROUNDS;
}
export const TRANSPORT_RE = /reconnect|websocket|transport|stream|disconnect|timed? ?out|rate.?limit|\b429\b|\b5\d\d\b|overloaded|network|connection|routing discovery/i;
/** Failure codes that can only come from a leak or an isolation fault: these stop the run. */
export const LEAK_RE = /sentinel|tool_use|attachment|instruction_fragment|outside_path|mcp_server|codex_home|_model$|session_changed|thread_changed|prompt_hash/;
/** Audit failures a transport fault produces by itself in its turn (an error event, a missing or unfinished turn). */
const TRANSPORT_CONSEQUENCE_RE = /^(?:turn(\d)_forbidden:(?:(?:event|item):error)(?:,(?:event|item):error)*|turn(\d)_output_missing|turn(\d)_events_missing|turn(\d)_not_completed|turn(\d)_is_error|run:turn(\d))$/;

/** An error message with the turn it was raised in (null: no turn, e.g. a collect error). */
export interface TurnMessage { turn: number | null; message: string }
export interface FailureEvidence { failures: string[]; run_errors: string[]; error_messages: TurnMessage[] }

/**
 * B7: "transport" only on positive evidence, per turn: every failure entry is a transport consequence of its
 * turn, that turn carries at least one transport message, and every error message is a transport message.
 * Unknown, mixed, leak, empty or evidence-free failures → "stop". A recovered transport fault in one turn never
 * explains a failure in another.
 */
export function classifyEvidence(evidence: FailureEvidence): { kind: "transport" | "stop"; evidence: string[] } {
  const messages: TurnMessage[] = [
    ...evidence.error_messages,
    ...evidence.run_errors.map((error) => {
      const turn = /^turn(\d):/.exec(error);
      return { turn: turn ? Number(turn[1]) : null, message: turn ? error.slice(turn[0].length) : error };
    }),
  ];
  const listed = messages.map((entry) => `${entry.turn === null ? "-" : `turn${entry.turn}`}: ${entry.message}`);
  const stop = { kind: "stop" as const, evidence: listed };
  if (evidence.failures.length === 0) return stop;
  if (evidence.failures.some((failure) => LEAK_RE.test(failure))) return stop;
  if (messages.length === 0 || !messages.every((entry) => TRANSPORT_RE.test(entry.message))) return stop;
  for (const failure of evidence.failures) {
    const match = TRANSPORT_CONSEQUENCE_RE.exec(failure);
    if (!match) return stop;
    const turn = Number(match.slice(1).find((group) => group !== undefined));
    if (!messages.some((entry) => entry.turn === turn)) return stop;
  }
  return { kind: "transport", evidence: listed };
}

/** The evidence of one failed case: its leakage record and the error events of its staged turns. */
export function failureEvidence(caseId: string): FailureEvidence {
  const leakage = readJson<{ failures?: string[]; run_errors?: string[] }>(dataPath("leakage", `${caseId}.json`));
  const staged = readJson<Registry>(registryPath(caseId));
  const messages: TurnMessage[] = [];
  for (const turn of [1, 2]) {
    const path = join(staged.dir, `events${turn}.jsonl`);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
      let event: { type?: string; message?: string; item?: { type?: string; message?: string } };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        messages.push({ turn, message: "unparseable event" });
        continue;
      }
      if (event.type === "error") messages.push({ turn, message: event.message ?? "error event without message" });
      else if (event.item?.type === "error") messages.push({ turn, message: event.item.message ?? "error item without message" });
    }
  }
  return { failures: leakage.failures ?? [], run_errors: leakage.run_errors ?? [], error_messages: messages };
}

export function classifyFailure(caseId: string): "transport" | "stop" {
  return classifyEvidence(failureEvidence(caseId)).kind;
}

/** The run's registries (corpus rows of its index only), with replacement links repaired (see header). */
export function runRegistries(tag: string): Registry[] {
  const regs = corpusRunIndex(tag).filter((entry) => existsSync(registryPath(entry.case_id))).map((entry) => loadStaged(entry.case_id) as Registry);
  for (const entry of regs) {
    const interrupted = typeof entry.meta?.restaged_from === "string" && !entry.abandoned &&
      !existsSync(dataPath("leakage", `${entry.case_id}.json`)) && !existsSync(dataPath("readings", `${entry.case_id}.json`));
    if (interrupted) {
      entry.abandoned = true;
      writeJson(registryPath(entry.case_id), entry);
    }
  }
  const live = regs.filter((entry) => !entry.abandoned);
  const byId = new Map(live.map((entry) => [entry.case_id, entry]));
  for (const entry of regs) {
    const replacement = live.find((other) => other.meta?.restaged_from === entry.case_id);
    if (replacement && entry.restaged_as !== replacement.case_id) {
      entry.restaged_as = replacement.case_id;
      writeJson(registryPath(entry.case_id), entry);
    } else if (!replacement && entry.restaged_as && !byId.has(entry.restaged_as)) {
      delete entry.restaged_as;
      writeJson(registryPath(entry.case_id), entry);
    }
  }
  return regs;
}

const leakageFailed = (caseId: string) => existsSync(dataPath("leakage", `${caseId}.json`)) && !readJson<{ pass: boolean }>(dataPath("leakage", `${caseId}.json`)).pass;

/** The failed, not yet re-staged cases of a run tag. */
function failedCases(tag: string): Registry[] {
  return runRegistries(tag).filter((staged) => !staged.restaged_as && retryEligible(staged) && leakageFailed(staged.case_id));
}

export interface RestageOptions {
  tag: string;
  max: number;
  /** The run-tag projection/cap check (pending and in-flight replacements reserved); true stops before the next launch. */
  exceeds: () => boolean;
  log?: (line: string) => void;
}

/** Re-stages transport-only failures, classifying before every retry. Returns the stop reason, if any. */
export async function restageRun(opts: RestageOptions): Promise<string | null> {
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  for (let round = 1; round <= opts.max; round++) {
    const failed = failedCases(opts.tag);
    if (failed.length === 0) return null;
    const verdicts = new Map<string, string[]>();
    for (const staged of failed) {
      const verdict = classifyEvidence(failureEvidence(staged.case_id));
      if (verdict.kind === "stop") return `leakage:${staged.case_id}:not transport-only (round ${round})`;
      verdicts.set(staged.case_id, verdict.evidence);
    }
    if (opts.exceeds()) return `projection exceeds the ${opts.tag} caps before re-stage round ${round}`;
    const items = failed.map((staged) => {
      const schemas = [1, 2].map((turn) => join(staged.dir, `schema${turn}.json`)).filter((path) => existsSync(path))
        .map((path) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
      const { dir: _dir, prompt_sha256: _hash, turn2_sha256: _turn2, staged_at: _at, restaged_as: _as, restage_evidence: _ev, abandoned: _ab, attempt, ...rest } = staged;
      const spec: CaseSpec = { ...rest, case_id: newCaseId(), prompt: readFileSync(join(staged.dir, "PROMPT.md"), "utf8"), ...(schemas.length ? { schemas } : {}), meta: { ...rest.meta, restaged_from: staged.case_id } };
      return { original: staged, spec, packet: staged.doc_id && staged.form === "N-T" ? loadPacketFile(staged.doc_id).packet : undefined, attempt: (attempt ?? 1) + 1 };
    });
    let stop: string | null = null;
    await runCases(items.map(({ spec, packet }) => ({ spec, packet })), 4, (outcome) => {
      const item = items.find((entry) => entry.spec.case_id === outcome.case_id)!;
      const path = registryPath(outcome.case_id);
      writeJson(path, { ...readJson<Registry>(path), attempt: item.attempt });
      writeJson(registryPath(item.original.case_id), { ...readJson<Registry>(registryPath(item.original.case_id)), restaged_as: outcome.case_id, restage_evidence: verdicts.get(item.original.case_id) });
      log(`round ${round}: ${item.original.case_id} → ${outcome.case_id} leakage=${outcome.leakage_pass} ${outcome.failures.join(",")}`);
      if (!outcome.leakage_pass && classifyFailure(outcome.case_id) === "stop") stop = stop ?? `leakage:${outcome.case_id}:${outcome.failures.join(",")}`;
    }, () => {
      if (stop === null && opts.exceeds()) stop = `projection exceeds the ${opts.tag} caps`;
      return stop !== null;
    });
    if (stop) return stop;
  }
  return null;
}

if (process.argv[1]?.endsWith("/restage.ts")) {
  // Not a top-level await: step5.ts imports this module, so awaiting its import here would deadlock the cycle.
  void import("./step5.js").then(async ({ parseRunArgs, projection, allPlanned }) => {
    const argv = process.argv.slice(2);
    const run = parseRunArgs(argv);
    if ("error" in run) {
      process.stderr.write(`${run.error}\nusage: restage.ts --run <tag> --cap-input <n> --cap-output <n> [--max 2]\n`);
      process.exitCode = 1;
      return;
    }
    const planned = allPlanned(run.tag);
    const stop = await restageRun({ tag: run.tag, max: Number(argValue(argv, "--max") ?? String(MAX_RESTAGE_ROUNDS)), exceeds: () => projection(planned, run).exceeds });
    if (stop) {
      process.stdout.write(`STOP: ${stop}\n`);
      process.exitCode = 3;
    }
  });
}
