<!-- Generated from workflows/month-end.md. Edit that source file, then run npm run sync:workflow-prompts. -->

# Month-End Close Checklist

Run the month-end close checklist, compute financial statements, and flag issues.

**Input:** Month in YYYY-MM format (e.g. `2026-02`).

## Step 1: Run the checklist

Call `month_end_close_checklist`:
- `month`: YYYY-MM value

## Step 2: Flag blocking issues

Present in priority order:

**BLOCKERS (must fix before closing):**
1. Unconfirmed purchase invoices — not registered in the ledger
2. Unconfirmed sale invoices — revenue not recorded
3. Unconfirmed journal entries — adjustments not posted
4. Unconfirmed bank transactions — cash not reconciled

For each blocker, show ID, date, amount/title. Suggested fixes:
- Purchase invoices: `confirm_purchase_invoice` or delete if duplicate
- Sale invoices: `confirm_sale_invoice`
- Journals: `confirm_journal`
- Transactions: use the **Reconcile Bank** workflow to match and confirm

**WARNINGS (review but may not block close):**
- Overdue receivables — may need follow-up or doubtful debt provision
- Overdue payables — check if payment was made but not yet recorded

## Step 3: Check for missing documents

Call `find_missing_documents`:
- `date_from`: YYYY-MM-01
- `date_to`: last day of the month

Report confirmed purchase invoices without attached PDFs — these need supporting documents for audit compliance.

## Step 4: Check for duplicate invoices

Call `detect_duplicate_purchase_invoice`:
- `date_from`: YYYY-MM-01
- `date_to`: last day of the month

Report exact duplicates (same supplier + invoice number) and suspicious matches (same supplier + amount + date with different numbers).

## Step 5: Compute financial statements

Call `compute_trial_balance`:
- `date_from`: YYYY-MM-01
- `date_to`: last day of the month

Verify total debits = total credits (difference should be 0.00).

Call `compute_profit_and_loss`:
- `date_from`: YYYY-01-01 (fiscal year start)
- `date_to`: last day of the month

Show YTD P&L: total revenue, total expenses, net profit.

Call `compute_balance_sheet`:
- `date_to`: last day of the month

Verify balanced (assets = liabilities + equity).

## Step 6: Summary report

```
Month-End Close: YYYY-MM
================================
Blockers:        X issues
Warnings:        X items
Missing docs:    X invoices
Duplicates:      X found

Trial Balance:   BALANCED / IMBALANCED by X EUR
Balance Sheet:   BALANCED / IMBALANCED
YTD Net Profit:  X.XX EUR

Status: READY TO CLOSE / HAS BLOCKERS
```

If blockers exist, list specific actions needed. Offer to help fix them.
