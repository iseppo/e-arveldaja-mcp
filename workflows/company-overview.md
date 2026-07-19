# Company Overview

Prepare a compact financial overview for the active e-arveldaja connection.

This workflow is read-only. It should feel like a dashboard, not a ledger export.

## Period selection

- If the user asks for a specific date, use it as the reporting date.
- If no date is requested, use today's date as the reporting date.
- If the user asks for a specific period, use its first day as `date_from`.
- If no period is requested, use the first day of the current year as `date_from`.
- State the chosen `date_from` and reporting date in the summary.

If the user says they recently changed data in the e-arveldaja web UI or asks for fresh numbers, call `clear_cache` before reading reports.

Follow these steps:

1. Call `compute_balance_sheet` with date_to: the selected reporting date.
2. Call `compute_profit_and_loss` with date_from: the selected period start and date_to: the selected reporting date.
3. Call `compute_payables_aging`.
<!-- E_ARVELDAJA_FEATURE_START:sales -->
4. Call `compute_receivables_aging`.
<!-- E_ARVELDAJA_FEATURE_END:sales -->
Then summarize the company state using the returned figures:
   - balance-sheet health and whether the check balances
   - profit or loss for the period
   - overdue payables
   - any visible blockers or follow-up checks
<!-- E_ARVELDAJA_FEATURE_START:sales -->
   - overdue receivables
<!-- E_ARVELDAJA_FEATURE_END:sales -->

When the sales feature section is unavailable, label the result as a purchase-side financial overview and do not imply that receivables were checked.

Use this output shape:
- Reporting period
- Balance sheet status
- Profit/loss for the period
- Payables needing attention
<!-- E_ARVELDAJA_FEATURE_START:sales -->
- Receivables needing attention
<!-- E_ARVELDAJA_FEATURE_END:sales -->
- Next recommended check

Do not create, update, confirm, send, or delete records in this workflow.
