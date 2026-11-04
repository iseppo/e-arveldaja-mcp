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

For CAMT journal reviews (`review_type: "camt_journal_review"`):
- Compare the named journal with the statement row. If it books the row and the owner confirms, continue with `action: "prepare_action"` (see the `prepare-accounting-review-action` workflow, "CAMT journal reviews the owner has checked"), so later imports do not raise it again; nothing is booked.
- If the movement is not booked yet (the named journal is another payment), never use `prepare_action` for it: that acknowledgement records that the journal books this row, the opposite decision.<!-- E_ARVELDAJA_FEATURE_START:standard --> Create the missing transaction inline after approval with `create_transaction` (as in the **Import CAMT** workflow).<!-- E_ARVELDAJA_FEATURE_END:standard --><!-- E_ARVELDAJA_FEATURE_START:guided --> This profile cannot create it: keep the item unresolved and route it to the `standard` or `full` profile (`EARVELDAJA_PROFILE`).<!-- E_ARVELDAJA_FEATURE_END:guided -->

### Step 3: Keep the interaction minimal

- if `unresolved_questions` is empty, do not invent extra questions
- do not execute any mutating follow-up without explicit approval

### Step 4: When the review item is already understood

If the next step is clear, continue with `continue_accounting_workflow` and `action: "prepare_action"` instead of inventing your own action plan — for a CAMT journal review only after the owner has confirmed that the existing journal books this movement.
