// Re-stages the leakage-failed cases of a run (plan §5.3: a failed case is discarded and re-staged, never
// scored). Each failed case is rebuilt from its staged PROMPT.md and schemas under a fresh case id and its own
// fresh directory; the old registry entry records `restaged_as` and the transport evidence. Planted and canary
// cases are never re-staged.
// Throughput round B7/B9: every failed case is classified BEFORE every retry, including each link of a retry
// chain. Only positive transport evidence re-stages; anything else stops the run, and the retries run under the
// caller's projection/cap callback, so they count against the same run-tag caps.
// Usage: npx tsx scripts/reading-p1/restage.ts --run <tag> --cap-input <n> --cap-output <n> [--max 2]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacketFile } from "./cases.js";
import { argValue, dataPath, readJson, writeJson } from "./common.js";
import { newCaseId, runCases } from "./run-cases.js";
import { loadStaged, registryPath, type CaseSpec, type StagedCase } from "./stage.js";

export type Registry = StagedCase & { restaged_as?: string; attempt?: number; restage_evidence?: string[] };

export const TRANSPORT_RE = /reconnect|websocket|transport|stream|disconnect|timed? ?out|rate.?limit|\b429\b|\b5\d\d\b|overloaded|network|connection|routing discovery/i;
/** Failure codes that can only come from a leak or an isolation fault: these stop the run. */
export const LEAK_RE = /sentinel|tool_use|attachment|instruction_fragment|outside_path|mcp_server|codex_home|_model$|session_changed|thread_changed|prompt_hash/;
/** Audit failures a transport fault produces by itself (an error event, a missing or unfinished turn). */
const TRANSPORT_CONSEQUENCE_RE = /^(?:turn\d_forbidden:(?:(?:event|item):error)(?:,(?:event|item):error)*|turn\d_output_missing|turn\d_events_missing|turn\d_not_completed|turn\d_is_error|run:turn\d)$/;

export interface FailureEvidence { failures: string[]; run_errors: string[]; error_messages: string[] }

/**
 * B7: "transport" only on positive evidence: at least one error event or run error matching TRANSPORT_RE, every
 * error message a transport message, and every failure entry a transport consequence. Unknown, mixed, leak,
 * empty or evidence-free failures → "stop".
 */
export function classifyEvidence(evidence: FailureEvidence): { kind: "transport" | "stop"; evidence: string[] } {
  const messages = [...evidence.error_messages, ...evidence.run_errors.map((error) => error.replace(/^turn\d:/, ""))];
  const stop = { kind: "stop" as const, evidence: messages };
  if (evidence.failures.length === 0) return stop;
  if (evidence.failures.some((failure) => LEAK_RE.test(failure))) return stop;
  if (!evidence.failures.every((failure) => TRANSPORT_CONSEQUENCE_RE.test(failure))) return stop;
  if (messages.length === 0 || !messages.every((message) => TRANSPORT_RE.test(message))) return stop;
  return { kind: "transport", evidence: messages };
}

/** The evidence of one failed case: its leakage record and the error events of its staged turns. */
export function failureEvidence(caseId: string): FailureEvidence {
  const leakage = readJson<{ failures?: string[]; run_errors?: string[] }>(dataPath("leakage", `${caseId}.json`));
  const staged = readJson<Registry>(registryPath(caseId));
  const messages: string[] = [];
  for (const turn of [1, 2]) {
    const path = join(staged.dir, `events${turn}.jsonl`);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
      let event: { type?: string; message?: string; item?: { type?: string; message?: string } };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        messages.push("unparseable event");
        continue;
      }
      if (event.type === "error") messages.push(event.message ?? "error event without message");
      else if (event.item?.type === "error") messages.push(event.item.message ?? "error item without message");
    }
  }
  return { failures: leakage.failures ?? [], run_errors: leakage.run_errors ?? [], error_messages: messages };
}

export function classifyFailure(caseId: string): "transport" | "stop" {
  return classifyEvidence(failureEvidence(caseId)).kind;
}

/** The failed, not yet re-staged cases of a run tag. */
function failedCases(tag: string): Registry[] {
  const failed: Registry[] = [];
  for (const name of readdirSync(dataPath("leakage")).filter((file) => file.endsWith(".json"))) {
    const caseId = name.slice(0, -5);
    if (!existsSync(registryPath(caseId))) continue;
    const staged = loadStaged(caseId) as Registry;
    if (staged.meta?.run !== tag || staged.restaged_as || staged.form === "planted" || staged.form === "canary") continue;
    if (!readJson<{ pass: boolean }>(dataPath("leakage", name)).pass) failed.push(staged);
  }
  return failed;
}

export interface RestageOptions {
  tag: string;
  max: number;
  /** The run-tag projection/cap check; true stops before the next retry. */
  exceeds: () => boolean;
  log?: (line: string) => void;
}

/** Re-stages transport-only failures, classifying before every retry. Returns the stop reason, if any. */
export async function restageRun(opts: RestageOptions): Promise<string | null> {
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  for (let round = 1; round <= opts.max; round++) {
    const failed = failedCases(opts.tag);
    if (failed.length === 0) return null;
    for (const staged of failed) {
      const verdict = classifyEvidence(failureEvidence(staged.case_id));
      if (verdict.kind === "stop") return `leakage:${staged.case_id}:not transport-only (round ${round})`;
    }
    if (opts.exceeds()) return `projection exceeds the ${opts.tag} caps before re-stage round ${round}`;
    const items = failed.map((staged) => {
      const schemas = [1, 2].map((turn) => join(staged.dir, `schema${turn}.json`)).filter((path) => existsSync(path))
        .map((path) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
      const { dir: _dir, prompt_sha256: _hash, turn2_sha256: _turn2, staged_at: _at, restaged_as: _as, restage_evidence: _ev, attempt, ...rest } = staged;
      const spec: CaseSpec = { ...rest, case_id: newCaseId(), prompt: readFileSync(join(staged.dir, "PROMPT.md"), "utf8"), ...(schemas.length ? { schemas } : {}), meta: { ...rest.meta, restaged_from: staged.case_id } };
      writeJson(registryPath(staged.case_id), { ...staged, restaged_as: spec.case_id, restage_evidence: classifyEvidence(failureEvidence(staged.case_id)).evidence });
      return { spec, packet: staged.doc_id && staged.form === "N-T" ? loadPacketFile(staged.doc_id).packet : undefined, attempt: (attempt ?? 1) + 1 };
    });
    let stop: string | null = null;
    const outcomes = await runCases(items.map(({ spec, packet }) => ({ spec, packet })), 4, (outcome) => {
      if (!outcome.leakage_pass && classifyFailure(outcome.case_id) === "stop") stop = stop ?? `leakage:${outcome.case_id}:${outcome.failures.join(",")}`;
      if (opts.exceeds()) stop = stop ?? `projection exceeds the ${opts.tag} caps`;
    }, () => stop !== null);
    for (const outcome of outcomes) {
      const index = items.findIndex((item) => item.spec.case_id === outcome.case_id);
      const path = registryPath(outcome.case_id);
      writeJson(path, { ...readJson<Registry>(path), attempt: items[index]!.attempt });
      log(`round ${round}: ${items[index]!.spec.meta?.restaged_from} → ${outcome.case_id} leakage=${outcome.leakage_pass} ${outcome.failures.join(",")}`);
    }
    if (stop) return stop;
  }
  return null;
}

if (process.argv[1]?.endsWith("/restage.ts")) {
  const { parseRunArgs, projection, allPlanned } = await import("./step5.js");
  const argv = process.argv.slice(2);
  const run = parseRunArgs(argv);
  if ("error" in run) {
    process.stderr.write(`${run.error}\nusage: restage.ts --run <tag> --cap-input <n> --cap-output <n> [--max 2]\n`);
    process.exitCode = 1;
  } else {
    const planned = allPlanned(run.tag);
    const stop = await restageRun({ tag: run.tag, max: Number(argValue(argv, "--max") ?? "2"), exceeds: () => projection(planned, run).exceeds });
    if (stop) {
      process.stdout.write(`STOP: ${stop}\n`);
      process.exitCode = 3;
    }
  }
}
