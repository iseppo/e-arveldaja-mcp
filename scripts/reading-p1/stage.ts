// Stages ONE reader case per fresh `mktemp -d` directory outside the repo and ~/Dokumendid (plan §5.3).
// The case is inlined in PROMPT.md (and TURN2.md for a two-turn form); case metadata, truth, snapshots and
// the sentinel never enter the directory. The case registry lives in <data>/staging/<case_id>.json.
//
// Every case staged with a run tag is also appended to the run index <data>/runs/<tag>.tsv (case id, document
// id), so readers of a run open only its own case records, filtered by document before any record is read
// (throughput round B8).
//
// Usage (smoke): npx tsx scripts/reading-p1/stage.ts --request <request.json>
//   request.json = {"cases": [CaseSpec]}; a request with more than one case is refused.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT, SCOPES, SCOPE_ID_SHAPE, argValue, dataPath, readJson, scopeIds, sentinel, sha256Hex, writeJson, writePrivate, type Scope } from "./common.js";
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
  /** Re-stage attempt (a replacement's, written at staging so a crash cannot lose it); absent on an original. */
  attempt?: number;
}

export interface StagedCase extends Omit<CaseSpec, "prompt" | "schemas"> {
  dir: string;
  prompt_sha256: string;
  turn2_sha256?: string;
  staged_at: string;
}

export interface RunIndexEntry { case_id: string; doc_id: string | null }

export function runIndexPath(tag: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tag)) throw new Error(`bad run tag ${tag}`);
  return dataPath("runs", `${tag}.tsv`);
}

export function appendRunIndex(tag: string, entry: RunIndexEntry): void {
  mkdirSync(dataPath("runs"), { recursive: true, mode: 0o700 });
  appendFileSync(runIndexPath(tag), `${entry.case_id}\t${entry.doc_id ?? ""}\n`, { mode: 0o600 });
}

/** The cases staged under a run tag, in staging order; `optional` returns [] for a tag with no index. */
export function runIndex(tag: string, opts: { optional?: boolean } = {}): RunIndexEntry[] {
  const path = runIndexPath(tag);
  if (!existsSync(path)) {
    if (opts.optional) return [];
    throw new Error(`no run index ${tag}: stage the run first`);
  }
  const seen = new Set<string>();
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => {
    const [caseId, docId] = line.split("\t");
    return { case_id: caseId!, doc_id: docId ? docId : null };
  }).filter((entry) => !seen.has(entry.case_id) && seen.add(entry.case_id));
}

/**
 * B8: the run's index rows of corpus documents (and document-less smoke cases), filtered by document id before
 * any case record is opened. Every script that opens a run's registries or readings goes through this.
 */
export function corpusRunIndex(tag: string): RunIndexEntry[] {
  const ids = scopeIds("corpus");
  return runIndex(tag, { optional: true }).filter((entry) => entry.doc_id === null || ids.has(entry.doc_id));
}

const runScopePath = (tag: string) => dataPath("runs", `${tag}.scope`);

/** A run tag's scope: runs/<tag>.scope when bound, corpus otherwise (every tag before step 6). */
export function runScope(tag: string): Scope {
  if (!existsSync(runScopePath(tag))) return "corpus";
  const scope = readFileSync(runScopePath(tag), "utf8").trim() as Scope;
  if (!SCOPES.includes(scope)) throw new Error(`run ${tag}: unknown scope ${scope}`);
  return scope;
}

/** Binds a tag to a scope before its first case: a bound tag never changes scope, and a tag with rows stays corpus. */
export function bindRunScope(tag: string, scope: Scope): string | null {
  if (existsSync(runScopePath(tag))) return runScope(tag) === scope ? null : `run ${tag} is bound to scope ${runScope(tag)}, not ${scope}`;
  if (scope === "corpus") return null;
  if (runIndex(tag, { optional: true }).length > 0) return `run ${tag} already holds corpus cases; use a new tag for scope ${scope}`;
  writePrivate(runScopePath(tag), `${scope}\n`);
  return null;
}

/**
 * A tag usable in `scope`: bound to it (corpus when unbound), and every index row of that scope's id shape
 * (a document-less row only in the corpus scope). Checked by shape, so no manifest is read.
 */
export function tagScopeError(tag: string, scope: Scope): string | null {
  if (runScope(tag) !== scope) return `run ${tag} is bound to scope ${runScope(tag)}, not ${scope}`;
  const foreign = runIndex(tag, { optional: true }).find((entry) => (entry.doc_id === null ? scope !== "corpus" : !SCOPE_ID_SHAPE[scope].test(entry.doc_id)));
  return foreign ? `run ${tag} holds a case of another scope (${foreign.case_id}, document ${foreign.doc_id ?? "none"})` : null;
}

/**
 * The run's index rows of its own scope's documents (corpus rows for a corpus tag, held-out rows for a held-out
 * tag; document-less rows only in the corpus scope), filtered before any case record is opened.
 */
export function scopedRunIndex(tag: string): RunIndexEntry[] {
  const scope = runScope(tag);
  if (scope === "corpus") return corpusRunIndex(tag);
  const ids = scopeIds(scope);
  return runIndex(tag, { optional: true }).filter((entry) => entry.doc_id !== null && ids.has(entry.doc_id));
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
  if (typeof spec.meta?.run === "string") appendRunIndex(spec.meta.run, { case_id: spec.case_id, doc_id: spec.doc_id });
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
