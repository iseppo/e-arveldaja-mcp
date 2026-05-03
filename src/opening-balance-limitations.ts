export const OPENING_BALANCE_API_LIMITATION_WARNING =
  "Known API coverage limitation: e-arveldaja's separate \"Algbilansi kanded\" (opening balance entries) section may not be included in the /journals API data available to this MCP server. Balances, trial balances, P&L, and journal lists can therefore miss opening-balance amounts; verify opening balances in the e-arveldaja UI before relying on audit totals.";

export function withOpeningBalanceApiLimitation(warnings: string[] = []): string[] {
  return warnings.includes(OPENING_BALANCE_API_LIMITATION_WARNING)
    ? warnings
    : [...warnings, OPENING_BALANCE_API_LIMITATION_WARNING];
}
