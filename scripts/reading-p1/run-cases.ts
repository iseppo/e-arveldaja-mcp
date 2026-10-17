// Runs staged reader cases end to end: stage → turn 1 → (turn 2) → leakage audit → collect (plan §5.3).
// One case per reader context; a case that fails its audit is recorded and never scored.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ReadingPacket } from "../../src/document-reading-packet.js";
import { auditClaudeCase, instructionFingerprints } from "./audit-claude.js";
import { auditCodexEvents } from "./audit-codex.js";
import { collectCase, type CollectedCase } from "./collect.js";
import { SCRIPTS_DIR, dataPath, sentinel, writeJson } from "./common.js";
import { promptNT2, schemaFor, turnOutputs, type Form } from "./prompts.js";
import { stageCase, stageTurn2, type CaseSpec, type Reader } from "./stage.js";

const run = promisify(execFile);
const TURN_TIMEOUT_MS = 15 * 60_000;

export function newCaseId(): string {
  return `c-${randomBytes(6).toString("hex")}`;
}

export const EXPECTED_MODEL_PREFIX: Record<Reader, string> = {
  opus: "claude-opus-",
  haiku: "claude-haiku-",
  codex: "gpt-6.1-sol",
};

/** Codex schemas for a form's turns (Claude cases carry none). */
export function schemasFor(reader: Reader, form: Form): CaseSpec["schemas"] {
  return reader === "codex" ? turnOutputs(form).map((kind) => schemaFor(kind)) : undefined;
}

async function runTurn(reader: Reader, dir: string, meta: string, turn: 1 | 2 | "cleanup"): Promise<{ ok: boolean; error?: string }> {
  // Test mode (selftest): READING_P1_READER_STUB names a log file; each launch is logged there and fails as a
  // non-transport error, and no reader process is started.
  const stub = process.env.READING_P1_READER_STUB;
  if (stub) {
    appendFileSync(stub, `${reader}\t${turn}\t${dir}\n`);
    return { ok: false, error: "reader stub (test mode)" };
  }
  try {
    if (reader === "codex") await run(join(SCRIPTS_DIR, "run-codex.sh"), [dir, meta, String(turn)], { timeout: TURN_TIMEOUT_MS });
    else await run(join(SCRIPTS_DIR, "run-claude.sh"), [dir, reader, String(turn)], { timeout: TURN_TIMEOUT_MS });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}

function turnOneText(reader: Reader, dir: string): string | null {
  const path = join(dir, "out1.json");
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  if (reader === "codex") return raw;
  try {
    const value = JSON.parse(raw) as { result?: unknown };
    return typeof value.result === "string" ? value.result : null;
  } catch {
    return null;
  }
}

export interface CaseOutcome {
  case_id: string;
  leakage_pass: boolean;
  failures: string[];
  run_errors: string[];
  collected?: CollectedCase;
}

/**
 * Runs one case. `turn2` builds the second prompt from the turn-1 text (N-T), or is a fixed text (smoke cases).
 */
export async function runCase(spec: CaseSpec, opts: { packet?: ReadingPacket; turn2Text?: string; fingerprints?: string[] } = {}): Promise<CaseOutcome> {
  const staged = stageCase(spec);
  const meta = dataPath("staging", `${spec.case_id}.codex`);
  const errors: string[] = [];
  const first = await runTurn(spec.reader, staged.dir, meta, 1);
  if (!first.ok) errors.push(`turn1:${first.error}`);
  if (spec.turns === 2 && first.ok) {
    let text = opts.turn2Text;
    if (text === undefined && spec.form === "N-T" && opts.packet) {
      const readingText = turnOneText(spec.reader, staged.dir);
      if (readingText !== null) text = promptNT2(opts.packet, readingText);
    }
    if (text === undefined) errors.push("turn2:no_turn1_text");
    else {
      stageTurn2(spec.case_id, text);
      const second = await runTurn(spec.reader, staged.dir, meta, 2);
      if (!second.ok) errors.push(`turn2:${second.error}`);
    }
  }
  const turnsRun = spec.turns === 2 && existsSync(join(staged.dir, "TURN2.md")) ? 2 : 1;
  const audit = spec.reader === "codex"
    ? auditCodexEvents({ caseDir: staged.dir, metaDir: meta, turns: turnsRun, sentinel: sentinel() })
    : auditClaudeCase({ caseDir: staged.dir, turns: turnsRun, sentinel: sentinel(), expectedModel: EXPECTED_MODEL_PREFIX[spec.reader], fingerprints: opts.fingerprints });
  if (spec.reader === "codex") await runTurn("codex", staged.dir, meta, "cleanup");
  const failures = [...audit.failures, ...errors.map((error) => `run:${error.split(":")[0]}`)];
  const leakage = { case_id: spec.case_id, case_reader: spec.reader, form: spec.form, kind: spec.kind, turns_run: turnsRun, run_errors: errors, ...audit, failures, pass: failures.length === 0 };
  writeJson(dataPath("leakage", `${spec.case_id}.json`), leakage);
  let collected: CollectedCase | undefined;
  try {
    collected = collectCase(spec.case_id);
  } catch (error) {
    errors.push(`collect:${error instanceof Error ? error.message : String(error)}`);
  }
  return { case_id: spec.case_id, leakage_pass: leakage.pass, failures, run_errors: errors, ...(collected ? { collected } : {}) };
}

/** Runs cases with bounded concurrency, in the given (already shuffled) order. */
export async function runCases(
  items: Array<{ spec: CaseSpec; packet?: ReadingPacket; turn2Text?: string }>,
  concurrency = 4,
  onDone?: (outcome: CaseOutcome) => void,
  shouldStop?: () => boolean,
): Promise<CaseOutcome[]> {
  const fingerprints = instructionFingerprints();
  const outcomes: CaseOutcome[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (shouldStop?.()) return;
      const index = next++;
      if (index >= items.length) return;
      const item = items[index]!;
      const outcome = await runCase(item.spec, { packet: item.packet, turn2Text: item.turn2Text, fingerprints });
      outcomes[index] = outcome;
      onDone?.(outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return outcomes.filter((outcome) => outcome !== undefined);
}
