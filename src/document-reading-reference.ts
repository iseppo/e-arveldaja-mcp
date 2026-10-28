// PURE module: the payment reference (viitenumber) a reading packet prints.
// Live 2026-10-28 (Arvutitark 447292): the reading path has no reference field, so the booking lost the
// bank_ref_number the legacy path kept. The value is derived from the packet on the server, never from a client
// argument: an Estonian reference label followed on the same line by a whole-token digit run with a valid 7-3-1
// check digit. English `Reference` labels are order references and are deliberately not read.

import type { ReadingPacket } from "./document-reading-packet.js";
import { isWholeToken } from "./document-reading-tokens.js";
import { isValidEstonianReferenceNumber } from "./ref-number.js";

// The label in its noun form (Viitenumber / Viitenr / Viite nr), then only `:`, `.`, `nr`, the column mark or
// whitespace, then the FIRST digit run. Any word between the label and the digits (a customer code, a phone number,
// a sentence) binds nothing; an inflected label ("Viitenumbrit ei ole vaja märkida") is a sentence, not a field.
const REFERENCE_RE = /(?:^|[^\p{L}])(?:viitenumber|viitenr\.?|viite\s*nr\.?)(?![\p{L}])[\s¦:.]*(?:nr\.?[\s¦]*)?(\d+)/giu;
/** Fewer than 4 digits: the 7-3-1 check accepts one random 2–3 digit run in ten; references in use are longer. */
const REFERENCE_MIN_DIGITS = 4;

export type PrintedPaymentReference = { value: string } | { ambiguous: string[] };

/** Exactly one distinct valid reference printed right after an Estonian label → `{ value }`; several → `{ ambiguous }`; none → undefined. */
export function printedPaymentReference(packet: Pick<ReadingPacket, "lines">): PrintedPaymentReference | undefined {
  const found = new Set<string>();
  for (const line of packet.lines) {
    for (const match of line.text.matchAll(REFERENCE_RE)) {
      const digits = match[1]!;
      const start = match.index! + match[0].length - digits.length;
      if (digits.length < REFERENCE_MIN_DIGITS || digits.length > 20) continue;
      if (!isWholeToken(line.text, start, digits.length) || isDecimalPart(line.text, { start, end: start + digits.length })) continue;
      if (isValidEstonianReferenceNumber(digits)) found.add(digits);
    }
  }
  if (found.size === 0) return undefined;
  if (found.size === 1) return { value: [...found][0]! };
  return { ambiguous: [...found].sort() };
}

/** A digit run joined by `,` `.` `-` `/` `_` to another letter or digit run is part of a longer token (124,00; 3114100-1). */
function isDecimalPart(text: string, token: { start: number; end: number }): boolean {
  return /[\p{L}\p{N}][.,\-/_]$/u.test(text.slice(0, token.start)) || /^[.,\-/_][\p{L}\p{N}]/u.test(text.slice(token.end));
}
