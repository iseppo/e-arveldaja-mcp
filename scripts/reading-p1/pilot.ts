// Step-5 pilot (plan §5.3 token table): 3 cases per reader × form on the corpus (never the held-out set), each
// in its own reader context, shuffled run order. Natural forms use truth-available corpus documents; I-forms
// draw from the 1:1 mutated/clean family-(a) list. Then: replay.ts --run pilot --pipeline and
// report.ts --run pilot --projection (stop for owner approval if the projection exceeds OQ-P1-9).
// Usage: npx tsx scripts/reading-p1/pilot.ts [--per 3]

import { formCase, loadFamilyA, READERS, type CaseItem } from "./cases.js";
import { argValue, dataPath, readJson, writeJson } from "./common.js";
import { rng, shuffle, type Candidate } from "./mutate.js";
import { FORMS } from "./prompts.js";
import { runCases } from "./run-cases.js";
import type { TruthRecord } from "./truth.js";

const RUN = "pilot";
const per = Number(argValue(process.argv.slice(2), "--per") ?? "3");
const random = rng(17);
const family = loadFamilyA();
const truth = readJson<Record<string, TruthRecord>>(dataPath("corpus", "truth.json"));
const naturalDocs = shuffle(Object.keys(truth).filter((id) => truth[id]!.status === "available").sort(), random).slice(0, per);

// 1:1 mutated and clean: each sampled survivor pairs with a clean case of its base.
const pairs: Array<{ docId: string; candidate: Candidate | null }> = family.sampled.flatMap((candidate) => [
  { docId: candidate.doc_id, candidate },
  { docId: candidate.doc_id, candidate: null },
]);
const injected = shuffle(pairs, random).slice(0, per);

const items: CaseItem[] = [];
for (const reader of READERS) {
  for (const form of FORMS) {
    const picks = form === "N-S" || form === "N-T" ? naturalDocs.map((docId) => ({ docId, candidate: null })) : injected;
    for (const pick of picks) {
      const base = family.admitted_bases.find((entry) => entry.doc_id === pick.docId);
      items.push(formCase(reader, form, pick.docId, base, pick.candidate, RUN));
    }
  }
}
const order = shuffle(items, random);
writeJson(dataPath("smoke", "pilot-plan.json"), { natural_docs: naturalDocs, injected: injected.map((pick) => ({ doc_id: pick.docId, mutated: pick.candidate !== null })), cases: order.length });
const outcomes = await runCases(order, 4, (outcome) => {
  process.stdout.write(`${outcome.case_id} leakage=${outcome.leakage_pass} ${outcome.failures.join(",")} ${outcome.run_errors.join(" | ").slice(0, 200)}\n`);
});
const failed = outcomes.filter((outcome) => !outcome.leakage_pass);
process.stdout.write(`pilot: ${outcomes.length} cases, ${failed.length} leakage failures\n`);
