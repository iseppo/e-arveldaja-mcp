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

Review `results`, `skipped_duplicate_details`, and `errors`.

### Step 3: Approval gate

Ask for approval before creating anything.

If the user does not explicitly approve, stop.

### Step 4: Execute

Call `import_camt053` again with execute: true.

Report created rows, skipped duplicates, errors, and suggest reconciliation as the next step.
