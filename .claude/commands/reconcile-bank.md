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

### Step 3: Handle based on mode

**If "auto" or empty:**

Call `auto_confirm_exact_matches`:
- execute: false (dry run first)
- min_confidence: 90

Show what would be confirmed. Ask user for approval.

If approved, call `auto_confirm_exact_matches`:
- execute: true
- min_confidence: 90

Report results.

**If "review":**

Show all matches. For each, ask user to confirm or skip.

For approved matches, call `confirm_transaction`:
- id: transaction ID
- distributions: JSON string `[{"related_table": "sale_invoices" or "purchase_invoices", "related_id": invoice_id, "amount": transaction_amount}]`

**If transaction ID:**

Call `get_transaction` with that ID. Show details and matches. Offer to confirm if a match exists.

### Step 4: Unmatched transactions

List transactions with no matches and suggest:
- Small amounts (<1 EUR): likely bank fees/interest, need manual journal entry
- Description contains "teenustasu", "intress", "service fee": bank charges
- Larger amounts: check if corresponding invoice exists

### Step 5: Summary

Report: confirmed count, remaining unconfirmed, unmatched needing manual attention.
