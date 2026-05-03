# RIK e-Financials OpenAPI Spec Defects

Defects found in the OpenAPI 3.1 specification served at `GET /openapi.yaml` on the RIK e-Financials API server. Verified against the spec downloaded 2026-03-15.

## 1. `GET /sale_invoices/{id}/delivery_options` — response codes reversed

**Location:** paths `/sale_invoices/{sale_invoices_id}/delivery_options` responses (spec lines ~1855-1870)

- `200` returns `ApiResponse` (generic success wrapper)
- `409` returns `SaleInvoicesDeliveryOptions` (the actual delivery options object)

These are almost certainly swapped. A successful GET should return delivery options at `200`, not at `409 Conflict`.

## 2. `SaleInvoicesDeliveryRequest.required` references wrong field names

**Location:** components/schemas/SaleInvoicesDeliveryRequest (spec lines ~3090-3092)

The `required` list says:
```yaml
required:
  - can_send_einvoice
  - can_send_email
```

But the actual properties in this schema are `send_einvoice` and `send_email` (without the `can_` prefix). The `can_send_*` fields belong to `SaleInvoicesDeliveryOptions` (the response schema for delivery_options). Looks like a copy-paste error.

## 3. `ApiFile.required` references nonexistent field `code`

**Location:** components/schemas/ApiFile (spec lines ~4552-4553)

```yaml
ApiFile:
  properties:
    name:
      type: string
    contents:
      type: string
      format: byte
  required:
    - code
```

`ApiFile` has properties `name` and `contents` — there is no `code` field. The `required: - code` was likely copied from the `ApiResponse` schema immediately above (which does have a `code` property). Should probably be `required: [name, contents]` or removed entirely.

Affects all document upload/download endpoints: `GET/PUT/DELETE /{entity}/{id}/document_user` for journals, transactions, sale invoices, and purchase invoices.

## 4. `Postings.journals_id` required but auto-filled

**Location:** components/schemas/Postings (spec lines ~3469-3504)

```yaml
Postings:
  properties:
    journals_id:
      type: integer
      description: entry id
    # ...
  required:
    - journals_id
    - accounts_id
    - amount
```

`journals_id` is listed as required alongside `accounts_id` and `amount`, but it is NOT marked `readOnly`. In practice the API auto-populates `journals_id` from the parent journal when postings are created as part of `POST /journals`. Clients creating journals with embedded postings cannot know the journal ID in advance.

Should either be marked `readOnly: true` or removed from the `required` list.

## 5. Opening balance entries are not available through the documented journal API

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
