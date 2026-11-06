/**
 * ÄS § 157 dividend capacity, anchored on the owner's APPROVED annual report.
 *
 * lg 1 (NET-based): approved retained earnings + approved profit for the year,
 * minus every distribution booked since the report (registered or draft, any
 * later date). The ledger is only a cross-check of the approved figure.
 * lg 2 (GROSS-based): as-of net assets − (share capital + restricted reserves)
 * − commitments of drafts and of journals dated after the dividend date.
 *
 * Pure: no API access. All arithmetic is in integer cents.
 */
import type { Account, Journal, Posting } from "./types/api.js";
import { roundMoney } from "./money.js";
import {
  CALCULATED_RESULT_NAME,
  CURRENT_YEAR_PROFIT_NAME,
  RETAINED_EARNINGS_NAME,
  SHARE_CAPITAL_NAME,
} from "./account-resolution.js";
import {
  CALCULATED_RESULT_ACCOUNT,
  CURRENT_YEAR_PROFIT_ACCOUNT,
  RETAINED_EARNINGS_ACCOUNT,
  SHARE_CAPITAL_ACCOUNT,
} from "./accounting-defaults.js";

export interface CitRate { num: number; den: number }

/** The dividend CIT exactly as the booking computes it (rounded to cents). */
export function dividendCit(net: number, rate: CitRate): number {
  return roundMoney(net * (rate.num / rate.den));
}

const toCents = (amount: number): number => Math.round(roundMoney(amount) * 100);
const fromCents = (cents: number): number => roundMoney(cents / 100);

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export interface DividendRoles {
  /** Retained-earnings, result and calculated-result accounts. */
  eq: Set<number>;
  /** Every Omakapital account ∪ EQ. */
  allEq: Set<number>;
  /** Tulud ∪ Kulud. */
  pl: Set<number>;
}

/**
 * EQ by number and by name over the whole chart (inactive accounts included, so
 * history on a deactivated account is read), plus the configured result account.
 * A caller override never adds an account to a role.
 */
export function resolveDividendRoles(accounts: readonly Account[], configuredResultAccount?: number): DividendRoles {
  const eq = new Set<number>([RETAINED_EARNINGS_ACCOUNT, CURRENT_YEAR_PROFIT_ACCOUNT, CALCULATED_RESULT_ACCOUNT]);
  if (configuredResultAccount !== undefined) eq.add(configuredResultAccount);
  for (const a of accounts) {
    const name = a.name_est ?? "";
    if (RETAINED_EARNINGS_NAME.test(name) || CURRENT_YEAR_PROFIT_NAME.test(name) || CALCULATED_RESULT_NAME.test(name)) eq.add(a.id);
  }
  const allEq = new Set<number>(eq);
  const pl = new Set<number>();
  for (const a of accounts) {
    if (a.account_type_est === "Omakapital") allEq.add(a.id);
    if (a.account_type_est === "Tulud" || a.account_type_est === "Kulud") pl.add(a.id);
  }
  return { eq, allEq, pl };
}

export interface DividendTargets {
  retainedEarnings: number;
  incomeTaxExpense: number;
  dividendPayable: number;
  taxPayable: number;
  shareCapital: number;
}

/**
 * Role checks for the proposed journal (`dividend_target_invalid` when any
 * fails). Activity/existence is checked separately by validateAccounts.
 */
export function validateDividendTargets(
  accounts: readonly Account[],
  roles: DividendRoles,
  targets: DividendTargets,
): string[] {
  const byId = new Map(accounts.map(a => [a.id, a]));
  const problems: string[] = [];
  const describe = (id: number) => `${id}${byId.get(id)?.name_est ? ` (${byId.get(id)!.name_est})` : ""}`;
  const retained = byId.get(targets.retainedEarnings);
  if (!roles.eq.has(targets.retainedEarnings) || retained?.account_type_est !== "Omakapital") {
    problems.push(
      `Retained earnings account ${describe(targets.retainedEarnings)} is not a retained-earnings or result account ` +
      "(Eelmiste perioodide jaotamata kasum / Aruandeaasta kasum, or the result account configured in the accounting rules).",
    );
  }
  const cit = byId.get(targets.incomeTaxExpense);
  if (cit?.account_type_est !== "Kulud" || targets.incomeTaxExpense < 8900 || targets.incomeTaxExpense > 8999) {
    problems.push(`Income-tax expense account ${describe(targets.incomeTaxExpense)} is not on the annual-report 'Tulumaks' line (Kulud 8900–8999).`);
  }
  for (const [id, label] of [[targets.dividendPayable, "Dividend payable"], [targets.taxPayable, "Tax payable"]] as const) {
    if (byId.get(id)?.account_type_est !== "Kohustused") problems.push(`${label} account ${describe(id)} is not a liability (Kohustused) account.`);
  }
  const share = byId.get(targets.shareCapital);
  if (targets.shareCapital !== SHARE_CAPITAL_ACCOUNT && !SHARE_CAPITAL_NAME.test(share?.name_est ?? "")) {
    problems.push(`Share capital account ${describe(targets.shareCapital)} is not the share-capital account (Osakapital või aktsiakapital nimiväärtuses, standard 2900).`);
  }
  const roleList: Array<[string, number]> = [
    ["retained earnings", targets.retainedEarnings],
    ["income-tax expense", targets.incomeTaxExpense],
    ["dividend payable", targets.dividendPayable],
    ["tax payable", targets.taxPayable],
    ["share capital", targets.shareCapital],
  ];
  const seen = new Map<number, string>();
  for (const [role, id] of roleList) {
    const other = seen.get(id);
    if (other) problems.push(`Account ${describe(id)} is used both as ${other} and as ${role}.`);
    else seen.set(id, role);
  }
  return problems;
}

/** approved_report_year must be Y−1 or Y−2 (Y = year of the dividend date). */
export function approvedReportYearProblem(reportYear: number, effectiveDate: string): string | undefined {
  const y = Number(effectiveDate.slice(0, 4));
  if (reportYear <= y - 1 && reportYear >= y - 2) return undefined;
  return `approved_report_year ${reportYear} is outside ${y - 2}–${y - 1} for a dividend dated ${effectiveDate}: ` +
    "it must be the last approved annual report, at most two years before the dividend year (never the dividend year itself).";
}

// ---------------------------------------------------------------------------
// Valuation
// ---------------------------------------------------------------------------

type Side = "D" | "C";
const livePostings = (j: Journal): Array<Posting & { type: Side }> =>
  (j.postings ?? []).filter((p): p is Posting & { type: Side } => !p.is_deleted && (p.type === "D" || p.type === "C"));

const isUnverified = (j: Journal, p: Posting): boolean =>
  (p.cl_currencies_id ?? j.cl_currencies_id ?? "EUR") !== "EUR" && p.base_amount == null;

/** Σ(C−D) in cents over the journal's live postings on `set`; unverified postings are skipped (they hold elsewhere). */
function delta(j: Journal, set: (id: number) => boolean): number {
  let sum = 0;
  for (const p of livePostings(j)) {
    if (!set(p.accounts_id) || isUnverified(j, p)) continue;
    const cents = toCents(p.base_amount ?? p.amount);
    sum += p.type === "C" ? cents : -cents;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

export interface ApprovedReportFigures {
  reportYear: number;
  retainedEarnings: number;
  profitForYear: number;
}

export interface DividendCapacityInput {
  accounts: readonly Account[];
  journals: readonly Journal[];
  effectiveDate: string;
  approved: ApprovedReportFigures;
  ledgerDifferenceAcknowledged?: number;
  roles: DividendRoles;
  shareCapitalAccount: number;
  restrictedReserveAccounts: readonly number[];
}

export interface DistributionSinceReport {
  journal_id: number | null;
  document_number: string | null;
  effective_date: string;
  status: "registered" | "draft";
  /** max(0, −ΔEQ, −ΔALLEQ) in EUR. */
  d: number;
}

export interface DividendLg1Components {
  approved_report_year: number;
  approved_retained_earnings: number;
  approved_profit_for_year: number;
  approved_total: number;
  ledger_position_at_report_end: number;
  difference: number;
  difference_acknowledged: boolean;
  distributions_since_report: DistributionSinceReport[];
  total: number;
  distributable_profit: number;
  note: string;
}

export interface DividendCommitment {
  journal_id: number | null;
  document_number: string | null;
  effective_date: string;
  status: "registered" | "draft";
  net_assets_reduction: number;
  floor_increase: number;
  reserved: number;
}

export interface DividendLg2Components {
  net_assets_before_distribution: number;
  share_capital_account: number;
  share_capital: number;
  restricted_reserves: number;
  restricted_reserve_accounts: Array<{ account: number; balance: number }>;
  minimum_net_assets: number;
  commitments: number;
  commitment_journals: DividendCommitment[];
  headroom: number;
}

export type DividendCapacityHold =
  | {
      code: "approved_report_ledger_mismatch";
      approved_total: number;
      ledger_position_at_report_end: number;
      difference: number;
      ledger_difference_acknowledged: number | null;
    }
  | {
      code: "dividend_amount_unverified";
      postings: Array<{ journal_id: number | null; effective_date: string; account: number; currency: string }>;
    }
  | {
      code: "pre_report_equity_draft";
      journals: Array<{ journal_id: number | null; document_number: string | null; effective_date: string }>;
    }
  | {
      code: "pre_report_draft_reduces_net_assets";
      journals: Array<{ journal_id: number | null; document_number: string | null; effective_date: string }>;
    }
  | {
      code: "distribution_history_incomplete";
      boundary_opening_date: string;
      journals: Array<{ journal_id: number | null; effective_date: string }>;
    };

export type DividendCapacityHoldCode = DividendCapacityHold["code"];

/** Priority order: the first present hold names the error code. */
export const DIVIDEND_HOLD_PRIORITY: readonly DividendCapacityHoldCode[] = [
  "distribution_history_incomplete",
  "dividend_amount_unverified",
  "pre_report_equity_draft",
  "pre_report_draft_reduces_net_assets",
  "approved_report_ledger_mismatch",
];

export interface DividendCapacityResult {
  holds: DividendCapacityHold[];
  lg1: DividendLg1Components;
  lg2: DividendLg2Components;
  lg1Cents: number;
  headroomCents: number;
}

const reportEnd = (reportYear: number) => `${reportYear}-12-31`;
const boundaryOpeningDate = (reportYear: number) => `${reportYear + 1}-01-01`;
const identity = (j: Journal) => ({ journal_id: j.id ?? null, document_number: j.document_number ?? null, effective_date: j.effective_date });
const statusOf = (j: Journal): "registered" | "draft" => (j.registered === true ? "registered" : "draft");

/**
 * A registered opening (INITIAL) dated exactly on the day after the report
 * end carries the report-end position: it is read with the report-end ledger
 * (cross-check) and never as a distribution.
 */
const isBoundaryOpening = (j: Journal, reportYear: number) =>
  j.operation_type === "INITIAL" && j.registered === true && j.effective_date === boundaryOpeningDate(reportYear);

/** Ledger position L_R: Σ(C−D) on EQ ∪ Tulud/Kulud of registered journals up to the report end (plus a boundary opening). */
export function ledgerPositionAtReportEnd(journals: readonly Journal[], roles: DividendRoles, reportYear: number): number {
  const cutoff = reportEnd(reportYear);
  const inSet = (id: number) => roles.eq.has(id) || roles.pl.has(id);
  let cents = 0;
  for (const j of journals) {
    if (j.is_deleted || j.registered !== true) continue;
    if (j.effective_date <= cutoff || isBoundaryOpening(j, reportYear)) cents += delta(j, inSet);
  }
  return fromCents(cents);
}

export function computeDividendCapacity(input: DividendCapacityInput): DividendCapacityResult {
  const { journals, effectiveDate, approved, roles } = input;
  const R = approved.reportYear;
  const cutoff = reportEnd(R);
  const protectedAccounts = new Set<number>([input.shareCapitalAccount, ...input.restrictedReserveAccounts]);
  const inEq = (id: number) => roles.eq.has(id);
  const inAllEq = (id: number) => roles.allEq.has(id);
  const inNa = (id: number) => roles.allEq.has(id) || roles.pl.has(id);
  const inChecked = (id: number) => inNa(id) || protectedAccounts.has(id);
  const holds: DividendCapacityHold[] = [];

  const live = journals.filter(j => !j.is_deleted);
  const preReportDraft = (j: Journal) => j.registered !== true && j.effective_date <= cutoff;

  // History coverage: an opening after the report other than the boundary
  // opening means the distributions in between are not in the books.
  const lateOpenings = live.filter(j =>
    j.operation_type === "INITIAL" && j.registered === true && j.effective_date > cutoff && !isBoundaryOpening(j, R));
  if (lateOpenings.length > 0) {
    holds.push({
      code: "distribution_history_incomplete",
      boundary_opening_date: boundaryOpeningDate(R),
      journals: lateOpenings.map(j => ({ journal_id: j.id ?? null, effective_date: j.effective_date })),
    });
  }

  // Verified EUR: every posting feeding a calculation must be EUR or carry base_amount.
  const unverified: Array<{ journal_id: number | null; effective_date: string; account: number; currency: string }> = [];
  for (const j of live) {
    // A pre-report draft is read only when it touches net assets or the floor.
    if (preReportDraft(j) && !livePostings(j).some(p => inChecked(p.accounts_id))) continue;
    for (const p of livePostings(j)) {
      if (inChecked(p.accounts_id) && isUnverified(j, p)) {
        unverified.push({ journal_id: j.id ?? null, effective_date: j.effective_date, account: p.accounts_id, currency: p.cl_currencies_id ?? j.cl_currencies_id ?? "" });
      }
    }
  }
  if (unverified.length > 0) holds.push({ code: "dividend_amount_unverified", postings: unverified });

  // Pre-report drafts: only a reclassification neutral for lg 1, net assets
  // AND the floor (ΔEQ = 0, ΔNA = 0, no posting on a protected account — the
  // RIK result entry, the 2970 → 2960 transfer) is fine.
  const heldDrafts = live.filter(j => {
    if (!preReportDraft(j)) return false;
    const postings = livePostings(j);
    if (!postings.some(p => inAllEq(p.accounts_id) || protectedAccounts.has(p.accounts_id))) return false;
    return delta(j, inEq) !== 0 || delta(j, inNa) !== 0 || postings.some(p => protectedAccounts.has(p.accounts_id));
  });
  if (heldDrafts.length > 0) {
    holds.push({ code: "pre_report_equity_draft", journals: heldDrafts.map(identity) });
  }
  // A pre-report draft without an equity posting that reduces net assets
  // (e.g. a pending year-end expense): lg 2 would read net assets without it,
  // while the approved figures may already include it.
  const reducingDrafts = live.filter(j =>
    preReportDraft(j) && !heldDrafts.includes(j) && delta(j, inNa) < 0);
  if (reducingDrafts.length > 0) {
    holds.push({ code: "pre_report_draft_reduces_net_assets", journals: reducingDrafts.map(identity) });
  }

  // Cross-check of the approved figure.
  const approvedCents = toCents(approved.retainedEarnings) + toCents(approved.profitForYear);
  const ledgerCents = toCents(ledgerPositionAtReportEnd(journals, roles, R));
  const differenceCents = approvedCents - ledgerCents;
  const acknowledged = input.ledgerDifferenceAcknowledged !== undefined &&
    toCents(input.ledgerDifferenceAcknowledged) === differenceCents;
  if (differenceCents !== 0 && !acknowledged) {
    holds.push({
      code: "approved_report_ledger_mismatch",
      approved_total: fromCents(approvedCents),
      ledger_position_at_report_end: fromCents(ledgerCents),
      difference: fromCents(differenceCents),
      ledger_difference_acknowledged: input.ledgerDifferenceAcknowledged ?? null,
    });
  }

  // Distributions since the report: monotone d(j) ≥ 0.
  const sinceReport = live.filter(j => j.effective_date > cutoff && !isBoundaryOpening(j, R));
  let totalDCents = 0;
  const distributions: DistributionSinceReport[] = [];
  for (const j of sinceReport) {
    const d = Math.max(0, -delta(j, inEq), -delta(j, inAllEq));
    if (d === 0) continue;
    totalDCents += d;
    distributions.push({ ...identity(j), status: statusOf(j), d: fromCents(d) });
  }
  const lg1Cents = approvedCents - totalDCents;

  // lg 2: as-of net assets and floor over registered journals up to the dividend date.
  const asOf = live.filter(j => j.registered === true && j.effective_date <= effectiveDate);
  const naCents = asOf.reduce((s, j) => s + delta(j, inNa), 0);
  const balanceCents = (account: number) => asOf.reduce((s, j) => s + delta(j, id => id === account), 0);
  const shareCapitalCents = balanceCents(input.shareCapitalAccount);
  const reserveDetails = [...new Set(input.restrictedReserveAccounts)]
    .map(account => ({ account, cents: balanceCents(account) }))
    .filter(r => r.cents !== 0);
  const reserveFloorCents = reserveDetails.reduce((s, r) => s + Math.max(0, r.cents), 0);
  const floorCents = Math.max(0, shareCapitalCents) + reserveFloorCents;

  // Commitments: every draft since the report, and every registered journal
  // dated after the dividend date (d = 0 journals included).
  const commitments: DividendCommitment[] = [];
  let commitmentCents = 0;
  for (const j of sinceReport) {
    if (j.registered === true && j.effective_date <= effectiveDate) continue;
    const naReduction = Math.max(0, -delta(j, inNa));
    let floorIncrease = 0;
    for (const account of protectedAccounts) floorIncrease += Math.max(0, delta(j, id => id === account));
    const reserved = naReduction + floorIncrease;
    if (reserved === 0) continue;
    commitmentCents += reserved;
    commitments.push({
      ...identity(j), status: statusOf(j),
      net_assets_reduction: fromCents(naReduction), floor_increase: fromCents(floorIncrease), reserved: fromCents(reserved),
    });
  }
  const headroomCents = naCents - floorCents - commitmentCents;

  return {
    holds,
    lg1Cents,
    headroomCents,
    lg1: {
      approved_report_year: R,
      approved_retained_earnings: fromCents(toCents(approved.retainedEarnings)),
      approved_profit_for_year: fromCents(toCents(approved.profitForYear)),
      approved_total: fromCents(approvedCents),
      ledger_position_at_report_end: fromCents(ledgerCents),
      difference: fromCents(differenceCents),
      difference_acknowledged: differenceCents !== 0 && acknowledged,
      distributions_since_report: distributions,
      total: fromCents(totalDCents),
      distributable_profit: fromCents(lg1Cents),
      note:
        `lg 1 = approved ${R} report (retained earnings + profit for the year) − every equity distribution booked after ${cutoff} ` +
        "(registered or draft, any later date). Credits into equity after the report never raise it.",
    },
    lg2: {
      net_assets_before_distribution: fromCents(naCents),
      share_capital_account: input.shareCapitalAccount,
      share_capital: fromCents(shareCapitalCents),
      restricted_reserves: fromCents(reserveDetails.reduce((s, r) => s + r.cents, 0)),
      restricted_reserve_accounts: reserveDetails.map(r => ({ account: r.account, balance: fromCents(r.cents) })),
      minimum_net_assets: fromCents(floorCents),
      commitments: fromCents(commitmentCents),
      commitment_journals: commitments,
      headroom: fromCents(headroomCents),
    },
  };
}

/**
 * Largest integer-cent net n with n ≤ lg 1 and n + CIT(n) ≤ lg 2 headroom, CIT
 * rounded exactly as booked. n + CIT(n) is strictly increasing, so binary search.
 */
export function maxNetDividend(lg1Cents: number, headroomCents: number, rate: CitRate): {
  max_net_dividend: number;
  max_net_by_retained_earnings: number;
  max_net_by_net_assets: number;
  limited_by: "retained_earnings" | "net_assets";
} {
  const byRetained = Math.max(0, lg1Cents);
  let lo = 0;
  let hi = Math.max(0, headroomCents);
  const fits = (n: number) => n + toCents(dividendCit(n / 100, rate)) <= headroomCents;
  if (!fits(0)) hi = -1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  const byNetAssets = Math.max(0, hi < 0 ? 0 : lo);
  return {
    max_net_dividend: fromCents(Math.min(byRetained, byNetAssets)),
    max_net_by_retained_earnings: fromCents(byRetained),
    max_net_by_net_assets: fromCents(byNetAssets),
    limited_by: byRetained <= byNetAssets ? "retained_earnings" : "net_assets",
  };
}

export { toCents as dividendToCents };
