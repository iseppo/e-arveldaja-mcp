// Leakage audit of one Claude reader case (plan §5.3): reads the session transcript
// ~/.claude/projects/<slug of $B>/<session_id>.jsonl and asserts, per turn:
//   - the user message's sha256 equals PROMPT.md's (TURN2.md's);
//   - no tool_use block;
//   - no instructions / CLAUDE.md / memory attachment (attachment types outside a fixed allowlist fail);
//   - no fragment of ~/.claude/CLAUDE.md, the project CLAUDE.md or an auto-memory MEMORY.md in any request blob;
//   - the sentinel is absent from the transcript and the outputs;
//   - the model id is the expected one; turn 2 keeps the turn-1 session.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, sha256Hex } from "./common.js";

/** Attachment types a tool-less --safe-mode session carries (observed 2026-10-17, claude-code 2.1.302). */
export const ALLOWED_ATTACHMENTS = new Set([
  "environment",
  "model",
  "total_tokens_reminder",
  "session_context",
  "date",
  "credential_org",
  "prompt_snapshot",
]);

const CHUNK = 40;
const STEP = 20;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Every auto-memory MEMORY.md plus both CLAUDE.md files that a non-safe session would load. */
export function instructionSources(): string[] {
  const sources = [join(homedir(), ".claude", "CLAUDE.md"), join(REPO_ROOT, "CLAUDE.md")];
  const projects = join(homedir(), ".claude", "projects");
  if (existsSync(projects)) {
    for (const slug of readdirSync(projects)) {
      const memory = join(projects, slug, "memory", "MEMORY.md");
      if (existsSync(memory)) sources.push(memory);
    }
  }
  return sources.filter((path) => existsSync(path));
}

/** 40-character shingles (step 20) of every line of 40+ characters of the instruction sources. */
export function instructionFingerprints(sources = instructionSources()): string[] {
  const chunks = new Set<string>();
  for (const path of sources) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const text = normalize(line);
      if (text.length < CHUNK) continue;
      for (let at = 0; at + CHUNK <= text.length; at += STEP) chunks.add(text.slice(at, at + CHUNK));
    }
  }
  return [...chunks];
}

export function fingerprintHits(text: string, fingerprints: readonly string[]): string[] {
  const haystack = normalize(text);
  return fingerprints.filter((chunk) => haystack.includes(chunk));
}

export function transcriptPath(caseDir: string, sessionId: string): string {
  const slug = caseDir.replace(/[^A-Za-z0-9]/g, "-");
  return join(homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
}

interface TranscriptEntry {
  type?: string;
  isMeta?: boolean;
  message?: { role?: string; model?: string; content?: unknown };
  attachment?: { type?: string };
  isSidechain?: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : "")).join("");
  }
  return "";
}

export interface ClaudeTurnAudit {
  turn: number;
  session_id: string | null;
  is_error: boolean | null;
  prompt_hash_ok: boolean;
  tool_use_blocks: number;
  attachment_types: string[];
  disallowed_attachments: string[];
  fingerprint_hits: number;
  sentinel_hit: boolean;
  models: string[];
  model_ok: boolean;
}

export interface ClaudeAudit {
  reader: "claude";
  transcript: string | null;
  turns: ClaudeTurnAudit[];
  same_session: boolean;
  failures: string[];
  pass: boolean;
}

/** The fixed opening of the Claude CLI's meta message after a safety-classifier stop. */
export const CLASSIFIER_META_PREFIX = "Your response above was stopped by a safety classifier \u2014 this is not a tool or API error.";
const isClassifierMeta = (entry: TranscriptEntry) => entry.type === "user" && entry.isMeta === true && entry.message?.role === "user" &&
  textOf(entry.message.content).startsWith(CLASSIFIER_META_PREFIX);

/** Audits a finished Claude case. `expectedModel` is a prefix such as `claude-opus-` or `claude-haiku-`. */
export function auditClaudeCase(input: {
  caseDir: string;
  turns: number;
  sentinel: string;
  expectedModel: string;
  fingerprints?: readonly string[];
  transcriptOverride?: string;
}): ClaudeAudit {
  const fingerprints = input.fingerprints ?? instructionFingerprints();
  const failures: string[] = [];
  const outs = Array.from({ length: input.turns }, (_, index) => {
    const path = join(input.caseDir, `out${index + 1}.json`);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  });
  const parsedOuts = outs.map((text) => {
    try {
      return text ? JSON.parse(text) as { session_id?: string; is_error?: boolean } : undefined;
    } catch {
      return undefined;
    }
  });
  const sessionId = parsedOuts[0]?.session_id ?? null;
  const transcript = input.transcriptOverride ?? (sessionId ? transcriptPath(input.caseDir, sessionId) : null);
  const entries: TranscriptEntry[] = transcript && existsSync(transcript)
    ? readFileSync(transcript, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as TranscriptEntry)
    : [];
  if (!transcript || entries.length === 0) failures.push("transcript_missing");
  const transcriptText = transcript && existsSync(transcript) ? readFileSync(transcript, "utf8") : "";

  // The CLI's own meta message after a safety-classifier stop is not a turn: it is flagged `classifier_interrupt`
  // (a discarded attempt, restage.ts). Any other extra user message still fails the turn count.
  const classifierMeta = entries.filter(isClassifierMeta).length;
  if (classifierMeta > 0) failures.push("classifier_interrupt");
  // Split the transcript into turns at each real user message (string or text-block content, not a tool result).
  const userIndices = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !isClassifierMeta(entry) && entry.type === "user" && entry.message?.role === "user" && textOf(entry.message.content) !== "" &&
      !(Array.isArray(entry.message.content) && (entry.message.content as Array<{ type?: string }>).some((block) => block.type === "tool_result")))
    .map(({ index }) => index);
  if (userIndices.length !== input.turns) failures.push(`user_messages_${userIndices.length}_expected_${input.turns}`);

  const turns: ClaudeTurnAudit[] = [];
  for (let turn = 1; turn <= input.turns; turn++) {
    const promptFile = join(input.caseDir, turn === 1 ? "PROMPT.md" : "TURN2.md");
    const expectedHash = existsSync(promptFile) ? sha256Hex(readFileSync(promptFile, "utf8")) : "";
    const from = userIndices[turn - 1] ?? entries.length;
    const to = userIndices[turn] ?? entries.length;
    const slice = entries.slice(from, to);
    const user = entries[from];
    const promptHashOk = user !== undefined && sha256Hex(textOf(user.message?.content)) === expectedHash;
    // Attachments recorded just before the user entry belong to that turn too.
    const before = entries.slice(turn === 1 ? 0 : (userIndices[turn - 2] ?? 0) + 1, from).filter((entry) => entry.type === "attachment");
    const scope = [...before, ...slice];
    const toolUse = scope.filter((entry) => entry.type === "assistant").flatMap((entry) => Array.isArray(entry.message?.content) ? entry.message!.content as Array<{ type?: string }> : [])
      .filter((block) => block.type === "tool_use").length;
    const attachmentTypes = [...new Set(scope.filter((entry) => entry.type === "attachment").map((entry) => entry.attachment?.type ?? "?"))];
    const disallowed = attachmentTypes.filter((type) => !ALLOWED_ATTACHMENTS.has(type));
    const blobs = scope.filter((entry) => entry.type === "api-request-blob" || entry.type === "user" || entry.type === "attachment").map((entry) => JSON.stringify(entry)).join("\n");
    const hits = fingerprintHits(blobs, fingerprints).length;
    const models = [...new Set(scope.filter((entry) => entry.type === "assistant").map((entry) => entry.message?.model ?? "?"))];
    const out = outs[turn - 1] ?? "";
    const sentinelHit = out.includes(input.sentinel) || scope.some((entry) => JSON.stringify(entry).includes(input.sentinel));
    const audit: ClaudeTurnAudit = {
      turn,
      session_id: parsedOuts[turn - 1]?.session_id ?? null,
      is_error: parsedOuts[turn - 1]?.is_error ?? null,
      prompt_hash_ok: promptHashOk,
      tool_use_blocks: toolUse,
      attachment_types: attachmentTypes,
      disallowed_attachments: disallowed,
      fingerprint_hits: hits,
      sentinel_hit: sentinelHit,
      models,
      model_ok: models.length > 0 && models.every((model) => model.startsWith(input.expectedModel)),
    };
    if (!out) failures.push(`turn${turn}_output_missing`);
    if (audit.is_error !== false) failures.push(`turn${turn}_is_error`);
    if (!promptHashOk) failures.push(`turn${turn}_prompt_hash`);
    if (toolUse > 0) failures.push(`turn${turn}_tool_use`);
    if (disallowed.length > 0) failures.push(`turn${turn}_attachment:${disallowed.join(",")}`);
    if (hits > 0) failures.push(`turn${turn}_instruction_fragment`);
    if (sentinelHit) failures.push(`turn${turn}_sentinel`);
    if (!audit.model_ok) failures.push(`turn${turn}_model`);
    turns.push(audit);
  }
  if (transcriptText.includes(input.sentinel)) failures.push("transcript_sentinel");
  const sameSession = parsedOuts.every((out) => out?.session_id === sessionId);
  if (!sameSession) failures.push("session_changed");
  return { reader: "claude", transcript, turns, same_session: sameSession, failures: [...new Set(failures)], pass: failures.length === 0 };
}
