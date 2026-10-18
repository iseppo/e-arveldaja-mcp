// Reader outputs → schema-validated readings (plan §5.1). The reader text is read ONLY from the runner
// outputs (Claude: out<n>.json `.result`; Codex: the -o file). Schema failures are kept and counted.
// Mechanical normalisation only: one surrounding code fence is stripped, and the evidence entries that the
// Codex strict schema forces to `null` are dropped (both recorded).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocumentReading, parseProof } from "../../src/document-reading-schemas.js";
import { dataPath, readJson, writeJson } from "./common.js";
import { turnOutputs, type Form } from "./prompts.js";
import { loadStaged, type StagedCase } from "./stage.js";

export interface TurnUsage { input: number; cached_input: number; output: number; reasoning_output: number }

export interface CollectedTurn {
  turn: number;
  expects: "both" | "reading" | "proof" | "text";
  session_id: string | null;
  text: string | null;
  fenced: boolean;
  nulls_dropped: number;
  json_ok: boolean;
  usage: TurnUsage | null;
  model: string | null;
}

export interface CollectedCase {
  case_id: string;
  reader: StagedCase["reader"];
  form: StagedCase["form"];
  kind: StagedCase["kind"];
  doc_id: string | null;
  meta?: Record<string, unknown>;
  turns: CollectedTurn[];
  reading: unknown;
  proof: unknown;
  reading_schema: "ok" | string | null;
  proof_schema: "ok" | string | null;
  leakage_pass: boolean;
  /** P2 C4: the packet holds packet_oversize, so no reader ran (no staging dir, usage 0). */
  reader_skipped?: true;
}

function stripFence(text: string): { text: string; fenced: boolean } {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return match ? { text: match[1]!, fenced: true } : { text, fenced: false };
}

function dropNullEvidence(value: unknown): number {
  let dropped = 0;
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.evidence && typeof record.evidence === "object") {
      for (const [key, entry] of Object.entries(record.evidence as Record<string, unknown>)) {
        if (entry === null) {
          delete (record.evidence as Record<string, unknown>)[key];
          dropped += 1;
        }
      }
    }
    if (record.document_reading) visit(record.document_reading);
  };
  visit(value);
  return dropped;
}

function readTurn(staged: StagedCase, turn: number, expects: CollectedTurn["expects"]): CollectedTurn {
  const path = join(staged.dir, `out${turn}.json`);
  const raw = existsSync(path) ? readFileSync(path, "utf8") : null;
  let text: string | null = null;
  let sessionId: string | null = null;
  let usage: TurnUsage | null = null;
  let model: string | null = null;
  if (raw !== null && staged.reader !== "codex") {
    try {
      const out = JSON.parse(raw) as {
        result?: string;
        session_id?: string;
        usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
        modelUsage?: Record<string, unknown>;
      };
      text = typeof out.result === "string" ? out.result : null;
      sessionId = out.session_id ?? null;
      const u = out.usage ?? {};
      usage = {
        input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        cached_input: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        reasoning_output: 0,
      };
      model = Object.keys(out.modelUsage ?? {})[0] ?? null;
    } catch {
      text = null;
    }
  } else if (staged.reader === "codex") {
    // Usage comes from the events even when the -o output is missing (an interrupted or failed turn).
    text = raw;
    const eventsPath = join(staged.dir, `events${turn}.jsonl`);
    if (existsSync(eventsPath)) {
      const events = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string; thread_id?: string; usage?: Record<string, number> });
      sessionId = events.find((event) => event.type === "thread.started")?.thread_id ?? null;
      const completed = events.find((event) => event.type === "turn.completed");
      if (completed?.usage) {
        usage = {
          input: completed.usage.input_tokens ?? 0,
          cached_input: completed.usage.cached_input_tokens ?? 0,
          output: completed.usage.output_tokens ?? 0,
          reasoning_output: completed.usage.reasoning_output_tokens ?? 0,
        };
      }
      model = "gpt-6.1-sol";
    }
  }
  let fenced = false;
  let jsonOk = false;
  let nullsDropped = 0;
  if (text !== null && expects !== "text") {
    const stripped = stripFence(text);
    fenced = stripped.fenced;
    try {
      JSON.parse(stripped.text);
      jsonOk = true;
      text = stripped.text;
    } catch {
      jsonOk = false;
    }
  }
  return { turn, expects, session_id: sessionId, text, fenced, nulls_dropped: nullsDropped, json_ok: jsonOk, usage, model };
}

const SESSIONS = () => dataPath("staging", "sessions.json");

/** Refuses an output whose session id another case already used (one case per reader context). */
function claimSessions(caseId: string, ids: Array<string | null>): void {
  const path = SESSIONS();
  const used: Record<string, string> = existsSync(path) ? readJson<Record<string, string>>(path) : {};
  for (const id of ids) {
    if (id === null) continue;
    if (used[id] !== undefined && used[id] !== caseId) throw new Error(`session ${id} of case ${caseId} was already used by case ${used[id]}`);
    used[id] = caseId;
  }
  writeJson(path, used);
}

export function collectCase(caseId: string): CollectedCase {
  const staged = loadStaged(caseId);
  const leakage = readJson<{ pass: boolean }>(dataPath("leakage", `${caseId}.json`));
  const expects: Array<CollectedTurn["expects"]> = staged.form === "canary" || staged.form === "planted" || staged.form === "legacy"
    ? Array.from({ length: staged.turns }, () => "text" as const)
    : turnOutputs(staged.form as Form);
  const turns = expects.map((kind, index) => readTurn(staged, index + 1, kind));
  // Turn 2 of a Claude/Codex resume keeps the session; claim the distinct ids only.
  claimSessions(caseId, [...new Set(turns.map((turn) => turn.session_id))]);

  let reading: unknown = null;
  let proof: unknown = null;
  for (const turn of turns) {
    if (!turn.json_ok || turn.text === null) continue;
    const value = JSON.parse(turn.text) as Record<string, unknown>;
    turn.nulls_dropped = staged.reader === "codex" ? dropNullEvidence(value) : 0;
    if (turn.expects === "both") {
      reading = value.document_reading ?? null;
      proof = value.proof ?? null;
    } else if (turn.expects === "reading") {
      reading = value;
    } else if (turn.expects === "proof") {
      proof = value;
    }
  }
  const readingInput = staged.meta?.reading_input;
  if (reading === null && readingInput !== undefined) reading = readingInput;
  const readingOutcome = reading === null ? null : parseDocumentReading(reading);
  const proofOutcome = proof === null ? null : parseProof(proof);
  const collected: CollectedCase = {
    case_id: caseId,
    reader: staged.reader,
    form: staged.form,
    kind: staged.kind,
    doc_id: staged.doc_id,
    ...(staged.meta ? { meta: staged.meta } : {}),
    turns,
    reading,
    proof,
    reading_schema: readingOutcome === null ? null : readingOutcome.ok ? "ok" : readingOutcome.code,
    proof_schema: proofOutcome === null ? null : proofOutcome.ok ? "ok" : proofOutcome.code,
    leakage_pass: leakage.pass,
  };
  writeJson(dataPath("readings", `${caseId}.json`), collected);
  return collected;
}
