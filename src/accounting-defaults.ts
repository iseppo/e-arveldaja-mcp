/** Default Estonian chart-of-accounts numbers used as fallbacks across tools. */

/** Accounts payable (Tarnijate võlgnevus) */
export const DEFAULT_LIABILITY_ACCOUNT = 2310;

/** Input VAT (Sisendkäibemaks) */
export const DEFAULT_VAT_ACCOUNT = 1510;

/** Payable to owner (Võlg omanikule) */
export const DEFAULT_OWNER_PAYABLE_ACCOUNT = 2110;

/** Accounts receivable (Ostjate ettemaksed / nõuded) */
export const DEFAULT_ACCOUNTS_RECEIVABLE = 1210;

/**
 * Retained earnings (Eelmiste perioodide jaotamata kasum), e-arveldaja standard
 * chart account 2960. Used only as a last-resort fallback — the tools resolve
 * the account by name against the company's actual chart first (see
 * `src/account-resolution.ts`), because account NUMBERS can differ across
 * companies while the RTJ-standard NAMES are stable.
 */
export const RETAINED_EARNINGS_ACCOUNT = 2960;

/** Dividend payable (Dividendivõlad), standard chart 2650. Name-resolved first. */
export const DIVIDEND_PAYABLE_ACCOUNT = 2650;

/**
 * Dividend income-tax payable (Dividenditulumaksu võlg), standard chart 2656 —
 * the liability for the 22/78 CIT triggered by a dividend distribution (TuMS
 * § 50). Name-resolved first. (NOT 2540 "Kogumispensioni maksed" — the old
 * default pointed at the mandatory-pension-payments account.)
 */
export const CIT_PAYABLE_ACCOUNT = 2656;

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

/**
 * Share capital (Osakapital või aktsiakapital nimiväärtuses), e-arveldaja
 * standard chart 2900. Name-resolved first. (NOT 3000 "Põhivara müügi
 * vahekonto" — the old default pointed at the fixed-asset-sale clearing account,
 * which would make the ÄS § 157(2) net-assets legality check read the wrong
 * balance.)
 */
export const SHARE_CAPITAL_ACCOUNT = 2900;

/**
 * Statutory reserve capital (Kohustuslik reservkapital), standard chart 2940 —
 * an ÄS § 157(2) restricted reserve. Name-resolved first.
 */
export const RESERVE_CAPITAL_ACCOUNT = 2940;

/** Current year profit/loss (Aruandeaasta kasum/kahjum) */
export const CURRENT_YEAR_PROFIT_ACCOUNT = 2970;

/** Other financial expenses (Muud finantskulud) */
export const DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT = 8610;

/**
 * Other financial income (Muud finantstulud), e-arveldaja standard chart 8600.
 * Name-resolved first. Default for booking Lightyear platform rewards/bonuses,
 * which the owner classifies as broker fee/campaign income, NOT securities
 * income (securities gains/dividends use 8330) — see the Lightyear booking
 * workflow. (The old default pointed at "Muud äritulud" 3800, which did not
 * exist in the standard chart.)
 */
export const DEFAULT_OTHER_FINANCIAL_INCOME_ACCOUNT = 8600;

/**
 * Exchange-rate gain/loss (Kasum/kahjum valuutakursi muutustest), e-arveldaja
 * standard chart 8500 — a SINGLE combined account for both directions. Both the
 * gain and the loss default resolve to it (name-resolved first). (The old
 * DEFAULT_FX_LOSS_ACCOUNT=8600 pointed at "Muud finantstulud", a financial
 * INCOME account, so an FX loss would post to income with the wrong sign.)
 */
export const DEFAULT_FX_GAIN_ACCOUNT = 8500;

/** Exchange-rate loss — same combined standard account 8500 as the gain. */
export const DEFAULT_FX_LOSS_ACCOUNT = 8500;

/**
 * Securities income (Tulu aktsiatelt ja osadelt), standard chart 8330 — realized
 * gains on sells and dividends from directly-held shares. Name-resolved first.
 */
export const SECURITIES_INCOME_ACCOUNT = 8330;

/**
 * Securities expense (Kulu aktsiatelt ja osadelt), standard chart 8335 — realized
 * losses on sells and securities-trade fees. Name-resolved first.
 */
export const SECURITIES_EXPENSE_ACCOUNT = 8335;

/** Default debt-check accounts for compute_client_debt */
export const DEFAULT_DEBT_CHECK_ACCOUNTS = [DEFAULT_OWNER_PAYABLE_ACCOUNT, DEFAULT_LIABILITY_ACCOUNT, DEFAULT_ACCOUNTS_RECEIVABLE];
