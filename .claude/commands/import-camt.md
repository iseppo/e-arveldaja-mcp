# Import CAMT.053

Parse a CAMT.053 statement, preview the import, and only create bank transactions after approval.

## Arguments

- `file_path`: absolute path to the CAMT.053 XML file
- `accounts_dimensions_id`: bank account dimension ID in e-arveldaja
- Optional `date_from` / `date_to`: statement-entry filter in `YYYY-MM-DD`

## Workflow

### Step 1: Parse the statement

Call `process_camt053`:
- `mode`: `parse`
- `file_path`: the provided file

Show:
- `result` as the delegated `parse_camt053` payload
- `statement_metadata`
- `summary.entry_count`
- `summary.credit_count` and `summary.credit_total`
- `summary.debit_count` and `summary.debit_total`
- `summary.duplicate_count`

### Step 2: Dry-run the import

Call `process_camt053`:
- `mode`: `dry_run`
- `file_path`: the provided file
- `accounts_dimensions_id`: the provided dimension ID
- include `date_from` / `date_to` when provided

Review:
- `process_camt053` is the preferred merged workflow tool; `parse_camt053` and `import_camt053` remain compatibility primitives.
- Use `result` as the delegated `import_camt053` payload.
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
- if the older match is PROJECT (unconfirmed), present its current state and offer to confirm it inline using `confirm_transaction` (or `reconcile_inter_account_transfers` for inter-account transfers). Do NOT defer it to manual UI work in e-arveldaja — the agent has the IDs and amounts loaded, so the natural next step is to ask the user yes/no for inline confirmation.

Do not suggest overwriting curated manual fields like description or reference when they are already filled.

### Step 3: Approval gate

Ask for approval before creating anything.

If the user does not explicitly approve, stop.

### Step 4: Execute

Call `process_camt053` again:
- `mode`: `execute`
- `file_path`: the provided file
- `accounts_dimensions_id`: the provided dimension ID
- include `date_from` / `date_to` when provided

Report:
- `execution.summary.created_count`
- `execution.summary.skipped_count`
- `execution.summary.error_count`
- any `execution.needs_review` possible duplicates — for each one propose an inline action (confirm via `confirm_transaction`, reconcile via `reconcile_inter_account_transfers`, enrich `bank_ref_number` via `update_transaction`, or delete the duplicate `PROJECT` row) and ask the user yes/no. Do not tell the user to "do this manually in e-arveldaja" — that is a last resort only when no MCP tool can perform the action and the API error has been shown to the user.
- any transactions still needing attention
- mention that side effects can be reviewed via `execution.audit_reference`

Offer reconciliation as the next step if the import succeeded.
