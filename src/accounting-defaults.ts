/** Default Estonian chart-of-accounts numbers used as fallbacks across tools. */

/** Accounts payable (Tarnijate võlgnevus) */
export const DEFAULT_LIABILITY_ACCOUNT = 2310;

/** Input VAT (Sisendkäibemaks) */
export const DEFAULT_VAT_ACCOUNT = 1510;

/** Payable to owner (Võlg omanikule) */
export const DEFAULT_OWNER_PAYABLE_ACCOUNT = 2110;

/** Accounts receivable (Ostjate ettemaksed / nõuded) */
export const DEFAULT_ACCOUNTS_RECEIVABLE = 1210;

/** Retained earnings (Jaotamata kasum) */
export const RETAINED_EARNINGS_ACCOUNT = 3020;

/** Dividend payable (Dividendide võlgnevus) */
export const DIVIDEND_PAYABLE_ACCOUNT = 2370;

/** Corporate income tax payable (Tulumaksu kohustus) */
export const CIT_PAYABLE_ACCOUNT = 2540;

/** Share capital (Osakapital) */
export const SHARE_CAPITAL_ACCOUNT = 3000;

/** Current year profit/loss (Aruandeaasta kasum/kahjum) */
export const CURRENT_YEAR_PROFIT_ACCOUNT = 3310;

/** Other financial expenses (Muud finantskulud) */
export const DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT = 8610;

/** Default debt-check accounts for compute_client_debt */
export const DEFAULT_DEBT_CHECK_ACCOUNTS = [DEFAULT_OWNER_PAYABLE_ACCOUNT, DEFAULT_LIABILITY_ACCOUNT, DEFAULT_ACCOUNTS_RECEIVABLE];
