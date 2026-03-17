import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ApiContext, isCompanyVatRegistered } from "./crud-tools.js";
import { computeAllBalances } from "./financial-statements.js";
import { roundMoney } from "../money.js";
import { create } from "../annotations.js";

async function validateAccounts(api: ApiContext, ...accountIds: number[]): Promise<string[]> {
  const accounts = await api.readonly.getAccounts();
  const accountMap = new Map(accounts.map(account => [account.id, account]));
  const errors: string[] = [];
  for (const id of new Set(accountIds)) {
    const account = accountMap.get(id);
    if (!account) {
      errors.push(`Account ${id} not found in chart of accounts`);
      continue;
    }
    if (!account.is_valid) {
      errors.push(
        `Account ${id} (${account.name_est}) is inactive. Activate in e-arveldaja: Seaded → Kontoplaan → ${account.name_est} → mark as active.`
      );
    }
  }
  return errors;
}

async function computeRetainedEarningsBalance(api: ApiContext, accountId: number, asOfDate?: string): Promise<number> {
  const allJournals = await api.journals.listAllWithPostings();
  let debit = 0;
  let credit = 0;

  for (const journal of allJournals) {
    if (journal.is_deleted) continue;
    if (!journal.registered) continue;
    if (asOfDate && journal.effective_date && journal.effective_date > asOfDate) continue;

    if (!journal.postings) continue;

    for (const posting of journal.postings) {
      if (posting.accounts_id !== accountId) continue;
      if (posting.is_deleted) continue;
      const amount = posting.base_amount ?? posting.amount;
      if (posting.type === "D") debit += amount;
      else if (posting.type === "C") credit += amount;
    }
  }

  // Retained earnings is a C-type account: balance = credit - debit
  return roundMoney(credit - debit);
}

export function registerEstonianTaxTools(server: McpServer, api: ApiContext): void {

  server.tool("prepare_dividend_package",
    "Calculate dividend distribution and create draft journal entries. " +
    "Estonian CIT on dividends: 22/78 (from 2025). " +
    "Creates a debit to retained earnings and credit to payable + tax liability. " +
    "Validates accounts exist and checks retained earnings balance before posting.",
    {
      net_dividend: z.number().describe("Net dividend amount to shareholder (EUR)"),
      shareholder_client_id: z.number().describe("Shareholder client ID"),
      effective_date: z.string().describe("Distribution date (YYYY-MM-DD)"),
      retained_earnings_account: z.number().optional().describe("Retained earnings account (default 3020)"),
      dividend_payable_account: z.number().optional().describe("Dividend payable account (default 2370)"),
      tax_payable_account: z.number().optional().describe("CIT payable account (default 2540)"),
      share_capital_account: z.number().optional().describe("Share capital account for ÄS §157 net-assets check (default 3000)"),
      force: z.boolean().optional().describe("Create journal even if retained earnings are insufficient (default false)"),
    },
    { ...create, title: "Prepare Dividend Package" },
    async ({ net_dividend, shareholder_client_id, effective_date, retained_earnings_account, dividend_payable_account, tax_payable_account, share_capital_account, force }) => {
      const retainedAccount = retained_earnings_account ?? 3020;
      const payableAccount = dividend_payable_account ?? 2370;
      const taxAccount = tax_payable_account ?? 2540;
      const shareCapitalAccount = share_capital_account ?? 3000;

      // Validate all accounts exist in chart of accounts
      const accountErrors = await validateAccounts(api, retainedAccount, payableAccount, taxAccount, shareCapitalAccount);
      if (accountErrors.length > 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Account validation failed",
              details: accountErrors,
              hint: "Use list_accounts to find correct account numbers.",
            }, null, 2),
          }],
        };
      }

      // Estonian CIT rate on dividends: 22/78 of net dividend
      const taxRate = 22 / 78;
      const cit = roundMoney(net_dividend * taxRate);
      const grossDividend = net_dividend + cit;

      // Check retained earnings balance
      const retainedBalance = await computeRetainedEarningsBalance(api, retainedAccount, effective_date);
      const warnings: string[] = [];
      if (retainedBalance < grossDividend) {
        if (!force) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "Insufficient retained earnings",
                retained_earnings_balance: retainedBalance,
                gross_dividend_required: roundMoney(grossDividend),
                shortfall: roundMoney(grossDividend - retainedBalance),
                calculation: { net_dividend, cit_rate: "22/78", cit_amount: cit, gross_dividend: roundMoney(grossDividend) },
                hint: "Distribution may be unlawful per ÄS § 157. Set force=true to create the journal anyway.",
              }, null, 2),
            }],
          };
        }
        warnings.push(
          `Retained earnings balance (${retainedBalance} EUR) is less than gross dividend (${roundMoney(grossDividend)} EUR). ` +
          `Verify that distribution is lawful per ÄS § 157. Journal created because force=true.`
        );
      }

      const balances = await computeAllBalances(api, undefined, effective_date);
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

      const result = await api.journals.create({
        title: `Dividendi väljamakse - ${shareholder.name}`,
        effective_date,
        clients_id: shareholder_client_id,
        cl_currencies_id: "EUR",
        document_number: `DIV-${effective_date}`,
        postings,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
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
          }, null, 2),
        }],
      };
    }
  );

  server.tool("create_owner_expense_reimbursement",
    "Book an owner-paid business expense: expense account + VAT + payable to owner. " +
    "Common for micro-OÜs where the owner pays with personal funds. " +
    "Books input VAT separately only for VAT-registered companies and validates accounts in chart of accounts.",
    {
      owner_client_id: z.number().describe("Owner/shareholder client ID"),
      effective_date: z.string().describe("Expense date (YYYY-MM-DD)"),
      description: z.string().describe("Expense description"),
      net_amount: z.number().describe("Net amount (without VAT)"),
      vat_rate: z.number().describe("VAT rate as decimal (e.g. 0.24 for 24%, 0.13, 0.09, 0.05, or 0 for no VAT/non-deductible)"),
      vat_amount: z.number().optional().describe("Exact VAT amount (overrides vat_rate if provided)"),
      expense_account: z.number().describe("Expense account number (e.g. 5000, 6000)"),
      vat_account: z.number().optional().describe("Input VAT account (default 1510)"),
      payable_account: z.number().optional().describe("Payable to owner account (default 2110)"),
      document_number: z.string().optional().describe("Receipt/document number"),
    },
    { ...create, title: "Book Owner Expense" },
    async ({ owner_client_id, effective_date, description, net_amount, vat_rate, vat_amount, expense_account, vat_account, payable_account, document_number }) => {
      const vatRegistered = await isCompanyVatRegistered(api);
      const vatAcc = vat_account ?? 1510;
      const payAcc = payable_account ?? 2110;

      // Validate all accounts exist
      const accountsToCheck = [expense_account, payAcc];
      const vat = vat_amount ?? roundMoney(net_amount * vat_rate);
      if (vat > 0 && vatRegistered) accountsToCheck.push(vatAcc);

      const accountErrors = await validateAccounts(api, ...accountsToCheck);
      if (accountErrors.length > 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "Account validation failed",
              details: accountErrors,
              hint: "Use list_accounts to find correct account numbers.",
            }, null, 2),
          }],
        };
      }

      const total = roundMoney(net_amount + vat);
      const expenseDebit = vatRegistered ? net_amount : total;

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

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
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
          }, null, 2),
        }],
      };
    }
  );
}
