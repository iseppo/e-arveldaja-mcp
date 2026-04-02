# Accounting Inbox

Start from one workspace-level scan, propose only the next safe dry-run steps, and ask the fewest possible follow-up questions.

## Arguments

- Optional `workspace_path`: folder to scan for CAMT statements, Wise CSV files, and receipt folders

## Workflow

### Step 1: Scan the workspace

Call `prepare_accounting_inbox`:
- include `workspace_path` when the user provided one

Treat the tool response as the planning source of truth:
- `user_summary`
- `detected_inputs`
- `defaults`
- `next_recommended_action`
- `next_question`
- `recommended_steps`
- `questions`
- `assistant_guidance`

### Step 2: Explain the plan in plain language

Present:
- what likely inputs were found
- what can be done immediately with safe dry runs
- what still needs one small decision
- whether anything already looks like accountant-review territory

Avoid raw internal field names unless they help the user make a concrete choice.

### Step 3: Ask only the listed questions

If `questions` is non-empty:
- ask only the listed questions
- ask them one at a time
- always start with the recommended default
- if the user answers, re-run `prepare_accounting_inbox` with the chosen override values before continuing

If `questions` is empty, continue immediately.

If `next_recommended_action` is present, treat it as the default next safe step.
If `next_question` is present, use it as the first follow-up question when no safer dry-run step should happen first.

### Step 4: Run the recommended dry-run steps

Use `recommended_steps` in order:
- prefer read-only previews such as `parse_camt053` before import dry runs
- use `execute: false` dry runs before any mutation
- do not use any `execute: true` mutation without explicit approval

If a step points to a more specific workflow such as CAMT import, Wise import, or receipt batch processing, follow that workflow's dry-run logic next.

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
