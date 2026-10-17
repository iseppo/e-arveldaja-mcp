// Re-stages the leakage-failed cases of a run (plan §5.3: a failed case is discarded and re-staged, never
// scored). Each failed case is rebuilt from its staged PROMPT.md and schemas under a fresh case id and its own
// fresh directory; the old registry entry records `restaged_as`. Planted and canary cases are never re-staged.
// Usage: npx tsx scripts/reading-p1/restage.ts --run <tag> [--max 2]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacketFile } from "./cases.js";
import { argValue, dataPath, readJson, writeJson } from "./common.js";
import { newCaseId, runCases } from "./run-cases.js";
import { loadStaged, registryPath, type CaseSpec, type StagedCase } from "./stage.js";

type Registry = StagedCase & { restaged_as?: string; attempt?: number };

const argv = process.argv.slice(2);
const tag = argValue(argv, "--run");
const max = Number(argValue(argv, "--max") ?? "2");
if (!tag) throw new Error("--run <tag> required");

for (let round = 1; round <= max; round++) {
  const failed: Registry[] = [];
  for (const name of readdirSync(dataPath("leakage")).filter((file) => file.endsWith(".json"))) {
    const caseId = name.slice(0, -5);
    if (!existsSync(registryPath(caseId))) continue;
    const staged = loadStaged(caseId) as Registry;
    if (staged.meta?.run !== tag || staged.restaged_as || staged.form === "planted" || staged.form === "canary") continue;
    if (!readJson<{ pass: boolean }>(dataPath("leakage", name)).pass) failed.push(staged);
  }
  if (failed.length === 0) break;
  const items = failed.map((staged) => {
    const schemas = [1, 2].map((turn) => join(staged.dir, `schema${turn}.json`)).filter((path) => existsSync(path))
      .map((path) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
    const { dir: _dir, prompt_sha256: _hash, turn2_sha256: _turn2, staged_at: _at, restaged_as: _as, attempt, ...rest } = staged;
    const spec: CaseSpec = { ...rest, case_id: newCaseId(), prompt: readFileSync(join(staged.dir, "PROMPT.md"), "utf8"), ...(schemas.length ? { schemas } : {}), meta: { ...rest.meta, restaged_from: staged.case_id } };
    writeJson(registryPath(staged.case_id), { ...staged, restaged_as: spec.case_id });
    return { spec, packet: staged.doc_id && staged.form === "N-T" ? loadPacketFile(staged.doc_id).packet : undefined, attempt: (attempt ?? 1) + 1 };
  });
  const outcomes = await runCases(items.map(({ spec, packet }) => ({ spec, packet })), 4);
  outcomes.forEach((outcome, index) => {
    const path = registryPath(outcome.case_id);
    writeJson(path, { ...readJson<Registry>(path), attempt: items[index]!.attempt });
    process.stdout.write(`round ${round}: ${items[index]!.spec.meta?.restaged_from} → ${outcome.case_id} leakage=${outcome.leakage_pass} ${outcome.failures.join(",")}\n`);
  });
}
