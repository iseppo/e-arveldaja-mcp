# Import Wise Transactions

Preview Wise import results, including fees and skipped duplicates, before creating any bank transactions.

## Arguments

`$ARGUMENTS` should provide:
- Wise `transaction-history.csv` path
- Wise `accounts_dimensions_id`
- optional `fee_account_dimensions_id`
- optional `date_from` / `date_to`
- optional `skip_jar_transfers`

## Workflow

### Step 1: Dry-run the import

Call `import_wise_transactions`:
- `file_path`: the provided file
- `accounts_dimensions_id`: the provided dimension ID
- include `fee_account_dimensions_id` when available
- execute: false
- include `date_from` / `date_to` when provided
- include `skip_jar_transfers: false` only if the user explicitly wants Jar transfers imported

If fee rows require a fee account:
- call `list_account_dimensions`
- show the available dimensions
- ask the user to choose the fee expense dimension

### Step 2: Review the preview

Review:
- `mode`
- `total_csv_rows`
- `eligible`
- `filtered_out`
- `skipped_jar_transfers`
- `created`
- `skipped`
- `results`
- `skipped_details`

### Step 3: Approval gate

Do not disable Jar skipping unless the user explicitly wants those internal Wise movements imported.

Ask for approval before calling `import_wise_transactions` with execute: true.

If the user does not explicitly approve, stop.

### Step 4: Execute

Call `import_wise_transactions` again with `execute: true`.

Report created rows, skipped rows, fee handling, and any manual follow-up needed.
