# Accounting Inbox

Start from one workspace-level scan, propose only the next safe dry-run steps, and ask the fewest possible follow-up questions.

## Arguments

- Optional `workspace_path`: folder to scan for CAMT statements, Wise CSV files, and receipt folders

## Workflow

### Step 1: Scan the workspace

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

Avoid raw internal field names unless they help the user make a concrete choice.

### Step 3: Ask only the listed questions

If `autopilot.needs_one_decision` is non-empty:
- ask only those listed questions
- ask them one at a time
- always start with the recommended default
- if the user answers, re-run `accounting_inbox` with `mode: "dry_run"` and the chosen override values before continuing

If an item under `autopilot.needs_accountant_review` includes:
- `recommendation`: present that first as the default compliant handling
- `compliance_basis`: summarize it briefly in plain language
- `follow_up_questions`: ask only those questions that the payload itself did not already answer
- `resolver_input`: pass that object to `continue_accounting_workflow` with `action: "resolve_review"` before inventing your own follow-up plan

If there are no unresolved questions, continue immediately.

If `autopilot.next_recommended_action` is present, treat it as the default next safe step.
If `autopilot.next_question` is present, use it as the first follow-up question when no safer dry-run step should happen first.

### Step 4: Run the recommended dry-run steps

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
