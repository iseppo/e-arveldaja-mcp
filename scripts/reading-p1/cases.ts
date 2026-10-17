// Case builders shared by smoke.ts and pilot.ts: one CaseSpec per reader context (plan §5.2, §5.3).
// Case ids are random (`c-<12hex>`) and carry no case-type information; kind, form, field and run tag live only
// in the staging registry (`meta`), never in the staged directory.

import type { PacketFile } from "./build-packets.js";
import { dataPath, readJson } from "./common.js";
import type { AdmittedBase, Candidate, FamilyA } from "./mutate.js";
import { promptIS, promptIT, promptNS, promptNT1, type Form } from "./prompts.js";
import { newCaseId, schemasFor } from "./run-cases.js";
import type { CaseSpec, Reader } from "./stage.js";

export const READERS: readonly Reader[] = ["opus", "haiku", "codex"];

export interface CaseItem { spec: CaseSpec; packet?: PacketFile["packet"]; turn2Text?: string }

export function loadPacketFile(docId: string): PacketFile {
  return readJson<PacketFile>(dataPath("packets", `${docId}.json`));
}

export function loadFamilyA(): FamilyA {
  return readJson<FamilyA>(dataPath("mutations", "a.json"));
}

/** The base reading with one field replaced by a printed competitor, with its true line and quote. */
export function mutatedReading(base: AdmittedBase, candidate: Candidate): Record<string, unknown> {
  const reading = JSON.parse(JSON.stringify(base.reading)) as Record<string, unknown> & { evidence: Record<string, unknown> };
  reading[candidate.field] = candidate.value;
  reading.evidence[candidate.field] = { line: candidate.line, quote: candidate.quote };
  return reading;
}

/** N-S or N-T case: the reader reads the packet itself. */
export function naturalCase(reader: Reader, form: "N-S" | "N-T", docId: string, run: string): CaseItem {
  const file = loadPacketFile(docId);
  const prompt = form === "N-S" ? promptNS(file.packet) : promptNT1(file.packet);
  return {
    spec: { case_id: newCaseId(), reader, form, kind: "natural", doc_id: docId, turns: form === "N-T" ? 2 : 1, prompt, schemas: schemasFor(reader, form), meta: { run } },
    packet: file.packet,
  };
}

/** I-S or I-T case: a clean base (candidate null) or a family-(a) mutation of it. */
export function injectedCase(reader: Reader, form: "I-S" | "I-T", base: AdmittedBase, candidate: Candidate | null, run: string): CaseItem {
  const file = loadPacketFile(base.doc_id);
  const reading = candidate ? mutatedReading(base, candidate) : base.reading;
  const prompt = form === "I-S" ? promptIS(file.packet, reading) : promptIT(file.packet, reading);
  const meta: Record<string, unknown> = { run, reading_input: reading, family: "a" };
  if (candidate) Object.assign(meta, { mutated_field: candidate.field, field_type: candidate.field_type, ...(candidate.direction ? { direction: candidate.direction } : {}) });
  return {
    spec: { case_id: newCaseId(), reader, form, kind: candidate ? "mutated" : "clean", doc_id: base.doc_id, turns: 1, prompt, schemas: schemasFor(reader, form), meta },
  };
}

export function formCase(reader: Reader, form: Form, docId: string, base: AdmittedBase | undefined, candidate: Candidate | null, run: string): CaseItem {
  if (form === "N-S" || form === "N-T") return naturalCase(reader, form, docId, run);
  if (!base) throw new Error(`no admitted base for ${docId}`);
  return injectedCase(reader, form, base, candidate, run);
}
