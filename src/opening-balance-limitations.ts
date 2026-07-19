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
