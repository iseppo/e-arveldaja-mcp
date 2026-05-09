<!-- Generated from workflows/company-overview.md. Edit that source file, then run npm run sync:workflow-prompts. -->

# Company Overview

Prepare a compact financial overview for the active e-arveldaja connection.

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

Do not create, update, confirm, send, or delete records in this workflow.
