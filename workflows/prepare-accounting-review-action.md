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

### CAMT journal reviews the owner has checked

A `camt_journal_review` item (`review_type: "camt_journal_review"`, or a CAMT `needs_review` item with `code: "camt_journal_review"`) that carries `item.acknowledgement` can be acknowledged when the owner confirms the named journal books that statement row. Nothing is booked or changed in e-arveldaja; the check is recorded so later imports of the same statement do not raise the row again.

1. Only after the owner confirms the journal books the row, call `action: "prepare_action"` with the item as returned. Refusals keep the review: `camt_ack_nonunique_movement` (the statement holds an identical second movement), `camt_ack_multiple_candidates` (more than one journal may book it — a possible double booking), `camt_ack_journal_already_claimed` (the journal is bound to another row), `camt_ack_journal_mismatch` (the journal does not move exactly this amount in this direction on the bank account), `camt_ack_needs_inbox_scan` (no inbox scan in this server session has compared the statement with the other statements — run an inbox scan first; also at execute after a restart), `camt_ack_code_not_acknowledgeable` (a wrong booking that needs a correction). Tell the owner the reason; never retry around it.
2. With `status="ready_for_approval"`, show `proposed_action.acknowledgement` (date, amount, direction, journal) and ask for explicit approval.
3. After approval, call `action: "execute_review_action"` with the same `review_item_json` and the returned `plan_handle`. `status: "acknowledged"` means it is recorded. `plan_drift` means the journal or review item changed: re-run the statement preview, prepare again and obtain fresh approval.
4. For other refusals, follow the returned `error_code` and explanation, keeping the review open. `camt_ack_store_unavailable` means the check could not be stored (single-file rules mode cannot store acknowledgements); explain the storage issue, do not claim the journal changed or change storage configuration automatically. `camt_ack_needs_inbox_scan` requires an inbox scan in this server session first. An invalid, expired or consumed plan handle requires fresh preparation and approval, not a claim that the journal changed. After resolving any refusal, use fresh preparation and approval before retrying execution; never retry around a refusal.

### Owner-paid expense receipts

A `receipt_review` item classified `owner_paid_expense_reimbursement` is booked by the server as one owner-payable DRAFT journal; registration is a separate step. It needs these answers under `review_item_json.item.owner_expense`:

- required: `owner_client_id` (the owner's client id), `effective_date` (YYYY-MM-DD), `description`, `net_amount` (EUR, without VAT), `vat_rate` (decimal fraction, e.g. 0.24; 0 when there is no VAT), `expense_account`, `payable_account` (the account holding the debt to the owner; the server default is 2110, but it is never assumed here — confirm it or name the company's account)
- when the expense or payable account has dimensions (e.g. 1360 split by person, or a 2110 split by lender, when the company uses dimensions there): `expense_account_dimension_id` / `payable_account_dimension_id`, the dimension id of that account (`missing_answers` lists the account's dimensions; for the debt to the owner pick the owner's own dimension, never another lender's). A dimension that is not the account's is refused
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
3. After approval, call `continue_accounting_workflow` with `action: "execute_review_action"`, the same `review_item_json`, and the returned `plan_handle`. This creates the journal as an unconfirmed draft: until it is registered, neither the expense nor the owner debt is in the ledger or the reports, so do not call the expense booked yet. A `plan_drift` error means the item or the live books changed: prepare again. A retry of an already-booked document-numbered receipt returns the existing journal (`booking_status: "duplicate"`) instead of booking twice.
4. Take the journal id from `journal_entry.api_response.created_object_id` and read the journal back.
<!-- E_ARVELDAJA_FEATURE_START:standard -->
   Call `get_journal` with that id and show its number, `registered` status and postings. If it is not registered, ask for explicit approval to register it, then call `confirm_journal` for that one journal.
<!-- E_ARVELDAJA_FEATURE_END:standard -->
<!-- E_ARVELDAJA_FEATURE_START:guided -->
   Call `inspect_accounting_record` with `entity: "journals"` and that id, and show its `registered` status. No tool on this profile registers a journal: when it is not registered, report the draft journal id and status, and tell the user the `standard` or `full` profile (`EARVELDAJA_PROFILE`) confirms it inline; the web UI is the fallback.
<!-- E_ARVELDAJA_FEATURE_END:guided -->
