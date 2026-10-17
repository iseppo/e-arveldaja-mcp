// checkReading (+ the full pipeline) over collected reader cases → results/<run>.json (plan §5.1, §5.7).
// Two passes: real (--today, default the run date) and as-of (truth.invoice_date + 30 days, from truth).
// Usage: npx tsx scripts/reading-p1/replay.ts --run <tag> [--scope corpus] [--today YYYY-MM-DD] [--pipeline]
// Scope (throughput round B8): "corpus" is the only scope; a reading of a document outside the corpus manifest is
// skipped before its packet, own ids or truth are read.

import { existsSync, readdirSync } from "node:fs";
import { normalizeVatValue } from "../../src/document-identifiers.js";
import { checkReading, type AcceptedValues, type CheckResult } from "../../src/document-reading-check.js";
import { normalizeInvoiceNumberForComparison } from "../../src/purchase-invoice-status.js";
import type { OwnIds, PacketFile } from "./build-packets.js";
import type { CollectedCase } from "./collect.js";
import { SCOPES, addDays, argValue, dataPath, hasFlag, readJson, scopeIds, todayIso, writeJson, type Scope, type SetName } from "./common.js";
import { runPipeline, type PipelineResult } from "./pipeline.js";
import { checkContext } from "./synth-proof.js";
import { companyOf, type TruthRecord } from "./truth.js";

export const SCORED_FIELDS = ["invoice_date", "invoice_number", "due_date", "supplier_reg", "supplier_vat", "supplier_iban", "currency", "net", "vat", "gross"] as const;
type ScoredField = typeof SCORED_FIELDS[number];

export interface PassResult {
  today: string;
  verdict: CheckResult["verdict"];
  holds: string[];
  content_holds: string[];
  notes: string[];
  silent_wrong: ScoredField[];
  pipeline?: PipelineResult & { verdict: "accept" | "hold"; silent_wrong_reverse_charge: boolean };
}

export interface CaseResult {
  case_id: string;
  reader: string;
  form: string;
  kind: string;
  doc_id: string | null;
  set: SetName | null;
  truth_available: boolean;
  reading_schema: string | null;
  proof_schema: string | null;
  leakage_pass: boolean;
  /** Reading fields that differ from truth (as read, before any check): the natural errors. */
  wrong_fields: ScoredField[];
  proof_problem_fields: string[];
  mutated_field?: string;
  passes: { real?: PassResult; as_of?: PassResult };
  usage: { input: number; cached_input: number; output: number; reasoning_output: number };
  models: string[];
}

/** The scored truth of a field: a printed due date (truth v2, B1) takes precedence over the booked one. */
function truthValue(field: ScoredField, truth: TruthRecord): unknown {
  if (field === "due_date" && truth.due_date_printed !== undefined) return truth.due_date_printed;
  return truth[field as keyof TruthRecord];
}

function differs(field: ScoredField, value: unknown, truth: TruthRecord): boolean {
  const expected = truthValue(field, truth);
  if (value === null || value === undefined) {
    // A null that changes the booking counts: VAT null books 0; net null books gross − VAT.
    if (field === "vat") return typeof expected === "number" && Math.abs(expected) > 0.005;
    return false;
  }
  if (expected === null || expected === undefined) return false;
  switch (field) {
    case "net":
    case "vat":
    case "gross":
      return typeof value !== "number" || Math.abs(value - Number(expected)) > 0.005;
    case "supplier_vat":
      return normalizeVatValue(String(value)) !== normalizeVatValue(String(expected));
    case "supplier_reg":
      return String(value).replace(/\s+/g, "") !== String(expected).replace(/\s+/g, "");
    case "supplier_iban":
      return String(value).replace(/\s+/g, "").toUpperCase() !== String(expected).replace(/\s+/g, "").toUpperCase();
    case "invoice_number":
      return normalizeInvoiceNumberForComparison(String(value)) !== normalizeInvoiceNumberForComparison(String(expected));
    default:
      return String(value) !== String(expected);
  }
}

/** Scored payload fields of a reading that differ from truth (truth-unscored fields skipped). */
export function wrongFields(values: Partial<Record<ScoredField, unknown>>, truth: TruthRecord | undefined): ScoredField[] {
  if (!truth || truth.status !== "available") return [];
  const unscored = new Set(truth.unscored_fields ?? []);
  const wrong: ScoredField[] = [];
  for (const field of SCORED_FIELDS) {
    if (unscored.has(field)) continue;
    if (field === "due_date" && (values.due_date === null || values.due_date === undefined)) continue;
    if (field === "net" && (values.net === null || values.net === undefined) && typeof values.gross === "number") {
      const derived = Math.round((values.gross - (typeof values.vat === "number" ? values.vat : 0)) * 100) / 100;
      if (differs("net", derived, truth)) wrong.push("net");
      continue;
    }
    if (differs(field, values[field], truth)) wrong.push(field);
  }
  return wrong;
}

/** B4: only a schema-valid reading has field values to score; schema failures are counted apart. */
export function caseWrongFields(collected: Pick<CollectedCase, "reading" | "reading_schema">, truth: TruthRecord | undefined): ScoredField[] {
  if (!collected.reading || collected.reading_schema !== "ok") return [];
  return wrongFields(collected.reading as Partial<Record<ScoredField, unknown>>, truth);
}

async function evaluatePass(collected: CollectedCase, file: PacketFile, own: OwnIds, truth: TruthRecord | undefined, today: string, pipeline: boolean): Promise<PassResult> {
  const result = checkReading(file.packet, collected.reading, collected.proof, checkContext(file, own, today));
  const pass: PassResult = {
    today,
    verdict: result.verdict,
    holds: result.holds.map((hold) => (hold.field ? `${hold.code}:${hold.field}` : hold.code)),
    content_holds: result.holds.filter((hold) => hold.class === "content").map((hold) => hold.code),
    notes: (result.notes ?? []).map((entry) => `${entry.code}:${entry.field}`),
    silent_wrong: result.verdict === "accept" && result.accepted ? wrongFields(result.accepted as AcceptedValues, truth) : [],
  };
  if (pipeline) {
    const full = await runPipeline({ accepted: result.accepted, check: result, file, truth, company: companyOf(own) });
    const accepted = full.status === "evaluated" && full.holds.length === 0;
    const rcWrong = accepted && truth?.status === "available" && truth.reverse_charge !== undefined &&
      (full.reversed_vat === true) !== (truth.reverse_charge === "applies");
    pass.pipeline = { ...full, verdict: accepted ? "accept" : "hold", silent_wrong_reverse_charge: rcWrong };
  }
  return pass;
}

export async function replayRun(tag: string, opts: { today: string; pipeline: boolean; scope: Scope }): Promise<CaseResult[]> {
  const ids = scopeIds(opts.scope);
  const results: CaseResult[] = [];
  const files = readdirSync(dataPath("readings")).filter((name) => name.endsWith(".json"));
  for (const name of files.sort()) {
    const collected = readJson<CollectedCase>(dataPath("readings", name));
    if (collected.meta?.run !== tag || !collected.doc_id || !ids.has(collected.doc_id)) continue;
    const set: SetName = opts.scope;
    const file = readJson<PacketFile>(dataPath("packets", `${collected.doc_id}.json`));
    const own = readJson<Record<string, OwnIds>>(dataPath(set, "own.json"))[collected.doc_id]!;
    const truthPath = dataPath(set, "truth.json");
    const truth = existsSync(truthPath) ? readJson<Record<string, TruthRecord>>(truthPath)[collected.doc_id] : undefined;
    const available = truth?.status === "available";
    const answers = ((collected.proof as { answers?: Record<string, { verdict?: string }> } | null)?.answers) ?? {};
    const usage = collected.turns.reduce((acc, turn) => ({
      input: acc.input + (turn.usage?.input ?? 0),
      cached_input: acc.cached_input + (turn.usage?.cached_input ?? 0),
      output: acc.output + (turn.usage?.output ?? 0),
      reasoning_output: acc.reasoning_output + (turn.usage?.reasoning_output ?? 0),
    }), { input: 0, cached_input: 0, output: 0, reasoning_output: 0 });
    const result: CaseResult = {
      case_id: collected.case_id,
      reader: collected.reader,
      form: collected.form,
      kind: collected.kind,
      doc_id: collected.doc_id,
      set,
      truth_available: available,
      reading_schema: collected.reading_schema,
      proof_schema: collected.proof_schema,
      leakage_pass: collected.leakage_pass,
      wrong_fields: caseWrongFields(collected, truth),
      proof_problem_fields: Object.entries(answers).filter(([, answer]) => answer?.verdict === "problem").map(([field]) => field),
      ...(typeof collected.meta?.mutated_field === "string" ? { mutated_field: collected.meta.mutated_field } : {}),
      passes: {},
      usage,
      models: [...new Set(collected.turns.map((turn) => turn.model).filter((model): model is string => model !== null))],
    };
    if (collected.leakage_pass && collected.reading !== null) {
      result.passes.real = await evaluatePass(collected, file, own, truth, opts.today, opts.pipeline);
      if (available && truth?.invoice_date) result.passes.as_of = await evaluatePass(collected, file, own, truth, addDays(truth.invoice_date, 30), opts.pipeline);
    }
    results.push(result);
  }
  writeJson(dataPath("results", `${tag}.json`), results);
  return results;
}

if (process.argv[1]?.endsWith("/replay.ts")) {
  const argv = process.argv.slice(2);
  const tag = argValue(argv, "--run");
  if (!tag) throw new Error("--run <tag> required");
  const scope = (argValue(argv, "--scope") ?? "corpus") as Scope;
  if (!SCOPES.includes(scope)) throw new Error(`--scope must be one of ${SCOPES.join(", ")}`);
  replayRun(tag, { today: argValue(argv, "--today") ?? todayIso(), pipeline: hasFlag(argv, "--pipeline"), scope })
    .then((results) => process.stdout.write(`replayed ${results.length} cases → results/${tag}.json\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
