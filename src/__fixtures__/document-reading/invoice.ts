// A synthetic clean invoice for the P1 checker tests (no corpus text) and a runner.
import { checkReading, type CheckContext, type CheckResult } from "../../document-reading-check.js";
import type { ReadingPacket } from "../../document-reading-packet.js";
import type { ReadingField } from "../../document-reading-schemas.js";
import { makePacket, type FixturePageMeta } from "./make-packet.js";
import { makeAnswer, makeProof, makeReading } from "./readings.js";

/** Column gaps are written as four spaces and become ` ¦ ` in the packet. */
export const BASE_LINES = [
  "Näidis OÜ    Arve nr A-17",          // p1:001
  "Reg. nr 10000018    KMKR EE100000007", // p1:002
  "Ostja: Ostja AS    Reg. nr 10000024",  // p1:003
  "Kuupäev 15.03.2026",                   // p1:004
  "Summa ilma KM-ta 100,00",              // p1:005
  "KM 24% 24,00",                         // p1:006
  "Kokku EUR 124,00",                     // p1:007
];

export const OWN = { reg: "10000024", vat: "EE100000010" };
export const TODAY = "2026-04-01";

export const BASE_VALUES: Record<string, unknown> = {
  doc_type: "invoice",
  invoice_date: "2026-03-15",
  invoice_number: "A-17",
  due_date: null,
  supplier_name: "Näidis OÜ",
  supplier_reg: "10000018",
  supplier_vat: "EE100000007",
  supplier_iban: null,
  buyer_name: "Ostja AS",
  buyer_reg: "10000024",
  buyer_vat: null,
  currency: "EUR",
  net: 100,
  vat: 24,
  gross: 124,
};

export const BASE_EVIDENCE: Record<string, { line: string; quote: string }> = {
  invoice_number: { line: "p1:001", quote: "Arve nr A-17" },
  supplier_name: { line: "p1:001", quote: "Näidis OÜ" },
  supplier_reg: { line: "p1:002", quote: "Reg. nr 10000018" },
  supplier_vat: { line: "p1:002", quote: "KMKR EE100000007" },
  buyer_name: { line: "p1:003", quote: "Ostja: Ostja AS" },
  buyer_reg: { line: "p1:003", quote: "Reg. nr 10000024" },
  invoice_date: { line: "p1:004", quote: "Kuupäev 15.03.2026" },
  net: { line: "p1:005", quote: "Summa ilma KM-ta 100,00" },
  vat: { line: "p1:006", quote: "KM 24% 24,00" },
  currency: { line: "p1:007", quote: "Kokku EUR 124,00" },
  gross: { line: "p1:007", quote: "Kokku EUR 124,00" },
};

/** Labels for the base proof (each is printed, has a letter and lies left of its value). */
export const BASE_LABELS: Partial<Record<ReadingField, string>> = {
  invoice_number: "Arve nr",
  invoice_date: "Kuupäev",
  supplier_reg: "Reg. nr",
  supplier_vat: "KMKR",
  gross: "Kokku",
};

export interface CaseInput {
  lines?: string[] | string[][];
  pageMeta?: FixturePageMeta | FixturePageMeta[];
  values?: Record<string, unknown>;
  evidence?: Record<string, { line: string; quote: string } | undefined>;
  extra?: Record<string, unknown>;
  answers?: Partial<Record<ReadingField, Record<string, unknown>>>;
  labels?: Partial<Record<ReadingField, string | null>>;
  ctx?: Partial<CheckContext>;
}

const noReverseCharge = () => false;

export function buildCase(input: CaseInput = {}): { packet: ReadingPacket; reading: Record<string, unknown>; proof: Record<string, unknown>; ctx: CheckContext } {
  const packet = makePacket(input.lines ?? BASE_LINES, input.pageMeta);
  const evidence = Object.fromEntries(
    Object.entries({ ...BASE_EVIDENCE, ...input.evidence }).filter(([, entry]) => entry !== undefined),
  );
  const reading = makeReading({
    ...BASE_VALUES,
    ...input.values,
    source_sha256: packet.source_sha256,
    packet_digest: packet.packet_digest,
    evidence,
    ...input.extra,
  });
  const labels = { ...BASE_LABELS, ...input.labels };
  const answers: Partial<Record<ReadingField, Record<string, unknown>>> = {};
  for (const [field, label] of Object.entries(labels)) {
    answers[field as ReadingField] = makeAnswer({ label_quote: label ?? null });
  }
  const proof = makeProof({ ...answers, ...input.answers }, {
    source_sha256: packet.source_sha256,
    packet_digest: packet.packet_digest,
  });
  const ctx: CheckContext = {
    today: TODAY,
    own: OWN,
    heuristic: { signals: [], confidence: "high", labelled: {} },
    isReverseChargeText: noReverseCharge,
    ...input.ctx,
  };
  return { packet, reading, proof, ctx };
}

export function runCase(input: CaseInput = {}): CheckResult {
  const { packet, reading, proof, ctx } = buildCase(input);
  return checkReading(packet, reading, proof, ctx);
}

export const holdCodes = (result: CheckResult) => result.holds.map((hold) => hold.code);
export const holdKeys = (result: CheckResult) => result.holds.map((hold) => (hold.field ? `${hold.code}:${hold.field}` : hold.code));
