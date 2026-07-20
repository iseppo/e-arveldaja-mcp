/**
 * Bank-transaction `ref_number` canonicalization.
 *
 * The e-arveldaja backend caps the stored `ref_number` length. Imported source
 * references (Wise/CAMT bank refs, invoice numbers) can exceed that cap; passing
 * an over-length value risks an upstream rejection or a silently truncated store
 * that then fails to dedupe against a re-import. This module is the single place
 * that trims + caps a reference so the write boundary and the Wise dedup
 * signature agree on exactly what got persisted.
 *
 * Cap source: `REF_NUMBER_MAX_LENGTH = 20` is the maintainer-reported fallback.
 * The demo-server probe (create a 27-char ref, observe the cutoff) was NOT run —
 * the configured server is LIVE and must never be probed or mutated. Revisit the
 * constant if a demo probe later pins a different length.
 */
export const REF_NUMBER_MAX_LENGTH = 20;

export interface CanonicalRefNumber {
  /** The trimmed, cap-enforced value; `undefined` for empty/whitespace input. */
  value: string | undefined;
  /** True when the trimmed value exceeded the cap and was sliced. */
  truncated: boolean;
  /** The full trimmed value before slicing — present only when `truncated`. */
  full?: string;
}

export function canonicalRefNumber(value: string | null | undefined): CanonicalRefNumber {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    return { value: undefined, truncated: false };
  }
  if (trimmed.length <= REF_NUMBER_MAX_LENGTH) {
    return { value: trimmed, truncated: false };
  }
  return {
    value: trimmed.slice(0, REF_NUMBER_MAX_LENGTH),
    truncated: true,
    full: trimmed,
  };
}
