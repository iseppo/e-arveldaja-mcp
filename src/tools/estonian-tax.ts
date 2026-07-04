import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import { type ApiContext, isCompanyVatRegistered, coerceId } from "./crud-tools.js";
import { computeAllBalances, sumCategory, type AccountBalance } from "./financial-statements.js";
import { roundMoney } from "../money.js";
import { create, readOnly } from "../annotations.js";
import { computeRepresentationCostLimit, computeDonationLimit, classifyExpenseForVat } from "../estonian-tax-rules.js";
import { logAudit } from "../audit-log.js";
import { validateAccounts } from "../account-validation.js";
import { toolError } from "../tool-error.js";
import { computeAccountBalance } from "./account-balance.js";
import { RETAINED_EARNINGS_ACCOUNT, DIVIDEND_PAYABLE_ACCOUNT, CIT_PAYABLE_ACCOUNT, INCOME_TAX_EXPENSE_ACCOUNT, SHARE_CAPITAL_ACCOUNT, DEFAULT_VAT_ACCOUNT, DEFAULT_OWNER_PAYABLE_ACCOUNT } from "../accounting-defaults.js";
import type { Account } from "../types/api.js";
import {
  getDefaultOwnerExpenseVatDeductionMode,
  getDefaultOwnerExpenseVatDeductionRatio,
  getOwnerExpenseVatDeductionModeForAccount,
  getOwnerExpenseVatDeductionRatioForAccount,
} from "../accounting-rules.js";
import { buildOwnerExpenseVatReviewGuidance } from "../estonian-accounting-guidance.js";

function requiresOwnerExpenseVatReview(accountName: string | undefined, description: string): boolean {
  const { isPassengerCar, isEntertainmentOrHospitality } = classifyExpenseForVat(`${accountName ?? ""} ${description}`);
  return isPassengerCar || isEntertainmentOrHospitality;
}

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Strict YYYY-MM-DD + calendar validity (rejects 2025-02-31, 01.01.2025, etc.).
// Round-trips through Date to catch month/day overflow that regex alone allows.
function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_REGEX.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

const isoDateSchema = (description: string) =>
  z.string().refine(isValidIsoDate, { message: "Expected valid YYYY-MM-DD date" }).describe(description);

/**
 * Estonian corporate income tax rate on distributed profits (KMS § 50).
 * Rate changed from 20/80 to 22/78 on 2025-01-01. ISO-date string compare is
 * only safe for strict YYYY-MM-DD, so we reject anything else defensively —
 * a DD.MM.YYYY value would compare lexically wrong and silently pick 20/80
 * for a 2025 distribution.
 */
export function getCitRateForDate(effective_date: string): { num: number; den: number; formatted: string } {
  if (!isValidIsoDate(effective_date)) {
    throw new Error(`getCitRateForDate requires YYYY-MM-DD; got ${JSON.stringify(effective_date)}`);
  }
  if (effective_date < "2025-01-01") {
    return { num: 20, den: 80, formatted: "20/80" };
  }
  return { num: 22, den: 78, formatted: "22/78" };
}

/**
 * Resolve the profit-and-loss income-tax-expense account (the "Tulumaks" line)
 * for the dividend distribution tax. An explicit override always wins. Otherwise
 * auto-detect the lowest Kulud account in the 8900–8999 range — the same range
 * `annual-report.ts` maps to the RTJ Schema 1 "Tulumaks" line — so the booked
 * tax lands on the income-statement line the annual report reads it from. Falls
 * back to the INCOME_TAX_EXPENSE_ACCOUNT constant when the chart has no such
 * account (account validation then surfaces a helpful error).
 */
export function resolveIncomeTaxExpenseAccount(accounts: Account[], override?: number): number {
  if (override !== undefined) return override;
  const candidate = accounts
    .filter(a => a.account_type_est === "Kulud" && a.id >= 8900 && a.id <= 8999)
    .map(a => a.id)
    .sort((x, y) => x - y)[0];
  return candidate ?? INCOME_TAX_EXPENSE_ACCOUNT;
}

export function registerEstonianTaxTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "prepare_dividend_package",
    "Calculate dividend tax (22/78 CIT from 2025-01-01, 20/80 before) and create draft journal entries. Only the NET dividend drains retained earnings (Jaotamata kasum); the CIT is booked as an income-tax expense (kasumiaruande 'Tulumaks' rida) with an equal tax liability — per Estonian GAAP the dividend income tax is a current-period expense, not a direct reduction of retained earnings. Hard-blocks distributions that lack retained earnings or would push net assets below share capital (ÄS § 157) unless force=true.",
    {
      net_dividend: z.number().describe("Net dividend amount to shareholder (EUR)"),
      shareholder_client_id: coerceId.describe("Shareholder client ID"),
      effective_date: isoDateSchema("Distribution date (YYYY-MM-DD)"),
      retained_earnings_account: z.number().optional().describe("Retained earnings account debited with the NET dividend (default 3020)"),
      dividend_payable_account: z.number().optional().describe("Dividend payable account (default 2370)"),
      tax_payable_account: z.number().optional().describe("CIT payable (liability) account (default 2540)"),
      income_tax_expense_account: z.number().optional().describe("Income-tax expense account debited with the CIT — the P&L 'Tulumaks' line (default: lowest Kulud account in 8900–8999, else 8900)"),
      share_capital_account: z.number().optional().describe("Share capital account for ÄS §157 net-assets check (default 3000)"),
      force: z.boolean().optional().describe("Create journal even if retained earnings are insufficient (default false)"),
      dry_run: z.boolean().optional().describe("Preview calculation and postings without creating journal (default false)"),
    },
    { ...create, title: "Prepare Dividend Distribution" },
    async ({ net_dividend, shareholder_client_id, effective_date, retained_earnings_account, dividend_payable_account, tax_payable_account, income_tax_expense_account, share_capital_account, force, dry_run }) => {
      // Reject non-positive dividends up front — a zero or negative net
      // would otherwise compute gross=0 and book an empty journal with
      // zero-amount postings, which is noise on the ledger and passes
      // both legality checks vacuously.
      if (!(net_dividend > 0)) {
        return toolError({
          error: "net_dividend must be > 0",
          hint: "Pass a positive EUR amount to distribute.",
        });
      }
      const retainedAccount = retained_earnings_account ?? RETAINED_EARNINGS_ACCOUNT;
      const payableAccount = dividend_payable_account ?? DIVIDEND_PAYABLE_ACCOUNT;
      const taxAccount = tax_payable_account ?? CIT_PAYABLE_ACCOUNT;
      const shareCapitalAccount = share_capital_account ?? SHARE_CAPITAL_ACCOUNT;

      // Validate all accounts exist in chart of accounts
      const accounts = await api.readonly.getAccounts();
      // The CIT is a P&L expense, not a retained-earnings debit, so it needs a
      // dedicated income-tax-expense account. Resolve it against the chart the
      // caller's company actually uses (auto-detects the 8900-series "Tulumaks"
      // account) rather than assuming a fixed number.
      const incomeTaxExpenseAccount = resolveIncomeTaxExpenseAccount(accounts, income_tax_expense_account);
      const accountErrors = validateAccounts(accounts, [
        { id: retainedAccount, label: "Retained earnings account" },
        { id: payableAccount, label: "Dividend payable account" },
        { id: taxAccount, label: "Tax payable account" },
        { id: incomeTaxExpenseAccount, label: "Income-tax expense account" },
        { id: shareCapitalAccount, label: "Share capital account" },
      ]);
      if (accountErrors.length > 0) {
        return toolError({
          error: "Account validation failed",
          details: accountErrors,
          hint: "Use list_accounts to find correct account numbers.",
        });
      }

      // Estonian CIT rate on dividends: date-keyed per KMS § 50
      // (20/80 pre-2025, 22/78 from 2025-01-01).
      const citRate = getCitRateForDate(effective_date);
      const taxRate = citRate.num / citRate.den;
      const cit = roundMoney(net_dividend * taxRate);
      const grossDividend = roundMoney(net_dividend + cit);

      // Preload journals once for both retained earnings and balance sheet checks
      const allJournals = await api.journals.listAllWithPostings();

      // Evaluate both legality checks up front as pure data so composition
      // is explicit: the caller sees BOTH violations in a single error when
      // both trigger, and dry_run previews are always complete (warnings
      // and net_assets_check included even when force=true would proceed).
      const retainedResult = await computeAccountBalance(api, retainedAccount, undefined, undefined, effective_date, allJournals);
      const retainedBalance = retainedResult.balance;
      const warnings: string[] = [];

      // Guard the manual override: auto-detection only ever picks a Kulud
      // account, but an explicit income_tax_expense_account is existence-checked,
      // not type-checked. A mistyped override (e.g. an equity or liability
      // account) would silently book the CIT to the wrong statement line, so
      // warn — non-blocking — when the resolved account is not an expense.
      const incomeTaxExpenseRecord = accounts.find(a => a.id === incomeTaxExpenseAccount);
      if (incomeTaxExpenseRecord && incomeTaxExpenseRecord.account_type_est !== "Kulud") {
        warnings.push(
          `Income-tax expense account ${incomeTaxExpenseAccount} (${incomeTaxExpenseRecord.name_est}) is not an expense (Kulud) account. ` +
          `The dividend CIT belongs on the P&L 'Tulumaks' expense line (Kulud, usually 8900–8999). Verify income_tax_expense_account.`
        );
      }

      const balances = await computeAllBalances(api, undefined, effective_date, {
        preloadedAccounts: accounts,
        preloadedJournals: allJournals,
      });
      // Net assets = equity + current-year P&L. Revenue/expense accounts
      // (Tulud/Kulud) are not closed into Omakapital until year-end, so the
      // equity total alone understates net assets mid-year. Fold current-year
      // P&L in explicitly — shares `sumCategory` with `compute_balance_sheet`
      // so both tools agree bit-identically on the same ledger.
      const byCategory = (cat: string): AccountBalance[] =>
        balances.filter(b => b.account_type_est === cat);
      const totalAssets = sumCategory(byCategory("Varad"), "D");
      const totalLiabilities = sumCategory(byCategory("Kohustused"), "C");
      const totalEquity = sumCategory(byCategory("Omakapital"), "C");
      const totalRevenue = sumCategory(byCategory("Tulud"), "C");
      const totalExpenses = sumCategory(byCategory("Kulud"), "D");
      const currentYearPL = roundMoney(totalRevenue - totalExpenses);
      const shareCapital = balances.find(balance => balance.account_id === shareCapitalAccount)?.balance ?? 0;
      const netAssetsBeforeDistribution = roundMoney(totalEquity + currentYearPL);
      const netAssetsAfterDistribution = roundMoney(netAssetsBeforeDistribution - grossDividend);
      const roundedShareCapital = roundMoney(shareCapital);

      // Cross-check: on a balanced ledger, Assets − Liabilities must equal
      // Equity + P&L. A mismatch indicates unbalanced or partially-deleted
      // journals, which means the retained-earnings and §157 net-assets checks
      // below are computed from an untrustworthy ledger. Hard-block unless
      // force=true so legal-distribution output is never produced from a broken
      // balance sheet. Tolerance 0.05 accounts for rounding drift across the 5
      // sub-totals (each rounded independently at up to 0.005 EUR).
      const assetsMinusLiabilities = roundMoney(totalAssets - totalLiabilities);
      const ledgerImbalance = Math.abs(assetsMinusLiabilities - netAssetsBeforeDistribution) > 0.05;
      if (ledgerImbalance) {
        warnings.push(
          `Ledger imbalance: Assets − Liabilities (${assetsMinusLiabilities} EUR) ` +
          `does not equal Equity + current-year P&L (${netAssetsBeforeDistribution} EUR). ` +
          `Retained-earnings and §157 net-assets checks are unreliable on this ledger. ` +
          `Investigate unregistered/deleted journals before distributing.`
        );
      }

      const retainedShortfall = retainedBalance < grossDividend;
      const netAssetsBreach = netAssetsAfterDistribution < roundedShareCapital - 0.01;
      const violations: string[] = [];
      if (ledgerImbalance) violations.push("Ledger is imbalanced — legality checks cannot be trusted");
      if (retainedShortfall) violations.push("Insufficient retained earnings");
      if (netAssetsBreach) violations.push("ÄS § 157 net assets breach");

      if (violations.length > 0 && !force) {
        // Report every triggered legality violation in one response so the
        // operator sees the full picture. ÄS § 157 is explicitly the
        // framework for retained-earnings distribution legality, so a
        // retained shortfall is already a § 157 signal; the net-assets
        // check covers the separate share-capital clause.
        return toolError({
          error: violations.join("; "),
          ...(retainedShortfall && {
            retained_earnings_check: {
              balance: retainedBalance,
              gross_dividend_required: roundMoney(grossDividend),
              shortfall: roundMoney(grossDividend - retainedBalance),
            },
          }),
          ...(netAssetsBreach && {
            net_assets_check: {
              net_assets_before_distribution: netAssetsBeforeDistribution,
              gross_dividend: roundMoney(grossDividend),
              net_assets_after_distribution: netAssetsAfterDistribution,
              share_capital: roundedShareCapital,
              share_capital_account: shareCapitalAccount,
              shortfall: roundMoney(roundedShareCapital - netAssetsAfterDistribution),
            },
          }),
          calculation: { net_dividend, cit_rate: citRate.formatted, cit_amount: cit, gross_dividend: roundMoney(grossDividend) },
          hint:
            retainedShortfall && netAssetsBreach
              ? "Both retained-earnings and § 157 net-assets clauses fail. Reduce the dividend, register a capital reduction first, or set force=true to override (unlawful absent additional action)."
              : retainedShortfall
                ? "Retained earnings are insufficient. Distribution may be unlawful per ÄS § 157. Set force=true to create the journal anyway."
                : "Distribution would push net assets below share capital, which ÄS § 157 prohibits. Reduce the dividend, register a capital reduction first, or set force=true to override (unlawful absent additional action).",
        });
      }

      if (retainedShortfall) {
        warnings.push(
          `Retained earnings balance (${retainedBalance} EUR) is less than gross dividend (${roundMoney(grossDividend)} EUR). ` +
          `Verify that distribution is lawful per ÄS § 157. Journal created because force=true.`
        );
      }
      if (netAssetsBreach) {
        warnings.push(
          `Net assets after distribution (${netAssetsAfterDistribution} EUR) would fall below share capital (${roundedShareCapital} EUR on account ${shareCapitalAccount}). ` +
          `Journal created because force=true. Verify ÄS § 157 compliance through a separate legal action (e.g. capital reduction).`
        );
      }

      const shareholder = await api.clients.get(shareholder_client_id);

      // Journal entry (Estonian GAAP / RTJ): the NET dividend is the only debit
      // to retained earnings (Jaotamata kasum) — it is what the resolution
      // distributes to the shareholder. The distribution income tax (TuMS § 50)
      // is a current-period income-tax EXPENSE (the P&L "Tulumaks" line), not a
      // reduction of retained earnings, so it debits the income-tax-expense
      // account. Credits go to dividend payable and the tax liability. Net
      // assets still fall by the full gross (both a dividend payable and a tax
      // liability arise), which is why the § 157 / retained-earnings checks
      // above stay gross-based.
      const postings = [
        { accounts_id: retainedAccount, type: "D" as const, amount: net_dividend },
        { accounts_id: incomeTaxExpenseAccount, type: "D" as const, amount: cit },
        { accounts_id: payableAccount, type: "C" as const, amount: net_dividend },
        { accounts_id: taxAccount, type: "C" as const, amount: cit },
      ];

      // Self-documenting title so an operator opening the journal in e-arveldaja
      // can see the split (net dividend vs. income-tax expense) without cross-
      // referencing the audit log. The API Posting type has no per-line
      // description field, so the split rationale has to live on the journal
      // itself.
      const journalData = {
        title: `Dividendi väljamakse - ${shareholder.name} (neto ${net_dividend} EUR, TuMa ${citRate.formatted} ${cit} EUR)`,
        effective_date,
        clients_id: shareholder_client_id,
        cl_currencies_id: "EUR",
        // Include shareholder ID so same-day distributions to different
        // shareholders don't collide on document_number.
        document_number: `DIV-${effective_date}-${shareholder_client_id}`,
        postings,
      };

      if (dry_run) {
        return {
          content: [{
            type: "text",
            text: toMcpJson({
              dry_run: true,
              calculation: {
                net_dividend,
                cit_rate: citRate.formatted,
                cit_amount: cit,
                gross_dividend: roundMoney(grossDividend),
              },
              booking: {
                retained_earnings_account: retainedAccount,
                retained_earnings_debit: net_dividend,
                income_tax_expense_account: incomeTaxExpenseAccount,
                income_tax_expense_debit: cit,
                note: "Only the net dividend drains retained earnings; the CIT is booked as income-tax expense (P&L 'Tulumaks').",
              },
              proposed_journal: journalData,
              shareholder: { id: shareholder.id, name: shareholder.name },
              // Mirror the executed path so the preview doesn't hide legality
              // context: an operator running dry_run with force=true must see
              // the same § 157 / retained-earnings signals they would on execute.
              retained_earnings_check: {
                account: retainedAccount,
                balance_before: retainedBalance,
                sufficient: retainedBalance >= grossDividend,
              },
              net_assets_check: {
                net_assets_before_distribution: netAssetsBeforeDistribution,
                gross_dividend: roundMoney(grossDividend),
                net_assets_after_distribution: netAssetsAfterDistribution,
                share_capital_account: shareCapitalAccount,
                share_capital: roundedShareCapital,
                sufficient: netAssetsAfterDistribution >= roundedShareCapital,
              },
              ...(warnings.length > 0 && { warnings }),
              note: "No journal created. Set dry_run=false to execute.",
            }),
          }],
        };
      }

      const result = await api.journals.create(journalData);
      logAudit({
        tool: "prepare_dividend_package", action: "CREATED", entity_type: "journal",
        entity_id: result.created_object_id,
        summary: `Dividend journal: ${net_dividend} EUR net to ${shareholder.name}, CIT ${cit} EUR`,
        details: {
          effective_date, client_name: shareholder.name, amount: grossDividend,
          total_net: net_dividend, total_gross: roundMoney(grossDividend),
          postings: postings.map(p => ({ accounts_id: p.accounts_id, type: p.type, amount: p.amount })),
          ...(warnings.length > 0 && { warnings }),
        },
      });

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            calculation: {
              net_dividend,
              cit_rate: citRate.formatted,
              cit_amount: cit,
              gross_dividend: roundMoney(grossDividend),
            },
            booking: {
              retained_earnings_account: retainedAccount,
              retained_earnings_debit: net_dividend,
              income_tax_expense_account: incomeTaxExpenseAccount,
              income_tax_expense_debit: cit,
              note: "Only the net dividend drains retained earnings; the CIT is booked as income-tax expense (P&L 'Tulumaks').",
            },
            retained_earnings_check: {
              account: retainedAccount,
              balance_before: retainedBalance,
              sufficient: retainedBalance >= grossDividend,
            },
            net_assets_check: {
              net_assets_before_distribution: netAssetsBeforeDistribution,
              gross_dividend: roundMoney(grossDividend),
              net_assets_after_distribution: netAssetsAfterDistribution,
              share_capital_account: shareCapitalAccount,
              share_capital: roundedShareCapital,
              sufficient: netAssetsAfterDistribution >= roundedShareCapital,
            },
            shareholder: { id: shareholder_client_id, name: shareholder.name },
            journal_entry: {
              api_response: result,
              postings: [
                { account: retainedAccount, type: "D", amount: net_dividend, description: `Dividend to ${shareholder.name} (net) — Jaotamata kasum` },
                { account: incomeTaxExpenseAccount, type: "D", amount: cit, description: `Tulumaksukulu ${citRate.formatted}, dividend to ${shareholder.name}` },
                { account: payableAccount, type: "C", amount: net_dividend, description: "Dividendide võlgnevus" },
                { account: taxAccount, type: "C", amount: cit, description: "Tulumaksu kohustus" },
              ],
            },
            ...(warnings.length > 0 && { warnings }),
          }),
        }],
      };
    }
  );

  registerTool(server, "create_owner_expense_reimbursement",
    "Create a journal for a business expense paid personally by the owner.",
    {
      owner_client_id: coerceId.describe("Owner/shareholder client ID"),
      effective_date: isoDateSchema("Expense date (YYYY-MM-DD)"),
      description: z.string().describe("Expense description"),
      net_amount: z.number().describe("Net amount (without VAT)"),
      vat_rate: z.number().describe("VAT rate as decimal (e.g. 0.24 for 24%, 0.13, 0.09, 0.05, or 0 for no VAT/non-deductible). Must be a fraction, NOT a percentage — use 0.24, not 24."),
      vat_amount: z.number().optional().describe("Exact VAT amount (overrides vat_rate if provided)"),
      vat_deduction_mode: z.enum(["none", "full", "partial"]).optional().describe("VAT deduction mode. Use partial with deductible_vat_amount."),
      deductible_vat_amount: z.number().optional().describe("Deductible part of VAT when vat_deduction_mode=partial, or an explicit deductible VAT amount to override the default or configured ratio."),
      expense_account: z.number().describe("Expense account number (e.g. 5000, 6000)"),
      vat_account: z.number().optional().describe("Input VAT account (default 1510)"),
      payable_account: z.number().optional().describe("Payable to owner account (default 2110)"),
      document_number: z.string().optional().describe("Receipt/document number"),
    },
    { ...create, title: "Book Owner-Paid Expense" },
    async ({
      owner_client_id,
      effective_date,
      description,
      net_amount,
      vat_rate,
      vat_amount,
      vat_deduction_mode,
      deductible_vat_amount,
      expense_account,
      vat_account,
      payable_account,
      document_number,
    }) => {
      if (vat_rate > 1) {
        return toolError({
          error: `vat_rate=${vat_rate} looks like a percentage. Pass a decimal fraction instead (e.g. 0.24 for 24%).`,
        });
      }
      const vatRegistered = await isCompanyVatRegistered(api);
      const vatAcc = vat_account ?? DEFAULT_VAT_ACCOUNT;
      const payAcc = payable_account ?? DEFAULT_OWNER_PAYABLE_ACCOUNT;
      const grossVat = vat_amount ?? roundMoney(net_amount * vat_rate);
      const accounts = await api.readonly.getAccounts();
      const expenseAccountRecord = accounts.find(account => account.id === expense_account);
      const requiresReview = requiresOwnerExpenseVatReview(expenseAccountRecord?.name_est ?? expenseAccountRecord?.name_eng, description);
      const configuredMode = getOwnerExpenseVatDeductionModeForAccount(expense_account) ?? getDefaultOwnerExpenseVatDeductionMode();
      const configuredRatio = getOwnerExpenseVatDeductionRatioForAccount(expense_account) ?? getDefaultOwnerExpenseVatDeductionRatio();

      if (vatRegistered && grossVat > 0 && vat_deduction_mode !== undefined && deductible_vat_amount !== undefined) {
        const differenceFromFull = Math.abs(deductible_vat_amount - grossVat);
        if (vat_deduction_mode === "none" && deductible_vat_amount > 0.01) {
          return toolError({
            error: "deductible_vat_amount conflicts with vat_deduction_mode='none'",
            hint: "Suggested default: remove deductible_vat_amount or set it to 0 when VAT should be non-deductible.",
          });
        }
        if (vat_deduction_mode === "full" && differenceFromFull >= 0.01) {
          return toolError({
            error: "deductible_vat_amount conflicts with vat_deduction_mode='full'",
            hint: "Suggested default: omit deductible_vat_amount for full deduction, or pass the full VAT amount explicitly.",
          });
        }
        if (vat_deduction_mode === "partial" && (deductible_vat_amount <= 0.01 || differenceFromFull < 0.01)) {
          return toolError({
            error: "deductible_vat_amount conflicts with vat_deduction_mode='partial'",
            hint: "Suggested default: pass only the deductible VAT portion when vat_deduction_mode='partial'.",
          });
        }
      }

      const deductionMode = !vatRegistered || grossVat <= 0
        ? "none"
        : vat_deduction_mode
          ?? (deductible_vat_amount !== undefined
            ? (Math.abs(deductible_vat_amount - grossVat) < 0.01 ? "full" : "partial")
            : configuredMode ?? "full");

      if (vatRegistered && grossVat > 0 && requiresReview && vat_deduction_mode === undefined && deductible_vat_amount === undefined && configuredMode === undefined) {
        const reviewGuidance = buildOwnerExpenseVatReviewGuidance({
          description,
          accountName: expenseAccountRecord?.name_est ?? expenseAccountRecord?.name_eng,
        });
        return toolError({
          error: "VAT deduction needs confirmation for this expense category",
          hint: reviewGuidance.recommendation,
          compliance_basis: reviewGuidance.compliance_basis,
          follow_up_questions: reviewGuidance.follow_up_questions,
          policy_hint: reviewGuidance.policy_hint,
          suggestions: [
            "If this is a standard business receipt with fully deductible VAT, rerun with vat_deduction_mode='full'.",
            "If this is passenger-car or mixed-use cost, rerun with vat_deduction_mode='partial' and deductible_vat_amount.",
            "If this is non-deductible VAT, rerun with vat_deduction_mode='none'.",
          ],
        });
      }

      if (deductionMode === "partial" && deductible_vat_amount === undefined && configuredRatio === undefined) {
        return toolError({
          error: "deductible_vat_amount is required when vat_deduction_mode=partial",
          hint: "Suggested default: set deductible_vat_amount explicitly or define a partial ratio in accounting-rules.md when the policy is stable.",
        });
      }

      const deductibleVat = !vatRegistered || grossVat <= 0
        ? 0
        : deductionMode === "full"
          ? grossVat
          : deductionMode === "partial"
            ? roundMoney(deductible_vat_amount ?? (configuredRatio !== undefined ? grossVat * configuredRatio : 0))
            : 0;

      if (deductibleVat < 0 || deductibleVat - grossVat > 0.01) {
        return toolError({
          error: `deductible_vat_amount must be between 0 and total VAT ${grossVat}`,
          hint: "Suggested default: keep the VAT non-deductible unless the source document and business-use analysis support deduction.",
        });
      }

      // Validate all accounts exist
      const accountErrors = validateAccounts(accounts, [
        { id: expense_account, label: "Expense account" },
        ...(deductibleVat > 0 && vatRegistered ? [{ id: vatAcc, label: "VAT account" }] : []),
        { id: payAcc, label: "Payable account" },
      ]);
      if (accountErrors.length > 0) {
        return toolError({
          error: "Account validation failed",
          details: accountErrors,
          hint: "Use list_accounts to find correct account numbers.",
        });
      }

      const total = roundMoney(net_amount + grossVat);
      const nonDeductibleVat = roundMoney(grossVat - deductibleVat);
      const expenseDebit = roundMoney(net_amount + nonDeductibleVat);

      // Defensive: the three postings below must balance to `total`. Rounding
      // at intermediate steps can drift by 1 cent in pathological VAT-deduction
      // combinations; refuse to create an unbalanced journal.
      const totalDebits = roundMoney(expenseDebit + (deductibleVat > 0 && vatRegistered ? deductibleVat : 0));
      if (totalDebits !== total) {
        return toolError({
          error: `Internal imbalance: sum of debits (${totalDebits}) would not equal credits (${total}).`,
          hint: "This is a rounding edge case in owner-expense reimbursement. Report with net_amount, vat_rate, vat_amount, vat_deduction_mode, deductible_vat_amount values.",
          details: [
            `net_amount=${net_amount}`,
            `grossVat=${grossVat}`,
            `deductibleVat=${deductibleVat}`,
            `nonDeductibleVat=${nonDeductibleVat}`,
            `expenseDebit=${expenseDebit}`,
            `total=${total}`,
          ],
        });
      }

      const postings: Array<{ accounts_id: number; type: "D" | "C"; amount: number }> = [
        { accounts_id: expense_account, type: "D", amount: expenseDebit },
      ];

      if (deductibleVat > 0 && vatRegistered) {
        postings.push({ accounts_id: vatAcc, type: "D", amount: deductibleVat });
      }

      postings.push({ accounts_id: payAcc, type: "C", amount: total });

      const result = await api.journals.create({
        title: description,
        effective_date,
        clients_id: owner_client_id,
        cl_currencies_id: "EUR",
        document_number,
        postings,
      });
      logAudit({
        tool: "create_owner_expense_reimbursement", action: "CREATED", entity_type: "journal",
        entity_id: result.created_object_id,
        summary: `Owner expense: ${description}, total ${total} EUR`,
        details: {
          effective_date, description, total_net: net_amount, total_vat: grossVat, deductible_vat: deductibleVat, total_gross: total,
          postings: postings.map(p => ({ accounts_id: p.accounts_id, type: p.type, amount: p.amount })),
        },
      });

      const suggestions: string[] = [];
      if (vatRegistered && grossVat > 0 && deductibleVat === grossVat) {
        suggestions.push("VAT was fully deducted by default. If this expense falls under passenger-car, representation, or mixed-use restrictions, rerun with vat_deduction_mode='partial' or 'none'.");
      } else if (vatRegistered && grossVat > 0 && deductibleVat === 0) {
        suggestions.push("VAT was treated as non-deductible. If the receipt supports deduction, rerun with vat_deduction_mode='full' or 'partial' and deductible_vat_amount.");
      }

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            expense: {
              description,
              net: net_amount,
              vat_rate: vat_amount !== undefined ? "custom" : `${roundMoney(vat_rate * 100)}%`,
              vat: grossVat,
              deductible_vat: deductibleVat,
              non_deductible_vat: nonDeductibleVat,
              total,
              vat_registered_company: vatRegistered,
              vat_deduction_mode: deductionMode,
              expense_debited: expenseDebit,
            },
            journal_entry: {
              api_response: result,
              postings: postings.map(p => ({
                account: p.accounts_id,
                type: p.type,
                amount: p.amount,
              })),
            },
            note: vatRegistered
              ? `Expense booked. Owner debt increased by ${total} EUR on account ${payAcc}.`
              : `Expense booked. Company is not VAT-registered, so the full gross amount was debited to expense account ${expense_account}. Owner debt increased by ${total} EUR on account ${payAcc}.`,
            ...(suggestions.length > 0 ? { suggestions } : {}),
          }),
        }],
      };
    }
  );

  registerTool(server, "check_tax_free_limits",
    "Compute the cumulative TuMS § 49 tax-free limits (representation costs 50 €/month + 2% of payroll; donations 3% of payroll or 10% of prior-year profit) and the income tax (22/78) on any excess. Pure calculator over caller-supplied year-to-date figures — get payroll from the TSD declaration and prior-year profit from compute_profit_and_loss; it does not read the ledger.",
    {
      as_of_date: isoDateSchema("Date the cumulative figures are taken as of (YYYY-MM-DD). Sets the 22/78 rate and the default months elapsed."),
      ytd_social_taxed_payroll: z.number().describe("Year-to-date payments subject to social tax (the 2%/3% base)."),
      months_elapsed: z.number().int().min(1).max(12).optional().describe("Calendar months elapsed for the representation 50 €/month accrual. Defaults to the month of as_of_date."),
      ytd_representation_costs: z.number().optional().describe("Year-to-date representation/entertainment costs booked. Omit to skip the representation limit."),
      ytd_donations: z.number().optional().describe("Year-to-date gifts/donations to listed associations. Omit to skip the donation limit."),
      prior_year_profit: z.number().optional().describe("Prior financial year's profit (for the donation 10% alternative). Defaults to 0."),
      donation_basis: z.enum(["payroll", "profit", "max"]).optional().describe("Which donation limit to apply: 3% payroll, 10% prior-year profit, or the more favourable (default max)."),
    },
    { ...readOnly, title: "Check Tax-Free Limits" },
    async ({ as_of_date, ytd_social_taxed_payroll, months_elapsed, ytd_representation_costs, ytd_donations, prior_year_profit, donation_basis }) => {
      const citRate = getCitRateForDate(as_of_date);
      const incomeTaxOnExcess = (excess: number) => roundMoney(excess * citRate.num / citRate.den);
      const months = months_elapsed ?? Number(as_of_date.slice(5, 7));

      const result: Record<string, unknown> = {
        as_of_date,
        cit_rate: citRate.formatted,
      };

      if (ytd_representation_costs !== undefined) {
        const rep = computeRepresentationCostLimit({
          ytdSocialTaxedPayroll: ytd_social_taxed_payroll,
          monthsElapsed: months,
          ytdRepresentationCosts: ytd_representation_costs,
        });
        result.representation = { ...rep, income_tax_on_excess: incomeTaxOnExcess(rep.excess) };
      }

      if (ytd_donations !== undefined) {
        const don = computeDonationLimit({
          ytdSocialTaxedPayroll: ytd_social_taxed_payroll,
          priorYearProfit: prior_year_profit ?? 0,
          ytdDonations: ytd_donations,
          basisChoice: donation_basis,
        });
        result.donations = { ...don, income_tax_on_excess: incomeTaxOnExcess(don.excess) };
      }

      result.note = `Cumulative (year-to-date) view. Excess is taxed at the CIT rate ${citRate.formatted} and declared on the TSD. Confirm the payroll/profit figures with the company's actual declarations.`;

      return {
        content: [{
          type: "text",
          text: toMcpJson(result),
        }],
      };
    }
  );
}
