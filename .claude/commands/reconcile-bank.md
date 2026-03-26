# Reconcile Bank Transactions

Match unconfirmed bank transactions to open invoices and confirm the matches.

## Arguments

$ARGUMENTS can be:
- empty or "auto" - dry run first, then confirm high-confidence matches with user approval
- "review" - show all matches for manual review without confirming
- a transaction ID number - show match details for that specific transaction

## Workflow

### Step 1: Get matches

Call `reconcile_transactions`:
- min_confidence: 30 (to see all potential matches)

Review the output:
- total_unconfirmed: bank transactions needing attention
- matched: transactions with at least one candidate
- unmatched: no match found

If total_unconfirmed is 0, tell the user everything is reconciled and stop.

### Step 2: Present matches

Show a summary table grouped by confidence:

**HIGH (>=80):** safe to auto-confirm
- Transaction date, amount, type (D=incoming, C=outgoing), description
- Matched invoice: number, client, gross amount, confidence, reasons

**MEDIUM (50-79):** needs review
**LOW (<50):** unlikely matches, shown for reference

If no `distribution` key is present or a partially paid warning is present, say clearly that no ready-to-use distribution is provided and the remaining open balance must be checked manually first.

### Step 3: Handle based on mode

**If "auto" or empty:**

Call `auto_confirm_exact_matches`:
- execute: false (dry run first)
- min_confidence: 90

Treat `execution` as the canonical batch payload when present. Prefer `execution.summary`, `execution.results`, `execution.errors`, and `execution.audit_reference`.

Show what would be confirmed. Ask user for approval.

If approved, call `auto_confirm_exact_matches`:
- execute: true
- min_confidence: 90

Report results.

**If "review":**

Show all matches. For each, ask user to confirm or skip.

For approved matches, call `confirm_transaction`:
- id: transaction ID
- distributions: `JSON.stringify([match.distribution])`

Only do this when a `distribution` key is present.
- If no `distribution` key is present or the invoice is partially paid, inspect the invoice first and prepare the distribution manually instead of reusing `match.distribution`.
- Only confirm one explicitly approved match at a time; do not auto-confirm ambiguous transactions.

**If transaction ID:**

Call `reconcile_transactions` with `min_confidence: 0`, then filter the returned matches to that transaction ID.
- If no match exists, report that and stop.
- If the user approves a match and it has a `distribution` key, call `confirm_transaction` with `distributions: JSON.stringify([match.distribution])`.
- If no `distribution` key is present, inspect the invoice first and prepare the distribution manually instead of reusing `match.distribution`.

### Step 4: Inter-account transfers

For transfers between your own bank accounts (counterparty matches company name or IBAN matches another own account):

Call `reconcile_inter_account_transfers`:
- `execute`: `false` (dry run first)

Review the results:
- Treat `execution.summary` as the canonical source for counts, and use `pairs`, `one_sided`, `already_handled`, and `ambiguous_pairs` for detailed breakdown.
- `already_handled`: transfers already journalized from the other side — safe to delete
- `one_sided`: would confirm against the other bank account
- `pairs`: would confirm both outgoing and incoming sides
- `execution.errors`: any confirmation failures or other blocking issues

Ask for approval. If approved, call again with `execute: true`.
- If there are 3+ bank accounts and IBAN is missing, provide `target_accounts_dimensions_id`.

**WARNING:** Do not manually confirm Wise-side transfers that were already confirmed via LHV CAMT — this creates duplicate journal entries.

### Step 5: Unmatched transactions

List transactions with no matches and suggest:
- Small amounts (<1 EUR): likely bank fees/interest, need manual journal entry
- Description contains "teenustasu", "intress", "service fee": bank charges
- Larger amounts: check if corresponding invoice exists

### Step 6: Summary

Report: confirmed count, remaining unconfirmed, unmatched needing manual attention, and `execution.audit_reference` whenever mutating tools were executed.
