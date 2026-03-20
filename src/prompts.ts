import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerPrompt } from "./mcp-compat.js";

export function registerPrompts(server: McpServer): void {

  registerPrompt(server, 
    "book-invoice",
    "Book a purchase invoice from a PDF file. Extracts invoice data, validates it, resolves the supplier, suggests booking accounts, and creates + confirms the invoice.",
    { file_path: z.string().describe("Absolute path to the PDF invoice file") },
    async ({ file_path }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Book the purchase invoice from the PDF at: ${file_path}

Follow these steps in order:

1. Call \`extract_pdf_invoice\` with file_path="${file_path}" to get the raw text and extraction hints.

2. Read the raw_text carefully and extract all of the following fields:
   - Supplier name and address
   - Supplier registry code (Estonian 8-digit code, if present)
   - Supplier VAT number (e.g. EE123456789, if present)
   - Invoice number
   - Invoice date (invoice_date) and due date (due_date) in YYYY-MM-DD format
   - Net amount (price without VAT)
   - VAT amount (vat_price)
   - Gross total (gross_price = net + VAT)
   - Line items: description, quantity, unit price, VAT rate, net amount per line
   - Supplier IBAN (bank account number)
   - Payment reference number

3. Call \`validate_invoice_data\` with the extracted totals and line items to check arithmetic consistency.
   Fix any rounding discrepancies before continuing.

4. Call \`detect_duplicate_purchase_invoice\` with the supplier name, invoice number, and invoice date to check for duplicates.
   If a duplicate is found, stop and report it — do not create a new invoice.

5. Call \`resolve_supplier\` with:
   - name: supplier name
   - reg_code: registry code (if found)
   - vat_no: VAT number (if found)
   - iban: IBAN (if found)
   - auto_create: true
   This will find or create the supplier client record and return a client_id.

6. Call \`suggest_booking\` with:
   - client_id: the supplier's client_id from step 5
   - description: the first line item description
   This returns a suggested expense account (purchase_accounts_id).

7. Determine if reverse charge VAT applies:
   - Reverse charge applies when the supplier is foreign (non-Estonian VAT number or no Estonian registry code) AND the invoice is for services (not goods).
   - If reverse charge applies, set reversed_vat_id: 1 on the invoice items.

8. Call \`create_purchase_invoice_from_pdf\` with ALL extracted data:
   - supplier client_id from step 5
   - invoice_number, invoice_date, due_date
   - price (net amount), vat_price (EXACT value from invoice), gross_price (EXACT value from invoice)
   - items array with purchase_accounts_id from step 6, quantities, prices, VAT rates
   - reversed_vat_id: 1 if reverse charge applies (step 7)
   - iban and reference number for payment tracking
   IMPORTANT: Use the EXACT vat_price and gross_price from the invoice — do not recalculate.

9. Call \`upload_invoice_document\` with:
   - id: the invoice ID returned in step 8
   - file_path: "${file_path}"

10. Call \`confirm_purchase_invoice\` with the invoice ID from step 8.

11. Report a summary:
    - Supplier name and client_id
    - Invoice number, date, due date
    - Net / VAT / Gross amounts
    - Booking account used
    - Whether reverse charge was applied
    - Invoice ID and confirmation status
`,
        },
      }],
    })
  );

  registerPrompt(server, 
    "reconcile-bank",
    "Match bank transactions to invoices and optionally auto-confirm exact matches.",
    { mode: z.string().optional().describe('Reconciliation mode: "auto" (default), "review", or a specific transaction ID') },
    async ({ mode }) => {
      const effectiveMode = mode ?? "auto";
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Reconcile bank transactions. Mode: ${effectiveMode}

Follow these steps:

1. Call \`reconcile_transactions\` with min_confidence: 30 to get all potential matches.

2. Present the matches grouped by confidence level:
   - HIGH confidence (≥80%): These are very likely correct matches
   - MEDIUM confidence (50–79%): These need a quick review
   - LOW confidence (<50%): These are uncertain — show for information only

   For each match show: transaction date, amount, description, matched invoice number, supplier/client name, and confidence score.

3. Based on the mode "${effectiveMode}":
   ${effectiveMode === "auto" ? `- AUTO mode: First call \`auto_confirm_exact_matches\` with dry_run: true to preview what would be confirmed.
   - Show the dry-run results and ask for approval.
   - After approval, call \`auto_confirm_exact_matches\` with dry_run: false to execute.` :
   effectiveMode === "review" ? `- REVIEW mode: Show all matches (high, medium, low confidence) for manual review.
   - For each match, ask the user to approve or skip.
   - Call \`confirm_transaction\` for each approved match.` :
   `- TRANSACTION ID mode: Show the match details for transaction ID ${effectiveMode}.
   - Ask for confirmation, then call \`confirm_transaction\` if approved.`}

4. List any unmatched transactions (no match found or confidence below threshold):
   - Show transaction date, amount, and description
   - Suggest possible actions (create invoice, mark as expense, etc.)

5. Report a final summary:
   - Total transactions processed
   - Number auto-confirmed / manually confirmed
   - Number unmatched
   - Total amount reconciled
`,
          },
        }],
      };
    }
  );

  registerPrompt(server, 
    "month-end-close",
    "Run the month-end close checklist: check for blockers, find missing documents, detect duplicates, and generate financial statements.",
    { month: z.string().describe('Month in YYYY-MM format, e.g. "2026-03"') },
    async ({ month }) => {
      // Parse month to get date range
      const [year, mm] = month.split("-");
      const lastDay = new Date(Number(year), Number(mm), 0).getDate();
      const startDate = `${month}-01`;
      const endDate = `${month}-${String(lastDay).padStart(2, "0")}`;

      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Run the month-end close checklist for ${month} (${startDate} to ${endDate}).

Follow these steps in order:

1. Call \`month_end_close_checklist\` with month: "${month}".
   Present the results clearly:
   - BLOCKERS (must fix before closing): unconfirmed journal entries, unconfirmed invoices, unregistered transactions
   - WARNINGS (should review): overdue receivables, unmatched bank transactions

2. If there are blockers, list them explicitly and ask the user whether to continue anyway or fix them first.

3. Call \`find_missing_documents\` for the date range ${startDate} to ${endDate}.
   List any purchase invoices or journal entries that are missing supporting documents.

4. Call \`detect_duplicate_purchase_invoice\` for the period to find any duplicate invoice entries.
   List any duplicates found.

5. Call \`compute_trial_balance\` for the period (start_date: "${startDate}", end_date: "${endDate}").
   Check that debits equal credits. If not balanced, flag this as a blocker.

6. Call \`compute_profit_and_loss\` for the year-to-date period:
   - start_date: "${year}-01-01"
   - end_date: "${endDate}"
   Show revenue, expenses, and net profit/loss YTD.

7. Call \`compute_balance_sheet\` as of the month end (as_of_date: "${endDate}").
   Show assets, liabilities, and equity totals.

8. Report a complete month-end summary:
   - Blockers: list each with resolution status
   - Warnings: list each
   - Missing documents: count and list
   - Duplicate invoices: count and list
   - Trial balance: balanced or unbalanced (with difference if any)
   - P&L YTD: revenue / expenses / net profit
   - Balance sheet totals: assets / liabilities / equity
   - Overall status: READY TO CLOSE or BLOCKED (with reasons)
`,
          },
        }],
      };
    }
  );

  registerPrompt(server, 
    "new-supplier",
    "Create a new supplier by looking up registry data and creating a client record.",
    { identifier: z.string().describe("Supplier name or 8-digit Estonian registry code") },
    async ({ identifier }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Create a new supplier for: ${identifier}

Follow these steps:

1. Determine what type of identifier this is:
   - If "${identifier}" consists of exactly 8 digits → it is an Estonian registry code
   - Otherwise → it is a supplier name

2. Search for the supplier in existing clients:
   - If it's a registry code: call \`find_client_by_code\` with code: "${identifier}"
   - If it's a name: call \`search_client\` with query: "${identifier}"

   If a match is found, show the existing client details and STOP — do not create a duplicate.

3. Call \`resolve_supplier\` with:
   - ${/^\d{8}$/.test(identifier) ? `reg_code: "${identifier}"` : `name: "${identifier}"`}
   - auto_create: false
   This will look up the Estonian Business Registry for company data without creating anything.

4. Show the registry data found (company name, registry code, address, VAT number if any).
   Then ask the user to provide any additional details needed:
   - IBAN (bank account number for payments)
   - VAT number (if not already found and company is VAT-registered)
   - Email address (for invoice delivery)
   - Any other relevant details

5. Once you have all the data, call \`create_client\` with:
   - name: company name
   - code: registry code
   - invoice_vat_no: VAT number (if applicable)
   - iban: IBAN (if provided)
   - email: email (if provided)
   - All other relevant fields from registry data

6. Report the created supplier:
   - Client ID assigned
   - Name, registry code, VAT number
   - IBAN and email
   - Note any missing optional fields the user may want to add later
`,
        },
      }],
    })
  );

  registerPrompt(server, 
    "company-overview",
    "Get a comprehensive dashboard overview of the company's current financial state.",
    async () => {
      const today = new Date().toISOString().slice(0, 10);
      const yearStart = `${today.slice(0, 4)}-01-01`;
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Generate a comprehensive company financial overview dashboard.

Follow these steps:

1. Call \`get_vat_info\` to get the company VAT registration status and number.
   Call \`get_invoice_info\` to get company name, address, and contact details.
   (These two calls can be made in parallel.)

2. Call \`list_connections\` to show the active connection (company/account).

3. Call \`compute_balance_sheet\` as of today (${today}) to get current financial position.

4. Call \`compute_profit_and_loss\` for the current year:
   - start_date: "${yearStart}"
   - end_date: "${today}"

5. Call \`compute_receivables_aging\` to see outstanding customer invoices by age bucket.
   Call \`compute_payables_aging\` to see outstanding supplier invoices by age bucket.
   (These two calls can be made in parallel.)

6. Present a dashboard summary with these sections:

   **Company**
   - Name, VAT number, active connection

   **Balance Sheet (as of ${today})**
   - Total assets
   - Total liabilities
   - Total equity

   **Profit & Loss (${yearStart} – ${today})**
   - Total revenue
   - Total expenses
   - Net profit / loss

   **Receivables**
   - Total outstanding
   - Overdue amount (broken down by 30/60/90+ days)

   **Payables**
   - Total outstanding
   - Overdue amount (broken down by 30/60/90+ days)

   **Key Ratios** (if calculable)
   - Current ratio (if current assets/liabilities available)
   - Quick summary: healthy / watch / attention needed
`,
          },
        }],
      };
    }
  );

  registerPrompt(server, 
    "lightyear-booking",
    "Book Lightyear investment trades and distributions into e-arveldaja journals. " +
    "Parses CSV exports, pairs FX conversions, matches capital gains, and creates journal entries.",
    {
      statement_path: z.string().describe("Absolute path to Lightyear AccountStatement CSV file"),
      capital_gains_path: z.string().optional().describe("Absolute path to Lightyear CapitalGainsStatement CSV (required for sells)"),
      investment_account: z.string().describe("Investment asset account number (e.g. 1520)"),
      broker_account: z.string().describe("Broker cash account number (e.g. 1120)"),
      income_account: z.string().optional().describe("Distribution income account (e.g. 8320 or 8400)"),
    },
    async ({ statement_path, capital_gains_path, investment_account, broker_account, income_account }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Book Lightyear investment activity into e-arveldaja.

Statement CSV: ${statement_path}
${capital_gains_path ? `Capital gains CSV: ${capital_gains_path}` : "No capital gains CSV provided (sells will be skipped)."}
Investment account: ${investment_account}
Broker account: ${broker_account}
${income_account ? `Income account: ${income_account}` : ""}

Follow these steps in order:

1. Call \`parse_lightyear_statement\` with file_path: "${statement_path}".
   Review the output:
   - Number of buy/sell trades
   - Distributions (dividends, interest)
   - Deposits/withdrawals
   - FX pairing warnings (unmatched foreign currency trades)
   - BRICEKSP money market fund entries are automatically excluded

   Present a summary table of trades by ticker, type (Buy/Sell), and EUR amount.

${capital_gains_path ? `2. Call \`parse_lightyear_capital_gains\` with file_path: "${capital_gains_path}".
   This provides FIFO cost basis data needed for sell trades.
   Show: total cost basis, total proceeds, total capital gains/losses, and per-ticker breakdown.
` : `2. No capital gains CSV — sell trades will be skipped. Only buys and distributions will be booked.
`}
3. Call \`lightyear_portfolio_summary\` with file_path: "${statement_path}".
   This computes current holdings with weighted average cost.
   Show the portfolio: ticker, quantity, remaining cost EUR, avg cost per share.
   This helps verify the investment account balance after booking.

4. Call \`book_lightyear_trades\` with:
   - file_path: "${statement_path}"
   ${capital_gains_path ? `- capital_gains_file: "${capital_gains_path}"` : ""}
   - investment_account: ${investment_account}
   - broker_account: ${broker_account}
   - dry_run: true (ALWAYS preview first!)

   Review the dry run output:
   - Number of journal entries that would be created
   - Any skipped trades (missing cost basis, already booked via document_number)
   - Any warnings

   Present the preview and ask for confirmation before proceeding.

5. After user confirms, call \`book_lightyear_trades\` again with dry_run: false.
   Report: number of journals created, any errors.

${income_account ? `6. Call \`book_lightyear_distributions\` with:
   - file_path: "${statement_path}"
   - broker_account: ${broker_account}
   - income_account: ${income_account}
   - dry_run: true (preview first!)

   Review the distributions preview:
   - Dividends by ticker and amount
   - Withheld tax amounts (if any)

   After user confirms, call again with dry_run: false.
` : `6. If there are distributions in the statement, ask the user for an income_account number
   (e.g. 8320 for fund distributions, 8400 for interest income) before booking them
   with \`book_lightyear_distributions\`.
`}
7. Final summary:
   - Trades booked: count and total EUR
   - Distributions booked: count and total EUR
   - Skipped entries: count and reasons
   - Current portfolio value (from step 3)
   - Suggest verifying the investment account balance with \`compute_account_balance\`
     using account_id: ${investment_account}
`,
        },
      }],
    })
  );

  registerPrompt(server, 
    "quarterly-vat",
    "Prepare data for the quarterly VAT return (KMD — käibedeklaratsioon).",
    { quarter: z.string().describe('Quarter in format YYYY-QN, e.g. "2026-Q1"') },
    async ({ quarter }) => {
      // Parse quarter into date range
      const match = quarter.match(/^(\d{4})-Q([1-4])$/);
      if (!match) {
        return {
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: `Invalid quarter format "${quarter}". Please use YYYY-QN format, e.g. "2026-Q1".`,
            },
          }],
        };
      }
      const year = match[1]!;
      const q = Number(match[2]);
      const quarterMonths: Record<number, [string, string]> = {
        1: ["01", "03"],
        2: ["04", "06"],
        3: ["07", "09"],
        4: ["10", "12"],
      };
      const [startMonth, endMonth] = quarterMonths[q]!;
      const lastDay = new Date(Number(year), Number(endMonth), 0).getDate();
      const startDate = `${year}-${startMonth}-01`;
      const endDate = `${year}-${endMonth}-${String(lastDay).padStart(2, "0")}`;

      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Prepare VAT return (KMD) data for ${quarter} (${startDate} to ${endDate}).

Follow these steps:

1. Call \`get_vat_info\` to confirm the company is VAT-registered (KMKR-kohustuslane).
   If the company is NOT VAT-registered, stop and inform the user that no KMD is required.

2. Call \`compute_trial_balance\` for the quarter:
   - start_date: "${startDate}"
   - end_date: "${endDate}"

   From the trial balance, identify and show these VAT-related accounts:
   - Account 1510 (Sisendkäibemaks / Input VAT deductible)
   - Account 1511 (Sisendkäibemaks 0% / Input VAT at 0%)
   - Output VAT accounts (typically 2310-series: Väljundkäibemaks)
   - Any reverse charge VAT accounts

3. Call \`list_sale_invoices\` filtered by date range (${startDate} to ${endDate}).
   Summarize sales by VAT rate:
   - Standard rate (24%): net amount and VAT amount
   - Reduced rate (9%): net amount and VAT amount
   - Zero rate (0%): net amount
   - Exempt / reverse charge: net amount

4. Call \`list_purchase_invoices\` filtered by date range (${startDate} to ${endDate}).
   Summarize purchases by VAT rate (same categories as above).
   Note any reverse charge purchase invoices separately.

5. Present the KMD preparation data:

   **${quarter} VAT Return Data**

   **Output VAT (Müügid / Sales)**
   - Row 1 (Taxable turnover at standard rate 24%): net amount
   - Row 1.1 (VAT at 24%): VAT amount
   - Row 2 (Taxable at reduced rate 9%): net amount
   - Row 2.1 (VAT at 9%): VAT amount
   - Row 3 (Zero-rated domestic/EU): net amount
   - Row 3.1 (EU intra-community supplies): amount
   - Row 4 (Exempt supplies): amount

   **Input VAT (Ostud / Purchases)**
   - Row 5 (Total purchases): gross amount
   - Row 5.1 (Deductible input VAT): VAT amount from account 1510
   - Reverse charge VAT: net and VAT amounts

   **Summary**
   - Output VAT total
   - Input VAT total (deductible)
   - NET VAT payable (positive = pay to Tax Board) or refundable (negative)

   **Important notes**:
   - KMD must be filed by the 20th of the month following the quarter end
   - ${quarter} deadline: ${Number(endMonth) === 12 ? `${Number(year) + 1}-01` : `${year}-${String(Number(endMonth) + 1).padStart(2, "0")}`}-20
   - Verify these figures against the official e-MTA portal before filing
`,
          },
        }],
      };
    }
  );
}
