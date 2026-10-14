# Accounting Inbox

Start from one workspace-level scan, propose only the next safe dry-run steps, and ask the fewest possible follow-up questions.

## Arguments

- Optional `workspace_path`: folder to scan for CAMT statements, Wise CSV files, and receipt folders
- Optional dimension overrides (pass when the user picks a specific bank-account dimension):
  - `bank_account_dimension_id`: default bank-account dimension reused for CAMT and receipt suggestions
  - `receipt_matching_dimension_id`: bank-account dimension used specifically for receipt matching
  - `wise_account_dimension_id`: bank-account dimension used specifically for Wise suggestions
  - `wise_inter_account_dimension_id`: the company's other own bank account that Wise transfers go to and from; becomes the Wise step's `inter_account_dimension_id` (ignored unless it is one of the other bank accounts). With exactly one other bank account it is suggested automatically.

## Workflow

### Step 1: Run the dry-run pass (scans the workspace and runs the safe dry-run steps)

Call `accounting_inbox`:
- set `mode` to `dry_run`
- include `workspace_path` when the user provided one

Treat the tool response as the first-pass source of truth:
- `prepared_inbox`
- `autopilot.executed_steps`
- `autopilot.skipped_steps`
- `autopilot.done_automatically`
- `autopilot.needs_one_decision`
- `autopilot.needs_accountant_review`
- `autopilot.next_recommended_action`
- `autopilot.next_question`
- `autopilot.user_summary`

### Step 2: Explain the plan in plain language

Present:
- what likely inputs were found
- what dry runs were already completed automatically
- what still needs one small decision
- whether anything already looks like accountant-review territory
- CAMT files that are byte-identical copies of another (`coverage: "duplicate"`, `duplicate_of`): they have no steps; importing one is harmless but unnecessary, and the user may still import one explicitly. The kept file's step references are bound to the scanned bytes: if that file was changed or removed, its step is refused (parse/dry run: `file_input_changed` or `file_input_unavailable`; an execute with a plan reports `plan_drift`), so re-run `accounting_inbox` and the duplicates are reconsidered. Passing a raw `file_path` instead of the step's `file_ref` bypasses this binding. Statements listed in `overlaps_with` (same account and currency, intersecting periods) are information only: both keep their steps, rows in the overlap are deduplicated on import, and reference-less rows there may come back as possible-duplicate review.

Avoid raw internal field names unless they help the user make a concrete choice.

On the guided profiles, the `file_ref`s under `detected_inputs.camt_files` / `wise_csv_files` are bank-input references for the guided bank tool. Like a raw `file_path`, they are not bound to the scanned bytes; only the recommended steps' references carry that binding (byte-identical copies).

### Step 3: Ask only the listed questions

If `autopilot.needs_one_decision` is non-empty:
- ask only those listed questions
- ask them one at a time
- always start with the recommended default
- if the user answers, re-run `accounting_inbox` with `mode: "dry_run"`, mapping the answer onto the matching override argument (`bank_account_dimension_id`, `receipt_matching_dimension_id`, `wise_account_dimension_id`, or `wise_inter_account_dimension_id`), before continuing
- the `wise_inter_account_dimension_id` question has no preferred candidate: ask the owner. It matters only when the Wise CSV has own-account transfers; rows without own-account evidence on another bank are held (not imported) until it is answered, reported as one `wise_transfer_counterpart_unresolved` review item; the other rows are planned as usual

Overlapping CAMT statements raise the same review item once per file. An item for the same statement leg (same bank reference, leg, review code, journals or transactions, and bank account) is listed once, with `seen_in_steps` naming the dry-run steps that raised it; items without a bank reference are never merged, so a repeat of one of those may still be listed per file.

If an item under `autopilot.needs_accountant_review` includes:
- `recommendation`: present that first as the default compliant handling; a recommendation that deletes or invalidates a row is carried out only after the owner explicitly approves that row
- `compliance_basis`: summarize it briefly in plain language
- `follow_up_questions`: ask only those questions that the payload itself did not already answer
- `resolver_input`: pass that object to `continue_accounting_workflow` with `action: "resolve_review"` before inventing your own follow-up plan

If there are no unresolved questions, continue immediately.

If `autopilot.next_recommended_action` is present, treat it as the default next safe step.
If `autopilot.next_question` is present, use it as the first follow-up question when no safer dry-run step should happen first.

### Step 4: Continue with the recommended dry-run steps

The autopilot already ran the safe default dry-run steps.
- do not repeat them unless the user asks
- continue from the next unresolved item
- use more specific workflows only for focused follow-up
- do not use any `execute: true` mutation without explicit approval

### Step 5: Keep the interaction decision-light

Default behavior:
- use the suggested bank dimensions when the tool marks them as ready
- keep questions recommendation-first
- only interrupt the user when a missing input or a genuine accounting judgment is unresolved

If live defaults are unavailable because credentials are not configured:
- explain that workspace scanning still worked
- explain that bank-account defaults may need manual confirmation
- keep the questions practical and recommendation-first

### Step 6: Summarize status clearly

After each pass, group the outcome as:
- done automatically
- needs one decision
- needs accountant review

This should feel like an inbox triage, not a technical tool dump.
