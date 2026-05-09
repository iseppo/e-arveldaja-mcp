# e-arveldaja MCP Server

TypeScript MCP server for the Estonian e-arveldaja (RIK e-Financials) REST API.
121 tools, 15 workflow prompts, 12 resources across 12 modules. Supports multiple companies/accounts.

## Quick Start

```bash
npm run build          # tsc -> dist/
npm run start          # node dist/index.js (stdio transport)
npm run dev            # tsx src/index.ts (development)
```

## Credentials

All `apikey*.txt` files are scanned from the working directory (where the server is launched). Multiple files = multiple connections (companies).

Credentials are loaded in this priority order (see `src/config.ts`):

1. **`EARVELDAJA_API_KEY_FILE`** env var pointing to a specific file
2. **Environment variables**: `EARVELDAJA_API_KEY_ID`, `EARVELDAJA_API_PUBLIC_VALUE`, `EARVELDAJA_API_PASSWORD`
3. **`.env` files** — local working directory first, then global config directory (`~/.config/e-arveldaja-mcp`)
4. **`apikey*.txt` files** — scanned from the working directory (import source, not long-term store)

The `apikey.txt` format:
```
ApiKey ID: <key_id>
ApiKey public value: <public_value>
Password: <password>
```

Set `EARVELDAJA_SERVER=demo` for the demo API (default: `live`).

### Multi-account (multiple companies)

Place multiple `apikey*.txt` files (e.g. `apikey.txt`, `apikey (1).txt`) next to the project.
Use `list_connections` to see all available accounts and `switch_connection` to switch between them.
Switching clears all cached data to prevent cross-company data leaks.

**NEVER commit `.env` or `apikey.txt` to git.** The `.gitignore` is configured to exclude them.

## Authentication

HMAC-SHA-384 signing (`src/auth.ts`):
- Message: `{keyId}:{utcTime}:{urlPath}`
- Signature: `BASE64(HMAC-SHA-384(message, password))`
- Headers: `X-AUTH-KEY: {publicValue}:{signature}`, `X-AUTH-QUERYTIME: {utcTime}`
- Signing uses the URL path only (no query params)

## API Endpoints (RIK e-Financials v1)

OpenAPI spec: `GET /openapi.yaml` on the API server. HTML docs: `/api.html`.

### Action endpoints
- **Confirm/Register**: `PATCH /{entity}/{id}/register` (not `/confirm`)
- **Invalidate**: `PATCH /{entity}/{id}/invalidate`
- **Reactivate**: `PATCH /clients|products/{id}/reactivate`
- **Deactivate**: `PATCH /clients|products/{id}/deactivate`
- **Deliver sale invoice**: `PATCH /sale_invoices/{id}/deliver` (not `/send_einvoice`)

### Document endpoints
- **User-uploaded docs**: `GET/PUT/DELETE /{entity}/{id}/document_user` (PUT to upload, not POST)
- **System-generated sale invoice PDF**: `GET /sale_invoices/{id}/pdf_system`

### Transaction registration
- Body is a **top-level JSON array** of `TransactionsDistribution` objects (not wrapped in `{items: [...]}`)
- Each distribution: `{related_table, amount, related_id?, related_sub_id?}`
- `related_table` values: `"accounts"` (book to a GL account), `"purchase_invoices"`, `"sale_invoices"`
- Example (purchase invoice): `PATCH /transactions/{id}/register` with body `[{"related_table":"purchase_invoices","related_id":123,"amount":59.94}]`
- Example (account with dimensions): `[{"related_table":"accounts","related_id":1360,"related_sub_id":12637323,"amount":1620.70}]`
- **`related_sub_id` is REQUIRED when `related_table="accounts"` and the account has dimensions.** Pass the dimension ID there. Without it, the API rejects with `"Entry cannot be made directly to the account <code> since it has dimensions"`. Common case: account 1360 "Arveldused aruandvate isikutega" with one sub-account per reporting person.
- **Do NOT pass the dimension ID into `related_id`.** That makes the API try to interpret it as an account ID and produces confusing errors like `"Dimension ID=<truncated> not found"`.
- The dimension ID is the integer `id` value returned by `list_account_dimensions` (NOT a sub-account code or label). `related_id` is the integer account ID, `related_sub_id` is the integer dimension ID — both are the database IDs, not the human-readable account/dimension codes.
- **Card payments often have `clients_id: null`** — confirmation fails with "buyer or supplier is missing". `TransactionsApi.confirm()` auto-fixes this by looking up the client from the linked invoice.

### Inline confirmation policy
- When a workflow leaves behind `PROJECT` (unconfirmed) transactions, journals, or `needs_review` items and the agent has the IDs/amounts/counterparties loaded, **always offer inline confirmation** via `confirm_transaction` / `reconcile_inter_account_transfers` / `update_transaction` (for `bank_ref_number` enrichment) / `delete_transaction`. Ask the user yes/no for each item.
- **Never** close a workflow with "these need your manual confirmation in e-arveldaja" / "tee see e-arveldaja UI-s käsitsi" as the default. That is a last-resort fallback only when (a) no MCP tool can perform the action, AND (b) the exact API error has already been shown to the user with what was tried.
- If the API rejects an inline attempt, show the raw API error and the exact body that was sent before suggesting manual UI fallback.

### Transaction type field
- **All bank transactions are `type: "C"`** regardless of direction (both CAMT-imported and API-created)
- The `type` field is cosmetic — it does **not** affect accounting
- **Journal entry direction is determined by the distribution** at confirmation time:
  - Confirming against another bank account → "Laekumine" (receipt): debit target, credit source
  - Confirming against expense/purchase invoice → "Tasumine" (payment): credit bank, debit expense
- The API auto-detects incoming vs outgoing from the account relationship in the distribution

### Transaction status
- **`status: "CONFIRMED"`** — registered/confirmed (not an `is_confirmed` boolean)
- **`status: "PROJECT"`** — unconfirmed/draft
- **`status: "VOID"`** — invalidated
- **To delete**: must `invalidate` confirmed transactions first (CONFIRMED → VOID → delete)

### Purchase invoice creation
- **Always pass invoice-level `gross_price` and `vat_price`** — confirm fails without them ("Gross sum and net sum with taxes differ")
- Do **not** pass item-level `gross_price` for non-VAT companies — the API computes it from `total_net_price`
- `client_name` is required on creation (API field `client_name2`)
- For VAT tracking on items: set `vat_rate_dropdown`, `vat_accounts_id`, `cl_vat_articles_id`, `project_no_vat_gross_price`
- The API will compute `vat_amount` on the item but invoice-level `vat_price` stays 0 for non-VAT companies
- **PATCH requires `items`** — updating invoice fields without including items fails with "Products/services are missing"
- **Accounts with dimensions**: If an expense account (e.g. 5120) has dimensions (sub-accounts), you MUST pass both `purchase_accounts_id` (the account ID) AND `purchase_accounts_dimensions_id` (the dimension ID) on each item. Passing only one fails with "Entry must be made to account's dimension." Use `list_account_dimensions` to find dimension IDs for an account.

### Inter-account transfer reconciliation
- CAMT-imported transactions confirmed as inter-account transfers create journal entries touching both bank accounts
- If the other side (e.g. Wise import) is also confirmed against the same bank account → **duplicate journal entries** and incorrect balance
- **Always use `reconcile_inter_account_transfers`** for inter-account confirmation — it checks existing journals before confirming
- The Wise import tool (`import_wise_transactions`) has built-in duplicate detection for inter-account transfers
- When manually confirming transactions against another bank account, first check for existing journals at that date/amount

### Known issues — Wise account
- **Wise balance has ~0.03 EUR discrepancy** with the real account balance (8.71 vs 8.68 EUR as of 2026-03-22). Root cause not yet identified — likely a pre-existing duplicate or rounding issue from earlier imports. Does not affect LHV balance.

## Architecture

```
src/
  config.ts              # Env/file credential loading, server URL selection
  auth.ts                # HMAC-SHA-384 request signing
  http-client.ts         # Authenticated HTTP client (rate-limited, 60s timeout)
  cache.ts               # In-memory TTL cache (300s default, 500 entry max)
  index.ts               # Server entry point, wires everything together
  api/
    base-resource.ts     # Generic CRUD with caching (listAll max 200 pages)
    clients.api.ts       # Clients (buyers/suppliers)
    products.api.ts      # Products/services
    journals.api.ts      # Journal entries with postings
    transactions.api.ts  # Bank transactions
    sale-invoices.api.ts # Sales invoices
    purchase-invoices.api.ts # Purchase invoices
    readonly.api.ts      # Reference data (accounts, articles, templates, etc.)
  tools/
    crud-tools.ts        # ~50 CRUD tools for all entities + reference data
    purchase-vat-defaults.ts # Purchase VAT article/account resolution from reference data
    account-balance.ts   # D/C balance computation, client debt
    pdf-workflow.ts      # PDF text extraction, invoice validation, supplier resolution, booking suggestions
    bank-reconciliation.ts # Transaction matching, auto-confirmation, inter-account transfer reconciliation
    financial-statements.ts # Trial balance, balance sheet, P&L, month-end close
    aging-analysis.ts    # Receivables/payables aging buckets
    recurring-invoices.ts # Clone sale invoices for recurring billing
    estonian-tax.ts      # Dividend package, owner expense reimbursement
    document-audit.ts    # Duplicate detection, missing documents
    lightyear-investments.ts # Lightyear CSV import (buy/sell/distribution booking)
  types/
    api.ts               # All TypeScript interfaces (~530 lines)
  resources/
    static-resources.ts  # MCP resources (accounts, articles, templates, etc.)
```

## Key Accounting Concepts

### D/C Balance Logic
- **D-type accounts** (assets, expenses): balance = debits - credits
- **C-type accounts** (liabilities, equity, revenue): balance = credits - debits
- Journal postings use `base_amount` (EUR) when available for multi-currency entries
- Balance sheet handles **contra-accounts** (e.g., accumulated depreciation is C-type within Varad)

### Account Types (Estonian)
- **Varad** = Assets (normal balance: D, but contra-assets like kulum are C)
- **Kohustused** = Liabilities (normal: C)
- **Omakapital** = Equity (normal: C)
- **Tulud** = Revenue (normal: C)
- **Kulud** = Expenses (normal: D)

### Cache Invalidation
All mutating API methods (`create`, `update`, `delete`, `confirm`, `deactivate`, `uploadDocument`, `deleteDocument`) call `cache.invalidate(this.basePath)` after a successful API call, ensuring stale data is never served from cache.

### Lightyear Investment CSV
- **BRICEKSP** (IE000GWTNRJ7): money market cash fund, always excluded from trades
- **FX pairing**: Foreign currency trades (e.g., USD) are paired with CN-xxx Conversion entries by date + amount match. Consumed conversions are tracked to prevent double-matching.
- **Sells require capital gains file**: Cost basis comes from the FIFO capital gains CSV. Sells without cost basis data are skipped with a warning.
- **Duplicate detection**: Journal `document_number` field stores `LY:{reference}` (e.g., `LY:OR-EVN9C76R7A`)
- **Dry run default**: Both `book_lightyear_trades` and `book_lightyear_distributions` default to `dry_run=true`

## Security Notes

- File read operations (PDF, CSV) resolve symlinks via `realpath()` and re-check extensions
- `safeJsonParse` enforces 1MB input size limit
- `listAll()` is bounded to 200 pages max
- HTTP client rate-limits to ~10 req/sec
- Error messages are sanitized — upstream API body text is kept off `Error.message` and forwarded on `HttpError.upstream_detail`, OCR-sandbox-wrapped
- Cache is bounded to 500 entries with LRU eviction
- `logAudit` warns (non-blocking) when an entry exceeds PIPE_BUF (4096 B); cross-process append atomicity is guaranteed only below that bound

### OCR / untrusted-text sandbox policy

External-provided text (PDF/OCR, CAMT XML, Wise/Lightyear CSV, upstream API
error bodies) can carry prompt-injection payloads. To keep these out of the
LLM's instruction stream, the affected MCP tool outputs wrap the relevant
fields with a per-call random nonce sandbox via `wrapUntrustedOcr` in
`src/mcp-json.ts`:

```
<<UNTRUSTED_OCR_START:<128-bit-hex-nonce>>>
...untrusted content...
<<UNTRUSTED_OCR_END:<128-bit-hex-nonce>>>
```

**Wrapped at MCP output:**
- Direct processing tools: `extract_pdf_invoice`, `parse_camt053`,
  `import_camt053`, `process_receipt_batch`, `parse_lightyear_capital_gains`,
  `import_wise_transactions`, etc.
- Review/analysis tools consuming imported data: `reconcile_transactions`,
  `reconcile_inter_account_transfers`, `analyze_unconfirmed_transactions`,
  `classify_unmatched_transactions`, `suggest_booking`,
  `find_missing_documents`, `detect_duplicate_purchase_invoice`,
  `month_end_close_checklist`, `generate_annual_report_data`,
  `compute_account_balance` (with `include_entries=true`),
  `compute_receivables_aging`, `compute_payables_aging`,
  `create_recurring_sale_invoices`.
- Upstream API errors: `HttpError.upstream_detail` (forwarded to MCP via
  `toolError`).

**Intentionally NOT wrapped — conscious architectural decision:**
- Generic CRUD read handlers (`get_journal`, `list_journals`, `get_client`,
  `list_clients`, `get_transaction`, `list_transactions`, `get_sale_invoice`,
  `list_sale_invoices`, `get_purchase_invoice`, `list_purchase_invoices`,
  etc.) return raw API payloads verbatim. Rationale: the trust gate for
  OCR/CAMT-origin data is at **import** time, where the direct-processing
  tool wraps it. Once the operator has reviewed and persisted the record
  in e-arveldaja, list/get calls are treated as reading trusted state.
- MCP resources in `src/resources/static-resources.ts` follow the same
  policy: they expose configured reference data (accounts, articles,
  templates), not imported content.

**When adding a new tool:** if it emits text from OCR/CAMT/CSV, upstream API
errors, or fields known to be populated by import flows (journal title
originating from auto-booking, client/supplier names auto-created from
receipt OCR), wrap at MCP output. CRUD `get_*`/`list_*` over unfiltered
API data remains raw.

## Estonian Tax Rules

- **KMD INF**: Partner detail annex, threshold 1000 EUR net per partner
- **Standard VAT rate**: 24% (from 1.07.2025)
- **VD**: Intra-community supply declaration (EU only)
- **CIT on dividends**: 22/78 from 2025-01-01; 20/80 before (date-gated via `getCitRateForDate` in `src/tools/estonian-tax.ts`)
- **ÄS § 157 net-assets block**: `prepare_dividend_package` hard-blocks distributions that lack retained earnings OR would push net assets below share capital. `force=true` overrides both checks (use only alongside a legitimate action such as a capital reduction).
- **Capital gains**: Securities taxed at 22% income tax

## Development

```bash
npx tsc --noEmit      # Type-check without emitting
npx tsc               # Full build to dist/
```

Unit tests use **vitest**:
```bash
npm run test              # vitest run (all unit tests)
npm run test:watch        # vitest in watch mode
npm run test:integration  # integration tests (requires API credentials)
```

Manual testing via MCP client connection:
```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "test", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools(); // 121 tools
```
