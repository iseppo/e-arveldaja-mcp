export const OPENING_BALANCE_API_LIMITATION_WARNING =
  "Known API coverage limitation: e-arveldaja's separate \"Algbilansi kanded\" (opening balance entries) section may not be included in the /journals API data available to this MCP server. Balances, trial balances, P&L, and journal lists can therefore miss opening-balance amounts; verify opening balances in the e-arveldaja UI before relying on audit totals.";

export function withOpeningBalanceApiLimitation(warnings: string[] = []): string[] {
  return warnings.includes(OPENING_BALANCE_API_LIMITATION_WARNING)
    ? warnings
    : [...warnings, OPENING_BALANCE_API_LIMITATION_WARNING];
}

export const OPENING_BALANCE_ACTIONABLE_WARNING =
  "Opening balances are not captured. The e-arveldaja API omits 'Algbilansi kanded' (opening-balance entries), so balances, trial balances, P&L, and the dividend §157 checks may be incomplete. Paste the register via the import_opening_balances tool to fold them in.";

export function withOpeningBalanceStatus(
  warnings: string[],
  opts: { captured: boolean; openingDate?: string; unmappedCodes?: string[] },
): string[] {
  const out = [...warnings];
  if (!opts.captured) {
    if (!out.includes(OPENING_BALANCE_ACTIONABLE_WARNING)) out.push(OPENING_BALANCE_ACTIONABLE_WARNING);
    return out;
  }
  const date = opts.openingDate ? ` (as of ${opts.openingDate})` : "";
  out.push(`Opening balances applied from the stored algbilanss${date}.`);
  if (opts.unmappedCodes && opts.unmappedCodes.length > 0) {
    out.push(`Opening-balance accounts not in the chart were skipped: ${opts.unmappedCodes.join(", ")}. Re-check these account codes.`);
  }
  return out;
}

// A stored algbilanss is folded in as one synthetic journal dated at the
// opening date (see `src/opening-balance-journal.ts`). The balance functions
// that accept `date_from`/`date_to` (or an as-of `date_to`) apply the same
// `effective_date < dateFrom` / `effective_date > dateTo` gates to that
// synthetic journal as to any other — so a stored algbilanss whose opening
// date falls outside the requested range is silently excluded from the
// figures even though `withOpeningBalanceStatus` above would still call it
// "applied" (it only checks storage presence, not date-window inclusion).
// This wraps that function with a third state — stored-but-out-of-window —
// WITHOUT changing `withOpeningBalanceStatus`'s existing two-state contract
// (other consumers depend on it staying captured/not-captured only).
export function withOpeningBalanceStatusInRange(
  warnings: string[],
  opts: { captured: boolean; openingDate?: string; unmappedCodes?: string[]; dateFrom?: string; dateTo?: string },
): string[] {
  if (!opts.captured) {
    return withOpeningBalanceStatus(warnings, { captured: false });
  }
  const { openingDate, dateFrom, dateTo } = opts;
  const inRange =
    (dateFrom === undefined || (openingDate !== undefined && openingDate >= dateFrom)) &&
    (dateTo === undefined || (openingDate !== undefined && openingDate <= dateTo));
  if (inRange) {
    return withOpeningBalanceStatus(warnings, opts);
  }
  const out = [...warnings];
  out.push(
    `Opening balances are stored (as of ${openingDate}) but fall outside this date range and are not included in these figures.`,
  );
  if (opts.unmappedCodes && opts.unmappedCodes.length > 0) {
    out.push(`Opening-balance accounts not in the chart were skipped: ${opts.unmappedCodes.join(", ")}. Re-check these account codes.`);
  }
  return out;
}
