import type { ApiResponse, Transaction } from "./types/api.js";
import { bankTransactionDirection, type BankTransactionDirection } from "./bank-transaction-direction.js";
import { canonicalRefNumber } from "./ref-number.js";

// A trailing signed-direction marker that `bankTransactionDirection` matches with
// END-ANCHORED regexes: the Wise `[source_direction=IN|OUT]` tag or the
// `[e-arveldaja-mcp:camt …]` marker. Any preceding whitespace/newline is captured
// so that reweaving text keeps the marker's own anchor intact (the camt regex
// requires a newline or start-of-string immediately before it).
const TRAILING_DIRECTION_MARKER =
  /\s*(?:\[source_direction=(?:IN|OUT)\]|\[e-arveldaja-mcp:camt[^\]\r\n]*\])\s*$/i;

// The e-arveldaja backend caps a stored transaction `description`. Weaving an
// over-cap reference into a near-max description must never push the result past
// this length (it would risk an upstream rejection or an overflowed/evicted
// metadata marker). Defined locally to avoid a circular import from
// camt-import.ts, which declares the same value.
export const TRANSACTION_DESCRIPTION_MAX_LENGTH = 150;

/**
 * Weave the full (pre-truncation) reference into `description` so it survives a
 * `ref_number` cap — but ONLY when it is not already present, and inserted
 * BEFORE any trailing direction marker so the end-anchored regexes in
 * `bankTransactionDirection` still resolve the statement direction.
 *
 * Length budget (`maxLength`, default `TRANSACTION_DESCRIPTION_MAX_LENGTH`): if
 * the woven result would exceed the budget it is NOT woven — the original
 * `description` is returned unchanged. Losing the extra ref chars (the ref is
 * still recoverable, capped, in `ref_number`) is an acceptable fail-safe; a
 * backend rejection or a broken/evicted marker is not.
 */
export function weaveFullRefIntoDescription(
  description: string | null | undefined,
  fullRef: string,
  maxLength: number = TRANSACTION_DESCRIPTION_MAX_LENGTH,
): string {
  const current = description ?? "";
  if (current.includes(fullRef)) return current;
  const woven = weaveRefBeforeTrailingMarker(current, fullRef);
  return woven.length <= maxLength ? woven : current;
}

function weaveRefBeforeTrailingMarker(current: string, fullRef: string): string {
  const markerMatch = current.match(TRAILING_DIRECTION_MARKER);
  if (markerMatch) {
    const head = current.slice(0, markerMatch.index).trimEnd();
    const tail = markerMatch[0];
    if (head === "") {
      // A marker-only (empty-narrative) description. The camt read-side regexes
      // anchor the marker to `(?:^|\n)`, so once the ref takes the start-of-string
      // slot the marker MUST be pushed onto its own line or the anchor breaks and
      // the entry's sig/bank_ref/source_direction become invisible (→ re-import /
      // double booking). A leading `\n` restores the anchor. The Wise marker has
      // no such preceding-char requirement (it needs a `WISE:` prefix a
      // marker-only string never carries), so a plain concat stays correct there.
      const isCamtMarker = /\[e-arveldaja-mcp:camt/i.test(tail);
      if (isCamtMarker && !tail.includes("\n")) {
        return `${fullRef}\n${tail.replace(/^\s+/, "")}`;
      }
      return `${fullRef}${tail}`;
    }
    return `${head} ${fullRef}${tail}`;
  }
  return current === "" ? fullRef : `${current} ${fullRef}`;
}

export interface BankTransactionCreateApi {
  transactions: {
    create(payload: Partial<Transaction>): Promise<ApiResponse>;
  };
}

/**
 * Single boundary for creating bank transactions.
 *
 * The e-arveldaja backend derives the cash-account (e.g. 1020) debit/credit leg
 * from the stored API `type` at confirmation time: `type="D"` books the cash on
 * the DEBIT side ("Laekumine" / money in), `type="C"` on the CREDIT side
 * ("Tasumine" / money out). On the write path `type` is therefore NOT a cosmetic
 * transport discriminator — it must reflect the true statement direction, or
 * every incoming row is booked backwards (cash on the wrong side, counter-account
 * reversed). Forcing `type="C"` unconditionally caused exactly that regression in
 * 0.22.0; this boundary restores the historical directional mapping.
 *
 * Direction comes from the explicit `direction` argument when the caller knows it
 * (CAMT/Wise importers pass their parsed statement direction), otherwise it is
 * derived from the payload's signed source metadata / legacy `type` via
 * `bankTransactionDirection`. Unknown falls back to `"C"` — the historical
 * default for manually-created rows with no direction signal.
 */
export function createBankTransaction(
  api: BankTransactionCreateApi,
  input: Partial<Transaction>,
  direction?: BankTransactionDirection,
): Promise<ApiResponse> {
  const resolved = direction ?? bankTransactionDirection(input);
  const type = resolved === "incoming" ? "D" : "C";
  const { type: _callerSuppliedType, ...payload } = input;

  // Canonicalize the source reference to the backend cap. On truncation, weave
  // the full reference into the description (before any trailing direction
  // marker) so the complete value is still recoverable from the ledger.
  const canonicalRef = canonicalRefNumber(payload.ref_number);
  const nextRefNumber = canonicalRef.value;
  let nextDescription = payload.description;
  if (canonicalRef.truncated && canonicalRef.full) {
    nextDescription = weaveFullRefIntoDescription(payload.description, canonicalRef.full, TRANSACTION_DESCRIPTION_MAX_LENGTH);
  }

  return api.transactions.create({
    ...payload,
    ...(payload.ref_number !== undefined ? { ref_number: nextRefNumber } : {}),
    ...(nextDescription !== undefined ? { description: nextDescription } : {}),
    type,
  });
}
