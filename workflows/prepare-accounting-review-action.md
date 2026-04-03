# Prepare Accounting Review Action

Turn a resolved accounting review item into the next concrete action, such as deleting a duplicate transaction or saving a stable auto-booking rule.

## Arguments

- `review_item_json`: JSON object from `autopilot.needs_accountant_review[*].resolver_input` or a direct review item payload
- Optional `save_as_rule`
- Optional `rule_override_json`

## Workflow

### Step 1: Prepare the action

Call `prepare_accounting_review_action`:
- `review_item_json`: the provided JSON object
- include `save_as_rule` when the user has confirmed this should become a reusable rule
- include `rule_override_json` when the booking fields have already been chosen explicitly

Treat the tool response as the source of truth:
- `status`
- `recommendation`
- `unresolved_questions`
- `proposed_action`
- `suggested_workflow`
- `suggested_tools`
- `next_step_summary`

### Step 2: Keep the interaction minimal

- if `status="needs_answers"`, ask only `unresolved_questions`
- if `proposed_action` is present, present it as the default next step
- ask for explicit approval before executing any `proposed_action`
- if the action is `save_auto_booking_rule`, explain briefly that it updates the local `accounting-rules.md` file
