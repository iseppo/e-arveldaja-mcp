# Classify Unmatched Transactions

Classify unmatched bank transactions, preview the auto-bookable purchase-invoice groups, and only apply them after approval.

## Arguments

- `accounts_dimensions_id`: bank account dimension ID
- Optional `date_from` / `date_to`: transaction-date filter in `YYYY-MM-DD`

## Workflow

### Step 1: Classify the transactions

Call `classify_unmatched_transactions`:
- `accounts_dimensions_id`: the provided dimension ID
- include `date_from` / `date_to` when provided

Show:
- `total_unconfirmed`
- `total_unmatched`
- `category_counts`
- `groups`

For each group, show:
- `category`
- `display_counterparty`
- `apply_mode`
- reasons
- `suggested_booking`
- transaction IDs, dates, amounts, and descriptions

### Step 2: Explain what can be applied

- `apply_mode="purchase_invoice"` groups are auto-bookable
- review-only categories are reported back as skipped

### Step 3: Dry-run the application

Call `apply_transaction_classifications`:
- `classifications_json`: `JSON.stringify(the full response from step 1)`
- `execute`: `false`

Group the result by status:
- `dry_run_preview`: would create purchase invoices and link transactions, but nothing has been created yet
- `skipped`: review-only or no longer applicable
- `failed`: exact blocking errors

If the user wants only some groups applied:
- build a filtered JSON object that preserves the top-level metadata and only the approved `groups`
- pass that filtered JSON object as `classifications_json`

### Step 4: Approval gate

Ask for approval before executing.

If the user does not explicitly approve, stop.

### Step 5: Execute

Call `apply_transaction_classifications` again:
- `classifications_json`: the approved full or filtered JSON object
- `execute`: `true`

Report:
- applied
- skipped
- failed
- `created_invoice_ids`
- `linked_transaction_ids`
- which groups still need manual review
