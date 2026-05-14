# RIK e-Financials OpenAPI Spec Defects

Defects found in the OpenAPI 3.1 specification served at `GET /openapi.yaml` on the RIK e-Financials API server. Verified against the spec downloaded 2026-05-14.

## 1. Opening balance entries are not available through the documented journal API

**Location:** accounting data exposed through `GET /journals` and `GET /journals/{id}`; e-arveldaja UI section "Algbilansi kanded".

MCP tools can currently compute balances only from journal postings returned by the journal API. In companies with opening balances entered through e-arveldaja's separate "Algbilansi kanded" section, those entries do not appear to be included in the journal API data available to the integration. As a result, external integrations can compute materially wrong balances:

- `compute_balance_sheet` can omit assets, liabilities, and equity created by opening balances.
- `compute_account_balance` can return wrong balances for accounts affected by opening balances.
- `compute_trial_balance` can omit opening-balance debit/credit totals.
- `compute_profit_and_loss` and period comparisons can be misleading when opening-balance data is needed for context.
- `list_journals` gives the impression that all ledger-impacting journal-like entries are listed, while opening balances may be missing.

Reproduction scenario:

1. In e-arveldaja UI, create an opening balance entry under "Algbilansi kanded", for example DR 1020 / CR 2900 for 1,000 EUR.
2. Query `GET /journals` and `GET /journals/{id}` through the API.
3. Observe that the opening balance entry is not represented as a normal journal/posting payload available to the API client.
4. Any integration that derives ledger balances from `/journals` returns balances missing that 1,000 EUR.

Requested API behavior:

- Either expose opening balance entries through an explicit endpoint such as `GET /opening_balances` / `GET /opening_balance_entries`, with account IDs, debit/credit direction, base amount, date, currency, and deletion/registration state;
- or include them in `GET /journals` / `GET /journals/{id}` with a distinct `operation_type` / source marker such as `OPENING_BALANCE`;
- and document whether standard financial-reporting consumers must merge these records with journals to produce complete balances.

Until this is available or documented, API consumers cannot reliably reproduce e-arveldaja UI balances from API data alone.

## Resolved on the RIK side (verified 2026-05-14)

The following defects, originally filed against the spec downloaded 2026-03-15, have been corrected in the current spec:

- `GET /sale_invoices/{id}/delivery_options` 200/409 response refs were swapped — `200` now correctly references `SaleInvoicesDeliveryOptions` and `409` references `ApiResponse`.
- `SaleInvoicesDeliveryRequest.required` referenced `can_send_einvoice` / `can_send_email`, which are properties of `SaleInvoicesDeliveryOptions`. The required list now correctly names `send_einvoice` / `send_email`.
- `ApiFile.required` listed the nonexistent field `code` (likely copy-pasted from `ApiResponse`). It now correctly lists `name` and `contents`.
- `Postings.journals_id` was marked `required` despite being auto-populated by the server when postings are embedded in `POST /journals`. It is now marked `readOnly: true` and removed from the `required` list.
