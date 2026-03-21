# Book Purchase Invoice from PDF

Book a purchase invoice from a source document. Extract the data, validate it, resolve the supplier safely, check duplicate risk, create the invoice, upload the document, and confirm it.

## Arguments

$ARGUMENTS should be the absolute path to the invoice document (`.pdf`, `.jpg`, `.jpeg`, `.png`). If not provided, look for supported files in the current directory and ask the user which one to book.

## Workflow

### Step 1: Extract the document text

Call `extract_pdf_invoice` with the file path.

Use `hints.raw_text` as the source of truth for the whole document.
- If `llm_fallback.recommended=true` or any identifier hint is missing, continue from `hints.raw_text` manually.
- Do not stop just because the regex identifier hints are incomplete.

Extract:
- Supplier name and address
- Supplier registry code and VAT number if present
- Invoice number
- Invoice date and due date in `YYYY-MM-DD`
- Net amount, VAT amount, gross total
- Line items
- Supplier IBAN
- Payment reference number

### Step 2: Validate the numbers

Call `validate_invoice_data`:
- total_net: invoice net total
- total_vat: invoice VAT total
- total_gross: invoice gross total
- items: JSON array of items, each with `total_net_price` and `vat_rate_dropdown` (e.g. "24", "22", "9", "0", or "-")
- invoice_date: YYYY-MM-DD
- due_date: YYYY-MM-DD (if available)

Do NOT proceed until validation passes (valid: true). If errors, re-check the extracted values.

### Step 3: Resolve the supplier without creating duplicates

Call `resolve_supplier`:
- name: supplier name
- reg_code: registry code if found
- vat_no: VAT number if found
- iban: IBAN if found
- auto_create: false

This either returns an existing supplier match or registry data for a possible new supplier.

### Step 4: Check duplicate risk before creating anything

Call `detect_duplicate_purchase_invoice` with:
- date_from: invoice date
- date_to: invoice date
- invoice_number: extracted invoice number
- gross_price: extracted gross total
- clients_id: resolved client ID if step 3 returned `found=true`

Inspect `candidate_invoice_number_matches` and `candidate_same_amount_date_matches` first.
- Also review `exact_duplicates` and `suspicious_same_amount_date` as warning context.
- If a candidate looks like the same invoice, stop and report it before creating anything.

### Step 5: Ensure the supplier client exists

- If step 3 returned `found=true`, use `client.id` as `supplier_client_id`.
- Otherwise call `resolve_supplier` again with the same identifiers and `auto_create: true`.
- Use `api_response.created_object_id` as `supplier_client_id`. If no client ID is returned, stop and report the failure.

### Step 6: Look up booking suggestions

Call `suggest_booking`:
- clients_id: supplier client ID
- description: first line item description

Reuse the most relevant `cl_purchase_articles_id`, `purchase_accounts_id`, and VAT fields from similar `past_invoices`.
If there is no suitable history, call `list_purchase_articles` or ask the user instead of inventing IDs.

### Step 7: Determine reverse charge VAT (pöördkäibemaks)

ALWAYS check if reverse charge applies. Set `reversed_vat_id: 1` on items when:
- Supplier is **outside Estonia** (EU or non-EU) AND provides services
- Invoice mentions "reverse charge", "Article 196", "pöördkäibemaks", or has 0% VAT with a foreign supplier
- Supplier country is NOT Estonia (check cl_code_country, VAT number prefix, or address)

When reverse charge applies:
- `vat_rate_dropdown`: "0"
- `reversed_vat_id`: 1

When supplier is Estonian with regular VAT:
- `vat_rate_dropdown`: the VAT rate (e.g. "24")
- `reversed_vat_id`: do not set

### Step 8: Create the purchase invoice

Call `create_purchase_invoice_from_pdf`:
- supplier_client_id
- invoice_number
- invoice_date: YYYY-MM-DD
- journal_date
- term_days
- items: JSON array where each item has:
  - custom_title: description from PDF
  - cl_purchase_articles_id
  - purchase_accounts_id
  - total_net_price: net amount
  - vat_rate_dropdown
  - vat_accounts_id
  - cl_vat_articles_id
  - reversed_vat_id when reverse charge applies
  - amount: quantity
- vat_price: EXACT total VAT from the original invoice
- gross_price: EXACT total gross from the original invoice
- ref_number: reference number (if found)
- bank_account_no: supplier IBAN (spaces removed)
- notes: source filename and any assumptions

Use the exact `vat_price` and `gross_price` from the invoice. Do not recalculate them.

### Step 9: Upload the document

Call `upload_invoice_document`:
- invoice_id: the ID from step 8
- file_path: the original PDF path

### Step 10: Confirm the invoice

Call `confirm_purchase_invoice`:
- id: the invoice ID

### Step 11: Summary

Report:
- Supplier name and supplier client ID
- Invoice number, date, due date
- Net / VAT / gross amounts
- Booking basis used
- Whether reverse charge was applied
- Any validation warnings or assumptions
- Invoice ID and confirmation status
