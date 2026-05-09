# Company Overview

Prepare a compact financial overview for the active e-arveldaja connection.

This workflow is read-only. It should feel like a dashboard, not a ledger export.

## Period selection

- If the user asks for a specific date, use it as `as_of_date`.
- If no date is requested, use today's date.
- If the user asks for a specific period, use its first day as `date_from`.
- If no period is requested, use the first day of the current year as `date_from`.
- State the chosen `date_from` and `as_of_date` in the summary.

Follow these steps:

1. Call `compute_balance_sheet` with date_to: the selected as_of_date (or today's date when no date is requested).
   - as_of_date: selected reporting date
2. Call `compute_profit_and_loss` with date_from: the selected period start and date_to: the selected as_of_date.
3. Call `compute_receivables_aging`.
4. Call `compute_payables_aging`.
5. Summarize the company state using the returned figures:
   - balance-sheet health and whether the check balances
   - profit or loss for the period
   - overdue receivables
   - overdue payables
   - any visible blockers or follow-up checks

Use this output shape:
- Reporting period
- Balance sheet status
- Profit/loss for the period
- Receivables needing attention
- Payables needing attention
- Next recommended check

Do not create, update, confirm, send, or delete records in this workflow.
