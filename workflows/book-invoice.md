# Book Purchase Invoice from PDF

Read a PDF invoice, extract data, find or create the supplier, create the purchase invoice, upload the PDF, and confirm.

**Input:** Absolute file path to the PDF invoice.

## Step 1: Extract text from the PDF

Call `extract_pdf_invoice`:
- `file_path`: absolute path to the PDF

The tool returns `hints` with regex-detected IBAN, registry code, VAT number, and reference number.

Also read the PDF visually and extract:
- Supplier name and registry code (registrikood, 8 digits)
- Supplier VAT number (KMKR, starts with EE)
- Invoice number
- Invoice date (YYYY-MM-DD)
- Due date or payment term in days
- Reference number (viitenumber) if present
- Supplier IBAN
- Line items: description, quantity, unit price, net total, VAT rate
- Invoice totals: net (without VAT), VAT amount, gross (with VAT)

Cross-check visually extracted values against the tool's hints.

## Step 2: Validate the numbers

Call `validate_invoice_data`:
- `total_net`: invoice net total
- `total_vat`: invoice VAT total
- `total_gross`: invoice gross total
- `items`: JSON array of items, each with `total_net_price` and `vat_rate_dropdown` (e.g. `"24"`, `"22"`, `"9"`, `"0"`, or `"-"`)
- `invoice_date`: YYYY-MM-DD
- `due_date`: YYYY-MM-DD (if available)

Do NOT proceed until the result shows `valid: true`. If errors are returned, re-check the extracted values.

## Step 3: Check for duplicates

Call `detect_duplicate_purchase_invoice` (no parameters needed).

If a duplicate is found with the same supplier and invoice number, STOP and inform the user.

## Step 4: Resolve the supplier

Call `resolve_supplier`:
- `name`: supplier name
- `reg_code`: registry code (if found)
- `vat_no`: VAT number (if found)
- `iban`: IBAN (if found)
- `auto_create`: `true` (creates the client if not found)

Note the returned client ID.

If the supplier was found (not created) and the invoice has an IBAN or VAT number missing from the existing client record, call `update_client` to add it:
- `id`: client ID
- `data`: JSON with fields to update, e.g. `{"bank_account_no": "EE...", "invoice_vat_no": "EE..."}`

## Step 5: Look up booking suggestions

Call `suggest_booking`:
- `clients_id`: supplier client ID
- `description`: first line item description (helps find similar past invoices)

Use the returned past invoice data to determine:
- Which `cl_purchase_articles_id` to use
- Which `purchase_accounts_id` (expense account) to use

If no past invoices exist, call `list_purchase_articles` and choose the most appropriate article. Common expense articles:

| ID | Name | Account | Typical use |
|----|------|---------|-------------|
| 35 | Üür ja rent / Leases | 5020 | Office rent, coworking |
| 37 | Bürookulud / Office expenses | 5040 | General office |
| 45 | Internet | 5230 | Internet, subscriptions |
| 49 | Konsultatsioon / Consultation | 5340 | Consulting fees |
| 62 | Muud tegevuskulud / Other operating | 5990 | Catch-all |

## Step 6: Create the purchase invoice

Call `create_purchase_invoice_from_pdf`:
- `supplier_client_id`: from step 4
- `invoice_number`: from the PDF
- `invoice_date`: YYYY-MM-DD
- `journal_date`: same as invoice_date
- `term_days`: calculated from due date, or `0` if already paid
- `items`: JSON array where each item has:
  - `custom_title`: description from PDF
  - `cl_purchase_articles_id`: from step 5
  - `purchase_accounts_id`: from step 5
  - `total_net_price`: net amount
  - `vat_rate_dropdown`: VAT rate as string (e.g. `"24"`)
  - `amount`: quantity
- `vat_price`: **EXACT** total VAT from the original invoice
- `gross_price`: **EXACT** total gross from the original invoice
- `ref_number`: reference number (if found)
- `bank_account_no`: supplier IBAN (spaces removed)
- `notes`: PDF filename

## Step 7: Upload the PDF

Call `upload_invoice_document`:
- `invoice_id`: the ID returned from step 6
- `file_path`: the original PDF path

## Step 8: Confirm the invoice

Call `confirm_purchase_invoice`:
- `id`: the invoice ID

This is irreversible. The tool automatically fixes `vat_price`/`gross_price` if inconsistent.

## Step 9: Summary

Report: invoice number, supplier name, net/VAT/gross amounts, expense account used, invoice ID, whether supplier was newly created or found, confirmation status.
