// Legacy replication (plan §5.3): the 33 selfcheck/own/ cases inlined in ONE Codex prompt (the documented
// exception to one case per context), own_B.md changed by one sentence plus one added sentence (deviation, see NO_TOOLS), one turn through run-codex.sh with the
// output via -o, scored by a copy of score.py with own_B_codex added. key.json is never staged.
// Usage: npx tsx scripts/reading-p1/legacy.ts run --run <tag> --cap-input <n> --cap-output <n> | score
// T4 (throughput round): each re-run has its own tag (a tag that already holds a reading is refused, so old
// results are never reused), the shared pre-launch preflight, and caps checked against the legacy estimate
// before the launch and against the measured usage after it. The step-5 output is kept as
// review_own_B_codex.step5-legacy.json.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_DIR, dataPath, writePrivate } from "./common.js";
import { newCaseId, runCase } from "./run-cases.js";
import { instructionFingerprints } from "./audit-claude.js";
import { preflightRun } from "./restage.js";
import { corpusRunIndex } from "./stage.js";
import { LEGACY, parseRunArgs, type RunArgs } from "./step5.js";

const SELF = join(LEGACY_DIR, "selfcheck");
const ORIGINAL = "Write a JSON array to ./review_own_B_MODEL.json.";
const REPLACEMENT = "Return the JSON array as your final message.";
/** Deviation from §5.3 (coordinator 2026-10-17, after c-9a2c39e41ba2 ran shell commands to open ./own/): one
 *  added sentence and path-free inline headers, so the inlined cases do not read as files to open. */
const NO_TOOLS = "The case files are inlined below; do not run any commands or read any files.";
/** B6 (throughput round): the step-5 copy obeyed this line and returned only the counts; it is removed. */
const FINAL_REPLY = "Final reply: one line with the counts.";
const LEGACY_CASES = 33;

/** B6: the output must be the 33-entry array of `{case, …}` objects, nothing else. */
export function legacyShapeOk(value: unknown): boolean {
  return Array.isArray(value) && value.length === LEGACY_CASES &&
    value.every((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry) && "case" in entry);
}

export function legacyPrompt(): string {
  const instructions = readFileSync(join(SELF, "own_B.md"), "utf8");
  if (!instructions.includes(ORIGINAL)) throw new Error("own_B.md no longer carries the sentence to replace");
  if (!instructions.includes(FINAL_REPLY)) throw new Error("own_B.md no longer carries the final-reply line to remove");
  const changed = instructions.replace(ORIGINAL, `${REPLACEMENT} ${NO_TOOLS}`).replace(FINAL_REPLY, "");
  const files = readdirSync(join(SELF, "own")).filter((name) => /^C\d+\.(json|txt)$/.test(name)).sort();
  const inline = files.map((name) => `===== ${name} (inlined) =====\n${readFileSync(join(SELF, "own", name), "utf8").trimEnd()}\n`);
  return `${changed.trimEnd()}\n\n${inline.join("\n")}`;
}

async function run(args: RunArgs): Promise<void> {
  const refuse = (reason: string) => {
    process.stdout.write(`STOP: ${reason}\n`);
    process.exitCode = 3;
  };
  if (corpusRunIndex(args.tag).some((entry) => existsSync(dataPath("readings", `${entry.case_id}.json`)))) return refuse(`${args.tag} already holds a legacy reading; use a new tag`);
  const preflight = preflightRun(args.tag);
  if (preflight) return refuse(preflight);
  if (LEGACY.input > args.caps.input || LEGACY.output > args.caps.output) return refuse(`the legacy estimate ${LEGACY.input}/${LEGACY.output} exceeds the ${args.tag} caps`);
  const caseId = newCaseId();
  const outcome = await runCase({ case_id: caseId, reader: "codex", form: "legacy", kind: "legacy", doc_id: null, turns: 1, prompt: legacyPrompt(), meta: { run: args.tag } }, { fingerprints: instructionFingerprints() });
  const usage = (outcome.collected?.turns ?? []).reduce((acc, turn) => ({ input: acc.input + (turn.usage?.input ?? 0), output: acc.output + (turn.usage?.output ?? 0) }), { input: 0, output: 0 });
  process.stdout.write(`${JSON.stringify({ case_id: caseId, leakage_pass: outcome.leakage_pass, failures: outcome.failures, run_errors: outcome.run_errors, usage })}\n`);
  if (usage.input > args.caps.input || usage.output > args.caps.output) process.stdout.write(`WARNING: the legacy case used ${usage.input}/${usage.output}, above the ${args.tag} caps\n`);
  const text = outcome.collected?.turns[0]?.text;
  if (!outcome.leakage_pass || !text) {
    process.exitCode = 3;
    return;
  }
  const stripped = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text)?.[1] ?? text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    parsed = undefined;
  }
  if (!legacyShapeOk(parsed)) {
    process.stdout.write(`refused: the output is not a ${LEGACY_CASES}-entry array of {case, …}; nothing written\n`);
    process.exitCode = 3;
    return;
  }
  const current = dataPath("legacy", "review_own_B_codex.json");
  const kept = dataPath("legacy", "review_own_B_codex.step5-legacy.json");
  if (existsSync(current) && !existsSync(kept)) renameSync(current, kept);
  writePrivate(current, stripped);
}

function score(): void {
  const dir = dataPath("legacy");
  copyFileSync(join(SELF, "key.json"), join(dir, "key.json"));
  const original = readFileSync(join(SELF, "score.py"), "utf8");
  const patched = original.replace("'own_B_opus','own_B_haiku']", "'own_B_opus','own_B_haiku','own_B_codex']");
  if (patched === original) throw new Error("score.py list not found");
  writeFileSync(join(dir, "score.py"), patched, { mode: 0o600 });
  for (const name of readdirSync(SELF).filter((file) => /^review_.*\.json$/.test(file))) {
    if (!existsSync(join(dir, name))) copyFileSync(join(SELF, name), join(dir, name));
  }
  const output = execFileSync("python3", ["-I", join(dir, "score.py")], { encoding: "utf8" });
  writePrivate(join(dir, "score.txt"), output);
  process.stdout.write(output);
}

if (process.argv[1]?.endsWith("/legacy.ts")) {
  const mode = process.argv[2] ?? "run";
  if (mode === "run") {
    const args = parseRunArgs(process.argv.slice(3));
    if ("error" in args) {
      process.stderr.write(`${args.error}\nusage: legacy.ts run --run <tag> --cap-input <n> --cap-output <n> | score\n`);
      process.exitCode = 1;
    } else await run(args);
  }
  else if (mode === "score") score();
  else throw new Error("usage: legacy.ts run|score");
}
