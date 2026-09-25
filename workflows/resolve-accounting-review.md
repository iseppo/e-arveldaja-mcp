# Resolve Accounting Review

Take one accounting review item and turn it into the next concrete step with the fewest possible user questions.

## Arguments

- `review_item_json`: JSON object from `autopilot.needs_accountant_review[*].resolver_input` or a direct review item payload

## Workflow

### Step 1: Resolve the review item

Call `continue_accounting_workflow`:
- action: "resolve_review"
- `review_item_json`: the provided JSON object

Treat the tool response as the source of truth:
- `recommendation`
- `compliance_basis`
- `unresolved_questions`
- `suggested_workflow`
- `suggested_tools`
- `next_step_summary`

### Step 2: Present the result in the right order

Always present:
- the recommendation first
- a short plain-language explanation of the compliance basis
- only the unresolved questions, if any
- the next concrete workflow or tool step

For owner-paid expense receipts:
- VAT-registered company: ordinary business input VAT normally defaults to deductible.
- Non-VAT-registered company: book the gross amount with no input-VAT deduction.
- Likely restricted categories (representation, passenger-car, etc.): need confirmation, unless a saved company booking rule already defines the policy.
- To book it, continue with `action: "prepare_action"` (see the `prepare-accounting-review-action` workflow, "Owner-paid expense receipts"): the answers go into `review_item_json.item.owner_expense`, and the prepared journal is booked with `action: "execute_review_action"`.

### Step 3: Keep the interaction minimal

- if `unresolved_questions` is empty, do not invent extra questions
- do not execute any mutating follow-up without explicit approval

### Step 4: When the review item is already understood

If the next step is clear, continue with `continue_accounting_workflow` and `action: "prepare_action"` instead of inventing your own action plan.
