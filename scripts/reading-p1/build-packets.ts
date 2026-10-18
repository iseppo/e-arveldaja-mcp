// Manifest → packets/<id>.json: the reading packet, the HeuristicView and the parse stats (plan §5.1).
// The heuristic inputs mirror documents/operations.ts (prepare): parseDocument, textItemsWithPageNums,
// computeMinOcrConfidence, extractReceiptFieldsFromText, buildExtractionConfidenceSignals and
// summarizeInvoiceExtraction(…, inferSupplierCountry(extracted)).
//
// Usage:
//   npx tsx scripts/reading-p1/build-packets.ts --set corpus|heldout [--out <dir>] [--only 01,02]
//   npx tsx scripts/reading-p1/build-packets.ts --pdf <file> --id <id> --out <dir> [--own-reg R] [--own-vat V]

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "../../src/document-parser.js";
import { buildReadingPacket, type ReadingPacket } from "../../src/document-reading-packet.js";
import { packetInputFromParse } from "../../src/tools/document-text-hazards.js";
import { labelledHeuristicValues, type HeuristicView } from "../../src/document-reading-check.js";
import { summarizeInvoiceExtraction } from "../../src/invoice-extraction-fallback.js";
import {
  computeMinOcrConfidence,
  detectCurrencyEquivalentAmbiguity,
  extractReceiptFieldsFromText,
  inferSupplierCountry,
} from "../../src/tools/receipt-extraction.js";
import { buildExtractionConfidenceSignals } from "../../src/tools/receipt-inbox.js";
import { textItemsWithPageNums } from "../../src/tools/pdf-workflow.js";
import { REPO_ROOT, argValue, dataPath, manifest, readJson, sha256Hex, writeJson, type SetName } from "./common.js";

export const PARSER_VERSION: string = `liteparse@${readJson<{ version: string }>(join(REPO_ROOT, "node_modules", "@llamaindex", "liteparse", "package.json")).version}`;

export interface OwnIds { reg: string | null; vat: string | null; name?: string }

/** Own name and IBANs as documents/operations.ts passes them: from the company snapshot, else own.json's name. */
export function ownExtractionContext(own: OwnIds): { ownCompanyName?: string; ownIbans?: string[] } {
  const company = own.reg ?? own.vat;
  const path = company ? dataPath("snapshots", company, "own.json") : undefined;
  if (path && existsSync(path)) {
    const snapshot = readJson<{ ownCompanyName?: string; ownIbans?: string[] }>(path);
    return { ...(snapshot.ownCompanyName ? { ownCompanyName: snapshot.ownCompanyName } : {}), ...(snapshot.ownIbans ? { ownIbans: snapshot.ownIbans } : {}) };
  }
  return own.name ? { ownCompanyName: own.name } : {};
}

export interface PacketFile {
  id: string;
  path: string;
  packet: ReadingPacket;
  heuristic: HeuristicView;
  /** Heuristic picks used for the duplicate union keys (§3.6) and the held-out pick; never a truth source. */
  heuristic_fields: {
    invoice_number: string | null;
    invoice_date: string | null;
    supplier_name: string | null;
    supplier_reg: string | null;
    supplier_vat: string | null;
    gross: number | null;
    currency: string | null;
  };
  currency_equivalent_ambiguity: boolean;
  stats: {
    total_pages: number;
    page_errors: number;
    any_needs_ocr: boolean;
    reasons: Record<string, number>;
    full_page_image_pages: number;
    scanned_pages: number;
    garbled_pages: number;
    ocr_items: string[];
    ocr_partial_failure: boolean;
    text_bytes: number;
    lines: number;
  };
}

export async function buildPacketFile(id: string, path: string, own: OwnIds): Promise<PacketFile> {
  const source = readFileSync(path);
  const parsed = await parseDocument(path);
  const result = parsed.result;
  const complexityPages = parsed.complexity?.pages;
  if (!result || !complexityPages) throw new Error(`parseDocument returned no result or complexity for ${id}`);
  const packet = buildReadingPacket(packetInputFromParse(parsed, sha256Hex(source), PARSER_VERSION));

  const items = textItemsWithPageNums(result.pages);
  const ownCompanyVat = own.vat ?? undefined;
  const ownCompanyRegistryCode = own.reg ?? undefined;
  const extracted = extractReceiptFieldsFromText(parsed.text, path.split("/").pop() ?? "document.pdf", {
    textItems: items,
    ownCompanyVat,
    ownCompanyRegistryCode,
    ...ownExtractionContext(own),
  });
  const signals = buildExtractionConfidenceSignals(extracted, {
    partialOcrFailure: parsed.ocrPartialFailure,
    minOcrConfidence: computeMinOcrConfidence(items),
    ownCompanyVat,
    ownCompanyRegistryCode,
  });
  const summary = summarizeInvoiceExtraction(extracted, signals, "advanced_detail.raw_text", inferSupplierCountry(extracted));
  const signalKeys = Object.entries(signals).filter(([, value]) => value === true).map(([key]) => key);
  const heuristic: HeuristicView = {
    signals: [...new Set([...signalKeys, ...summary.confidence_signals])],
    confidence: summary.confidence,
    labelled: labelledHeuristicValues(extracted.field_provenance ?? []),
  };

  const reasons: Record<string, number> = {};
  for (const page of complexityPages) for (const reason of page.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
  const ocrItems = result.pages.flatMap((page) => page.textItems.filter((item) => item.confidence !== undefined && item.text.trim() !== "").map((item) => item.text));

  return {
    id,
    path,
    packet,
    heuristic,
    heuristic_fields: {
      invoice_number: extracted.invoice_number ?? null,
      invoice_date: extracted.invoice_date ?? null,
      supplier_name: extracted.supplier_name ?? null,
      supplier_reg: extracted.supplier_reg_code ?? null,
      supplier_vat: extracted.supplier_vat_no ?? null,
      gross: extracted.total_gross ?? null,
      currency: extracted.currency ?? null,
    },
    currency_equivalent_ambiguity: detectCurrencyEquivalentAmbiguity(parsed.text) !== undefined,
    stats: {
      total_pages: result.totalPages,
      page_errors: result.pageErrors.length,
      any_needs_ocr: complexityPages.some((page) => page.needsOcr),
      reasons,
      full_page_image_pages: complexityPages.filter((page) => page.fullPageImage).length,
      scanned_pages: complexityPages.filter((page) => page.reasons.includes("scanned")).length,
      garbled_pages: complexityPages.filter((page) => page.isGarbled).length,
      ocr_items: ocrItems,
      ocr_partial_failure: parsed.ocrPartialFailure === true,
      text_bytes: packet.text_bytes,
      lines: packet.lines.length,
    },
  };
}

async function main(argv: string[]): Promise<void> {
  const pdf = argValue(argv, "--pdf");
  if (pdf) {
    const id = argValue(argv, "--id");
    const out = argValue(argv, "--out");
    if (!id || !out) throw new Error("--pdf needs --id and --out");
    const file = await buildPacketFile(id, pdf, { reg: argValue(argv, "--own-reg") ?? null, vat: argValue(argv, "--own-vat") ?? null });
    writeJson(join(out, `${id}.json`), file);
    process.stdout.write(`${id} ${file.packet.packet_digest} holds=${file.packet.holds.map((hold) => hold.code).join(",") || "-"}\n`);
    return;
  }
  const set = (argValue(argv, "--set") ?? "corpus") as SetName;
  const out = argValue(argv, "--out") ?? dataPath("packets");
  const only = argValue(argv, "--only")?.split(",");
  const own = readJson<Record<string, OwnIds>>(dataPath(set, "own.json"));
  for (const entry of manifest(set)) {
    if (only && !only.includes(entry.id)) continue;
    if (sha256Hex(readFileSync(entry.path)) !== entry.sha256) throw new Error(`${entry.id}: file changed since the manifest was recorded`);
    const ownIds = own[entry.id];
    if (!ownIds) throw new Error(`${entry.id}: no own.json entry`);
    const file = await buildPacketFile(entry.id, entry.path, ownIds);
    writeJson(join(out, `${entry.id}.json`), file);
    process.stdout.write(`${entry.id} ${file.packet.packet_digest.slice(0, 16)} bytes=${file.packet.text_bytes} lines=${file.packet.lines.length} holds=${file.packet.holds.map((hold) => hold.code).join(",") || "-"}\n`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
