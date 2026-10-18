// results/<run>.json → reports/<run>/{summary.md, summary.json} (plan §5.8), plus the token projection for the
// step-5 run sizes against the OQ-P1-9 ceiling (30M input / 4M output).
// Usage: npx tsx scripts/reading-p1/report.ts --run <tag> [--supersede <sub-tag>] [--scope corpus|heldout] [--projection] [--full]   (--full: §5.8 items 3-7 + the §5.2 decision)
// --supersede a[,b…]: each later run's results replace the results so far of the same reader × document × form
// (listed as superseded, never deleted); the report goes to reports/<tag>+<a>+<b…>/. The carried slices (not
// superseded) keep their original run's results.
// Scope (throughput round B8; held-out added for step 6): one scope per report. Every path is derived from that
// scope's manifest ids BEFORE any read, list or hash, so a corpus report touches no held-out input and vice versa.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { PARSER_VERSION, type PacketFile } from "./build-packets.js";
import { REPO_ROOT, SCOPES, argValue, dataPath, hasFlag, readJson, scopeIds, sha256Hex, supplierKeys, writeJson, writePrivate, type Scope } from "./common.js";
import { FORMS } from "./prompts.js";
import { loadStaged, registryPath, runIndex, tagScopeError } from "./stage.js";
import { PROOF_QUESTIONS } from "../../src/document-reading-check.js";
import { mcpPayloadBytes } from "../../src/response-budget.js";
import type { TruthRecord } from "./truth.js";
import { resultsScopeError, type CaseResult, type PassResult } from "./replay.js";

const CEILING = { input: 30_000_000, output: 4_000_000 };
const LEGACY_TOKENS = 200_000;
const PLAN_MAX_I_CASES = 240;
/** §2.5 proof / cross-check codes: a wrong field held by any OTHER code on that field was caught by a hard check. */
const PROOF_CODES = new Set(["proof_problem", "label_quote_missing", "label_quote_not_printed", "label_quote_no_letter", "label_quote_overlaps_value", "competitor_not_printed", "reading_heuristic_conflict"]);

export function wilson(successes: number, total: number): [number, number] | null {
  if (total === 0) return null;
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const rate = (successes: number, total: number) => ({ successes, total, rate: total ? successes / total : null, ci95: wilson(successes, total) });
const fmtRate = (value: ReturnType<typeof rate>) => value.total === 0 ? "n/a (0)" :
  `${value.successes}/${value.total} = ${(value.rate! * 100).toFixed(1)}% [${(value.ci95![0] * 100).toFixed(1)}, ${(value.ci95![1] * 100).toFixed(1)}]`;
const fileHash = (path: string) => (existsSync(path) ? sha256Hex(readFileSync(path)) : null);

/** Results of the scope's documents (legacy cases carry no document). */
/** The run's results with every reader × document × form slice of `sub` replaced by the sub-run's results. */
export function supersede(base: CaseResult[], sub: CaseResult[]): { results: CaseResult[]; superseded: CaseResult[] } {
  const slice = (result: CaseResult) => `${result.reader}|${result.doc_id}|${result.form}`;
  const slices = new Set(sub.map(slice));
  const superseded = base.filter((result) => slices.has(slice(result)));
  return { results: [...base.filter((result) => !slices.has(slice(result))), ...sub], superseded };
}

/** The results of the scope's documents; a document-less result belongs to the corpus scope only. */
export function inScope(results: CaseResult[], ids: ReadonlySet<string>, scope: Scope = "corpus"): CaseResult[] {
  return results.filter((result) => (result.doc_id === null ? scope === "corpus" : ids.has(result.doc_id)));
}

type SupplierSource = { supplier_reg?: string | null; supplier_vat?: string | null; supplier_name?: string | null };

/**
 * Plan §5.1/§5.8 (critic m13): held-out results split by supplier seen or unseen in the corpus. A document's
 * supplier keys come from its truth and its packet heuristic (VAT, registry number, normalized name); it is
 * "seen" when any key is a corpus document's key, "unknown" when it has none. Yield per reader × form × pass.
 */
export function supplierSplit(results: CaseResult[], heldout: Record<string, SupplierSource[]>, corpus: SupplierSource[][]) {
  const corpusKeys = new Set(corpus.flatMap((sources) => supplierKeys(...sources)));
  const group = (doc: string): "seen" | "unseen" | "unknown" => {
    const keys = supplierKeys(...(heldout[doc] ?? []));
    return keys.length === 0 ? "unknown" : keys.some((key) => corpusKeys.has(key)) ? "seen" : "unseen";
  };
  const docs = Object.keys(heldout).sort();
  const groups = { seen: docs.filter((doc) => group(doc) === "seen"), unseen: docs.filter((doc) => group(doc) === "unseen"), unknown: docs.filter((doc) => group(doc) === "unknown") };
  const rows: Array<{ reader: string; form: string; pass: string; group: string; cases: number; accepted: number; held: number; silent_wrong_cases: number; pipeline_silent_wrong_cases: number }> = [];
  for (const item of results) {
    if (!item.doc_id || item.kind !== "natural") continue;
    for (const pass of ["real", "as_of"] as const) {
      const entry = item.passes[pass];
      if (!entry) continue;
      const key = { reader: item.reader, form: item.form, pass, group: group(item.doc_id) };
      let row = rows.find((candidate) => candidate.reader === key.reader && candidate.form === key.form && candidate.pass === key.pass && candidate.group === key.group);
      if (!row) rows.push(row = { ...key, cases: 0, accepted: 0, held: 0, silent_wrong_cases: 0, pipeline_silent_wrong_cases: 0 });
      row.cases += 1;
      if (entry.verdict === "accept") row.accepted += 1;
      else row.held += 1;
      if (entry.silent_wrong.length > 0) row.silent_wrong_cases += 1;
      if (entry.pipeline && entry.pipeline.verdict === "accept" && (entry.silent_wrong.length > 0 || entry.pipeline.silent_wrong_reverse_charge)) row.pipeline_silent_wrong_cases += 1;
    }
  }
  rows.sort((a, b) => `${a.reader}|${a.form}|${a.pass}|${a.group}`.localeCompare(`${b.reader}|${b.form}|${b.pass}|${b.group}`));
  return { documents: groups, rows };
}

function hardCaught(pass: PassResult | undefined, field: string): boolean {
  return (pass?.holds ?? []).some((hold) => {
    const [code, holdField] = hold.split(":");
    return holdField === field && !PROOF_CODES.has(code!);
  });
}

export function summarize(tag: string, results: CaseResult[]) {
  const readers = [...new Set(results.map((result) => result.reader))].sort();
  const groups = readers.flatMap((reader) => FORMS.map((form) => ({ reader, form, cases: results.filter((result) => result.reader === reader && result.form === form) })))
    .filter((group) => group.cases.length > 0);

  const usage = groups.map(({ reader, form, cases }) => {
    const sum = cases.reduce((acc, item) => ({
      input: acc.input + item.usage.input, cached_input: acc.cached_input + item.usage.cached_input,
      output: acc.output + item.usage.output, reasoning_output: acc.reasoning_output + item.usage.reasoning_output,
    }), { input: 0, cached_input: 0, output: 0, reasoning_output: 0 });
    return { reader, form, cases: cases.length, ...sum, per_case_input: Math.round(sum.input / cases.length), per_case_output: Math.round(sum.output / cases.length) };
  });

  const yieldRows = groups.flatMap(({ reader, form, cases }) => (["real", "as_of"] as const).map((pass) => {
    const scored = cases.filter((item) => item.passes[pass]);
    const checker = scored.map((item) => item.passes[pass]!);
    const pipeline = checker.filter((entry) => entry.pipeline);
    return {
      reader, form, pass,
      cases: cases.length,
      leakage_failed: cases.filter((item) => !item.leakage_pass).length,
      checker: {
        accepted: checker.filter((entry) => entry.verdict === "accept").length,
        held: checker.filter((entry) => entry.verdict === "hold").length,
        silent_wrong_cases: checker.filter((entry) => entry.silent_wrong.length > 0).length,
        silent_wrong_fields: checker.reduce((acc, entry) => acc + entry.silent_wrong.length, 0),
      },
      pipeline: pipeline.length === 0 ? null : {
        accepted: pipeline.filter((entry) => entry.pipeline!.verdict === "accept").length,
        held: pipeline.filter((entry) => entry.pipeline!.verdict === "hold").length,
        silent_wrong_cases: pipeline.filter((entry) => entry.pipeline!.verdict === "accept" && (entry.silent_wrong.length > 0 || entry.pipeline!.silent_wrong_reverse_charge)).length,
        silent_wrong_reverse_charge: pipeline.filter((entry) => entry.pipeline!.silent_wrong_reverse_charge).length,
      },
    };
  }));

  // Hold rate per code over natural cases, as-of pass: documents with the code, and with it as the only hold.
  const holdRates: Record<string, { with: number; only: number }> = {};
  for (const item of results.filter((result) => result.kind === "natural" && result.passes.as_of)) {
    const codes = [...new Set(item.passes.as_of!.holds.map((hold) => hold.split(":")[0]!))];
    for (const code of codes) {
      const entry = (holdRates[code] ??= { with: 0, only: 0 });
      entry.with += 1;
      if (codes.length === 1) entry.only += 1;
    }
  }

  const forms = groups.map(({ reader, form, cases }) => {
    const natural = cases.filter((item) => item.kind === "natural" && item.leakage_pass && item.truth_available);
    let wrong = 0;
    let caught = 0;
    for (const item of natural) {
      for (const field of item.wrong_fields) {
        if (hardCaught(item.passes.as_of, field)) continue;
        wrong += 1;
        if (item.proof_problem_fields.includes(field)) caught += 1;
      }
    }
    const mutated = cases.filter((item) => item.kind === "mutated" && item.leakage_pass);
    const clean = cases.filter((item) => item.kind === "clean" && item.leakage_pass);
    return {
      reader, form,
      natural_catch: rate(caught, wrong),
      injected_catch: rate(mutated.filter((item) => item.mutated_field !== undefined && item.proof_problem_fields.includes(item.mutated_field)).length, mutated.length),
      false_alarm: rate(clean.filter((item) => item.proof_problem_fields.length > 0).length, clean.length),
      schema_failures: { reading: cases.filter((item) => item.reading_schema !== null && item.reading_schema !== "ok").length, proof: cases.filter((item) => item.proof_schema !== null && item.proof_schema !== "ok").length, proof_missing: cases.filter((item) => item.proof_schema === null).length },
    };
  });

  return { tag, readers, usage, yield: yieldRows, hold_rates: holdRates, forms };
}

/** Projects the step-5 reader runs from this run's mean tokens per case (reader × form). */
export function projection(usage: ReturnType<typeof summarize>["usage"], ids: ReadonlySet<string>) {
  const corpus = ids.size;
  const heldout = 0; // corpus scope: the held-out manifest is never read
  const familyA = existsSync(dataPath("mutations", "a.json")) ? readJson<{ sampled: unknown[] }>(dataPath("mutations", "a.json")) : { sampled: [] };
  const plannedI = 2 * familyA.sampled.length; // mutated + clean, 1:1, per reader and form
  const scenario = (iCases: number) => {
    const rows = usage.map((row) => {
      const units = row.form === "N-S" || row.form === "N-T" ? corpus + heldout : iCases;
      return { reader: row.reader, form: row.form, units, input: units * row.per_case_input, output: units * row.per_case_output };
    });
    const input = rows.reduce((acc, row) => acc + row.input, 0) + LEGACY_TOKENS;
    const output = rows.reduce((acc, row) => acc + row.output, 0);
    return { i_cases_per_reader_form: iCases, rows, input, output, legacy_tokens: LEGACY_TOKENS, exceeds_ceiling: input > CEILING.input || output > CEILING.output };
  };
  return { documents: { corpus, heldout }, ceiling: CEILING, planned: scenario(plannedI), plan_upper_bound: scenario(PLAN_MAX_I_CASES) };
}

/** Plan §5.2 decision rule, applied per reader; any unmet condition (incl. too little evidence) selects two-turn. */
export function formDecision(forms: ReturnType<typeof summarize>["forms"], results: CaseResult[]) {
  const readers = [...new Set(forms.map((row) => row.reader))].sort();
  const perReader = readers.map((reader) => {
    const row = (form: string) => forms.find((entry) => entry.reader === reader && entry.form === form);
    const count = (form: string, kind: string) => results.filter((item) => item.reader === reader && item.form === form && item.kind === kind && item.leakage_pass).length;
    const iS = row("I-S"), iT = row("I-T"), nS = row("N-S"), nT = row("N-T");
    const conditions = {
      c1_min_60_mutated_and_clean: { I_S: { mutated: count("I-S", "mutated"), clean: count("I-S", "clean") }, I_T: { mutated: count("I-T", "mutated"), clean: count("I-T", "clean") },
        met: ["I-S", "I-T"].every((form) => count(form, "mutated") >= 60 && count(form, "clean") >= 60) },
      c2_catch: { I_S: iS?.injected_catch.rate ?? null, I_T: iT?.injected_catch.rate ?? null,
        met: iS?.injected_catch.rate != null && iT?.injected_catch.rate != null && iS.injected_catch.rate >= iT.injected_catch.rate - 0.05 },
      c3_false_alarm: { I_S: iS?.false_alarm.rate ?? null, I_T: iT?.false_alarm.rate ?? null,
        met: iS?.false_alarm.rate != null && iT?.false_alarm.rate != null && iS.false_alarm.rate <= iT.false_alarm.rate + 0.05 },
      c4_natural: { N_S_wrong: nS?.natural_catch.total ?? 0, N_T_wrong: nT?.natural_catch.total ?? 0, N_S: nS?.natural_catch.rate ?? null, N_T: nT?.natural_catch.rate ?? null,
        met: (nS?.natural_catch.total ?? 0) >= 5 && (nT?.natural_catch.total ?? 0) >= 5 && nS!.natural_catch.rate! >= nT!.natural_catch.rate! },
    };
    const unmet = Object.entries(conditions).filter(([, value]) => !value.met).map(([name]) => name);
    return { reader, conditions, unmet };
  });
  const single = perReader.length > 0 && perReader.every((entry) => entry.unmet.length === 0);
  return { decision: single ? "single-turn" : "two-turn", decided_by: single ? "all conditions met for every reader" : [...new Set(perReader.flatMap((entry) => entry.unmet))], per_reader: perReader };
}

/** §5.8 items 3-7 that come from outside the run's case results. */
export function extras(results: CaseResult[], ids: ReadonlySet<string>, tag: string | string[], scope: Scope = "corpus") {
  // Families, family (a) and the legacy replication are corpus artefacts: reported in the corpus scope only.
  const corpus = scope === "corpus";
  const index = () => (Array.isArray(tag) ? tag : [tag]).flatMap((entry) => runIndex(entry, { optional: true }));
  const families = corpus && existsSync(dataPath("mutations", "families.json")) ? readJson<{ base_acceptance: unknown; by_family: Record<string, Record<string, number>>; results: { family: string; name: string; doc: string; expected: unknown; status: string; layer?: string; new_codes?: string[] }[] }>(dataPath("mutations", "families.json")) : null;
  const a = corpus && existsSync(dataPath("mutations", "a.json")) ? readJson<{ bases: { admitted: string[] }; admitted_bases: { doc_id: string; source?: string | null }[]; candidates: number; held_by_hard_checks: number; survivors: number; sampled: unknown[]; by_field_type: unknown; amounts_by_direction: unknown }>(dataPath("mutations", "a.json")) : null;
  const injected = results.filter((item) => item.kind === "mutated" && item.leakage_pass);
  const proofCatch: Record<string, { caught: number; cases: number }> = {};
  for (const item of injected) {
    const entry = (proofCatch[`${item.reader}|${item.form}`] ??= { caught: 0, cases: 0 });
    entry.cases += 1;
    if (item.mutated_field && item.proof_problem_fields.includes(item.mutated_field)) entry.caught += 1;
  }
  const corpusPackets = [...ids].sort().map((id) => dataPath("packets", `${id}.json`)).filter((path) => existsSync(path))
    .map((path) => readJson<PacketFile & { stats?: { text_bytes?: number; lines?: number } }>(path));
  const dist = (values: number[]) => {
    const sorted = [...values].sort((x, y) => x - y);
    const at = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null;
    return { n: sorted.length, min: sorted[0] ?? null, p50: at(0.5), p90: at(0.9), max: sorted.at(-1) ?? null };
  };
  const envelopes = corpusPackets.map((file) => mcpPayloadBytes({ packet: file.packet, questions: PROOF_QUESTIONS }) + 1024);
  const oversize = corpusPackets.filter((file) => ((file.packet as { holds?: { code?: string }[] | string[] }).holds ?? []).some((hold) => (typeof hold === "string" ? hold : hold.code) === "packet_oversize")).length;
  const proofOut = results.filter((item) => (item.form === "N-T" || item.form === "I-T") && item.leakage_pass).map((item) => item.usage.output);
  const det = (["run1", "run2"] as const).map((run) => Object.fromEntries([...ids].sort().map((id) => dataPath("determinism", run, `${id}.json`)).filter((path) => existsSync(path))
    .map((path) => [path.slice(path.lastIndexOf("/") + 1), (readJson<PacketFile>(path).packet as { packet_digest?: string }).packet_digest])));
  const detNames = Object.keys(det[0]!);
  const legacyScore = corpus && existsSync(dataPath("legacy", "score.txt")) ? readFileSync(dataPath("legacy", "score.txt"), "utf8") : null;
  const truth = existsSync(dataPath(scope, "truth.json")) ? readJson<Record<string, TruthRecord>>(dataPath(scope, "truth.json")) : {};
  const expectedHolds = Object.entries(truth).filter(([, record]) => (record.expected_document_holds ?? []).length > 0).map(([doc, record]) => {
    const cases = results.filter((item) => item.doc_id === doc && item.kind === "natural" && item.leakage_pass && item.passes.as_of);
    const codes = record.expected_document_holds!;
    const failing = cases.filter((item) => item.passes.as_of!.verdict !== "hold" || !item.passes.as_of!.holds.some((hold) => codes.includes(hold.split(":")[0]!)));
    // A reading that fails its schema holds before any content check can run: reported apart, not hidden.
    const schemaHeld = failing.filter((item) => item.passes.as_of!.verdict === "hold" && item.passes.as_of!.holds.every((hold) => hold.startsWith("reading_schema_invalid") || hold.startsWith("proof_schema_invalid")));
    return { doc, expected: codes, cases: cases.length, failing: failing.map((item) => item.case_id), schema_held: schemaHeld.map((item) => item.case_id) };
  });
  // Every truth change with its reason (B1/B3/B5), and every re-staged case of the run with its evidence (B7, 5a).
  const truthChanges = Object.entries(truth).flatMap(([doc, record]) => (record.truth_changes ?? []).map((change) => ({ doc, ...change })));
  // From the run index, filtered by document before any registry is opened.
  const restaged = index().filter((entry) => (entry.doc_id === null || ids.has(entry.doc_id)) && existsSync(registryPath(entry.case_id)))
    .map((entry) => loadStaged(entry.case_id) as ReturnType<typeof loadStaged> & { restaged_as?: string; restage_evidence?: string[]; restage_class?: string })
    .filter((entry) => entry.restaged_as)
    .map((entry) => ({ case_id: entry.case_id, doc_id: entry.doc_id, reader: entry.reader, form: entry.form, kind: entry.kind, restaged_as: entry.restaged_as!,
      restage_class: entry.restage_class ?? "transport", evidence: entry.restage_evidence ?? null }));
  // Every classifier-interrupted attempt of the run (discarded, never scored), so the measurement is not censored.
  const classifierInterrupts = index().filter((entry) => (entry.doc_id === null || ids.has(entry.doc_id)) && existsSync(registryPath(entry.case_id)) &&
    existsSync(dataPath("leakage", `${entry.case_id}.json`)) && (readJson<{ failures?: string[] }>(dataPath("leakage", `${entry.case_id}.json`)).failures ?? []).includes("classifier_interrupt"))
    .map((entry) => loadStaged(entry.case_id) as ReturnType<typeof loadStaged> & { restaged_as?: string })
    .map((entry) => ({ case_id: entry.case_id, doc_id: entry.doc_id, reader: entry.reader, form: entry.form, kind: entry.kind, restaged_as: entry.restaged_as ?? null }));
  return {
    truth_changes: truthChanges,
    restaged,
    classifier_interrupts: classifierInterrupts,
    families: families && { base_acceptance: families.base_acceptance, by_family: families.by_family, escaped: families.results.filter((entry) => entry.status !== "OK"), cases: families.results.length },
    family_a: a && { bases: a.admitted_bases.map((base) => ({ doc_id: base.doc_id, source: base.source ?? null })), candidates: a.candidates, held_by_hard_checks: a.held_by_hard_checks, survivors: a.survivors, sampled: a.sampled.length, by_field_type: a.by_field_type, amounts_by_direction: a.amounts_by_direction, proof_catch: proofCatch },
    packets: { corpus_packets: corpusPackets.length, text_bytes: dist(corpusPackets.map((file) => (file.packet as { text_bytes: number }).text_bytes)), lines: dist(corpusPackets.map((file) => (file.packet as { lines: unknown[] }).lines.length)), packet_oversize: oversize, envelope_bytes: dist(envelopes), proof_output_tokens_per_two_turn_case: dist(proofOut),
      determinism: { files: detNames.length, identical: detNames.filter((name) => det[0]![name] !== undefined && det[0]![name] === det[1]![name]).length } },
    legacy_score: legacyScore,
    expected_document_holds: expectedHolds,
  };
}

function header(tag: string, results: CaseResult[], scope: Scope = "corpus") {
  const commit = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-C", REPO_ROOT, "status", "--porcelain", "--", "src"], { encoding: "utf8" }).trim() !== "";
  const snapshots = existsSync(dataPath("snapshots")) ? readdirSync(dataPath("snapshots")).filter((name) => existsSync(dataPath("snapshots", name, "meta.json"))) : [];
  const anyPacket = results.find((result) => result.doc_id)?.doc_id;
  return {
    run: tag,
    checker_commit: commit,
    src_dirty: dirty,
    parser: PARSER_VERSION,
    builder: anyPacket ? (readJson<PacketFile>(dataPath("packets", `${anyPacket}.json`)).packet as { builder_version?: string }).builder_version ?? null : null,
    today: { real: [...new Set(results.map((result) => result.passes.real?.today).filter(Boolean))], as_of: "truth.invoice_date + 30 days" },
    scope,
    manifests: { [scope]: { files: fileHash(dataPath(scope, "files.txt")), sha256: fileHash(dataPath(scope, "sha256.txt")) } },
    snapshots: Object.fromEntries(snapshots.map((company) => {
      const meta = readJson<Record<string, unknown>>(dataPath("snapshots", company, "meta.json"));
      return [company, { meta_sha256: fileHash(dataPath("snapshots", company, "meta.json")), taken_at: meta.taken_at ?? meta.created_at ?? null }];
    })),
    models: [...new Set(results.flatMap((result) => result.models))].sort(),
    claude_path: "primary (tool-less claude -p --safe-mode)",
    leakage: Object.fromEntries([...new Set(results.map((result) => result.reader))].map((reader) => {
      const cases = results.filter((result) => result.reader === reader);
      return [reader, { cases: cases.length, failed: cases.filter((result) => !result.leakage_pass).length }];
    })),
  };
}

function markdown(head: ReturnType<typeof header>, summary: ReturnType<typeof summarize>, proj?: ReturnType<typeof projection>, extra?: ReturnType<typeof extras>, decision?: ReturnType<typeof formDecision>, superseded?: { by: string; cases: CaseResult[] }): string {
  const lines: string[] = [`# Reading P1 run \`${head.run}\``, ""];
  if (superseded) {
    lines.push(`- superseded by \`${superseded.by}\` (kept, not scored here): ${superseded.cases.length} cases`);
    for (const item of superseded.cases) lines.push(`  - ${item.case_id} #${item.doc_id ?? "-"} ${item.reader} ${item.form} ${item.kind}${item.proof_problem_fields.length ? ` problem ${item.proof_problem_fields.join(",")}` : ""}`);
    lines.push("");
  }
  lines.push(`- checker commit ${head.checker_commit}${head.src_dirty ? " (src dirty)" : ""}, ${head.parser}, builder ${head.builder ?? "?"}`);
  lines.push(`- today: real ${head.today.real.join(", ") || "-"}; as-of ${head.today.as_of}`);
  lines.push(`- models: ${head.models.join(", ")}; Claude path: ${head.claude_path}`);
  lines.push(`- leakage: ${Object.entries(head.leakage).map(([reader, entry]) => `${reader} ${entry.failed}/${entry.cases} failed`).join("; ")}`, "");
  lines.push("## Tokens", "", "| reader | form | cases | input | cached | output | reasoning | in/case | out/case |", "|---|---|---|---|---|---|---|---|---|");
  for (const row of summary.usage) lines.push(`| ${row.reader} | ${row.form} | ${row.cases} | ${row.input} | ${row.cached_input} | ${row.output} | ${row.reasoning_output} | ${row.per_case_input} | ${row.per_case_output} |`);
  lines.push("", "## Yield", "", "| reader | form | pass | cases | leak fail | accepted | held | silent-wrong (cases/fields) | pipeline acc/held/sw |", "|---|---|---|---|---|---|---|---|---|");
  for (const row of summary.yield) {
    const p = row.pipeline ? `${row.pipeline.accepted}/${row.pipeline.held}/${row.pipeline.silent_wrong_cases}` : "-";
    lines.push(`| ${row.reader} | ${row.form} | ${row.pass} | ${row.cases} | ${row.leakage_failed} | ${row.checker.accepted} | ${row.checker.held} | ${row.checker.silent_wrong_cases}/${row.checker.silent_wrong_fields} | ${p} |`);
  }
  lines.push("", "## Hold rate per code (natural cases, as-of)", "", "| code | cases | only hold |", "|---|---|---|");
  for (const [code, entry] of Object.entries(summary.hold_rates).sort((a, b) => b[1].with - a[1].with)) lines.push(`| ${code} | ${entry.with} | ${entry.only} |`);
  lines.push("", "## Forms (95% Wilson)", "", "| reader | form | natural catch | injected catch | false alarm | schema fail (reading/proof/missing) |", "|---|---|---|---|---|---|");
  for (const row of summary.forms) lines.push(`| ${row.reader} | ${row.form} | ${fmtRate(row.natural_catch)} | ${fmtRate(row.injected_catch)} | ${fmtRate(row.false_alarm)} | ${row.schema_failures.reading}/${row.schema_failures.proof}/${row.schema_failures.proof_missing} |`);
  if (extra) {
    lines.push("", "Called out (plan §5.8.3): " + ["competing_consistent_total (A2)", "mixed_vat_rate (A3)", "invoice_number_is_identifier (H9)", "foreign_rate_trio", "cited_origin_unestablished", "unaccounted_identifier"].map((label) => { const code = label.split(" ")[0]!; const entry = summary.hold_rates[code]; return `${label} ${entry ? `${entry.with}/${entry.only}` : "0/0"}`; }).join("; ") + "; " +
      Object.entries(summary.hold_rates).filter(([code]) => code.startsWith("ocr_")).map(([code, entry]) => `${code} ${entry.with}/${entry.only}`).join("; ") + " (cases/only)");
    lines.push("", "## Truth changes", "", ...(extra.truth_changes.length ? extra.truth_changes.map((change) => `- #${change.doc} ${change.field}: ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)} (${change.reason})`) : ["- none"]));
    lines.push("", "## Re-staged cases (transport evidence, classifier interrupt or usage limit)", "", ...(extra.restaged.length ? extra.restaged.map((entry) => `- ${entry.case_id} → ${entry.restaged_as} [${entry.restage_class}]: ${entry.evidence ? entry.evidence.join(" | ") : "NO EVIDENCE RECORDED"}`) : ["- none"]));
    lines.push("", "## Classifier interrupts (discarded attempts, never scored)", "", ...(extra.classifier_interrupts.length ? extra.classifier_interrupts.map((entry) => `- ${entry.case_id}: #${entry.doc_id ?? "-"} ${entry.reader} ${entry.form} ${entry.kind} → ${entry.restaged_as ?? "not re-staged"}`) : ["- none"]));
    lines.push("", "## Expected document holds (§7.7)", "");
    for (const entry of extra.expected_document_holds) lines.push(`- #${entry.doc} expects one of ${entry.expected.join(", ")}: ${entry.cases} natural cases, ${entry.failing.length} not held with one of them${entry.failing.length ? ` (${entry.failing.join(", ")})` : ""}${entry.schema_held.length ? `; of these ${entry.schema_held.length} held by a schema hold only (no content check ran)` : ""}`);
    if (extra.families) {
      lines.push("", "## Families (c)–(k)", "", `- base acceptance: ${JSON.stringify(extra.families.base_acceptance)}`, `- ${extra.families.cases} cases; by family ${JSON.stringify(extra.families.by_family)}`, `- not OK: ${extra.families.escaped.length ? extra.families.escaped.map((entry) => `${entry.family}/${entry.name} ${entry.status}`).join("; ") : "none"}`);
    }
    if (extra.family_a) {
      const fa = extra.family_a;
      lines.push("", "## Family (a)", "", `- bases ${fa.bases.map((base) => `${base.doc_id} (${base.source ?? "truth-derived"})`).join(", ")}; candidates ${fa.candidates}, held by hard checks ${fa.held_by_hard_checks}, survivors ${fa.survivors}, sampled ${fa.sampled}`,
        `- by field type ${JSON.stringify(fa.by_field_type)}`, `- amounts by direction ${JSON.stringify(fa.amounts_by_direction)}`, `- proof catch on the mutated field: ${Object.entries(fa.proof_catch).map(([key, value]) => `${key} ${value.caught}/${value.cases}`).join("; ") || "-"}`);
    }
    const pk = extra.packets;
    lines.push("", "## Packets", "", `- ${pk.corpus_packets} corpus packets; text_bytes ${JSON.stringify(pk.text_bytes)}; lines ${JSON.stringify(pk.lines)}; packet_oversize ${pk.packet_oversize}`,
      `- envelope estimate (packet + PROOF_QUESTIONS + 1 KiB, bytes) ${JSON.stringify(pk.envelope_bytes)}`, `- output tokens per two-turn case ${JSON.stringify(pk.proof_output_tokens_per_two_turn_case)}`, `- cross-process determinism: ${pk.determinism.identical}/${pk.determinism.files} packet digests identical`);
    lines.push("", "## Legacy replication", "", extra.legacy_score ? "```\n" + extra.legacy_score.trim() + "\n```" : "- not scored");
  }
  if (decision) {
    lines.push("", "## §5.2 form decision", "", `- **${decision.decision}**; decided by ${Array.isArray(decision.decided_by) ? decision.decided_by.join(", ") : decision.decided_by}`);
    for (const entry of decision.per_reader) lines.push(`- ${entry.reader}: ${JSON.stringify(entry.conditions)}`);
  }
  if (proj) {
    lines.push("", "## Token projection (step 5 reader runs)", "");
    for (const [name, scenario] of [["planned (family (a) as sampled)", proj.planned], ["plan upper bound (240 I-cases)", proj.plan_upper_bound]] as const) {
      lines.push(`- ${name}: ${scenario.i_cases_per_reader_form} I-cases per reader × form; input ${(scenario.input / 1e6).toFixed(2)}M, output ${(scenario.output / 1e6).toFixed(2)}M (ceiling ${proj.ceiling.input / 1e6}M / ${proj.ceiling.output / 1e6}M) → ${scenario.exceeds_ceiling ? "EXCEEDS" : "within"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Step 6: the held-out report is always the full report (plan §6 step 6). */
export const fullFor = (scope: Scope, flag: boolean): boolean => scope !== "corpus" || flag;

/** A document's supplier sources: its truth (when available) and its packet heuristic. */
function supplierSourcesOf(set: Scope, id: string): SupplierSource[] {
  const truthPath = dataPath(set, "truth.json");
  const truth = existsSync(truthPath) ? readJson<Record<string, TruthRecord>>(truthPath)[id] : undefined;
  const packetPath = dataPath("packets", `${id}.json`);
  const heuristic = existsSync(packetPath) ? readJson<PacketFile>(packetPath).heuristic_fields : undefined;
  const sources: SupplierSource[] = [];
  if (truth?.status === "available") sources.push(truth);
  if (heuristic) sources.push(heuristic);
  return sources;
}

if (process.argv[1]?.endsWith("/report.ts")) {
  const argv = process.argv.slice(2);
  const tag = argValue(argv, "--run");
  if (!tag) throw new Error("--run <tag> required");
  const scope = (argValue(argv, "--scope") ?? "corpus") as Scope;
  if (!SCOPES.includes(scope)) throw new Error(`--scope must be one of ${SCOPES.join(", ")}`);
  const subs = (argValue(argv, "--supersede") ?? "").split(",").filter(Boolean);
  const sub = subs.length ? subs.join("+") : undefined;
  const out = sub ? `${tag}+${sub}` : tag;
  // Every report tag and superseding tag belongs to the scope, and a report of another scope is never overwritten.
  for (const name of [tag, ...subs]) {
    const error = tagScopeError(name, scope) ?? resultsScopeError(name, scope);
    if (error) throw new Error(error);
  }
  const previous = dataPath("reports", out, "summary.json");
  if (existsSync(previous) && (readJson<{ header?: { scope?: string } }>(previous).header?.scope ?? "corpus") !== scope) throw new Error(`reports/${out} is a report of another scope`);
  const ids = scopeIds(scope);
  let merged: { results: CaseResult[]; superseded: CaseResult[] } | undefined;
  for (const entry of subs) {
    const next = supersede(merged?.results ?? readJson<CaseResult[]>(dataPath("results", `${tag}.json`)), readJson<CaseResult[]>(dataPath("results", `${entry}.json`)));
    merged = { results: next.results, superseded: [...(merged?.superseded ?? []), ...next.superseded] };
  }
  const results = inScope(merged ? merged.results : readJson<CaseResult[]>(dataPath("results", `${tag}.json`)), ids, scope);
  const head = header(out, results, scope);
  const summary = summarize(tag, results);
  const proj = hasFlag(argv, "--projection") && scope === "corpus" ? projection(summary.usage, ids) : undefined;
  const extra = fullFor(scope, hasFlag(argv, "--full")) ? extras(results, ids, subs.length ? [tag, ...subs] : tag, scope) : undefined;
  const decision = extra ? formDecision(summary.forms, results) : undefined;
  const superseded = merged && sub ? { by: sub, cases: inScope(merged.superseded, ids, scope) } : undefined;
  const split = scope !== "corpus" ? supplierSplit(results,
    Object.fromEntries([...ids].map((id) => [id, supplierSourcesOf(scope, id)])),
    [...scopeIds("corpus")].map((id) => supplierSourcesOf("corpus", id))) : undefined;
  writeJson(dataPath("reports", out, "summary.json"), { header: head, ...summary, ...(proj ? { projection: proj } : {}), ...(extra ? { extras: extra, form_decision: decision } : {}),
    ...(superseded ? { superseded: { by: superseded.by, case_ids: superseded.cases.map((item) => item.case_id) } } : {}), ...(split ? { supplier_split: split } : {}) });
  let md = markdown(head, summary, proj, extra, decision, superseded);
  if (split) {
    const lines = ["", "## Held-out by supplier seen/unseen in the corpus (§5.1)", "", `- documents: seen ${split.documents.seen.length}, unseen ${split.documents.unseen.length}, unknown ${split.documents.unknown.length}`, "",
      "| reader | form | pass | supplier | cases | accepted | held | silent-wrong | pipeline silent-wrong |", "|---|---|---|---|---|---|---|---|---|",
      ...split.rows.map((row) => `| ${row.reader} | ${row.form} | ${row.pass} | ${row.group} | ${row.cases} | ${row.accepted} | ${row.held} | ${row.silent_wrong_cases} | ${row.pipeline_silent_wrong_cases} |`)];
    md += `${lines.join("\n")}\n`;
  }
  writePrivate(dataPath("reports", out, "summary.md"), md);
  process.stdout.write(md);
}
