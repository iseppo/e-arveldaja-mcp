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
- Treat `execution` as the canonical batch payload when present.
- Prefer `execution.summary.total_statement_entries`, `execution.summary.eligible_entries`, `execution.summary.filtered_out`, `execution.summary.created_count`, `execution.summary.skipped_count`, `execution.summary.error_count`, `execution.results`, `execution.skipped`, `execution.errors`, and `execution.audit_reference`.
- Also inspect `execution.needs_review` for possible duplicates against older manual transactions that lack CAMT bank references.
- Use the first 10 items from `execution.results` as the preview sample.
- Fall back to top-level `created_count`, `skipped_count`, `error_count`, `sample`, `skipped_summary`, and `errors` only if `execution` is absent.

Present:
- which rows would create transactions
- which are skipped as exact duplicates
- any `execution.needs_review` possible duplicates

For possible duplicates, the default recommendation is:
- if the older matched transaction is already confirmed, keep it by default
- update that confirmed transaction only with missing CAMT metadata such as `bank_ref_number`
- then avoid creating, or if already created, delete the new `PROJECT` transaction
- if the older match is not confirmed, review statuses before deciding which row to keep

Do not suggest overwriting curated manual fields like description or reference when they are already filled.

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
- `execution.summary.created_count`
- `execution.summary.skipped_count`
- `execution.summary.error_count`
- any `execution.needs_review` possible duplicates that should be resolved
- any transactions still needing attention
- mention that side effects can be reviewed via `execution.audit_reference`

Offer reconciliation as the next step if the import succeeded.
