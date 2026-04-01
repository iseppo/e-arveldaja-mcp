# Accounting Rules

Use this file for company-specific accounting choices that the ledger cannot prove by itself.
Keep free-form notes here if useful; only the markdown tables below are machine-read.

## Auto Booking

Add counterparty-specific defaults here when supplier history is not enough.

Columns:
- `match`
- `category`
- `purchase_article_id`
- `purchase_account_id`
- `purchase_account_dimensions_id`
- `liability_account_id`
- `vat_rate_dropdown`
- `reversed_vat_id`
- `reason`

## Owner Expense Reimbursement

Set a default only if your policy is stable.

If you want a global default, add a plain text line here using:
- `Default VAT deduction mode: full`
- `Default VAT deduction mode: none`
- `Default VAT deduction mode: partial ratio 0.5`

Optional account overrides table:
- `expense_account`
- `vat_deduction_mode`
- `vat_deduction_ratio`

## Liability Classification

Add account-level overrides only when maturity is known outside the ledger.

Columns:
- `account_id`
- `classification`

## Cash Flow Category

Add account-level overrides when the standard chart-of-accounts heuristic is not enough.

Columns:
- `account_id`
- `category`
