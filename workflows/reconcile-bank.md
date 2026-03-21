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
- Transaction: date, amount, type (`D`=incoming, `C`=outgoing), description
- Matched invoice: number, client, gross amount, confidence, match reasons

**MEDIUM (50-79):** Review recommended.

**LOW (<50):** Unlikely matches, shown for reference only.

If `distribution_ready=false` or a partially paid warning is present, say clearly that no ready-to-use distribution is provided and the remaining open balance must be checked manually first.

## Step 3: Handle based on mode

### Auto mode

First, do a dry run:

Call `auto_confirm_exact_matches`:
- `execute`: `false`
- `min_confidence`: `90`

Show what would be confirmed. Ask user for approval.

If approved, call again with `execute: true`.

Report: how many confirmed, how many skipped, any errors.

### Review mode

Show all matches. For each, ask user to confirm or skip.

For approved matches, call `confirm_transaction`:
- `id`: transaction ID
- `distributions`: `JSON.stringify([match.distribution])`

Only do this when `distribution_ready=true`.
- If `distribution_ready=false` or the invoice is partially paid, inspect the invoice first and prepare the distribution manually instead of reusing `match.distribution`.
- Only confirm one explicitly approved match at a time; do not auto-confirm ambiguous transactions.

### Single transaction mode

Call `reconcile_transactions` with `min_confidence: 0`, then filter the returned matches to the requested transaction ID.
- If no match exists for that transaction, report that and stop.
- If the user approves a match and `distribution_ready=true`, call `confirm_transaction` with `distributions: JSON.stringify([match.distribution])`.
- If `distribution_ready=false`, inspect the invoice first and prepare the distribution manually instead of reusing `match.distribution`.

## Step 4: Unmatched transactions

List transactions with no matches and suggest actions:
- Small amounts (<1 EUR): likely bank fees or interest — need a manual journal entry
- Description contains "teenustasu", "intress", "service fee": bank charges
- Larger amounts: check if the corresponding invoice exists in the system

## Step 5: Summary

Report:
- Transactions confirmed in this session
- Remaining unconfirmed transactions
- Unmatched transactions requiring manual attention
