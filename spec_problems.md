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
