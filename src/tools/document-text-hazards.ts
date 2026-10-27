// Tool-side adapter of the reading checker's text-hazard producer (P2 E0). The
// heuristic intake paths (receipt_batch, extract_pdf_invoice /
// create_purchase_invoice_from_pdf, process_accounting_document prepare) call it
// on the parse they already made, so the hazards are never computed from a
// second parse and are the same ones the checker holds on.

import type { ParsedDocument } from "../document-parser.js";
import { documentTextHazards } from "../document-reading-check.js";
import { buildReadingPacket, type PacketBuildInput, type ReadingPacket } from "../document-reading-packet.js";
import type { ExtractionConfidenceSignals } from "../invoice-extraction-fallback.js";
import { blankLeaderLines, type BlankLeaderProof } from "../documents/lost-value-ocr.js";

/** The packet input of one parse, the same mapping the reading harness uses (OCR item = one with a confidence). */
export function packetInputFromParse(parsed: ParsedDocument, sourceSha256: string, parserVersion: string): PacketBuildInput {
  const complexityByPage = new Map((parsed.complexity?.pages ?? []).map((page) => [page.pageNumber, page]));
  const pages = parsed.result?.pages ?? [];
  return {
    sourceSha256,
    parserVersion,
    pages: pages.map((page) => {
      const complexity = complexityByPage.get(page.pageNum);
      return {
        pageNum: page.pageNum,
        text: page.text ?? "",
        items: (page.textItems ?? []).map((item) => ({ text: item.text, ocr: item.confidence !== undefined })),
        fullPageImage: complexity?.fullPageImage ?? false,
        reasons: complexity?.reasons ?? [],
        isGarbled: complexity?.isGarbled ?? false,
      };
    }),
    totalPages: parsed.result?.totalPages ?? pages.length,
    pageErrors: parsed.result?.pageErrors ?? [],
    parseConfig: {
      maxPagesSet: process.env.EARVELDAJA_LITEPARSE_MAX_PAGES !== undefined,
      targetPagesSet: Boolean(process.env.EARVELDAJA_LITEPARSE_TARGET_PAGES),
    },
  };
}

/**
 * The reading packet of one parse. When it holds text_layer_value_lost, the leader lines the page image proves blank
 * (signature lines; `blankLeaderLines`) are passed to the builder, so they are not lost values. Any failure of that
 * proof leaves the packet as built.
 */
export async function readingPacketOf(
  parsed: ParsedDocument, filePath: string, sourceSha256: string, parserVersion: string,
  proveBlank: BlankLeaderProof = (path, source, built) => blankLeaderLines(path, source, built),
): Promise<ReadingPacket> {
  const input = packetInputFromParse(parsed, sourceSha256, parserVersion);
  const packet = buildReadingPacket(input);
  if (!packet.holds.some((hold) => hold.code === "text_layer_value_lost")) return packet;
  const blank = await Promise.resolve().then(() => proveBlank(filePath, parsed, packet)).catch((): string[] => []);
  return blank.length > 0 ? buildReadingPacket({ ...input, blankLeaderLines: blank }) : packet;
}

/**
 * The checker's text hazards on the caller's parse of `filePath`, as extraction confidence signals (only the raised
 * ones). `currency` is the extracted currency: a foreign-currency marker counts only on a reading that is, or
 * defaults to, EUR (a non-EUR reading already stops at booking).
 */
export async function textHazardSignals(parsed: ParsedDocument, currency: string | undefined, filePath: string): Promise<ExtractionConfidenceSignals> {
  // The digest is never read here: the packet only normalizes the lines exactly as the checker sees them.
  const packet = await readingPacketOf(parsed, filePath, "", "");
  const hazards = documentTextHazards(packet.lines);
  const signals: ExtractionConfidenceSignals = {};
  if (hazards.credit_word_present) signals.credit_word_present = true;
  if (hazards.signed_amount_present) signals.signed_amount_present = true;
  if (hazards.foreign_currency_marker && (currency ?? "EUR").toUpperCase() === "EUR") signals.foreign_currency_marker = true;
  if (packet.holds.some((hold) => hold.code === "text_layer_value_lost")) signals.text_layer_value_lost = true;
  return signals;
}
