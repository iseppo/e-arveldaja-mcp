# Reconcile Bank Transactions

Match unconfirmed bank transactions to open invoices and confirm the matches.

**Input:** One of:
- `auto` or empty — dry run first, then confirm high-confidence matches with user approval
- `review` — show all matches for manual review without confirming
- A transaction ID — show match details for that specific transaction

## Step 1: Get matches

Call `reconcile_transactions`:
- `min_confidence`: `30` (to see all potential matches including low-confidence ones)

Review the output:
- `total_unconfirmed`: bank transactions needing attention
- `matched`: transactions with at least one candidate match
- `unmatched`: no match found

If `total_unconfirmed` is 0, everything is reconciled — stop here.

## Step 2: Present matches

Show a summary grouped by confidence level:

**HIGH (>=80):** Safe to auto-confirm.
- Transaction: date, amount, description, and raw `type` if helpful
- Do not infer incoming vs outgoing direction from `type` alone; bank transactions are commonly stored as `C` regardless of direction in e-arveldaja
- Matched invoice: number, client, gross amount, confidence, match reasons

**MEDIUM (50-79):** Review recommended.

**LOW (<50):** Unlikely matches, shown for reference only.

If no `distribution` key is present or a partially paid warning is present, say clearly that no ready-to-use distribution is provided and the remaining open balance must be checked manually first.

## Step 3: Handle based on mode

### Auto mode

First, do a dry run:

Call `auto_confirm_exact_matches`:
- `execute`: `false`
- `min_confidence`: `90`

Treat `execution` as the canonical batch payload when present. Prefer `execution.summary`, `execution.results`, `execution.errors`, and `execution.audit_reference`.

Show what would be confirmed. Ask user for approval.

If approved, call again with `execute: true`.

Report: how many confirmed, how many skipped, any errors.

### Review mode

Show all matches. For each, ask user to confirm or skip.

For approved matches, call `confirm_transaction`:
- `id`: transaction ID
- `distributions`: `JSON.stringify([match.distribution])`

Only do this when a `distribution` key is present.
- If no `distribution` key is present or the invoice is partially paid, inspect the invoice first and prepare the distribution manually instead of reusing `match.distribution`.
- Only confirm one explicitly approved match at a time; do not auto-confirm ambiguous transactions.

### Single transaction mode

Call `reconcile_transactions` with `min_confidence: 0`, then filter the returned matches to the requested transaction ID.
- If no match exists for that transaction, report that and stop.
- If the user approves a match and it has a `distribution` key, call `confirm_transaction` with `distributions: JSON.stringify([match.distribution])`.
- If no `distribution` key is present, inspect the invoice first and prepare the distribution manually instead of reusing `match.distribution`.

## Step 4: Inter-account transfers

For transfers between your own bank accounts (counterparty matches company name or IBAN matches another own account):

Call `reconcile_inter_account_transfers`:
- `execute`: `false` (dry run first)

Review the results:
- Treat `execution.summary` as the canonical source for counts, and use `pairs`, `one_sided`, `already_handled`, and `ambiguous_pairs` for detailed breakdown.
- `already_handled`: transfers already journalized from the other side — safe to delete
- `one_sided`: would confirm against the other bank account
- `pairs`: would confirm the outgoing side and delete the duplicate incoming `PROJECT` row (`incoming_action: "would_delete_duplicate"`)
- `execution.errors`: any confirmation failures or other blocking issues
- Never manually confirm both sides of a transfer pair; that duplicates the journal and breaks the single-journal invariant.

Ask for approval. If approved, call again with `execute: true`.
- If there are 3+ bank accounts and IBAN is missing, provide `target_accounts_dimensions_id`.
- In `pairs`, `incoming_action: "deleted"` is normal; `incoming_action: "orphan"` means the duplicate incoming row could not be deleted and needs explicit follow-up.

**WARNING:** Do not manually confirm Wise-side transfers that were already confirmed via LHV CAMT — this creates duplicate journal entries.

## Step 5: Unmatched transactions

List transactions with no matches and suggest actions:
- Small amounts (<1 EUR): likely bank fees or interest — need a manual journal entry
- Description contains "teenustasu", "intress", "service fee": bank charges
- Larger amounts: check if the corresponding invoice exists in the system

## Step 6: Summary

Report:
- Transactions confirmed in this session
- Remaining unconfirmed transactions
- Unmatched transactions requiring manual attention
- If mutating tools were executed, mention that side effects can be reviewed via `execution.audit_reference`
