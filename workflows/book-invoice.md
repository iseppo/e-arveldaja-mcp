# Book Purchase Invoice from PDF

Book a purchase invoice from a source document. Extract the data, validate it, resolve the supplier safely, check duplicate risk, preview the booking, then create the invoice, upload the document, and confirm it after approval.

**Input:** Absolute path to the invoice document (`.pdf`, `.jpg`, `.jpeg`, `.png`).

## Step 1: Extract the document text

Call `extract_pdf_invoice`:
- `file_path`: absolute path to the invoice document

Use `hints.raw_text` as the source of truth for the whole document.
- If `llm_fallback.recommended=true` or any identifier hint is missing, continue from `hints.raw_text` manually.
- Do not stop just because the regex identifier hints are incomplete.

Extract all of the following from `hints.raw_text`:
- Supplier name and address
- Supplier registry code (if present)
- Supplier VAT number (if present)
- Invoice number
- Invoice date and due date in `YYYY-MM-DD`
- Net amount, VAT amount, gross total
- Line items: description, quantity, unit price, VAT rate, net amount per line
- Supplier IBAN
- Payment reference number

## Step 2: Validate the totals

Call `validate_invoice_data`:
- `total_net`: extracted net total
- `total_vat`: extracted VAT total
- `total_gross`: extracted gross total
- `items`: JSON array of extracted line items
- `invoice_date`: extracted invoice date
- `due_date`: extracted due date (if available)

If validation returns `valid=false` or any errors, stop and ask the user to review the extraction before creating anything.

## Step 3: Resolve the supplier without creating duplicates

Call `resolve_supplier`:
- `name`: supplier name
- `reg_code`: registry code (if found)
- `vat_no`: VAT number (if found)
- `iban`: IBAN (if found)
- `auto_create: false`

This either returns an existing supplier match or registry data for a possible new supplier.

## Step 4: Check duplicate risk before creating anything

Call `detect_duplicate_purchase_invoice` with:
- `date_from`: invoice date
- `date_to`: invoice date
- `invoice_number`: extracted invoice number
- `gross_price`: extracted gross total
- `clients_id`: resolved client ID if step 3 returned `found=true`

Inspect `candidate_invoice_number_matches` and `candidate_same_amount_date_matches` first.
- Also review `exact_duplicates` and `suspicious_same_amount_date` as warning context.
- If a candidate looks like the same invoice, stop and report it before creating anything.

## Step 5: Ensure the supplier client exists

- If step 3 returned `found=true`, use `client.id` as `supplier_client_id`.
- Otherwise call `resolve_supplier` again with the same identifiers and `auto_create: true`.
- Use `api_response.created_object_id` as `supplier_client_id`. If no client ID is returned, stop and report the failure.

## Step 6: Reuse the best booking setup

Call `suggest_booking`:
- `clients_id`: supplier client ID
- `description`: first line item description

Review `past_invoices` and reuse the most relevant:
- `cl_purchase_articles_id`
- `purchase_accounts_id`
- `purchase_accounts_dimensions_id` (required when the account has sub-accounts)
- VAT fields such as `vat_rate_dropdown`, `vat_accounts_id`, `cl_vat_articles_id`, `reversed_vat_id`

If there is no suitable history, call `list_purchase_articles` or ask the user instead of inventing IDs.

## Step 7: Determine VAT treatment

- For normal domestic invoices, keep the VAT treatment shown on the document.
- Reverse charge applies when the supplier is foreign and the invoice is for services rather than goods.
- If reverse charge applies, set `reversed_vat_id: 1` on the affected lines.

## Step 8: Preview the booking and ask for approval

Before creating anything, present:
- Supplier name and supplier client ID
- Invoice number, invoice date, due date, journal date, and term days
- Net / VAT / gross amounts
- The exact item-level booking you intend to send, including article IDs, account IDs, VAT fields, and any `reversed_vat_id`
- The booking basis used and any assumptions

If the user has not explicitly approved the preview, stop here and wait.

## Step 9: Create the purchase invoice

Call `create_purchase_invoice_from_pdf`:
- `supplier_client_id`
- `invoice_number`
- `invoice_date`
- `journal_date`
- `term_days`
- `items`: JSON array with `cl_purchase_articles_id`, `purchase_accounts_id`, `purchase_accounts_dimensions_id` (when the account has dimensions), quantities, totals, VAT fields, `vat_accounts_id`, `cl_vat_articles_id`, and `reversed_vat_id` when applicable
- `vat_price`: exact value from the invoice
- `gross_price`: exact value from the invoice
- `ref_number`
- `bank_account_no`
- `notes`: source filename and any assumptions
- `file_path`: the original file path (auto-uploads the source document)

Use the exact `vat_price` and `gross_price` from the invoice. Do not recalculate them.

## Step 10: Confirm and report

Call `confirm_purchase_invoice`:
- `id`: the invoice ID from step 9

Report the result:

Report:
- Supplier name and supplier client ID
- Invoice number, date, due date
- Net / VAT / gross amounts
- Booking basis used
- Whether reverse charge was applied
- Any validation warnings or assumptions
- Invoice ID and confirmation status
