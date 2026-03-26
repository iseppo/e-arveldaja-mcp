# Classify Unmatched Transactions

Classify unmatched bank transactions, preview which groups can be auto-booked, and only apply them after approval.

## Arguments

`$ARGUMENTS` should provide:
- bank `accounts_dimensions_id`
- optional `date_from` / `date_to`

## Workflow

### Step 1: Classify

Call `classify_unmatched_transactions` with the provided dimension ID and optional date filters.

Show `total_unconfirmed`, `total_unmatched`, `category_counts`, and the classified `groups`.

For each group, show category, counterparty, `apply_mode`, reasons, and `suggested_booking`.

### Step 2: Explain execution scope

- `apply_mode="purchase_invoice"` groups can be auto-booked
- review-only groups will be skipped

### Step 3: Dry-run application

Call `apply_transaction_classifications`:
- `classifications_json`: `JSON.stringify(the full response from step 1)`
- `execute`: `false`

Treat `execution` as the canonical batch payload when present. Prefer `execution.summary`, `execution.results`, `execution.skipped`, `execution.errors`, and `execution.audit_reference`.

Group the result into `execution.results` entries with `status="dry_run_preview"`, `execution.skipped`, and `execution.errors`.

If only some groups should be applied, build a filtered JSON object and pass that as `classifications_json`.

### Step 4: Approval gate

Ask for approval before executing.

If the user does not explicitly approve, stop.

### Step 5: Execute

Call `apply_transaction_classifications` again with `execute: true`.

Report `execution.summary.applied`, `execution.summary.skipped`, `execution.summary.failed`, `created_invoice_ids`, `linked_transaction_ids`, remaining manual review items, and `execution.audit_reference`.
