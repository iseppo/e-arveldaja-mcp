import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerPrompt } from "./mcp-compat.js";

export function registerPrompts(server: McpServer): void {

  registerPrompt(server, 
    "book-invoice",
    "Book a purchase invoice from a source document. Extracts invoice data, validates it, resolves the supplier, suggests booking accounts, previews the booking, and creates + confirms the invoice after approval.",
    { file_path: z.string().describe("Absolute path to the invoice document file (PDF/JPG/PNG)") },
    async ({ file_path }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Book the purchase invoice from the source document at: ${file_path}

Follow these steps in order:

1. Call \`extract_pdf_invoice\` with file_path="${file_path}" to get \`hints.raw_text\`, identifier hints, and \`llm_fallback\`.

2. Treat \`hints.raw_text\` as the source of truth for the whole document.
   - If \`llm_fallback.recommended=true\` or any identifier hint is missing, continue by reading \`hints.raw_text\` manually.
   - Do not stop just because the regex identifier hints are incomplete.

3. Read \`hints.raw_text\` carefully and extract all of the following fields:
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

4. Call \`validate_invoice_data\` with:
   - total_net: extracted net total
   - total_vat: extracted VAT total
   - total_gross: extracted gross total
   - items: JSON array of extracted line items
   - invoice_date and due_date
   If validation returns \`valid=false\` or any errors, stop and ask the user to review the extraction before creating anything.

5. Call \`resolve_supplier\` with:
   - name: supplier name
   - reg_code: registry code (if found)
   - vat_no: VAT number (if found)
   - iban: IBAN (if found)
   - auto_create: false
   This either returns an existing supplier match or, for Estonian registry-code lookups, registry data for a new supplier.

6. Duplicate check:
   - Call \`detect_duplicate_purchase_invoice\` with:
     - date_from: invoice_date
     - date_to: invoice_date
     - invoice_number: extracted invoice number
     - gross_price: extracted gross total
     - clients_id: resolved client.id if step 5 returned \`found=true\`
   - Inspect \`candidate_invoice_number_matches\` and \`candidate_same_amount_date_matches\` first.
   - Also inspect \`exact_duplicates\` and \`suspicious_same_amount_date\` as warning context for messy supplier histories.
   - If a candidate match looks like the same invoice, stop and report it before creating anything.

7. Ensure the supplier client exists:
   - If step 5 returned \`found=true\`, use \`client.id\` as \`supplier_client_id\`.
   - Otherwise call \`resolve_supplier\` again with the same identifiers and \`auto_create: true\`.
   - Use \`api_response.created_object_id\` as \`supplier_client_id\`. If no client ID is returned, stop and report the failure.

8. Call \`suggest_booking\` with:
   - clients_id: supplier_client_id
   - description: the first line item description
   Review \`past_invoices\` and reuse the most relevant \`cl_purchase_articles_id\`, \`purchase_accounts_id\`, and VAT fields
   (\`vat_rate_dropdown\`, \`vat_accounts_id\`, \`cl_vat_articles_id\`, \`reversed_vat_id\`) from a similar line.
   If there is no suitable history, call \`list_purchase_articles\` or ask the user instead of inventing purchase article IDs.

9. Determine VAT treatment per line:
   - For normal domestic invoices, keep the VAT treatment shown on the document.
   - Reverse charge applies when the supplier is foreign (non-Estonian VAT number or no Estonian registry code) AND the invoice is for services (not goods).
   - If reverse charge applies, set \`reversed_vat_id: 1\` on the affected service lines.

10. Derive the remaining invoice fields:
   - journal_date: normally invoice_date unless a different turnover date is clearly stated on the invoice.
   - term_days: the calendar-day difference between invoice_date and due_date.
   - If due_date is missing, use \`term_days: 0\` and mention that assumption in the final summary.

11. Present a booking preview and ask for approval before creating anything:
   - Supplier name and supplier_client_id
   - Invoice number, invoice_date, due_date, journal_date, and term_days
   - Net / VAT / Gross amounts
   - The exact item-level booking you intend to send, including \`cl_purchase_articles_id\`, \`purchase_accounts_id\`, VAT fields, and any \`reversed_vat_id\`
   - Booking basis used (which past invoice/article/account/VAT config was reused, or that it was chosen manually)
   - Any validation warnings or assumptions
   If the user has not explicitly approved the preview, stop here and wait.

12. After approval, call \`create_purchase_invoice_from_pdf\` with:
   - supplier_client_id
   - invoice_number
   - invoice_date
   - journal_date
   - term_days
   - items: JSON array with \`cl_purchase_articles_id\`, \`purchase_accounts_id\`, quantities, totals, VAT fields,
     \`vat_accounts_id\`, \`cl_vat_articles_id\`, and \`reversed_vat_id\` when applicable
   - vat_price: EXACT value from invoice
   - gross_price: EXACT value from invoice
   - ref_number
   - bank_account_no
   - notes: include the source PDF filename or any important assumptions
   IMPORTANT: Use the EXACT \`vat_price\` and \`gross_price\` from the invoice. Do not recalculate them.

13. Call \`upload_invoice_document\` with:
   - invoice_id: the invoice ID returned in step 12
   - file_path: "${file_path}"

14. Call \`confirm_purchase_invoice\` with:
   - id: the invoice ID from step 12

15. Report a summary:
    - Supplier name and supplier_client_id
    - Invoice number, date, due date
    - Net / VAT / Gross amounts
    - Booking basis used (which past invoice/article/account/VAT config was reused, or that it was chosen manually)
    - Whether reverse charge was applied
    - Any validation warnings or assumptions
    - Invoice ID and confirmation status
`,
        },
      }],
    })
  );

  registerPrompt(server, 
    "receipt-batch",
    "Scan a receipt folder, preview auto-bookable results, and only create purchase invoices after explicit approval.",
    {
      folder_path: z.string().describe("Absolute path to the receipt folder"),
      accounts_dimensions_id: z.number().describe("Bank account dimension ID used for bank transaction matching"),
      date_from: z.string().optional().describe("Optional receipt modified-date lower bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional receipt modified-date upper bound (YYYY-MM-DD)"),
    },
    async ({ folder_path, accounts_dimensions_id, date_from, date_to }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Process a receipt batch from: ${folder_path}

Bank account dimension ID: ${accounts_dimensions_id}
${date_from ? `Date from: ${date_from}` : ""}
${date_to ? `Date to: ${date_to}` : ""}

Follow these steps in order:

1. Call \`scan_receipt_folder\` with:
   - folder_path: "${folder_path}"
   ${date_from || date_to ? "- If the user asked for date filtering, mention that the scan itself does not apply date filters; the processing step does." : ""}

2. Present the scan results before doing anything else:
   - folder_path
   - total valid files found
   - skipped entries and their reasons
   - if there are zero valid files, stop here

3. Call \`process_receipt_batch\` with:
   - folder_path: "${folder_path}"
   - accounts_dimensions_id: ${accounts_dimensions_id}
   - execute: false
   ${date_from ? `- date_from: "${date_from}"` : ""}
   ${date_to ? `- date_to: "${date_to}"` : ""}

4. Review the dry run output carefully:
   - summary.created
   - summary.matched
   - summary.skipped_duplicate
   - summary.needs_review
   - summary.failed
   - summary.dry_run_preview
   - skipped
   - results

5. Present the preview grouped by status:
   - \`dry_run_preview\`: show file name, extracted supplier, invoice number, amounts, booking suggestion, supplier resolution, and any matching bank transaction. The purchase invoice has NOT been created yet. The document has NOT been uploaded yet. The invoice has NOT been confirmed yet.
   - \`skipped_duplicate\`: show the duplicate match and why it was skipped.
   - \`needs_review\`: show the file, classification, missing fields, llm_fallback, and notes.
   - \`failed\`: show the file and exact error.

6. Make the approval checkpoint explicit:
   - Say that \`execute: false\` was only a preview.
   - Do not imply that any invoice already exists.
   - Ask whether to proceed with \`execute: true\`.

7. If the user does not explicitly approve execution, stop here.

8. After approval, call \`process_receipt_batch\` again with:
   - folder_path: "${folder_path}"
   - accounts_dimensions_id: ${accounts_dimensions_id}
   - execute: true
   ${date_from ? `- date_from: "${date_from}"` : ""}
   ${date_to ? `- date_to: "${date_to}"` : ""}

9. Report the execution summary:
   - created
   - matched
   - skipped_duplicate
   - needs_review
   - failed
   - which files still need manual follow-up
`,
        },
      }],
    })
  );

  registerPrompt(server, 
    "import-camt",
    "Parse a CAMT.053 statement, preview imported bank transactions, and only create them after approval.",
    {
      file_path: z.string().describe("Absolute path to the CAMT.053 XML file"),
      accounts_dimensions_id: z.number().describe("Bank account dimension ID in e-arveldaja"),
      date_from: z.string().optional().describe("Optional statement-entry lower bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional statement-entry upper bound (YYYY-MM-DD)"),
    },
    async ({ file_path, accounts_dimensions_id, date_from, date_to }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Import CAMT.053 bank transactions from: ${file_path}

Bank account dimension ID: ${accounts_dimensions_id}
${date_from ? `Date from: ${date_from}` : ""}
${date_to ? `Date to: ${date_to}` : ""}

Follow these steps in order:

1. Call \`parse_camt053\` with:
   - file_path: "${file_path}"

2. Present the parsed statement preview:
   - statement_metadata
   - summary.entry_count
   - summary.credit_count and summary.credit_total
   - summary.debit_count and summary.debit_total
   - summary.duplicate_count
   - any duplicate hints already found in the parsed entries

3. Call \`import_camt053\` with:
   - file_path: "${file_path}"
   - accounts_dimensions_id: ${accounts_dimensions_id}
   - execute: false
   ${date_from ? `- date_from: "${date_from}"` : ""}
   ${date_to ? `- date_to: "${date_to}"` : ""}

4. Review the import dry run:
   - mode
   - total_statement_entries
   - eligible_entries
   - filtered_out
   - created_count
   - skipped_duplicates
   - errors_count
   - results
   - skipped_duplicate_details
   - errors

5. Present a clear import preview:
   - transactions that would_create, with date, amount, currency, direction, counterparty, and reference
   - skipped duplicates, including why each was skipped
   - any import errors that would block execution

6. Ask for approval before creating anything.
   If the user does not explicitly approve, stop here.

7. After approval, call \`import_camt053\` again with:
   - file_path: "${file_path}"
   - accounts_dimensions_id: ${accounts_dimensions_id}
   - execute: true
   ${date_from ? `- date_from: "${date_from}"` : ""}
   ${date_to ? `- date_to: "${date_to}"` : ""}

8. Report the execution result:
   - created_count
   - skipped_duplicates
   - errors_count
   - any transactions that still need attention

9. If import completed successfully, offer the next logical step:
   - reconcile the imported bank account with \`reconcile-bank\`
`,
        },
      }],
    })
  );

  registerPrompt(server, 
    "import-wise",
    "Preview Wise transaction import results, including fees and skipped duplicates, before creating any bank transactions.",
    {
      file_path: z.string().describe("Absolute path to the regular Wise transaction-history.csv export"),
      accounts_dimensions_id: z.number().describe("Bank account dimension ID for the Wise account"),
      fee_account_dimensions_id: z.number().optional().describe("Optional Wise fee expense account dimension ID"),
      date_from: z.string().optional().describe("Optional transaction-date lower bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional transaction-date upper bound (YYYY-MM-DD)"),
      skip_jar_transfers: z.boolean().optional().describe("Skip Jar transfers (default true)"),
    },
    async ({
      file_path,
      accounts_dimensions_id,
      fee_account_dimensions_id,
      date_from,
      date_to,
      skip_jar_transfers,
    }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Import Wise transactions from: ${file_path}

Wise account dimension ID: ${accounts_dimensions_id}
${fee_account_dimensions_id !== undefined ? `Fee account dimension ID: ${fee_account_dimensions_id}` : "Fee account dimension ID: not provided"}
${date_from ? `Date from: ${date_from}` : ""}
${date_to ? `Date to: ${date_to}` : ""}
Skip Jar transfers: ${skip_jar_transfers === false ? "false" : "true"}

Follow these steps in order:

1. Call \`import_wise_transactions\` with:
   - file_path: "${file_path}"
   - accounts_dimensions_id: ${accounts_dimensions_id}
   ${fee_account_dimensions_id !== undefined ? `- fee_account_dimensions_id: ${fee_account_dimensions_id}` : ""}
   - execute: false
   ${date_from ? `- date_from: "${date_from}"` : ""}
   ${date_to ? `- date_to: "${date_to}"` : ""}
   ${skip_jar_transfers === false ? "- skip_jar_transfers: false" : ""}

2. If the dry run fails because Wise fee rows require \`fee_account_dimensions_id\`:
   - call \`list_account_dimensions\`
   - show the available dimensions to the user
   - ask the user which expense dimension should be used for Wise fees
   - then retry step 1 with \`fee_account_dimensions_id\`

3. Review the dry run output:
   - mode
   - total_csv_rows
   - eligible
   - filtered_out
   - skipped_jar_transfers
   - created
   - skipped
   - results
   - skipped_details

4. Present a clear preview:
   - each main transaction or fee transaction that would be created
   - skipped duplicates and skipped fee rows, with their exact reasons
   - whether Jar transfers were skipped
   - whether fees will be auto-confirmed to the configured expense dimension

5. Do not disable Jar skipping unless the user explicitly wants those internal Wise movements imported.

6. Ask for approval before creating anything.
   If the user does not explicitly approve, stop here.

7. After approval, call \`import_wise_transactions\` again with:
   - file_path: "${file_path}"
   - accounts_dimensions_id: ${accounts_dimensions_id}
   ${fee_account_dimensions_id !== undefined ? `- fee_account_dimensions_id: ${fee_account_dimensions_id}` : ""}
   - execute: true
   ${date_from ? `- date_from: "${date_from}"` : ""}
   ${date_to ? `- date_to: "${date_to}"` : ""}
   ${skip_jar_transfers === false ? "- skip_jar_transfers: false" : ""}

8. Report the execution result:
   - created
   - skipped
   - which rows became fee transactions
   - any rows that still need manual follow-up
`,
        },
      }],
    })
  );

  registerPrompt(server, 
    "classify-unmatched",
    "Classify unmatched bank transactions, preview the suggested purchase-invoice bookings, and only apply them after approval.",
    {
      accounts_dimensions_id: z.number().describe("Bank account dimension ID"),
      date_from: z.string().optional().describe("Optional lower transaction date bound (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Optional upper transaction date bound (YYYY-MM-DD)"),
    },
    async ({ accounts_dimensions_id, date_from, date_to }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Classify unmatched bank transactions for account dimension ${accounts_dimensions_id}.

${date_from ? `Date from: ${date_from}` : ""}
${date_to ? `Date to: ${date_to}` : ""}

Follow these steps in order:

1. Call \`classify_unmatched_transactions\` with:
   - accounts_dimensions_id: ${accounts_dimensions_id}
   ${date_from ? `- date_from: "${date_from}"` : ""}
   ${date_to ? `- date_to: "${date_to}"` : ""}

2. Present the classification summary:
   - total_unconfirmed
   - total_unmatched
   - category_counts
   - groups

3. Review each group carefully and show:
   - category
   - display_counterparty
   - apply_mode
   - reasons
   - suggested_booking
   - transaction IDs, dates, amounts, and descriptions

4. Explain the execution boundary clearly:
   - \`apply_mode="purchase_invoice"\` groups are the ones that can be auto-booked through \`apply_transaction_classifications\`
   - review-only categories will be reported back as skipped, not booked

5. Call \`apply_transaction_classifications\` with:
   - classifications_json: JSON.stringify(the full response from step 1)
   - execute: false

6. Present the dry run result grouped by status:
   - \`dry_run_preview\`: would create purchase invoices and link transactions, but nothing has been created yet
   - \`skipped\`: review-only categories or groups that no longer qualify
   - \`failed\`: exact errors that blocked preview

7. If the user wants to apply only some groups:
   - build a filtered JSON object that keeps the original top-level metadata and only the approved \`groups\` array entries
   - pass that filtered JSON object to \`apply_transaction_classifications\` instead of the full response

8. Ask for approval before executing.
   If the user does not explicitly approve, stop here.

9. After approval, call \`apply_transaction_classifications\` again with:
   - classifications_json: the approved full or filtered JSON object
   - execute: true

10. Report the execution result:
   - applied
   - skipped
   - failed
   - created_invoice_ids
   - linked_transaction_ids
   - which groups still need manual review
`,
        },
      }],
    })
  );

  registerPrompt(server, 
    "reconcile-bank",
    "Match bank transactions to invoices and optionally auto-confirm exact matches.",
    { mode: z.string().optional().describe('Reconciliation mode: "auto" (default), "review", or a numeric transaction ID') },
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

   For each match show: transaction_id, transaction date, amount, description, matched invoice number, supplier/client name, confidence score, and any partially paid warning.
   If \`distribution_ready=false\` or a partially paid warning is present, say clearly that no ready-to-use distribution is provided and the remaining open balance must be checked manually first.

3. Based on the mode "${effectiveMode}":
   ${effectiveMode === "auto" ? `- AUTO mode: First call \`auto_confirm_exact_matches\` with \`execute: false\` to preview what would be confirmed.
   - Show the dry-run results and ask for approval.
   - After approval, call \`auto_confirm_exact_matches\` with \`execute: true\` to execute.` :
   effectiveMode === "review" ? `- REVIEW mode: Show all matches (high, medium, low confidence) for manual review.
   - For each approved match with \`distribution_ready=true\`, call \`confirm_transaction\` with:
     - id: transaction_id
     - distributions: JSON.stringify([match.distribution])
   - If \`distribution_ready=false\` or the match is partially paid, inspect the invoice first and prepare the distribution manually instead of reusing \`match.distribution\`.
   - Only confirm one explicitly approved match at a time; do not auto-confirm ambiguous transactions.` :
   `- TRANSACTION ID mode: Call \`reconcile_transactions\` with \`min_confidence: 0\`, then filter the returned matches to transaction ID ${effectiveMode}.
   - If no match exists for that transaction, report that and stop.
   - If the user approves a match and \`distribution_ready=true\`, call \`confirm_transaction\` with:
     - id: transaction_id
     - distributions: JSON.stringify([match.distribution])
   - If \`distribution_ready=false\`, inspect the invoice first and prepare the distribution manually instead of reusing \`match.distribution\``}

4. For inter-account transfers (counterparty matches own company name or IBAN matches another own bank account):
   - Call \`reconcile_inter_account_transfers\` with execute=false first.
   - It automatically detects transfers already journalized from the other account side and skips them.
   - Show the dry-run: already_handled (safe to delete), one_sided (would confirm), pairs (would confirm both sides).
   - After approval, run with execute=true. If there are 3+ bank accounts and IBAN is missing, provide target_accounts_dimensions_id.
   - WARNING: Do NOT manually confirm Wise-side transfers that were already confirmed via LHV CAMT — this creates duplicate journal entries.

5. List any remaining unmatched transactions (no match found or confidence below threshold):
   - Show transaction date, amount, and description
   - Suggest possible actions (create invoice, mark as expense, delete if duplicate, etc.)

6. Report a final summary:
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
    { month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Expected YYYY-MM").describe('Month in YYYY-MM format, e.g. "2026-03"') },
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

3. Call \`find_missing_documents\` with:
   - date_from: "${startDate}"
   - date_to: "${endDate}"
   List any purchase invoices or journal entries that are missing supporting documents.

4. Call \`detect_duplicate_purchase_invoice\` with:
   - date_from: "${startDate}"
   - date_to: "${endDate}"
   This scans ALL suppliers for the month. Present both \`exact_duplicates\` (same supplier + invoice number)
   and \`suspicious_same_amount_date\` (same supplier + amount + date) findings.

5. Call \`compute_trial_balance\` for the period:
   - date_from: "${startDate}"
   - date_to: "${endDate}"
   Check that debits equal credits. If not balanced, flag this as a blocker.

6. Call \`compute_profit_and_loss\` for the year-to-date period:
   - date_from: "${year}-01-01"
   - date_to: "${endDate}"
   Show revenue, expenses, and net profit/loss YTD.

7. Call \`compute_balance_sheet\` with:
   - date_to: "${endDate}"
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
   - If it's a name: call \`search_client\` with name: "${identifier}"

   If a clear match is found, show the existing client details and STOP — do not create a duplicate.

3. Call \`resolve_supplier\` with:
   - ${/^\d{8}$/.test(identifier) ? `reg_code: "${identifier}"` : `name: "${identifier}"`}
   - auto_create: false
   ${/^\d{8}$/.test(identifier)
    ? "This can look up Estonian Business Registry data without creating anything."
    : "This can find an existing supplier match, but name-only lookup does not fetch Estonian Business Registry data."}

4. If \`resolve_supplier\` returns \`found=true\`, show the matched client and STOP — do not create a duplicate.

5. Review the result from step 3:
   - If \`registry_data\` is present, show the company name, registry code, and address from the registry lookup.
   - If \`registry_data\` is missing, say so explicitly. Name-only lookup does not provide registry data.
   - \`resolve_supplier\` does not fetch a VAT number from the registry lookup, so ask for \`invoice_vat_no\` separately if needed.
   Then ask the user to provide any additional details needed:
   - bank_account_no (IBAN for payments)
   - invoice_vat_no (if the supplier is VAT-registered)
   - email
   - telephone
   - address_text (if the registry data is missing or incomplete)
   - cl_code_country if the supplier is not Estonian
   - Whether this is a natural person or a legal entity

6. Once you have all the data, call \`create_client\` with:
   - name: company name
   - code: registry code
   - is_client: false
   - is_supplier: true
   - cl_code_country
   - is_physical_entity / is_juridical_entity
   - invoice_vat_no
   - bank_account_no
   - email
   - telephone
   - address_text

7. Report the created supplier:
   - Client ID assigned
   - Name, registry code, VAT number (if provided)
   - bank_account_no and email
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
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const yearStart = `${today.slice(0, 4)}-01-01`;
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Generate a comprehensive company financial overview dashboard.

Follow these steps:

1. Call \`get_vat_info\`, \`get_invoice_info\`, and \`list_connections\`.
   These can be fetched in parallel.

2. Call all four of these in parallel (they have no dependencies on each other):
   - \`compute_balance_sheet\` with date_to: "${today}"
   - \`compute_profit_and_loss\` with date_from: "${yearStart}", date_to: "${today}"
   - \`compute_receivables_aging\` with as_of_date: "${today}"
   - \`compute_payables_aging\` with as_of_date: "${today}"

3. Present a dashboard summary with these sections:

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

   Also surface any warnings returned by the balance sheet or aging tools.
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
      investment_account: z.number().describe("Investment asset account number (e.g. 1550)"),
      broker_account: z.number().describe("Broker cash account number (e.g. 1120)"),
      income_account: z.number().optional().describe("Distribution income account (e.g. 8320 or 8400)"),
      gain_loss_account: z.number().optional().describe("Realized gain/loss account for sell trades"),
      loss_account: z.number().optional().describe("Optional separate realized loss account"),
      fee_account: z.number().optional().describe("Optional fee expense account"),
      tax_account: z.number().optional().describe("Withheld tax account for distributions"),
      investment_dimension_id: z.number().optional().describe("Optional dimension ID for the investment account"),
      broker_dimension_id: z.number().optional().describe("Optional dimension ID for the broker account"),
    },
    async ({ statement_path, capital_gains_path, investment_account, broker_account, income_account, gain_loss_account, loss_account, fee_account, tax_account, investment_dimension_id, broker_dimension_id }) => ({
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
${gain_loss_account ? `Gain/loss account: ${gain_loss_account}` : ""}
${loss_account ? `Loss account: ${loss_account}` : ""}
${fee_account ? `Fee account: ${fee_account}` : ""}
${tax_account ? `Tax account: ${tax_account}` : ""}
${investment_dimension_id ? `Investment dimension ID: ${investment_dimension_id}` : ""}
${broker_dimension_id ? `Broker dimension ID: ${broker_dimension_id}` : ""}

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
   Treat this as the current accounting carrying value / cost basis, not market value.
   This helps verify the investment account balance after booking.

4. Before booking trades:
   - If the statement includes sell trades and no \`capital_gains_path\` is available, explain that sells will be skipped.
   - If sell trades are present and no \`gain_loss_account\` is known, ask the user for it before booking sells.
   - If the user wants fees expensed separately or dimensions applied, collect \`fee_account\`, \`investment_dimension_id\`, and \`broker_dimension_id\` before booking.

5. Call \`book_lightyear_trades\` with:
   - file_path: "${statement_path}"
   ${capital_gains_path ? `- capital_gains_file: "${capital_gains_path}"` : ""}
   - investment_account: ${investment_account}
   - broker_account: ${broker_account}
   ${gain_loss_account ? `- gain_loss_account: ${gain_loss_account}` : ""}
   ${loss_account ? `- loss_account: ${loss_account}` : ""}
   ${fee_account ? `- fee_account: ${fee_account}` : ""}
   ${investment_dimension_id ? `- investment_dimension_id: ${investment_dimension_id}` : ""}
   ${broker_dimension_id ? `- broker_dimension_id: ${broker_dimension_id}` : ""}
   - dry_run: true (ALWAYS preview first!)

   Review the dry run output:
   - Number of journal entries that would be created
   - Any skipped trades (missing cost basis, already booked via document_number)
   - Any warnings

   Present the preview and ask for confirmation before proceeding.

6. After user confirms, call \`book_lightyear_trades\` again with dry_run: false.
   Report: number of journals created, any errors.

${income_account ? `7. Before booking distributions:
   - If the parsed distributions include withheld tax and no \`tax_account\` is known, ask the user for it before proceeding.

   Call \`book_lightyear_distributions\` with:
   - file_path: "${statement_path}"
   - broker_account: ${broker_account}
   - income_account: ${income_account}
   ${tax_account ? `- tax_account: ${tax_account}` : ""}
   ${fee_account ? `- fee_account: ${fee_account}` : ""}
   ${broker_dimension_id ? `- broker_dimension_id: ${broker_dimension_id}` : ""}
   - dry_run: true (preview first!)

   Review the distributions preview:
   - Dividends by ticker and amount
   - Withheld tax amounts (if any)

   After user confirms, call again with dry_run: false.
` : `7. If there are distributions in the statement, ask the user for an income_account number
   (e.g. 8320 for fund distributions, 8400 for interest income) before booking them
   with \`book_lightyear_distributions\`.
   If the parsed distributions include withheld tax, also ask for \`tax_account\` before booking.
`}
8. Final summary:
   - Trades booked: count and total EUR
   - Distributions booked: count and total EUR
   - Skipped entries: count and reasons
   - Current portfolio carrying value / remaining cost basis (from step 3)
   - Suggest verifying the investment account balance with \`compute_account_balance\`
     using account_id: ${investment_account}
`,
        },
      }],
    })
  );

}
