# Book Purchase Invoice from PDF

Read a PDF invoice, extract data, find or create the supplier, create the purchase invoice, upload the PDF, and confirm.

## Arguments

$ARGUMENTS should be the absolute file path to the PDF invoice. If not provided, look for PDF files in the current directory and ask the user which one to book.

## Workflow

### Step 1: Read the PDF

Use the Read tool to visually read the PDF file. Extract these fields:
- Supplier name and registry code (registrikood, 8 digits)
- Supplier VAT number (KMKR, starts with EE)
- Invoice number
- Invoice date (convert to YYYY-MM-DD)
- Due date or payment term in days
- Reference number (viitenumber) if present
- Supplier IBAN
- Line items: description, quantity, unit price, net total, VAT rate
- Invoice totals: net (without VAT), VAT amount, gross (with VAT)

Also call `extract_pdf_invoice` with the file_path to get machine-readable hints (IBAN, registry code, VAT number, reference number). Cross-check against what you read visually.

### Step 2: Validate the numbers

Call `validate_invoice_data`:
- total_net: invoice net total
- total_vat: invoice VAT total
- total_gross: invoice gross total
- items: JSON array of items, each with `total_net_price` and `vat_rate_dropdown` (e.g. "24", "22", "9", "0", or "-")
- invoice_date: YYYY-MM-DD
- due_date: YYYY-MM-DD (if available)

Do NOT proceed until validation passes (valid: true). If errors, re-check the extracted values.

### Step 3: Check for duplicates

Call `detect_duplicate_purchase_invoice` (no params needed) to scan all existing invoices.

If a duplicate is found with the same supplier and invoice number, STOP and tell the user.

### Step 4: Resolve the supplier

Call `resolve_supplier`:
- name: supplier name
- reg_code: registry code (if found)
- vat_no: VAT number (if found)
- iban: IBAN (if found)
- auto_create: true

Note the returned client ID.

If the supplier was found (not created) and the invoice has an IBAN or VAT number missing from the existing client, call `update_client` to add it.

### Step 5: Look up booking suggestions

Call `suggest_booking`:
- clients_id: the supplier client ID
- description: first line item description (helps find similar past invoices)

Use the returned past invoice data to determine:
- Which `cl_purchase_articles_id` to use
- Which `purchase_accounts_id` (expense account) to use

If no past invoices exist, call `list_purchase_articles` and choose the most appropriate article. Common expense articles:
- 35 (Leases/Üür, acct 5020) - office rent, coworking
- 37 (Office expenses/Bürookulud, acct 5040)
- 45 (Internet, acct 5230)
- 49 (Consultation/Konsultatsioon, acct 5340)
- 62 (Other operating/Muud tegevuskulud, acct 5990)

### Step 6: Create the purchase invoice

Call `create_purchase_invoice_from_pdf`:
- supplier_client_id: from step 4
- invoice_number: from the PDF
- invoice_date: YYYY-MM-DD
- journal_date: same as invoice_date
- term_days: from due date calculation, or 0 if already paid
- items: JSON array where each item has:
  - custom_title: description from PDF
  - cl_purchase_articles_id: from step 5
  - purchase_accounts_id: from step 5
  - total_net_price: net amount
  - vat_rate_dropdown: VAT rate as string (e.g. "24")
  - amount: quantity
- vat_price: EXACT total VAT from the original invoice
- gross_price: EXACT total gross from the original invoice
- ref_number: reference number (if found)
- bank_account_no: supplier IBAN (spaces removed)
- notes: PDF filename

### Step 7: Upload the PDF

Call `upload_invoice_document`:
- invoice_id: the ID from step 6
- file_path: the original PDF path

### Step 8: Confirm the invoice

Call `confirm_purchase_invoice`:
- id: the invoice ID

### Step 9: Summary

Report: invoice number, supplier, net/VAT/gross, expense account used, invoice ID, whether supplier was new or existing, confirmation status.
