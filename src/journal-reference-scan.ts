import type { Journal } from "./types/api.js";
import { normalizeInvoiceNumberForComparison } from "./purchase-invoice-status.js";

/**
 * Journal reference scan — does a live journal already name this document?
 *
 * The purchase-invoice number check only sees purchase invoices and the
 * cross-mechanism cash scan only sees bank postings within ±7 days, so a
 * document booked by a manual journal (e.g. a prepayment journal whose
 * document_number is `ETR1:EE1966453`) is invisible to both. This scan matches
 * the document's invoice number against every live journal's `document_number`
 * and `title` (free-text descriptions are not scanned).
 *
 * Matching is token EQUALITY, never substring: `EE19664531` and `XEE1966453`
 * do not hit `EE1966453`. A haystack field is split into tokens on anything but
 * letters, digits, dashes, `/`, `.` and `_` (so `ETR1:EE1966453` splits at the
 * colon); each token is ALSO split on its internal delimiters (dash, `/`, `.`,
 * `_`) so a delimiter-joined `ETR1-EE1966453` yields `EE1966453`. Runs of 2-3
 * adjacent tokens / sub-tokens are joined as well (`INV 2024 01` = `INV-2024-01`).
 * Every candidate is compared under `journalReferenceKey`.
 *
 * Strength gate on the reference (false holds are acceptable, but a short
 * number like "110" must not hold every journal that mentions it):
 * - strong: key of 6+ characters with a digit, not date-shaped — matches any
 *   token / sub-token / join of `document_number` or `title`;
 * - weak: key of 4-5 characters, or date-shaped (YYYYMM, YYYYMMDD, DDMMYYYY) —
 *   matches only the WHOLE `document_number`, or its remainder after one leading
 *   `PREFIX:` (`LY:1234` holds `1234`). A weak reference never matches a title,
 *   a sub-token or a join, so `1234` does not hit `ETR1-1234` or `Arve 1234`;
 * - shorter than 4 characters, or no digit: never matched.
 *
 * Kept MCP-free: hits carry raw journal text; callers wrap it at output.
 */

export interface JournalReferenceHit {
  journal_id: number;
  /** The document reference (as given by the caller) that matched. */
  reference: string;
  matched_field: "document_number" | "title";
  document_number: string | null;
  title: string | null;
}

export interface JournalReferenceScanResult {
  scan_available: boolean;
  scan_note?: string;
  hits: JournalReferenceHit[];
}

type ReferenceStrength = "strong" | "weak";

const TOKEN_SPLIT = /[^\p{L}\p{N}\-‐‑‒–—/._]+/u;
const SUBTOKEN_SPLIT = /[\-‐‑‒–—/._]+/;
const SOURCE_PREFIX = /^[A-Za-z][\w-]*:/;
const MAX_JOIN = 3;

/** Comparison key: `normalizeInvoiceNumberForComparison`, then `/`, `.`, `_`, `:` dropped too. */
export function journalReferenceKey(value: string | null | undefined): string {
  return normalizeInvoiceNumberForComparison(value).replace(/[/._:]/g, "");
}

function isDateShaped(key: string): boolean {
  if (key.length === 6) return /^(19|20)\d\d(0[1-9]|1[0-2])$/.test(key);
  if (key.length === 8) {
    return /^(19|20)\d\d(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(key)
      || /^(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])(19|20)\d\d$/.test(key);
  }
  return false;
}

export function journalReferenceStrength(key: string): ReferenceStrength | undefined {
  if (key.length < 4 || !/\d/.test(key)) return undefined;
  if (key.length < 6 || isDateShaped(key)) return "weak";
  return "strong";
}

function addRunJoins(keys: Set<string>, parts: readonly string[]): void {
  for (let start = 0; start < parts.length; start++) {
    let joined = "";
    for (let end = start; end < Math.min(parts.length, start + MAX_JOIN); end++) {
      joined += parts[end]!;
      if (joined !== "") keys.add(joined);
    }
  }
}

/** Every token, sub-token and 2-3 token join of `text`, under `journalReferenceKey`. */
function candidateKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const tokens = text.split(TOKEN_SPLIT).filter(token => token !== "");
  addRunJoins(keys, tokens.map(journalReferenceKey));
  for (const token of tokens) {
    const parts = token.split(SUBTOKEN_SPLIT).filter(part => part !== "");
    if (parts.length > 1) addRunJoins(keys, parts.map(journalReferenceKey));
  }
  return keys;
}

/** Whole document_number keys a weak reference may equal: the value, and its remainder after one `PREFIX:`. */
function wholeDocumentNumberKeys(documentNumber: string): Set<string> {
  const trimmed = documentNumber.trim();
  const keys = new Set([journalReferenceKey(trimmed)]);
  const prefix = SOURCE_PREFIX.exec(trimmed);
  if (prefix) keys.add(journalReferenceKey(trimmed.slice(prefix[0].length)));
  keys.delete("");
  return keys;
}

/**
 * Live journals (`is_deleted !== true`, any operation type, drafts included)
 * whose document_number or title carries one of `references`. One hit per
 * journal (document_number preferred), sorted by journal id.
 */
export function findJournalsReferencingDocument(
  journals: readonly Journal[],
  references: ReadonlyArray<string | null | undefined>,
): JournalReferenceHit[] {
  const gated = references
    .filter((reference): reference is string => typeof reference === "string")
    .map(reference => ({ reference, key: journalReferenceKey(reference) }))
    .map(entry => ({ ...entry, strength: journalReferenceStrength(entry.key) }))
    .filter((entry): entry is { reference: string; key: string; strength: ReferenceStrength } => entry.strength !== undefined);
  if (gated.length === 0) return [];

  const hits: JournalReferenceHit[] = [];
  for (const journal of journals) {
    if (journal.is_deleted === true || journal.id == null) continue;
    const documentNumber = typeof journal.document_number === "string" ? journal.document_number : null;
    const title = typeof journal.title === "string" ? journal.title : null;
    const docWhole = documentNumber !== null ? wholeDocumentNumberKeys(documentNumber) : new Set<string>();
    const docTokens = documentNumber !== null ? candidateKeys(documentNumber) : new Set<string>();
    const titleTokens = title !== null ? candidateKeys(title) : new Set<string>();

    let hit: Pick<JournalReferenceHit, "reference" | "matched_field"> | undefined;
    for (const { reference, key, strength } of gated) {
      if (docWhole.has(key) || (strength === "strong" && docTokens.has(key))) {
        hit = { reference, matched_field: "document_number" };
        break;
      }
      if (strength === "strong" && titleTokens.has(key)) {
        hit ??= { reference, matched_field: "title" };
      }
    }
    if (hit) {
      hits.push({ journal_id: journal.id, ...hit, document_number: documentNumber, title });
    }
  }
  return hits.sort((a, b) => a.journal_id - b.journal_id);
}

/**
 * Fail-safe wrapper: reads the (cached) journal list and runs the matcher. A
 * list failure (200-page cap, timeout) returns `scan_available: false` with a
 * note and no hits — like the cash scan, an advisory sub-check never holds or
 * fails a booking by being unavailable. Skips the read when no reference
 * passes the strength gate.
 */
export async function checkJournalReferences(
  api: { journals: { listAll(): Promise<Journal[]> } },
  references: ReadonlyArray<string | null | undefined>,
): Promise<JournalReferenceScanResult> {
  const usable = references.some(reference =>
    typeof reference === "string" && journalReferenceStrength(journalReferenceKey(reference)) !== undefined);
  if (!usable) return { scan_available: true, hits: [] };
  try {
    const journals = await api.journals.listAll();
    return { scan_available: true, hits: findJournalsReferencingDocument(journals, references) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      scan_available: false,
      scan_note: `Journal reference scan unavailable: ${message} — journals that may already book this document were not checked.`,
      hits: [],
    };
  }
}
