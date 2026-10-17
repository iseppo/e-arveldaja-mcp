// Stages ONE reader case per fresh `mktemp -d` directory outside the repo and ~/Dokumendid (plan §5.3).
// The case is inlined in PROMPT.md (and TURN2.md for a two-turn form); case metadata, truth, snapshots and
// the sentinel never enter the directory. The case registry lives in <data>/staging/<case_id>.json.
//
// Usage (smoke): npx tsx scripts/reading-p1/stage.ts --request <request.json>
//   request.json = {"cases": [CaseSpec]}; a request with more than one case is refused.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT, argValue, dataPath, readJson, sentinel, sha256Hex, writeJson } from "./common.js";
import type { Form } from "./prompts.js";

export type Reader = "opus" | "haiku" | "codex";
export type CaseKind = "natural" | "clean" | "mutated" | "canary" | "planted" | "legacy";

export interface CaseSpec {
  case_id: string;
  reader: Reader;
  form: Form | "canary" | "planted" | "legacy";
  kind: CaseKind;
  doc_id: string | null;
  turns: 1 | 2;
  prompt: string;
  /** Codex structured-output schema per turn. */
  schemas?: Array<Record<string, unknown> | null>;
  /** Free metadata kept in the registry only (mutation family, field, …). */
  meta?: Record<string, unknown>;
}

export interface StagedCase extends Omit<CaseSpec, "prompt" | "schemas"> {
  dir: string;
  prompt_sha256: string;
  turn2_sha256?: string;
  staged_at: string;
}

const FORBIDDEN_ROOTS = [resolve(REPO_ROOT), resolve(homedir(), "Dokumendid")];

export function registryPath(caseId: string): string {
  if (!/^[a-z0-9-]{4,64}$/.test(caseId)) throw new Error(`bad case id ${caseId}`);
  return dataPath("staging", `${caseId}.json`);
}

export function loadStaged(caseId: string): StagedCase {
  return readJson<StagedCase>(registryPath(caseId));
}

function assertOutside(dir: string): void {
  const absolute = resolve(dir);
  if (!absolute.startsWith("/tmp/reading-p1.")) throw new Error(`staging dir not under /tmp/reading-p1.*: ${absolute}`);
  for (const root of FORBIDDEN_ROOTS) {
    if (absolute === root || absolute.startsWith(`${root}/`)) throw new Error(`staging dir inside ${root}`);
  }
}

/** Stages exactly one case into its own fresh directory. */
export function stageCase(spec: CaseSpec): StagedCase {
  if (existsSync(registryPath(spec.case_id))) throw new Error(`case ${spec.case_id} already staged`);
  if (spec.prompt.includes(sentinel())) throw new Error(`case ${spec.case_id}: prompt contains the sentinel`);
  if (spec.turns === 2 && spec.form !== "N-T" && spec.form !== "canary" && spec.form !== "planted") {
    throw new Error(`case ${spec.case_id}: only N-T (and smoke cases) have a second turn`);
  }
  const dir = execFileSync("mktemp", ["-d", "/tmp/reading-p1.XXXXXXXX"], { encoding: "utf8" }).trim();
  assertOutside(dir);
  if (readdirSync(dir).length !== 0) throw new Error(`staging dir ${dir} is not empty`);
  writeFileSync(join(dir, "PROMPT.md"), spec.prompt, { mode: 0o600 });
  (spec.schemas ?? []).forEach((schema, index) => {
    if (schema) writeFileSync(join(dir, `schema${index + 1}.json`), JSON.stringify(schema), { mode: 0o600 });
  });
  const { prompt: _prompt, schemas: _schemas, ...rest } = spec;
  const staged: StagedCase = { ...rest, dir, prompt_sha256: sha256Hex(spec.prompt), staged_at: new Date().toISOString() };
  writeJson(registryPath(spec.case_id), staged);
  return staged;
}

/** Stages turn 2 into the case's own directory (once). */
export function stageTurn2(caseId: string, text: string): StagedCase {
  const staged = loadStaged(caseId);
  if (staged.turns !== 2) throw new Error(`case ${caseId} has one turn`);
  const path = join(staged.dir, "TURN2.md");
  if (existsSync(path)) throw new Error(`case ${caseId}: TURN2.md already staged`);
  if (text.includes(sentinel())) throw new Error(`case ${caseId}: turn 2 contains the sentinel`);
  writeFileSync(path, text, { mode: 0o600 });
  const updated = { ...staged, turn2_sha256: sha256Hex(text) };
  writeJson(registryPath(caseId), updated);
  return updated;
}

/** A staging request must carry exactly one case: one case per reader context (critic r2 N4). */
export function stageRequest(request: { cases?: unknown }): StagedCase {
  if (!Array.isArray(request.cases) || request.cases.length !== 1) {
    throw new Error(`refused: a staging request must hold exactly one case (got ${Array.isArray(request.cases) ? request.cases.length : "none"})`);
  }
  return stageCase(request.cases[0] as CaseSpec);
}

if (process.argv[1]?.endsWith("/stage.ts")) {
  try {
    const requestPath = argValue(process.argv.slice(2), "--request");
    if (!requestPath) throw new Error("--request <file> required");
    const staged = stageRequest(JSON.parse(readFileSync(requestPath, "utf8")) as { cases?: unknown });
    process.stdout.write(`${JSON.stringify({ case_id: staged.case_id, dir: staged.dir })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
