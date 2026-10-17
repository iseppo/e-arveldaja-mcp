// Legacy replication (plan §5.3): the 33 selfcheck/own/ cases inlined in ONE Codex prompt (the documented
// exception to one case per context), own_B.md changed by one sentence plus one added sentence (deviation, see NO_TOOLS), one turn through run-codex.sh with the
// output via -o, scored by a copy of score.py with own_B_codex added. key.json is never staged.
// Usage: npx tsx scripts/reading-p1/legacy.ts [run|score]

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_DIR, dataPath, writePrivate } from "./common.js";
import { newCaseId, runCase } from "./run-cases.js";
import { instructionFingerprints } from "./audit-claude.js";

const SELF = join(LEGACY_DIR, "selfcheck");
const ORIGINAL = "Write a JSON array to ./review_own_B_MODEL.json.";
const REPLACEMENT = "Return the JSON array as your final message.";
/** Deviation from §5.3 (coordinator 2026-10-17, after c-9a2c39e41ba2 ran shell commands to open ./own/): one
 *  added sentence and path-free inline headers, so the inlined cases do not read as files to open. */
const NO_TOOLS = "The case files are inlined below; do not run any commands or read any files.";

export function legacyPrompt(): string {
  const instructions = readFileSync(join(SELF, "own_B.md"), "utf8");
  if (!instructions.includes(ORIGINAL)) throw new Error("own_B.md no longer carries the sentence to replace");
  const changed = instructions.replace(ORIGINAL, `${REPLACEMENT} ${NO_TOOLS}`);
  const files = readdirSync(join(SELF, "own")).filter((name) => /^C\d+\.(json|txt)$/.test(name)).sort();
  const inline = files.map((name) => `===== ${name} (inlined) =====\n${readFileSync(join(SELF, "own", name), "utf8").trimEnd()}\n`);
  return `${changed.trimEnd()}\n\n${inline.join("\n")}`;
}

async function run(): Promise<void> {
  const caseId = newCaseId();
  const outcome = await runCase({ case_id: caseId, reader: "codex", form: "legacy", kind: "legacy", doc_id: null, turns: 1, prompt: legacyPrompt(), meta: { run: "step5-legacy" } }, { fingerprints: instructionFingerprints() });
  process.stdout.write(`${JSON.stringify({ case_id: caseId, leakage_pass: outcome.leakage_pass, failures: outcome.failures, run_errors: outcome.run_errors })}\n`);
  const text = outcome.collected?.turns[0]?.text;
  if (!outcome.leakage_pass || !text) {
    process.exitCode = 3;
    return;
  }
  const stripped = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text)?.[1] ?? text;
  JSON.parse(stripped);
  writePrivate(dataPath("legacy", "review_own_B_codex.json"), stripped);
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
  if (mode === "run") await run();
  else if (mode === "score") score();
  else throw new Error("usage: legacy.ts run|score");
}
