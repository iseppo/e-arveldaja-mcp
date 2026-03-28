import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import { type ApiContext, isCompanyVatRegistered, coerceId } from "./crud-tools.js";
import { computeAllBalances } from "./financial-statements.js";
import { roundMoney } from "../money.js";
import { create } from "../annotations.js";
import { logAudit } from "../audit-log.js";
import { validateAccounts } from "../account-validation.js";
import { toolError } from "../tool-error.js";
import { computeAccountBalance } from "./account-balance.js";
import { RETAINED_EARNINGS_ACCOUNT, DIVIDEND_PAYABLE_ACCOUNT, CIT_PAYABLE_ACCOUNT, SHARE_CAPITAL_ACCOUNT, DEFAULT_VAT_ACCOUNT, DEFAULT_OWNER_PAYABLE_ACCOUNT } from "../accounting-defaults.js";

export function registerEstonianTaxTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "prepare_dividend_package",
    "Calculate dividend tax (22/78 CIT) and create draft journal entries for dividend payable and tax liability. Validates retained earnings balance and net assets.",
    {
      net_dividend: z.number().describe("Net dividend amount to shareholder (EUR)"),
      shareholder_client_id: coerceId.describe("Shareholder client ID"),
      effective_date: z.string().describe("Distribution date (YYYY-MM-DD)"),
      retained_earnings_account: z.number().optional().describe("Retained earnings account (default 3020)"),
      dividend_payable_account: z.number().optional().describe("Dividend payable account (default 2370)"),
      tax_payable_account: z.number().optional().describe("CIT payable account (default 2540)"),
      share_capital_account: z.number().optional().describe("Share capital account for ÄS §157 net-assets check (default 3000)"),
      force: z.boolean().optional().describe("Create journal even if retained earnings are insufficient (default false)"),
      dry_run: z.boolean().optional().describe("Preview calculation and postings without creating journal (default false)"),
    },
    { ...create, title: "Prepare Dividend Distribution" },
    async ({ net_dividend, shareholder_client_id, effective_date, retained_earnings_account, dividend_payable_account, tax_payable_account, share_capital_account, force, dry_run }) => {
      const retainedAccount = retained_earnings_account ?? RETAINED_EARNINGS_ACCOUNT;
      const payableAccount = dividend_payable_account ?? DIVIDEND_PAYABLE_ACCOUNT;
      const taxAccount = tax_payable_account ?? CIT_PAYABLE_ACCOUNT;
      const shareCapitalAccount = share_capital_account ?? SHARE_CAPITAL_ACCOUNT;

      // Validate all accounts exist in chart of accounts
      const accounts = await api.readonly.getAccounts();
      const accountErrors = validateAccounts(accounts, [
        { id: retainedAccount, label: "Retained earnings account" },
        { id: payableAccount, label: "Dividend payable account" },
        { id: taxAccount, label: "Tax payable account" },
        { id: shareCapitalAccount, label: "Share capital account" },
      ]);
      if (accountErrors.length > 0) {
        return toolError({
          error: "Account validation failed",
          details: accountErrors,
          hint: "Use list_accounts to find correct account numbers.",
        });
      }

      // Estonian CIT rate on dividends: 22/78 of net dividend
      const taxRate = 22 / 78;
      const cit = roundMoney(net_dividend * taxRate);
      const grossDividend = roundMoney(net_dividend + cit);

      // Preload journals once for both retained earnings and balance sheet checks
      const allJournals = await api.journals.listAllWithPostings();

      // Check retained earnings balance
      const retainedResult = await computeAccountBalance(api, retainedAccount, undefined, undefined, effective_date, allJournals);
      const retainedBalance = retainedResult.balance;
      const warnings: string[] = [];
      if (retainedBalance < grossDividend) {
        if (!force) {
          return toolError({
            error: "Insufficient retained earnings",
            retained_earnings_balance: retainedBalance,
            gross_dividend_required: roundMoney(grossDividend),
            shortfall: roundMoney(grossDividend - retainedBalance),
            calculation: { net_dividend, cit_rate: "22/78", cit_amount: cit, gross_dividend: roundMoney(grossDividend) },
            hint: "Distribution may be unlawful per ÄS § 157. Set force=true to create the journal anyway.",
          });
        }
        warnings.push(
          `Retained earnings balance (${retainedBalance} EUR) is less than gross dividend (${roundMoney(grossDividend)} EUR). ` +
          `Verify that distribution is lawful per ÄS § 157. Journal created because force=true.`
        );
      }

      const balances = await computeAllBalances(api, undefined, effective_date, {
        preloadedAccounts: accounts,
        preloadedJournals: allJournals,
      });
      const totalAssets = balances
        .filter(balance => balance.account_type_est === "Varad")
        .reduce((sum, balance) => sum + (balance.balance_type === "D" ? balance.balance : -balance.balance), 0);
      const totalLiabilities = balances
        .filter(balance => balance.account_type_est === "Kohustused")
        .reduce((sum, balance) => sum + (balance.balance_type === "C" ? balance.balance : -balance.balance), 0);
      const shareCapital = balances.find(balance => balance.account_id === shareCapitalAccount)?.balance ?? 0;
      const netAssetsBeforeDistribution = roundMoney(totalAssets - totalLiabilities);
      const netAssetsAfterDistribution = roundMoney(netAssetsBeforeDistribution - grossDividend);
      const roundedShareCapital = roundMoney(shareCapital);

      if (netAssetsAfterDistribution < roundedShareCapital - 0.01) {
        warnings.push(
          `Net assets after distribution (${netAssetsAfterDistribution} EUR) would fall below share capital (${roundedShareCapital} EUR on account ${shareCapitalAccount}). ` +
          `Verify compliance with ÄS § 157 before proceeding.`
        );
      }

      const shareholder = await api.clients.get(shareholder_client_id);

      // Journal entry: Debit retained earnings, Credit dividend payable + tax payable
      const postings = [
        { accounts_id: retainedAccount, type: "D" as const, amount: grossDividend },
        { accounts_id: payableAccount, type: "C" as const, amount: net_dividend },
        { accounts_id: taxAccount, type: "C" as const, amount: cit },
      ];

      const journalData = {
        title: `Dividendi väljamakse - ${shareholder.name}`,
        effective_date,
        clients_id: shareholder_client_id,
        cl_currencies_id: "EUR",
        document_number: `DIV-${effective_date}`,
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
                cit_rate: "22/78",
                cit_amount: cit,
                gross_dividend: grossDividend,
              },
              proposed_journal: journalData,
              shareholder: { id: shareholder.id, name: shareholder.name },
              retained_earnings_balance: retainedBalance,
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
              cit_rate: "22/78",
              cit_amount: cit,
              gross_dividend: roundMoney(grossDividend),
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
                { account: retainedAccount, type: "D", amount: grossDividend, description: "Jaotamata kasum" },
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
    "Create a journal for a business expense paid personally by the owner. Splits input VAT for VAT-registered companies.",
    {
      owner_client_id: coerceId.describe("Owner/shareholder client ID"),
      effective_date: z.string().describe("Expense date (YYYY-MM-DD)"),
      description: z.string().describe("Expense description"),
      net_amount: z.number().describe("Net amount (without VAT)"),
      vat_rate: z.number().describe("VAT rate as decimal (e.g. 0.24 for 24%, 0.13, 0.09, 0.05, or 0 for no VAT/non-deductible). Must be a fraction, NOT a percentage — use 0.24, not 24."),
      vat_amount: z.number().optional().describe("Exact VAT amount (overrides vat_rate if provided)"),
      expense_account: z.number().describe("Expense account number (e.g. 5000, 6000)"),
      vat_account: z.number().optional().describe("Input VAT account (default 1510)"),
      payable_account: z.number().optional().describe("Payable to owner account (default 2110)"),
      document_number: z.string().optional().describe("Receipt/document number"),
    },
    { ...create, title: "Book Owner-Paid Expense" },
    async ({ owner_client_id, effective_date, description, net_amount, vat_rate, vat_amount, expense_account, vat_account, payable_account, document_number }) => {
      if (vat_rate > 1) {
        return toolError({
          error: `vat_rate=${vat_rate} looks like a percentage. Pass a decimal fraction instead (e.g. 0.24 for 24%).`,
        });
      }
      const vatRegistered = await isCompanyVatRegistered(api);
      const vatAcc = vat_account ?? DEFAULT_VAT_ACCOUNT;
      const payAcc = payable_account ?? DEFAULT_OWNER_PAYABLE_ACCOUNT;

      // Validate all accounts exist
      const accountsToCheck = [expense_account, payAcc];
      const vat = vat_amount ?? roundMoney(net_amount * vat_rate);
      if (vat > 0 && vatRegistered) accountsToCheck.push(vatAcc);

      const accounts = await api.readonly.getAccounts();
      const accountErrors = validateAccounts(accounts, [
        { id: expense_account, label: "Expense account" },
        ...(vat > 0 && vatRegistered ? [{ id: vatAcc, label: "VAT account" }] : []),
        { id: payAcc, label: "Payable account" },
      ]);
      if (accountErrors.length > 0) {
        return toolError({
          error: "Account validation failed",
          details: accountErrors,
          hint: "Use list_accounts to find correct account numbers.",
        });
      }

      const total = roundMoney(net_amount + vat);
      const expenseDebit = vatRegistered ? roundMoney(net_amount) : total;

      const postings: Array<{ accounts_id: number; type: "D" | "C"; amount: number }> = [
        { accounts_id: expense_account, type: "D", amount: expenseDebit },
      ];

      if (vat > 0 && vatRegistered) {
        postings.push({ accounts_id: vatAcc, type: "D", amount: vat });
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
          effective_date, description, total_net: net_amount, total_vat: vat, total_gross: total,
          postings: postings.map(p => ({ accounts_id: p.accounts_id, type: p.type, amount: p.amount })),
        },
      });

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            expense: {
              description,
              net: net_amount,
              vat_rate: vat_amount !== undefined ? "custom" : `${vat_rate * 100}%`,
              vat,
              total,
              vat_registered_company: vatRegistered,
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
          }),
        }],
      };
    }
  );
}
