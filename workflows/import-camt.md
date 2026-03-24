# Import CAMT.053

Parse a CAMT.053 statement, preview the import, and only create bank transactions after approval.

## Arguments

- `file_path`: absolute path to the CAMT.053 XML file
- `accounts_dimensions_id`: bank account dimension ID in e-arveldaja
- Optional `date_from` / `date_to`: statement-entry filter in `YYYY-MM-DD`

## Workflow

### Step 1: Parse the statement

Call `parse_camt053`:
- `file_path`: the provided file

Show:
- `statement_metadata`
- `summary.entry_count`
- `summary.credit_count` and `summary.credit_total`
- `summary.debit_count` and `summary.debit_total`
- `summary.duplicate_count`

### Step 2: Dry-run the import

Call `import_camt053`:
- `file_path`: the provided file
- `accounts_dimensions_id`: the provided dimension ID
- execute: false
- include `date_from` / `date_to` when provided

Review:
- `total_statement_entries`
- `eligible_entries`
- `filtered_out`
- `created_count`
- `skipped_count`
- `error_count`
- `sample`
- `skipped_summary`
- `errors`

Present which rows would create transactions and which are skipped as duplicates.

### Step 3: Approval gate

Ask for approval before creating anything.

If the user does not explicitly approve, stop.

### Step 4: Execute

Call `import_camt053` again:
- `file_path`: the provided file
- `accounts_dimensions_id`: the provided dimension ID
- execute: true
- include `date_from` / `date_to` when provided

Report:
- `created_count`
- `skipped_count`
- `error_count`
- any transactions still needing attention

Offer reconciliation as the next step if the import succeeded.
