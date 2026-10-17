// results/<run>.json → reports/<run>/{summary.md, summary.json} (plan §5.8), plus the token projection for the
// step-5 run sizes against the OQ-P1-9 ceiling (30M input / 4M output).
// Usage: npx tsx scripts/reading-p1/report.ts --run <tag> [--projection]

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { PARSER_VERSION, type PacketFile } from "./build-packets.js";
import { REPO_ROOT, argValue, dataPath, hasFlag, readJson, sha256Hex, writeJson, writePrivate } from "./common.js";
import { FORMS } from "./prompts.js";
import type { CaseResult, PassResult } from "./replay.js";

const CEILING = { input: 30_000_000, output: 4_000_000 };
const LEGACY_TOKENS = 200_000;
const PLAN_MAX_I_CASES = 240;
/** §2.5 proof / cross-check codes: a wrong field held by any OTHER code on that field was caught by a hard check. */
const PROOF_CODES = new Set(["proof_problem", "label_quote_missing", "label_quote_not_printed", "label_quote_no_letter", "label_quote_overlaps_value", "competitor_not_printed", "competitor_equals_value", "reading_heuristic_conflict"]);

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

function markdown(head: ReturnType<typeof header>, summary: ReturnType<typeof summarize>, proj?: ReturnType<typeof projection>): string {
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
  writeJson(dataPath("reports", tag, "summary.json"), { header: head, ...summary, ...(proj ? { projection: proj } : {}) });
  const md = markdown(head, summary, proj);
  writePrivate(dataPath("reports", tag, "summary.md"), md);
  process.stdout.write(md);
}
