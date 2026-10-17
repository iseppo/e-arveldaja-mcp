// results/<run>.json → reports/<run>/{summary.md, summary.json} (plan §5.8), plus the token projection for the
// step-5 run sizes against the OQ-P1-9 ceiling (30M input / 4M output).
// Usage: npx tsx scripts/reading-p1/report.ts --run <tag> [--projection] [--full]   (--full: §5.8 items 3-7 + the §5.2 decision)

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { PARSER_VERSION, type PacketFile } from "./build-packets.js";
import { REPO_ROOT, argValue, dataPath, hasFlag, readJson, sha256Hex, writeJson, writePrivate } from "./common.js";
import { FORMS } from "./prompts.js";
import { PROOF_QUESTIONS } from "../../src/document-reading-check.js";
import { mcpPayloadBytes } from "../../src/response-budget.js";
import type { TruthRecord } from "./truth.js";
import type { CaseResult, PassResult } from "./replay.js";

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
export function projection(usage: ReturnType<typeof summarize>["usage"]) {
  const corpus = readFileSync(dataPath("corpus", "files.txt"), "utf8").split("\n").filter(Boolean).length;
  const heldout = existsSync(dataPath("heldout", "files.txt")) ? readFileSync(dataPath("heldout", "files.txt"), "utf8").split("\n").filter(Boolean).length : 0;
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
export function extras(results: CaseResult[]) {
  const families = existsSync(dataPath("mutations", "families.json")) ? readJson<{ base_acceptance: unknown; by_family: Record<string, Record<string, number>>; results: { family: string; name: string; doc: string; expected: unknown; status: string; layer?: string; new_codes?: string[] }[] }>(dataPath("mutations", "families.json")) : null;
  const a = existsSync(dataPath("mutations", "a.json")) ? readJson<{ bases: { admitted: string[] }; admitted_bases: { doc_id: string; source?: string | null }[]; candidates: unknown[]; held_by_hard_checks: unknown[]; survivors: unknown[]; sampled: unknown[]; by_field_type: unknown; amounts_by_direction: unknown }>(dataPath("mutations", "a.json")) : null;
  const injected = results.filter((item) => item.kind === "mutated" && item.leakage_pass);
  const proofCatch: Record<string, { caught: number; cases: number }> = {};
  for (const item of injected) {
    const entry = (proofCatch[`${item.reader}|${item.form}`] ??= { caught: 0, cases: 0 });
    entry.cases += 1;
    if (item.mutated_field && item.proof_problem_fields.includes(item.mutated_field)) entry.caught += 1;
  }
  const packets = existsSync(dataPath("packets")) ? readdirSync(dataPath("packets")).filter((name) => name.endsWith(".json")).map((name) => readJson<PacketFile & { stats?: { text_bytes?: number; lines?: number } }>(dataPath("packets", name))) : [];
  const corpusPackets = packets.filter((file) => !String((file as { id?: string }).id ?? "").startsWith("h"));
  const dist = (values: number[]) => {
    const sorted = [...values].sort((x, y) => x - y);
    const at = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null;
    return { n: sorted.length, min: sorted[0] ?? null, p50: at(0.5), p90: at(0.9), max: sorted.at(-1) ?? null };
  };
  const envelopes = corpusPackets.map((file) => mcpPayloadBytes({ packet: file.packet, questions: PROOF_QUESTIONS }) + 1024);
  const oversize = corpusPackets.filter((file) => ((file.packet as { holds?: { code?: string }[] | string[] }).holds ?? []).some((hold) => (typeof hold === "string" ? hold : hold.code) === "packet_oversize")).length;
  const proofOut = results.filter((item) => (item.form === "N-T" || item.form === "I-T") && item.leakage_pass).map((item) => item.usage.output);
  const det = (["run1", "run2"] as const).map((run) => existsSync(dataPath("determinism", run)) ? Object.fromEntries(readdirSync(dataPath("determinism", run)).map((name) => [name, (readJson<PacketFile>(dataPath("determinism", run, name)).packet as { packet_digest?: string }).packet_digest])) : {});
  const detNames = Object.keys(det[0]!);
  const legacyScore = existsSync(dataPath("legacy", "score.txt")) ? readFileSync(dataPath("legacy", "score.txt"), "utf8") : null;
  const truth = existsSync(dataPath("corpus", "truth.json")) ? readJson<Record<string, TruthRecord>>(dataPath("corpus", "truth.json")) : {};
  const expectedHolds = Object.entries(truth).filter(([, record]) => (record.expected_document_holds ?? []).length > 0).map(([doc, record]) => {
    const cases = results.filter((item) => item.doc_id === doc && item.kind === "natural" && item.leakage_pass && item.passes.as_of);
    const codes = record.expected_document_holds!;
    const failing = cases.filter((item) => item.passes.as_of!.verdict !== "hold" || !item.passes.as_of!.holds.some((hold) => codes.includes(hold.split(":")[0]!)));
    return { doc, expected: codes, cases: cases.length, failing: failing.map((item) => item.case_id) };
  });
  return {
    families: families && { base_acceptance: families.base_acceptance, by_family: families.by_family, escaped: families.results.filter((entry) => entry.status !== "OK"), cases: families.results.length },
    family_a: a && { bases: a.admitted_bases.map((base) => ({ doc_id: base.doc_id, source: base.source ?? null })), candidates: a.candidates.length, held_by_hard_checks: a.held_by_hard_checks.length, survivors: a.survivors.length, sampled: a.sampled.length, by_field_type: a.by_field_type, amounts_by_direction: a.amounts_by_direction, proof_catch: proofCatch },
    packets: { corpus_packets: corpusPackets.length, text_bytes: dist(corpusPackets.map((file) => (file.packet as { text_bytes: number }).text_bytes)), lines: dist(corpusPackets.map((file) => (file.packet as { lines: unknown[] }).lines.length)), packet_oversize: oversize, envelope_bytes: dist(envelopes), proof_output_tokens_per_two_turn_case: dist(proofOut),
      determinism: { files: detNames.length, identical: detNames.filter((name) => det[0]![name] !== undefined && det[0]![name] === det[1]![name]).length } },
    legacy_score: legacyScore,
    expected_document_holds: expectedHolds,
  };
}

function header(tag: string, results: CaseResult[]) {
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
    manifests: Object.fromEntries((["corpus", "heldout"] as const).map((set) => [set, { files: fileHash(dataPath(set, "files.txt")), sha256: fileHash(dataPath(set, "sha256.txt")) }])),
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

function markdown(head: ReturnType<typeof header>, summary: ReturnType<typeof summarize>, proj?: ReturnType<typeof projection>, extra?: ReturnType<typeof extras>, decision?: ReturnType<typeof formDecision>): string {
  const lines: string[] = [`# Reading P1 run \`${head.run}\``, ""];
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
    lines.push("", "## Expected document holds (§7.7)", "");
    for (const entry of extra.expected_document_holds) lines.push(`- #${entry.doc} expects one of ${entry.expected.join(", ")}: ${entry.cases} natural cases, ${entry.failing.length} not held with one of them${entry.failing.length ? ` (${entry.failing.join(", ")})` : ""}`);
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

if (process.argv[1]?.endsWith("/report.ts")) {
  const argv = process.argv.slice(2);
  const tag = argValue(argv, "--run");
  if (!tag) throw new Error("--run <tag> required");
  const results = readJson<CaseResult[]>(dataPath("results", `${tag}.json`));
  const head = header(tag, results);
  const summary = summarize(tag, results);
  const proj = hasFlag(argv, "--projection") ? projection(summary.usage) : undefined;
  const extra = hasFlag(argv, "--full") ? extras(results) : undefined;
  const decision = extra ? formDecision(summary.forms, results) : undefined;
  writeJson(dataPath("reports", tag, "summary.json"), { header: head, ...summary, ...(proj ? { projection: proj } : {}), ...(extra ? { extras: extra, form_decision: decision } : {}) });
  const md = markdown(head, summary, proj, extra, decision);
  writePrivate(dataPath("reports", tag, "summary.md"), md);
  process.stdout.write(md);
}
