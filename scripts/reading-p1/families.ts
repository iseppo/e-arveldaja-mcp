// Mutation families (c)–(k) on admitted corpus bases (plan §5.4, §5.5): deterministic text patches, reading
// edits, injected clients and snapshot edits. No reader runs.
//
// Rebinding (critic r2 m6): the patch is applied to the page text (packet lines, ` ¦ ` written back as a
// column gap), the packet is rebuilt with buildReadingPacket, every evidence line id is remapped by content
// (equal text, nearest position; else `rebind_failed` unless the case re-cites the field), source_sha256 and
// packet_digest are re-stamped, and the synthetic proof is regenerated for the reading actually evaluated.
// The rebuilt page carries its whole text as one native item: the admitted bases are native-text documents.
//
// Pass rule: every expected code is newly present (present in the case, absent from the rebuilt base); a
// residual pass requires accept; an `absent` case requires none of its codes newly present. A case held only
// by other codes is reported as `held_other` (no false create, but not the expected code).
// Usage: npx tsx scripts/reading-p1/families.ts [--as-of]   → mutations/families.json

import { buildReadingPacket, type ReadingPacket } from "../../src/document-reading-packet.js";
import { checkReading, CREDIT_WORDS, type CheckContext, type CheckResult } from "../../src/document-reading-check.js";
import type { EvidenceField } from "../../src/document-reading-schemas.js";
import type { Client, Journal, PurchaseInvoice } from "../../src/types/api.js";
import { PARSER_VERSION, type OwnIds, type PacketFile } from "./build-packets.js";
import { addDays, dataPath, readJson, sha256Hex, writeJson } from "./common.js";
import type { AdmittedBase, FamilyA } from "./mutate.js";
import { loadSnapshot, runPipeline, type Snapshot } from "./pipeline.js";
import type { BookingView } from "../../src/document-reading-binding.js";
import { checkContext, synthesizeProof } from "./synth-proof.js";
import { companyOf, type TruthRecord } from "./truth.js";

type Lines = Array<{ page: number; text: string }>;
type Reading = Record<string, unknown> & { evidence: Record<string, { line: string; quote: string } | undefined> };

interface Edit {
  /** Value change and/or a re-citation: the evidence line is the first patched line containing `on`. */
  set?: Array<{ field: EvidenceField | "doc_type"; value: unknown; on?: string; quote?: string }>;
}

export interface FamilyCase {
  family: "c" | "d'" | "e" | "f" | "g" | "h" | "i" | "j" | "k";
  name: string;
  doc: string;
  patch?: (lines: Lines) => void;
  edit?: Edit;
  ctx?: (ctx: CheckContext) => CheckContext;
  pipeline?: { snapshot?: (snapshot: Snapshot, base: Snapshot, truth: TruthRecord) => Snapshot; clientsUnavailable?: boolean; booking?: (booking: BookingView) => BookingView };
  expect: { hold_new: string[]; any?: boolean } | { residual_pass: string } | { absent: string[] };
}

// ---------------------------------------------------------------------------
// Patch helpers
// ---------------------------------------------------------------------------

const find = (lines: Lines, needle: string) => {
  const index = lines.findIndex((line) => line.text.includes(needle));
  if (index < 0) throw new Error(`patch: no line contains ${JSON.stringify(needle)}`);
  return index;
};
const replace = (needle: string, to: string) => (lines: Lines) => {
  const index = find(lines, needle);
  lines[index] = { ...lines[index]!, text: lines[index]!.text.replace(needle, to) };
};
const replaceAll = (pairs: Array<[string, string]>) => (lines: Lines) => {
  for (const [from, to] of pairs) for (const line of lines) line.text = line.text.split(from).join(to);
};
const insertAfter = (needle: string, texts: string[]) => (lines: Lines) => {
  const index = find(lines, needle);
  lines.splice(index + 1, 0, ...texts.map((text) => ({ page: lines[index]!.page, text })));
};
const insertBefore = (needle: string, texts: string[]) => (lines: Lines) => {
  const index = find(lines, needle);
  lines.splice(index, 0, ...texts.map((text) => ({ page: lines[index]!.page, text })));
};
const append = (texts: string[]) => (lines: Lines) => {
  const page = lines[lines.length - 1]!.page;
  lines.push(...texts.map((text) => ({ page, text })));
};
const removeLine = (needle: string) => (lines: Lines) => {
  lines.splice(find(lines, needle), 1);
};
const splitLine = (needle: string, parts: string[]) => (lines: Lines) => {
  const index = find(lines, needle);
  lines.splice(index, 1, ...parts.map((text) => ({ page: lines[index]!.page, text })));
};
const chain = (...patches: Array<(lines: Lines) => void>) => (lines: Lines) => patches.forEach((patch) => patch(lines));
const titleCase = (text: string) => text.replace(/(^|\s)(\p{L})/gu, (_m, space: string, letter: string) => `${space}${letter.toUpperCase()}`);

// ---------------------------------------------------------------------------
// Cases. Bases: 06 (Next Interaction, EUR trio, no IBAN), 15 (Tech Tatami, dot decimals, IBAN), 17 (Arvutitark).
// ---------------------------------------------------------------------------

const RC_LINE = "Pöördmaksustamine: käibemaksu tasub ostja";
/** A gross-only document: the net and VAT lines removed (the heuristic's labelled net/VAT go with them). */
const GROSS_ONLY_DOC = chain(removeLine("Netosumma"), removeLine("Käibemaks (24.00%)"));
const GROSS_ONLY_READING: Edit = { set: [{ field: "vat", value: null }, { field: "net", value: null }, { field: "currency", value: "EUR", on: "Kokku: €15.00", quote: "€" }] };
const withoutLabelled = (fields: string[]) => (ctx: CheckContext): CheckContext => ({
  ...ctx,
  heuristic: { ...ctx.heuristic, labelled: Object.fromEntries(Object.entries(ctx.heuristic.labelled).filter(([field]) => !fields.includes(field))) },
});
/** Re-cites fields whose evidence line a patch rewrote: [field, line substring, quote]. */
const recite = (entries: Array<[EvidenceField, string, string]>): Edit => ({
  set: entries.map(([field, on, quote]) => ({ field, value: KEEP, on, quote })),
});
const KEEP = Symbol("keep");
const CONTRACT = ["Lepingu maksumus 1000,00", "Lepingu KM 240,00", "Lepingu kokku 1240,00"];

export function familyCases(): FamilyCase[] {
  const cases: FamilyCase[] = [
    // (c) token boundaries and ambiguity
    { family: "c", name: "id_superstring", doc: "06", patch: replace("Registrikood: 14100426", "Registrikood: 141004261"),
      edit: { set: [{ field: "supplier_reg", value: "14100426", on: "141004261", quote: "14100426" }] }, expect: { hold_new: ["value_not_complete_token"] } },
    { family: "c", name: "vat_letter_glued_before", doc: "06", patch: replace("KMKR: EE102505584", "KMKR: XEE102505584"),
      edit: { set: [{ field: "supplier_vat", value: "EE102505584", on: "XEE102505584", quote: "EE102505584" }] }, expect: { hold_new: ["value_not_complete_token"] } },
    { family: "c", name: "vat_letter_glued_after", doc: "06", patch: replace("KMKR: EE102505584", "KMKR: EE102505584A"),
      edit: { set: [{ field: "supplier_vat", value: "EE102505584", on: "EE102505584A", quote: "EE102505584" }] }, expect: { hold_new: ["value_not_complete_token"] } },
    { family: "c", name: "number_cut_at_delimiter", doc: "06",
      edit: { set: [{ field: "invoice_number", value: "JT-2026", on: "Arve JT-2026-000017", quote: "JT-2026" }] }, expect: { hold_new: ["value_not_complete_token"] } },
    { family: "c", name: "number_INV_2024_cut", doc: "06", patch: replace("Arve JT-2026-000017", "Arve INV 2024 001"),
      edit: { set: [{ field: "invoice_number", value: "INV 2024", on: "Arve INV 2024 001", quote: "INV 2024" }] }, expect: { hold_new: ["value_not_complete_token"] } },
    { family: "c", name: "amount_6,000_style", doc: "06", patch: replace("Kokku: €15.00", "Kokku: €15,000"),
      edit: { set: [{ field: "gross", value: 15, on: "Kokku: €15,000", quote: "€15,000" }] }, expect: { hold_new: ["ambiguous_amount_token"] } },
    { family: "c", name: "slash_date", doc: "15", patch: replace("09.08.2026", "09/08/2026"),
      edit: { set: [{ field: "invoice_date", value: "2026-08-09", on: "09/08/2026", quote: "09/08/2026" }] }, expect: { hold_new: ["ambiguous_slash_date"] } },
    { family: "c", name: "date_split_over_two_lines", doc: "15", patch: splitLine("Kuupäev: ¦ 09.08.2026", ["Kuupäev: ¦ 09.08.", "2026"]),
      edit: { set: [{ field: "invoice_date", value: "2026-08-09", on: "Kuupäev: ¦ 09.08.", quote: "09.08." }] }, expect: { hold_new: ["value_not_complete_token"] } },
    { family: "c", name: "quantity_joined_in_cell", doc: "15", patch: replace("ettevalmistamine ¦ 1 ¦ 350.00", "ettevalmistamine ¦ 1 350.00"),
      edit: { set: [{ field: "net", value: 1350, on: "ettevalmistamine ¦ 1 350.00", quote: "1 350.00" }, { field: "vat", value: 84, on: "ettevalmistamine ¦ 1 350.00", quote: "84.00" }] },
      expect: { hold_new: ["ambiguous_amount_token"] } },
    { family: "c", name: "whole_cell_1_350,00", doc: "15", patch: replace("kokku: ¦ 350.00", "kokku: ¦ 1 350,00"),
      edit: { set: [{ field: "net", value: 1350, on: "kokku: ¦ 1 350,00", quote: "1 350,00" }] }, expect: { hold_new: ["ambiguous_amount_token"] } },

    // (d′) currency
    { family: "d'", name: "kr_only", doc: "06", patch: replaceAll([["€12.10", "12.10 kr"], ["€2.90", "2.90 kr"], ["€15.00", "15.00 kr"]]),
      edit: recite([["net", "Netosumma", "12.10"], ["vat", "Käibemaks", "2.90"], ["gross", "Kokku", "15.00"], ["currency", "Kokku", "kr"]]), expect: { hold_new: ["currency_not_stated"] } },
    { family: "d'", name: "zloty_only", doc: "06", patch: replaceAll([["€12.10", "12.10 zł"], ["€2.90", "2.90 zł"], ["€15.00", "15.00 zł"]]),
      edit: recite([["net", "Netosumma", "12.10"], ["vat", "Käibemaks", "2.90"], ["gross", "Kokku", "15.00"], ["currency", "Kokku", "zł"]]), expect: { hold_new: ["currency_not_stated"] } },
    { family: "d'", name: "moms_25_trio", doc: "06", patch: append(["Belopp exkl. moms ¦ 12,00", "Moms 25% ¦ 3,00", "Att betala ¦ 15,00"]),
      expect: { hold_new: ["foreign_rate_trio"] } },
    { family: "d'", name: "every_eur_token_removed", doc: "06", patch: replaceAll([["€", ""]]),
      edit: recite([["net", "Netosumma", "12.10"], ["vat", "Käibemaks", "2.90"], ["gross", "Kokku", "15.00"], ["currency", "Kokku", "Kokku: 15.00"]]), expect: { hold_new: ["currency_not_stated"] } },

    // (e) signs and credit words
    { family: "e", name: "discount_minus", doc: "15", patch: insertAfter("Riigihankepakkumuse", ["Allahindlus -26,00"]), expect: { hold_new: ["signed_amount_present"] } },
    { family: "e", name: "discount_en_dash", doc: "15", patch: insertAfter("Riigihankepakkumuse", ["Allahindlus – 26,00"]), expect: { hold_new: ["signed_amount_present"] } },
    { family: "e", name: "discount_parentheses", doc: "15", patch: insertAfter("Riigihankepakkumuse", ["Allahindlus (26,00)"]), expect: { hold_new: ["signed_amount_present"] } },
    { family: "e", name: "discount_trailing_minus", doc: "15", patch: insertAfter("Riigihankepakkumuse", ["Allahindlus 26,00-"]), expect: { hold_new: ["signed_amount_present"] } },
    { family: "e", name: "negative_non-refundable", doc: "06", patch: append(["This ticket is non-refundable"]), expect: { absent: ["credit_word_present"] } },
    { family: "e", name: "negative_kreeditarvele", doc: "06", patch: append(["Vea korral viidake kreeditarvele"]), expect: { absent: ["credit_word_present"] } },

    // (f) trios and rates
    { family: "f", name: "line_item_trio", doc: "06", patch: insertAfter("Kirjeldus", ["Teenus ¦ 10,00 ¦ 2,40 ¦ 12,40"]), expect: { hold_new: ["competing_consistent_total"] } },
    { family: "f", name: "contract_trio_above", doc: "06", patch: insertBefore("Netosumma", CONTRACT), expect: { hold_new: ["competing_consistent_total"] } },
    { family: "f", name: "contract_trio_below", doc: "06", patch: append(CONTRACT), expect: { hold_new: ["competing_consistent_total"] } },
    { family: "f", name: "rates_9_and_24", doc: "06", patch: insertAfter("Käibemaks (24.00%)", ["Käibemaks (9.00%): €0.90"]), expect: { hold_new: ["mixed_vat_rate"] } },
    { family: "f", name: "rates_10_and_20", doc: "06", patch: append(["KM 10% ¦ 1,00", "KM 20% ¦ 2,00"]), expect: { hold_new: ["mixed_vat_rate"] } },
    { family: "f", name: "header_layout_10_20", doc: "06", patch: append(["KM 10% ¦ KM 20%", "1,00 ¦ 2,00", "Kokku EUR 20,00"]), expect: { hold_new: ["mixed_vat_rate"] } },
    { family: "f", name: "vertical_trio_block", doc: "06", patch: append(["Summa", "100,00", "KM 24%", "24,00", "Kokku", "124,00"]), expect: { hold_new: ["competing_consistent_total"] } },
    { family: "f", name: "negative_small_genuine_trio", doc: "06", patch: append(["Pakkimine ¦ 2,02 ¦ 0,48 ¦ 2,50"]), expect: { absent: ["mixed_vat_rate", "foreign_rate_trio"] } },

    // (g) buyer and third parties
    { family: "g", name: "null_buyer", doc: "06", edit: { set: [{ field: "buyer_vat", value: null }, { field: "buyer_name", value: null }] }, expect: { hold_new: ["buyer_id_missing"] } },
    { family: "g", name: "projektpartner_reg", doc: "06", patch: append(["Projektpartner: Näidis OÜ ¦ 10000018"]), expect: { hold_new: ["unaccounted_identifier"] } },
    { family: "g", name: "projektpartner_grouped_vat", doc: "06", patch: append(["Projektpartner: Näidis OÜ ¦ EE 100 000 007"]), expect: { hold_new: ["unaccounted_identifier"] } },
    { family: "g", name: "name_only_third_party", doc: "06", patch: append(["Projektpartner: Näidis OÜ"]), expect: { residual_pass: "name-only third party" } },
    { family: "g", name: "own_unavailable", doc: "06", ctx: (ctx) => ({ ...ctx, own: "unavailable" }), expect: { hold_new: ["own_identity_unavailable"] } },
    { family: "g", name: "iban_bic_lines", doc: "06", patch: append(["IBAN: EE781010220221194222 ¦ BIC: EEUHEE2X"]), expect: { residual_pass: "IBAN/BIC lines" } },
    { family: "g", name: "codex_r4_m2_receipt_third_party_reg_as_number", doc: "06", patch: append(["Partner reg 10000018"]),
      edit: { set: [{ field: "doc_type", value: "receipt" }, { field: "buyer_vat", value: null }, { field: "buyer_name", value: null }, { field: "invoice_number", value: "10000018", on: "Partner reg 10000018", quote: "10000018" }] },
      expect: { hold_new: ["invoice_number_is_identifier"] } },

    // (h) injected clients (full pipeline)
    { family: "h", name: "clients_mixed_ids", doc: "06", pipeline: { snapshot: (s) => ({ ...s, clients: s.clients.map((c) => (c.code === "14100426" ? { ...c, invoice_vat_no: "EE100000007" } : c)) }) },
      expect: { hold_new: ["supplier_id_contradiction"] } },
    { family: "h", name: "clients_no_ids", doc: "06", pipeline: { snapshot: (s) => ({ ...s, clients: s.clients.map((c) => (c.code === "14100426" ? { ...c, code: null, invoice_vat_no: null } as unknown as Client : c)) }) },
      expect: { hold_new: ["supplier_not_client"] } },
    { family: "h", name: "clients_unavailable", doc: "06", pipeline: { clientsUnavailable: true }, expect: { hold_new: ["clients_unavailable"] } },
    { family: "h", name: "clients_two_candidates", doc: "06", pipeline: { snapshot: (s) => {
      const match = s.clients.find((c) => c.code === "14100426");
      return match ? { ...s, clients: [...s.clients, { ...match, id: 999_000_001 }] } : s;
    } }, expect: { hold_new: ["supplier_ambiguous"] } },

    // (i) snapshot duplicates (full pipeline): the own booking re-added in altered form
    { family: "i", name: "same_supplier_same_number", doc: "06", pipeline: { snapshot: (s, base, truth) => withInvoice(s, base, truth, (inv) => ({ ...inv, id: 999_000_011 })) },
      expect: { hold_new: ["duplicate_supplier_number"] } },
    { family: "i", name: "other_supplier_same_number", doc: "06", pipeline: { snapshot: (s, base, truth) => withInvoice(s, base, truth, (inv) => ({ ...inv, id: 999_000_012, clients_id: otherClientId(s, inv.clients_id) })) },
      expect: { hold_new: ["duplicate_number_any_supplier"] } },
    { family: "i", name: "journal_ETR1_number", doc: "06", pipeline: { snapshot: (s) => withJournal(s, "ETR1:JT-2026-000017") }, expect: { hold_new: ["journal_reference_hit"] } },
    { family: "i", name: "reissue_new_number", doc: "06", pipeline: { snapshot: (s, base, truth) => withInvoice(s, base, truth, (inv) => ({
      ...inv, id: 999_000_013, number: "JT-2026-000018", gross_price: Math.round(((inv.gross_price ?? 0) + 0.02) * 100) / 100, create_date: addDays(inv.create_date, 5),
    })) }, expect: { hold_new: ["duplicate_same_amount_date"] } },
    { family: "i", name: "voided_same_number", doc: "06", pipeline: { snapshot: (s, base, truth) => withInvoice(s, base, truth, (inv) => ({ ...inv, id: 999_000_014, status: "INVALIDATED" })) },
      expect: { hold_new: ["duplicate_voided_candidate"] } },

    // (j) VAT and reverse charge (full pipeline)
    { family: "j", name: "non_vat_item_gross_differs", doc: "06", pipeline: {
      snapshot: (s) => ({ ...s, vatRegistered: false }),
      booking: (b) => ({ ...b, effective: { ...b.effective, itemGross: b.effective.itemGross + 1 } }),
    }, expect: { hold_new: ["booking_field_mismatch"] } },
    { family: "j", name: "null_vat_with_deductible_item", doc: "06", patch: GROSS_ONLY_DOC, edit: GROSS_ONLY_READING, ctx: withoutLabelled(["net", "vat"]),
      pipeline: { booking: (b) => ({ ...b, items: b.items.map((item) => ({ ...item, vat_rate_dropdown: "24" })) }) }, expect: { hold_new: ["booking_field_mismatch"] } },
    { family: "j", name: "reverse_charge_with_vat", doc: "06", patch: append([RC_LINE]), expect: { hold_new: ["reading_reverse_charge_unverified"] } },
    { family: "j", name: "converse_rc_note_unbooked", doc: "06", patch: append([RC_LINE]),
      pipeline: { booking: (b) => ({ ...b, items: b.items.map((item) => ({ ...item, reversed_vat_id: null })) }) }, expect: { hold_new: ["reading_reverse_charge_unbooked"] } },
    ...(["USA", null] as const).flatMap((country): FamilyCase[] => {
      const recountry = (s: Snapshot) => ({ ...s, clients: s.clients.map((c) => (c.code === "14100426" ? { ...c, cl_code_country: country } as unknown as Client : c)) });
      return [
        { family: "j", name: `foreign_${country ?? "null"}_gross_only_rc_skipped`, doc: "06", patch: GROSS_ONLY_DOC, edit: GROSS_ONLY_READING, ctx: withoutLabelled(["net", "vat"]),
          pipeline: { snapshot: recountry, booking: (b) => ({ ...b, items: b.items.map((item) => ({ ...item, reversed_vat_id: null })) }) },
          expect: { hold_new: ["reading_reverse_charge_unbooked"] } },
        { family: "j", name: `foreign_${country ?? "null"}_gross_only_rc_applied`, doc: "06", patch: GROSS_ONLY_DOC, edit: GROSS_ONLY_READING, ctx: withoutLabelled(["net", "vat"]),
          pipeline: { snapshot: recountry }, expect: { hold_new: ["reading_reverse_charge_unverified"] } },
      ];
    }),
    { family: "j", name: "split_reverse_charge_note", doc: "06", patch: append(["VAT: reverse", "charge applies"]), expect: { hold_new: ["reading_reverse_charge_unverified"] } },

    // (k) totals that are not the invoice total
    { family: "k", name: "previous_debt_gross_only", doc: "06", patch: append(["Eelmine võlg ¦ 50,00", "Tasuda ¦ 65,00"]),
      edit: { set: [{ field: "gross", value: 65, on: "Tasuda ¦ 65,00", quote: "65,00" }, { field: "net", value: null }, { field: "vat", value: null }] }, expect: { hold_new: ["trio_not_read"] } },
    { family: "k", name: "prediscount_trio_signed_discount", doc: "06", patch: insertBefore("Netosumma", ["Summa enne allahindlust ¦ 20,00", "Allahindlus ¦ -5,00"]), expect: { hold_new: ["signed_amount_present"] } },
    { family: "k", name: "gross_only_reading_of_trio", doc: "06", edit: { set: [{ field: "net", value: null }, { field: "vat", value: null }] }, expect: { hold_new: ["trio_not_read"] } },
    { family: "k", name: "unsigned_discount", doc: "06", patch: insertBefore("Kokku:", ["Allahindlus ¦ 0,50"]), expect: { residual_pass: "unsigned discount" } },
  ];
  // (e) every credit entry, title case and a dash variant
  for (const word of CREDIT_WORDS) {
    const dash = word.includes(" ") ? word.replace(/ /g, "-") : `${word}-nr 12`;
    cases.push({ family: "e", name: `credit_title:${word}`, doc: "06", patch: insertAfter("Arve JT-2026-000017", [titleCase(word)]), expect: { hold_new: ["credit_word_present"] } });
    cases.push({ family: "e", name: `credit_dash:${word}`, doc: "06", patch: insertAfter("Arve JT-2026-000017", [titleCase(dash)]), expect: { hold_new: ["credit_word_present"] } });
  }
  return cases;
}

function ownInvoice(base: Snapshot, truth: TruthRecord): PurchaseInvoice | undefined {
  return base.purchaseInvoices.find((invoice) => invoice.id === truth.invoice_id);
}
function withInvoice(s: Snapshot, base: Snapshot, truth: TruthRecord, change: (invoice: PurchaseInvoice) => PurchaseInvoice): Snapshot {
  const invoice = ownInvoice(base, truth);
  if (!invoice) throw new Error("own invoice not in snapshot");
  return { ...s, purchaseInvoices: [...s.purchaseInvoices, change(invoice)] };
}
function otherClientId(s: Snapshot, notId: number | undefined): number {
  return s.clients.find((client) => client.id !== notId && client.is_deleted !== true)!.id!;
}
function withJournal(s: Snapshot, documentNumber: string): Snapshot {
  if (s.journals === "unavailable") return s;
  const journal = { id: 999_000_021, document_number: documentNumber, title: "Ettemaks", effective_date: "2026-07-01", is_deleted: false, registered: true, postings: [] } as unknown as Journal;
  return { ...s, journals: [...s.journals, journal] };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function packetLines(packet: ReadingPacket): Lines {
  return packet.lines.map((line) => ({ page: line.page, text: line.text }));
}

function rebuild(lines: Lines): ReadingPacket {
  const pages = [...new Set(lines.map((line) => line.page))].sort((a, b) => a - b).map((pageNum) => {
    const text = lines.filter((line) => line.page === pageNum).map((line) => line.text.split(" ¦ ").join("   ")).join("\n");
    return { pageNum, text, items: [{ text, ocr: false }], fullPageImage: false, reasons: [], isGarbled: false };
  });
  const sourceSha256 = sha256Hex(pages.map((page) => page.text).join("\f"));
  return buildReadingPacket({ sourceSha256, parserVersion: PARSER_VERSION, pages, totalPages: pages.length, pageErrors: [], parseConfig: { maxPagesSet: false, targetPagesSet: false } });
}

/** Remaps every evidence line id by content (equal text, nearest position). Returns the fields that failed. */
function rebind(reading: Reading, from: ReadingPacket, to: ReadingPacket): string[] {
  const failed: string[] = [];
  for (const [field, evidence] of Object.entries(reading.evidence)) {
    if (!evidence) continue;
    const old = from.lines.findIndex((line) => line.id === evidence.line);
    const text = from.lines[old]?.text;
    const matches = to.lines.map((line, index) => ({ line, index })).filter(({ line }) => line.text === text);
    if (matches.length === 0) {
      failed.push(field);
      continue;
    }
    matches.sort((a, b) => Math.abs(a.index - old) - Math.abs(b.index - old));
    reading.evidence[field] = { ...evidence, line: matches[0]!.line.id };
  }
  return failed;
}

export interface FamilyResult {
  family: string;
  name: string;
  doc: string;
  expected: FamilyCase["expect"];
  status: "OK" | "ESCAPED" | "held_other" | "rebind_failed" | "base_not_admitted" | "patch_failed";
  layer: "checker" | "pipeline";
  holds: string[];
  new_codes: string[];
  base_holds: string[];
  detail?: string;
}

async function evaluate(packet: ReadingPacket, reading: Reading, file: PacketFile, own: OwnIds, truth: TruthRecord, asOf: string, c: Pick<FamilyCase, "ctx" | "pipeline">) {
  const stamped: Reading = { ...reading, source_sha256: packet.source_sha256, packet_digest: packet.packet_digest };
  const proof = synthesizeProof(packet, stamped);
  const ctxBase = checkContext({ ...file, packet }, own, asOf);
  const ctx = c.ctx ? c.ctx(ctxBase) : ctxBase;
  const result: CheckResult = checkReading(packet, stamped, proof, ctx);
  const holds = result.holds.map((hold) => hold.code as string);
  let pipelineHolds: string[] | null = null;
  // The full pipeline runs on every accepted case: the (h)–(j) layer and the base reference need it.
  if (result.verdict === "accept") {
    const base = loadSnapshot(companyOf(own));
    const full = await runPipeline({
      accepted: result.accepted, check: result, file: { ...file, packet }, truth, company: companyOf(own),
      overrides: c.pipeline ? {
        ...(c.pipeline.snapshot && base ? { snapshot: (s: Snapshot) => c.pipeline!.snapshot!(s, base, truth) } : {}),
        ...(c.pipeline.clientsUnavailable ? { clientsUnavailable: true } : {}),
        ...(c.pipeline.booking ? { booking: c.pipeline.booking } : {}),
      } : undefined,
    });
    pipelineHolds = full.status === "evaluated" ? full.holds.map((hold) => hold.code as string) : [`pipeline_${full.status}`];
  }
  return { holds, pipelineHolds, verdict: result.verdict };
}

export async function runFamilies(asOfPass = true): Promise<{ results: FamilyResult[]; base_acceptance: Record<string, unknown> }> {
  const family = readJson<FamilyA>(dataPath("mutations", "a.json"));
  const truthAll = readJson<Record<string, TruthRecord>>(dataPath("corpus", "truth.json"));
  const ownAll = readJson<Record<string, OwnIds>>(dataPath("corpus", "own.json"));
  const results: FamilyResult[] = [];
  const baseCache = new Map<string, { holds: string[]; pipelineHolds: string[] | null } | null>();
  const baseAcceptance: Record<string, unknown> = {};
  for (const c of familyCases()) {
    const base: AdmittedBase | undefined = family.admitted_bases.find((entry) => entry.doc_id === c.doc);
    const truth = truthAll[c.doc]!;
    const own = ownAll[c.doc]!;
    const asOf = asOfPass ? addDays(truth.invoice_date!, 30) : new Date().toISOString().slice(0, 10);
    const layer = c.family === "h" || c.family === "i" || c.family === "j" ? "pipeline" : "checker";
    const row = (status: FamilyResult["status"], extra: Partial<FamilyResult> = {}): FamilyResult =>
      ({ family: c.family, name: c.name, doc: c.doc, expected: c.expect, status, layer, holds: [], new_codes: [], base_holds: [], ...extra });
    if (!base) {
      results.push(row("base_not_admitted"));
      continue;
    }
    const file = readJson<PacketFile>(dataPath("packets", `${c.doc}.json`));
    // The rebuilt, unpatched base: the reference for "newly present".
    if (!baseCache.has(c.doc)) {
      const packet = rebuild(packetLines(file.packet));
      const reading = JSON.parse(JSON.stringify(base.reading)) as Reading;
      const failed = rebind(reading, file.packet, packet);
      const evaluated = failed.length === 0 ? await evaluate(packet, reading, file, own, truth, asOf, {}) : null;
      baseCache.set(c.doc, evaluated ? { holds: evaluated.holds, pipelineHolds: evaluated.pipelineHolds } : null);
      baseAcceptance[c.doc] = evaluated ? { checker: evaluated.verdict, pipeline_holds: evaluated.pipelineHolds } : "rebind_failed";
    }
    const reference = baseCache.get(c.doc);
    if (!reference || reference.holds.length > 0) {
      results.push(row("base_not_admitted", { base_holds: reference?.holds ?? [] }));
      continue;
    }
    const lines = packetLines(file.packet);
    try {
      c.patch?.(lines);
    } catch (error) {
      results.push(row("patch_failed", { detail: error instanceof Error ? error.message : String(error) }));
      continue;
    }
    const packet = rebuild(lines);
    const reading = JSON.parse(JSON.stringify(base.reading)) as Reading;
    const failed = new Set(rebind(reading, file.packet, packet));
    for (const set of c.edit?.set ?? []) {
      if (set.value !== KEEP) reading[set.field] = set.value;
      if (set.field === "doc_type") continue;
      if (set.value === null) {
        delete reading.evidence[set.field];
        failed.delete(set.field);
      } else if (set.on) {
        const line = packet.lines.find((candidate) => candidate.text.includes(set.on!));
        if (!line) throw new Error(`${c.name}: no patched line contains ${set.on}`);
        reading.evidence[set.field] = { line: line.id, quote: set.quote ?? String(reading[set.field]) };
        failed.delete(set.field);
      }
    }
    if (failed.size > 0) {
      results.push(row("rebind_failed", { detail: [...failed].join(",") }));
      continue;
    }
    const evaluated = await evaluate(packet, reading, file, own, truth, asOf, c);
    const caseHolds = layer === "pipeline" && evaluated.pipelineHolds ? [...evaluated.holds, ...evaluated.pipelineHolds] : evaluated.holds;
    const baseHolds = layer === "pipeline" ? [...reference.holds, ...(reference.pipelineHolds ?? [])] : reference.holds;
    const newCodes = [...new Set(caseHolds.filter((code) => !baseHolds.includes(code)))];
    const accepted = caseHolds.length === 0;
    let status: FamilyResult["status"];
    if ("residual_pass" in c.expect) status = accepted ? "OK" : "held_other";
    else if ("absent" in c.expect) status = c.expect.absent.some((code) => newCodes.includes(code)) ? "held_other" : "OK";
    else {
      const want = c.expect.hold_new;
      const ok = c.expect.any ? want.some((code) => newCodes.includes(code)) : want.every((code) => newCodes.includes(code));
      status = ok ? "OK" : accepted ? "ESCAPED" : "held_other";
    }
    results.push(row(status, { holds: caseHolds, new_codes: newCodes, base_holds: baseHolds }));
  }
  return { results, base_acceptance: baseAcceptance };
}

if (process.argv[1]?.endsWith("/families.ts")) {
  const { results, base_acceptance } = await runFamilies(true);
  const byFamily: Record<string, Record<string, number>> = {};
  for (const result of results) {
    const entry = (byFamily[result.family] ??= {});
    entry[result.status] = (entry[result.status] ?? 0) + 1;
  }
  writeJson(dataPath("mutations", "families.json"), { base_acceptance, by_family: byFamily, results });
  for (const result of results) {
    if (result.status !== "OK") process.stdout.write(`${result.status.padEnd(17)} ${result.family} ${result.name} new=[${result.new_codes.join(",")}] ${result.detail ?? ""}\n`);
  }
  process.stdout.write(`${JSON.stringify({ base_acceptance, by_family: byFamily }, null, 2)}\n`);
}
