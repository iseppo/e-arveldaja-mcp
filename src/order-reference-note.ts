// PURE module: the canonical purchase-invoice notes line that carries a
// document's order / shopping-cart number (okt 2026 finding 5). A card payment's
// bank description names the cart number, not the invoice number, so the
// reconcile suggestion path reads this line back from the invoice notes.

export const ORDER_REFERENCE_NOTE_LABEL = "Ostukorvi/tellimuse nr:";

// One line, the label and one unspaced value; `tagNotes` may append
// " (e-arveldaja-mcp)" to the last line of the notes.
const ORDER_REFERENCE_NOTE_LINE_RE = /^Ostukorvi\/tellimuse nr: (\S+)(?: \(e-arveldaja-mcp\))?$/;

/** The canonical notes line for exactly one distinct reference; none or several distinct values bind nothing. */
export function orderReferenceNoteLine(references: readonly string[]): string | undefined {
  const distinct = [...new Set(references.map(reference => reference.trim()).filter(reference => /^\S+$/.test(reference)))];
  return distinct.length === 1 ? `${ORDER_REFERENCE_NOTE_LABEL} ${distinct[0]}` : undefined;
}

/** Every order reference carried by canonical lines in `notes`. */
export function orderReferencesFromNotes(notes: string | null | undefined): string[] {
  if (typeof notes !== "string") return [];
  return notes.split(/\r?\n/)
    .map(line => ORDER_REFERENCE_NOTE_LINE_RE.exec(line.trim())?.[1])
    .filter((value): value is string => value !== undefined);
}

/**
 * `notes` with the canonical line appended on its own line. Idempotent: notes
 * that already carry the same line (also with the `tagNotes` suffix) are
 * returned unchanged, and so are notes when there is no line.
 */
export function appendOrderReferenceNote(notes: string | undefined, line: string | undefined): string | undefined {
  if (line === undefined) return notes;
  const value = ORDER_REFERENCE_NOTE_LINE_RE.exec(line)?.[1];
  if (value === undefined) return notes;
  if (orderReferencesFromNotes(notes).includes(value)) return notes;
  return notes !== undefined && notes !== "" ? `${notes}\n${line}` : line;
}
