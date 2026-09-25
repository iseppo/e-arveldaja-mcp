# Company Overview

Prepare a compact financial overview for the active e-arveldaja connection.

This workflow is read-only. It should feel like a dashboard, not a ledger export.

## Period selection

- If the user asks for a specific date, use it as the reporting date.
- If no date is requested, use today's date as the reporting date.
- If the user asks for a specific period, use its first day as `date_from`.
- If no period is requested, use the first day of the current year as `date_from`.
- State the chosen `date_from` and reporting date in the summary.

<!-- E_ARVELDAJA_FEATURE_START:standard -->
If the user says they recently changed data in the e-arveldaja web UI or asks for fresh numbers, call `clear_cache` before reading reports.
<!-- E_ARVELDAJA_FEATURE_END:standard -->
<!-- E_ARVELDAJA_FEATURE_START:guided -->
Reports read through a short-lived cache (a few minutes): if the user just changed data in the e-arveldaja web UI, say the figures may lag those edits briefly.
<!-- E_ARVELDAJA_FEATURE_END:guided -->

Reporting is only accurate after the relevant journals, invoices, and transactions are confirmed: unconfirmed (PROJECT) records are not yet in the ledger. If recent activity may still be unconfirmed, say so in the summary rather than presenting the figures as final.

Use the SAME operator-selected reporting date as the single cutoff for every figure, so the whole overview shares one consistent cutoff instead of the aging reports silently defaulting to today.

<!-- E_ARVELDAJA_FEATURE_START:standard -->
1. Call `compute_balance_sheet` with `date_to`: the selected reporting date.
2. Call `compute_profit_and_loss` with `date_from`: the selected period start and `date_to`: the selected reporting date.
3. Call `compute_payables_aging` with `as_of_date`: the selected reporting date.
<!-- E_ARVELDAJA_FEATURE_END:standard -->
<!-- E_ARVELDAJA_FEATURE_START:sales -->
4. Call `compute_receivables_aging` with `as_of_date`: the selected reporting date.
<!-- E_ARVELDAJA_FEATURE_END:sales -->
<!-- E_ARVELDAJA_FEATURE_START:guided -->
1. Call `run_accounting_report` with report="balance_sheet" and date_to: the selected reporting date.
2. Call `run_accounting_report` with report="profit_and_loss", date_from: the selected period start and date_to: the selected reporting date.
3. Call `run_accounting_report` with report="aging" and as_of_date: the selected reporting date; read the payables side, and the receivables side when the result includes one.
<!-- E_ARVELDAJA_FEATURE_END:guided -->

Then summarize the company state using the returned figures:
   - balance-sheet health and whether the check balances
   - profit or loss for the period
   - overdue payables
   - overdue receivables, when receivables were read
   - any visible blockers or follow-up checks

When no receivables were read (sales tools are not enabled), label the result as a purchase-side financial overview and do not imply that receivables were checked.

Use this output shape:
- Reporting period
- Balance sheet status
- Profit/loss for the period
- Payables needing attention
<!-- E_ARVELDAJA_FEATURE_START:sales -->
- Receivables needing attention
<!-- E_ARVELDAJA_FEATURE_END:sales -->
<!-- E_ARVELDAJA_FEATURE_START:guided -->
- Receivables needing attention (only when the aging result had a receivables side)
<!-- E_ARVELDAJA_FEATURE_END:guided -->
- Next recommended check

Do not create, update, confirm, send, or delete records in this workflow.
