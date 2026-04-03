# Resolve Accounting Review

Take one accounting review item and turn it into the next concrete step with the fewest possible user questions.

## Arguments

- `review_item_json`: JSON object from `autopilot.needs_accountant_review[*].resolver_input` or a direct review item payload

## Workflow

### Step 1: Resolve the review item

Call `resolve_accounting_review_item`:
- `review_item_json`: the provided JSON object

Treat the tool response as the source of truth:
- `recommendation`
- `compliance_basis`
- `unresolved_questions`
- `suggested_workflow`
- `suggested_tools`
- `suggested_rule_markdown`
- `next_step_summary`

### Step 2: Present the result in the right order

Always present:
- the recommendation first
- a short plain-language explanation of the compliance basis
- only the unresolved questions, if any
- the next concrete workflow or tool step

### Step 3: Keep the interaction minimal

- if `unresolved_questions` is empty, do not invent extra questions
- if `suggested_rule_markdown` is present, offer it only as an optional future default
- do not execute any mutating follow-up without explicit approval
