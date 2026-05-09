<!-- Generated from workflows/new-supplier.md. Edit that source file, then run npm run sync:workflow-prompts. -->

# Create New Supplier

Create a new supplier (client) in e-arveldaja with proper fields and optional business registry lookup.

**Input:** Supplier name or Estonian registry code (8 digits).

## Step 1: Determine input type

- 8-digit number → treat as registry code
- Text → treat as supplier name

## Step 2: Check if supplier already exists

If registry code provided: call `find_client_by_code`:
- `code`: the registry code

If name provided: call `search_client`:
- `name`: the supplier name

For registry-code lookups, a hit is authoritative — show the existing client details and stop. Do not create a duplicate.

For name-based search, treat any hit as a candidate, not a decision: show the matched client(s) to the user and ask whether one of them is the same supplier. If the user confirms the match, stop and do not create a duplicate. Otherwise continue to step 3 to register the new supplier.

## Step 3: Resolve supplier details

Call `resolve_supplier`:
- `name`: supplier name (if provided)
- `reg_code`: registry code (if provided)
- `auto_create`: `false` (review registry data before creating)
- `country`: `"EST"` (default)

For Estonian codes, the tool queries the business registry (äriregister.rik.ee) for the official company name and address. Show this data to the user for review.

A name-only lookup does not fetch Estonian Business Registry data, and `resolve_supplier` does not fetch a VAT number from the registry lookup — ask for `invoice_vat_no` separately when needed.

## Step 4: Gather additional information

Ask the user for any details to add:
- Bank account (IBAN) — useful for payment matching
- VAT number (KMKR, e.g. EE123456789) — needed for EU intra-community supply
- Email address
- Phone number
- Address (if not found from registry)

## Step 5: Preview and ask for approval

Before creating anything, present one approval card:
- supplier name
- registry code and country
- duplicate-check result
- registry/address data being used
- bank account, VAT number, email, phone, and address fields that will be stored
- side effect: create one supplier client record in e-arveldaja

If the user does not explicitly approve, stop.

## Step 6: Create the supplier

Call `create_client`:
- `name`: official name from registry, or user-provided name
- `code`: registry code (if known)
- `is_client`: `false`
- `is_supplier`: `true`
- `cl_code_country`: `"EST"` (or as specified)
- `is_juridical_entity`: `true` (default; `false` for natural persons)
- `bank_account_no`: IBAN (if provided)
- `invoice_vat_no`: VAT number (if provided)
- `email`: (if provided)
- `telephone`: (if provided)
- `address_text`: from registry or user input

## Step 7: Report

Show created supplier: client ID, name, registry code, country, and any additional fields set.

The supplier is now available for use when booking purchase invoices.
