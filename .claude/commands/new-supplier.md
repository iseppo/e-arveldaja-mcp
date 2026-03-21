# Create New Supplier

Create a new supplier (client) in e-arveldaja with proper fields.

## Arguments

$ARGUMENTS should be the supplier name or Estonian registry code (8 digits). If not provided, ask the user.

## Workflow

### Step 1: Determine input type

- 8-digit number: treat as registry code
- Text: treat as supplier name

### Step 2: Check if supplier already exists

If registry code: call `find_client_by_code` with code: the registry code.
If name: call `search_client` with name: the supplier name.

If a clear match is found, show the existing client and stop. Do not create a duplicate.

### Step 3: Resolve supplier details

Call `resolve_supplier`:
- name: supplier name (if provided)
- reg_code: registry code (if provided)
- auto_create: false (check registry data first)
- country: "EST" (default)

If an Estonian code was provided, the tool queries the business registry for the official company name and address. Show this to the user.
Name-only lookup does not provide Estonian Business Registry data.
`resolve_supplier` also does not fetch a VAT number from the registry lookup, so ask for `invoice_vat_no` separately if needed.

### Step 4: Gather additional information

Ask the user for any details they want to add:
- Bank account (IBAN)
- VAT number (KMKR, e.g. EE123456789)
- Email address
- Phone number
- Address (if not found from registry)

### Step 5: Create the supplier

Call `create_client`:
- name: official name from registry, or user-provided name
- code: registry code (if known)
- is_client: false
- is_supplier: true
- cl_code_country: "EST" (or as specified)
- is_juridical_entity: true (default, false for natural persons)
- bank_account_no: IBAN (if provided)
- invoice_vat_no: VAT number (if provided)
- email: (if provided)
- telephone: (if provided)
- address_text: from registry or user

### Step 6: Report

Show created supplier: client ID, name, registry code, country, any additional fields.

Remind user this supplier is now available for `/book-invoice`.
