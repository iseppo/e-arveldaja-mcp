// Mutation family (a), exhaustive before sampling (plan §5.4, Codex-9): for each accepted field of an
// admitted base, every other printed value of the same type, with its true line and quote. The hard checks
// run on ALL candidates (each with a regenerated synthetic proof); the survivors are sampled per OQ-P1-3
// (at most 4 per field type per document, at most 120 per reader, seed 17). The sampled survivors become
// the mutated I-cases, each paired 1:1 with a clean case (the unmodified base).
//
// Usage: npx tsx scripts/reading-p1/mutate.ts --family a [--set corpus]   → mutations/a.json
// Families (c)–(k) are deterministic corpus patches without readers; they are step-5 work.

import { checkReading } from "../../src/document-reading-check.js";
import type { ReadingPacket } from "../../src/document-reading-packet.js";
import type { EvidenceField } from "../../src/document-reading-schemas.js";
import { ibanScan, identifierScan, lineCells, lineTokens } from "../../src/document-reading-tokens.js";
import type { OwnIds, PacketFile } from "./build-packets.js";
import { readdirSync } from "node:fs";
import type { CollectedCase } from "./collect.js";
import { addDays, argValue, dataPath, readJson, writeJson, type SetName } from "./common.js";
import { admitBase, checkContext, FIELD_KIND, synthesizeProof, truthDerivedReading } from "./synth-proof.js";
import type { TruthRecord } from "./truth.js";

type FieldType = "date" | "amount" | "id" | "number" | "name" | "iban" | "currency";

const FIELD_TYPE: Record<EvidenceField, FieldType> = {
  invoice_date: "date", due_date: "date",
  net: "amount", vat: "amount", gross: "amount",
  supplier_reg: "id", supplier_vat: "id", buyer_reg: "id", buyer_vat: "id",
  invoice_number: "number",
  supplier_name: "name", buyer_name: "name",
  supplier_iban: "iban",
  currency: "currency",
};

export interface Candidate {
  doc_id: string;
  field: EvidenceField;
  field_type: FieldType;
  value: string | number;
  line: string;
  quote: string;
  direction?: "larger" | "smaller";
}

export interface EvaluatedCandidate extends Candidate { held: boolean; codes: string[] }

const cellQuote = (text: string, start: number, end: number) => {
  const cell = lineCells(text).find((candidate) => start >= candidate.start && end <= candidate.end);
  const quote = cell ? cell.text.trim() : text.slice(start, end);
  return quote.length <= 200 ? quote : text.slice(start, end);
};

/**
 * Every other printed value of the field's type (exhaustive). `equivalent` values are equally correct readings
 * (B3: the supplier's other printed accounts), not errors, so they are no candidates.
 */
export function candidatesFor(docId: string, packet: ReadingPacket, field: EvidenceField, baseValue: string | number, equivalent: ReadonlyArray<string | number> = []): Candidate[] {
  const type = FIELD_TYPE[field];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (value: string | number, line: string, quote: string) => {
    if (value === baseValue || (typeof value === "number" && typeof baseValue === "number" && Math.abs(value - baseValue) <= 0.005)) return;
    if (equivalent.includes(value)) return;
    if (quote.length === 0 || quote.length > 200) return;
    const key = `${value}\u0000${line}\u0000${quote}`;
    if (seen.has(key)) return;
    seen.add(key);
    const candidate: Candidate = { doc_id: docId, field, field_type: type, value, line, quote };
    if (type === "amount" && typeof value === "number" && typeof baseValue === "number") candidate.direction = value > baseValue ? "larger" : "smaller";
    out.push(candidate);
  };
  if (type === "id") {
    const kind = FIELD_KIND[field];
    const hits = [...identifierScan(packet.lines, "accounting"), ...identifierScan(packet.lines, "strict")];
    for (const hit of hits) {
      if (kind === "reg" ? hit.kind !== "ee_reg" : hit.kind === "ee_reg") continue;
      const text = packet.lines.find((line) => line.id === hit.line)!.text;
      for (const value of hit.values) add(value, hit.line, cellQuote(text, hit.start, hit.end));
    }
    return out;
  }
  if (type === "iban") {
    for (const hit of ibanScan(packet.lines)) add(hit.value, hit.line, cellQuote(packet.lines.find((line) => line.id === hit.line)!.text, hit.start, hit.end));
    return out;
  }
  for (const line of packet.lines) {
    const tokens = lineTokens(line);
    if (type === "date") {
      for (const token of tokens.dates) for (const value of token.values) add(value, line.id, cellQuote(line.text, token.start, token.end));
    } else if (type === "amount") {
      for (const token of tokens.money) for (const value of token.values) if (value > 0 || field !== "gross") add(value, line.id, cellQuote(line.text, token.start, token.end));
    } else if (type === "number") {
      for (const token of tokens.wordTokens) add(token.text, line.id, cellQuote(line.text, token.start, token.end));
      for (const cell of tokens.cells) {
        const words = tokens.wordTokens.filter((token) => token.cell === cell.index);
        for (let size = 2; size <= 3; size++) {
          for (let at = 0; at + size <= words.length; at++) {
            const run = line.text.slice(words[at]!.start, words[at + size - 1]!.end);
            add(run, line.id, cellQuote(line.text, words[at]!.start, words[at + size - 1]!.end));
          }
        }
      }
    } else if (type === "name") {
      for (const cell of tokens.cells) {
        const text = cell.text.trim();
        const runs = [text, ...text.split(/[,;|:]\s/).map((part) => part.trim())];
        for (const run of runs) if ((run.match(/\p{L}/gu) ?? []).length >= 2 && run.length <= 200) add(run, line.id, text);
      }
    } else if (type === "currency") {
      for (const token of tokens.wordTokens) if (/^[A-Z]{3}$/.test(token.text)) add(token.text, line.id, cellQuote(line.text, token.start, token.end));
    }
  }
  return out;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

export interface AdmittedBase { doc_id: string; reading: Record<string, unknown>; sources: Record<string, string>; source?: "opus_nt" | "truth_derived" }

const PAYLOAD_FIELDS = ["supplier_reg", "supplier_vat", "invoice_number", "invoice_date", "due_date", "currency", "net", "vat", "gross", "supplier_iban"] as const;

/**
 * §5.5 first base source: the step-5 opus N-T clean reading of the document, only if it equals truth on every
 * payload field. Truth here is the truth-derived reading (the printed truth values, with unprinted ids/IBAN,
 * VAT 0 and an unlabelled due date as null), so a null is equal only where that reading is null too.
 */
function opusBase(docId: string, derived: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!derived) return undefined;
  const readings = readdirSync(dataPath("readings")).filter((name) => name.endsWith(".json")).map((name) => readJson<CollectedCase>(dataPath("readings", name)))
    .filter((entry) => entry.meta?.run === "step5" && entry.reader === "opus" && entry.form === "N-T" && entry.doc_id === docId && entry.leakage_pass && entry.reading_schema === "ok");
  const reading = readings[0]?.reading as Record<string, unknown> | undefined;
  if (!reading) return undefined;
  const same = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 0.005 : String(a ?? "") === String(b ?? ""));
  return PAYLOAD_FIELDS.every((field) => same(reading[field], derived[field])) ? reading : undefined;
}

export interface FamilyA {
  family: "a";
  seed: number;
  bases: { admitted: string[]; excluded: Array<{ doc_id: string; reason: string }> };
  candidates: number;
  held_by_hard_checks: number;
  survivors: number;
  by_field_type: Record<string, { candidates: number; held: number; survivors: number }>;
  amounts_by_direction: Record<string, { candidates: number; held: number }>;
  sampled: Candidate[];
  admitted_bases: AdmittedBase[];
}

function familyA(set: SetName): FamilyA {
  const truth = readJson<Record<string, TruthRecord>>(dataPath(set, "truth.json"));
  const own = readJson<Record<string, OwnIds>>(dataPath(set, "own.json"));
  const admitted: AdmittedBase[] = [];
  const excluded: Array<{ doc_id: string; reason: string }> = [];
  const evaluated: EvaluatedCandidate[] = [];
  for (const [docId, record] of Object.entries(truth).sort(([a], [b]) => a.localeCompare(b))) {
    if (record.status !== "available") {
      excluded.push({ doc_id: docId, reason: `truth_unavailable:${record.reason}` });
      continue;
    }
    const file = readJson<PacketFile>(dataPath("packets", `${docId}.json`));
    const ownIds = own[docId]!;
    const asOf = addDays(record.invoice_date!, 30);
    const derived = truthDerivedReading(file, record, ownIds);
    const opus = opusBase(docId, derived.dropped === undefined ? derived.reading : undefined);
    const base = opus ? { reading: opus as typeof derived.reading, sources: {} } : derived;
    const admission = admitBase(file, base, ownIds, asOf);
    if (!admission.admitted) {
      excluded.push({ doc_id: docId, reason: base.dropped ?? `held:${admission.result.holds.map((hold) => hold.code).join(",")}` });
      continue;
    }
    admitted.push({ doc_id: docId, reading: base.reading, sources: base.sources as Record<string, string>, source: opus ? "opus_nt" : "truth_derived" });
    const ctx = checkContext(file, ownIds, asOf);
    for (const field of Object.keys(FIELD_TYPE) as EvidenceField[]) {
      const baseValue = base.reading[field];
      if (baseValue === null || baseValue === undefined) continue;
      const equivalent = field === "supplier_iban" ? record.supplier_ibans_printed ?? [] : [];
      for (const candidate of candidatesFor(docId, file.packet, field, baseValue as string | number, equivalent)) {
        const mutated = JSON.parse(JSON.stringify(base.reading)) as typeof base.reading;
        mutated[field] = candidate.value;
        mutated.evidence[field] = { line: candidate.line, quote: candidate.quote };
        const result = checkReading(file.packet, mutated, synthesizeProof(file.packet, mutated), ctx);
        evaluated.push({ ...candidate, held: result.verdict === "hold", codes: result.holds.map((hold) => hold.code) });
      }
    }
  }
  const survivors = evaluated.filter((candidate) => !candidate.held);
  const random = rng(17);
  const perDocType = new Map<string, number>();
  const sampled: Candidate[] = [];
  for (const candidate of shuffle(survivors, random)) {
    const key = `${candidate.doc_id}:${candidate.field_type}`;
    if ((perDocType.get(key) ?? 0) >= 4) continue;
    if (sampled.length >= 120) break;
    perDocType.set(key, (perDocType.get(key) ?? 0) + 1);
    const { held: _held, codes: _codes, ...plain } = candidate as EvaluatedCandidate;
    sampled.push(plain);
  }
  const byType: FamilyA["by_field_type"] = {};
  const byDirection: FamilyA["amounts_by_direction"] = {};
  for (const candidate of evaluated) {
    const entry = (byType[candidate.field_type] ??= { candidates: 0, held: 0, survivors: 0 });
    entry.candidates += 1;
    if (candidate.held) entry.held += 1;
    else entry.survivors += 1;
    if (candidate.direction) {
      const direction = (byDirection[candidate.direction] ??= { candidates: 0, held: 0 });
      direction.candidates += 1;
      if (candidate.held) direction.held += 1;
    }
  }
  return {
    family: "a",
    seed: 17,
    bases: { admitted: admitted.map((base) => base.doc_id), excluded },
    candidates: evaluated.length,
    held_by_hard_checks: evaluated.length - survivors.length,
    survivors: survivors.length,
    by_field_type: byType,
    amounts_by_direction: byDirection,
    sampled,
    admitted_bases: admitted,
  };
}

if (process.argv[1]?.endsWith("/mutate.ts")) {
  const argv = process.argv.slice(2);
  const family = argValue(argv, "--family") ?? "a";
  const set = (argValue(argv, "--set") ?? "corpus") as SetName;
  if (set !== "corpus") {
    // Family (a) is corpus-only (throughput round B8): no held-out truth, own ids or packet is read here.
    process.stderr.write("mutate.ts: family (a) is built from the corpus only\n");
    process.exitCode = 2;
  } else if (family !== "a") {
    process.stderr.write(`family ${family}: not implemented in step 4 (families (c)-(k) are step-5 corpus patches)\n`);
    process.exitCode = 2;
  } else {
    const result = familyA(set);
    writeJson(dataPath("mutations", "a.json"), result);
    const { sampled, admitted_bases: _bases, ...summary } = result;
    process.stdout.write(`${JSON.stringify({ ...summary, sampled: sampled.length }, null, 2)}\n`);
  }
}
