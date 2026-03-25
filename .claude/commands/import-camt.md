# Import CAMT.053

Parse a CAMT.053 bank statement, preview the import, and only create transactions after approval.

## Arguments

`$ARGUMENTS` should provide:
- CAMT.053 XML file path
- bank `accounts_dimensions_id`
- optional `date_from` / `date_to`

## Workflow

### Step 1: Parse the statement

Call `parse_camt053` with the provided file path.

Show `statement_metadata`, entry counts, totals, and duplicate hints.

### Step 2: Dry-run the import

Call `import_camt053`:
- `file_path`: the provided file
- `accounts_dimensions_id`: the provided dimension ID
- execute: false
- include `date_from` / `date_to` when provided

Review:
- `mode`
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

Suggest reconciliation as the next step if the import succeeded.
