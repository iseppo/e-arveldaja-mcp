# Prepare Accounting Review Action

Turn a resolved accounting review item into the next concrete action, such as cleaning up a duplicate transaction or saving a stable auto-booking rule.

## Arguments

- `review_item_json`: JSON object from `autopilot.needs_accountant_review[*].resolver_input` or a direct review item payload
- Optional `save_as_rule`
- Optional `rule_override_json`

## Workflow

### Step 1: Prepare the action

Call `continue_accounting_workflow`:
- action: "prepare_action"
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
- if the action is `cleanup_camt_possible_duplicate`, explain briefly that it fills missing CAMT metadata onto the kept older transaction before deleting the duplicate PROJECT row
- if the action is `save_auto_booking_rule`, explain briefly that it saves the rule into the company's configured accounting-knowledge store (an Open Knowledge Format bundle by default, or the legacy `accounting-rules.md` single file when that mode is configured)

### Owner-paid expense receipts

A `receipt_review` item classified `owner_paid_expense_reimbursement` is booked by the server as one owner-payable journal. It needs these answers under `review_item_json.item.owner_expense`:

- required: `owner_client_id` (the owner's client id), `effective_date` (YYYY-MM-DD), `description`, `net_amount` (EUR, without VAT), `vat_rate` (decimal fraction, e.g. 0.24; 0 when there is no VAT), `expense_account`, `payable_account` (the account holding the debt to the owner; the server default is 2110, but it is never assumed here — confirm it or name the company's account; an account with per-person dimensions such as 1360 cannot be booked this way)
- `question_answers`: one decision per review question, keyed by the `question_id` that `missing_answers` gives for it: `true`, `false`, or `{ "answer": true|false, "note": "..." }`. The `note` is kept as context only and is never read as the decision. A plain text answer is not accepted and leaves the question open, so turn the user's reply into `true` or `false`. What an answer does is fixed by the server for each question:
  - it proceeds (e.g. "yes, business use only");
  - it limits the VAT deduction (e.g. a passenger car whose private use is not excluded — the KMS § 30 lg 4 50% cap; mixed business/private use; hospitality that is not business-trip accommodation), so `vat_deduction_mode` must be `"partial"` (with `deductible_vat_amount`) or `"none"`, and `"full"` is refused;
  - it excludes the VAT deduction (guest reception, or staff meals / other employee personal consumption — KMS § 30 lg 1), so `vat_deduction_mode` must be `"none"` and any other mode is refused. A taxed fringe benefit is a separate case outside this flow;
  - or it blocks the booking (e.g. the source document does not identify the seller, date, amount and VAT; the business link of a trip is not provable). A blocked question is listed under `blocked_answers`, and nothing is prepared until the issue is resolved and re-answered, or the receipt is booked another way. A "no" to a question the server has no rule for also blocks.
- `vat_deduction_mode`: `"full"`, `"partial"` (with `deductible_vat_amount`) or `"none"` — the VAT deduction decided from those answers. It is required while the item has review questions, and it answers none of them by itself
- optional: `vat_amount`, `deductible_vat_amount`, `vat_account`, `document_number` (the receipt number; used to detect an already-booked journal)

Steps:

1. Call `action: "prepare_action"`. With `status="needs_answers"`, ask only the `unresolved_questions`; `missing_answers` names the `owner_expense` field for each answer (`question_answers.<question_id>` for a review question). Add the answers to `item.owner_expense` and call `prepare_action` again with the updated item.
2. With `status="ready_for_approval"`, show `proposed_action.booking_preview` (date, amounts, VAT split, accounts, postings) and ask for explicit approval.
3. After approval, call `continue_accounting_workflow` with `action: "execute_review_action"`, the same `review_item_json`, and the returned `plan_handle`. A `plan_drift` error means the item or the live books changed: prepare again. A retry of an already-booked document-numbered receipt returns the existing journal instead of booking twice.
