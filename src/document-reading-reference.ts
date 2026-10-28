// PURE module: the payment reference (viitenumber) a reading packet prints.
// Live 2026-10-28 (Arvutitark 447292): the reading path has no reference field, so the booking lost the
// bank_ref_number the legacy path kept. The value is derived from the packet on the server, never from a client
// argument: an Estonian reference label followed on the same line by a whole-token digit run with a valid 7-3-1
// check digit. English `Reference` labels are order references and are deliberately not read.

import type { ReadingPacket } from "./document-reading-packet.js";
import { isWholeToken, lineTokens } from "./document-reading-tokens.js";
import { isValidEstonianReferenceNumber } from "./ref-number.js";

const REFERENCE_LABEL_RE = /(?:^|[^\p{L}])(?:viitenumb(?:er|ri|rit|riga)?(?![\p{L}])|viitenr\.?)/giu;

export type PrintedPaymentReference = { value: string } | { ambiguous: string[] };

/** Exactly one distinct valid reference printed under an Estonian label → `{ value }`; several → `{ ambiguous }`; none → undefined. */
export function printedPaymentReference(packet: Pick<ReadingPacket, "lines">): PrintedPaymentReference | undefined {
  const found = new Set<string>();
  for (const line of packet.lines) {
    const labels = [...line.text.matchAll(REFERENCE_LABEL_RE)];
    if (labels.length === 0) continue;
    const tokens = lineTokens(line);
    for (const label of labels) {
      const from = label.index! + label[0].length;
      for (const token of tokens.wordTokens) {
        if (token.start < from || !/^\d{2,20}$/.test(token.text)) continue;
        if (!isWholeToken(line.text, token.start, token.text.length) || isDecimalPart(line.text, token)) continue;
        if (isValidEstonianReferenceNumber(token.text)) found.add(token.text);
      }
    }
  }
  if (found.size === 0) return undefined;
  if (found.size === 1) return { value: [...found][0]! };
  return { ambiguous: [...found].sort() };
}

/** A digit run joined by `,` or `.` to another digit run is part of an amount (124,00), not a reference. */
function isDecimalPart(text: string, token: { start: number; end: number }): boolean {
  return /\d[.,]$/.test(text.slice(0, token.start)) || /^[.,]\d/.test(text.slice(token.end));
}
