# Receipt Batch

Scan a folder of receipts, preview what can be auto-booked, and only create purchase invoices after approval.

## Arguments

- `folder_path`: absolute path to the receipt folder
- `accounts_dimensions_id`: bank account dimension ID used for bank transaction matching
- Optional `date_from` / `date_to`: receipt modified-date filter in `YYYY-MM-DD`

## Workflow

### Step 1: Scan the folder

Call `scan_receipt_folder`:
- `folder_path`: the provided folder

Show:
- valid files found
- skipped entries and their reasons

If there are no valid files, stop.

### Step 2: Preview the batch

Call `process_receipt_batch`:
- `folder_path`: the provided folder
- `accounts_dimensions_id`: the provided dimension ID
- `execute`: `false`
- include `date_from` / `date_to` when provided

Review:
- `summary.created`
- `summary.matched`
- `summary.skipped_duplicate`
- `summary.needs_review`
- `summary.failed`
- `summary.dry_run_preview`
- `skipped`
- `results`

Group the preview by status:
- `dry_run_preview`: show extracted supplier, invoice number, amounts, booking suggestion, and bank match. The purchase invoice has NOT been created yet. The document has NOT been uploaded yet. The invoice has NOT been confirmed yet.
- `skipped_duplicate`: show the duplicate match and reason
- `needs_review`: show missing fields, `llm_fallback`, and notes
- `failed`: show the exact error

### Step 3: Approval gate

State clearly that `execute: false` is only a preview.

Ask for approval before running `process_receipt_batch` with `execute: true`.

If the user does not explicitly approve, stop.

### Step 4: Execute

Call `process_receipt_batch` again:
- `folder_path`: the provided folder
- `accounts_dimensions_id`: the provided dimension ID
- `execute`: `true`
- include `date_from` / `date_to` when provided

Report:
- created
- matched
- skipped_duplicate
- needs_review
- failed
- which files still need manual follow-up
