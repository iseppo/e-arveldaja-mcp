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

/**
 * Corporate income tax expense (Tulumaksukulu) — the profit-and-loss "Tulumaks"
 * line under RTJ Schema 1, which `annual-report.ts` maps to Kulud accounts
 * 8900–8999. The income tax triggered by a dividend distribution (TuMS § 50) is
 * a current-period expense, NOT a direct reduction of retained earnings: only
 * the net dividend drains Jaotamata kasum, while the 22/78 tax hits this expense
 * line and an equal Tulumaksu kohustus liability. Default is the lowest 8900-
 * series expense account found in the chart; falls back to this constant.
 */
export const INCOME_TAX_EXPENSE_ACCOUNT = 8900;

/**
 * EMTA prepayment account (EMTA ettemaksukonto) — the single tax-authority
 * prepayment account all taxes are drawn from (post-2021). A bank transfer to
 * EMTA is a top-up of this asset account (Debit 1516 / Credit bank); the
 * tax-expense entries that draw it down are created by e-arveldaja itself from
 * the EMTA prepayment-account statement (Aruandlus → EMTA ettemaksukonto kanded),
 * not from the bank payment. So tax-payment transfers default their contra
 * account here, never to a tax-expense account or a purchase invoice.
 */
export const EMTA_PREPAYMENT_ACCOUNT = 1516;

/** Share capital (Osakapital) */
export const SHARE_CAPITAL_ACCOUNT = 3000;

/** Statutory reserve capital (Reservkapital), ÄS § 157(2) restricted reserve. */
export const RESERVE_CAPITAL_ACCOUNT = 3010;

/**
 * Reserves that ÄS § 157(2) makes non-distributable: net assets must stay at or
 * above share capital PLUS these reserves. Defaults to reservkapital (3010);
 * override per company when the articles mandate additional restricted reserves.
 */
export const DEFAULT_RESTRICTED_RESERVE_ACCOUNTS = [RESERVE_CAPITAL_ACCOUNT];

/** Current year profit/loss (Aruandeaasta kasum/kahjum) */
export const CURRENT_YEAR_PROFIT_ACCOUNT = 2970;

/** Other financial expenses (Muud finantskulud) */
export const DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT = 8610;

/**
 * Other operating income (Muud äritulud), 3800-series. Default for booking
 * Lightyear platform rewards, which are non-investment other income (real
 * investment income — fund distributions, interest — uses a caller-supplied
 * income account such as 8320/8400).
 */
export const DEFAULT_OTHER_OPERATING_INCOME_ACCOUNT = 3800;

/** Exchange rate gain (Kasum valuutakursi muutusest) */
export const DEFAULT_FX_GAIN_ACCOUNT = 8500;

/** Exchange rate loss (Kahjum valuutakursi muutusest) */
export const DEFAULT_FX_LOSS_ACCOUNT = 8600;

/** Default debt-check accounts for compute_client_debt */
export const DEFAULT_DEBT_CHECK_ACCOUNTS = [DEFAULT_OWNER_PAYABLE_ACCOUNT, DEFAULT_LIABILITY_ACCOUNT, DEFAULT_ACCOUNTS_RECEIVABLE];
