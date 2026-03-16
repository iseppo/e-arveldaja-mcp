# Month-End Close Checklist

Run the month-end close checklist, compute financial statements, and flag issues.

## Arguments

$ARGUMENTS should be the month in YYYY-MM format (e.g. 2026-02). If not provided, use the previous calendar month.

## Workflow

### Step 1: Run the checklist

Call `month_end_close_checklist`:
- month: the YYYY-MM value

### Step 2: Flag blocking issues

Present in priority order:

**BLOCKERS (must fix before closing):**
1. Unconfirmed purchase invoices - not registered in ledger
2. Unconfirmed sale invoices - revenue not recorded
3. Unconfirmed journal entries - adjustments not posted
4. Unconfirmed bank transactions - cash not reconciled

For each, show ID, date, amount/title, and suggest the fix:
- Purchase invoices: `confirm_purchase_invoice` or delete if duplicate
- Sale invoices: `confirm_sale_invoice`
- Journals: `confirm_journal`
- Transactions: suggest running `/reconcile-bank`

**WARNINGS:**
- Overdue receivables - may need follow-up
- Overdue payables - check if payment was made

### Step 3: Check for missing documents

Call `find_missing_documents`:
- date_from: YYYY-MM-01
- date_to: last day of the month

Report confirmed purchase invoices without attached PDFs.

### Step 4: Check for duplicates

Call `detect_duplicate_purchase_invoice`:
- date_from: YYYY-MM-01
- date_to: last day of the month

Report any exact duplicates or suspicious matches.

### Step 5: Compute financial statements

Call `compute_trial_balance`:
- date_from: YYYY-MM-01
- date_to: last day of the month

Verify total debits = total credits.

Call `compute_profit_and_loss`:
- date_from: YYYY-01-01 (fiscal year start)
- date_to: last day of the month

Show YTD P&L: total revenue, expenses, net profit.

Call `compute_balance_sheet`:
- date_to: last day of the month

Verify balanced (assets = liabilities + equity).

### Step 6: Summary report

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

If blockers exist, list specific actions. Offer to help fix them.
