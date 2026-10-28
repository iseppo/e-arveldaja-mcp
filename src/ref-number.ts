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

/**
 * The Estonian payment reference (viitenumber) check: 2–20 digits whose last digit is the 7-3-1 check digit
 * (weights 7, 3, 1 repeating from the right over the other digits; check = (10 − sum mod 10) mod 10).
 */
export function isValidEstonianReferenceNumber(value: string): boolean {
  if (!/^\d{2,20}$/.test(value)) return false;
  const body = value.slice(0, -1);
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) sum += Number(body[body.length - 1 - i]) * weights[i % 3]!;
  return (10 - (sum % 10)) % 10 === Number(value[value.length - 1]);
}
