# e-arveldaja MCP Server

TypeScript MCP server for the Estonian e-arveldaja (RIK e-Financials) REST API.
88 tools, 6 workflow prompts, 12 resources across 11 modules. Supports multiple companies/accounts.

## Quick Start

```bash
npm run build          # tsc -> dist/
npm run start          # node dist/index.js (stdio transport)
npm run dev            # tsx src/index.ts (development)
```

## Credentials

All `apikey*.txt` files are scanned from the project root and its parent directory. Multiple files = multiple connections (companies).

Credentials are loaded in this priority order (see `src/config.ts`):

1. **Environment variables**: `EARVELDAJA_API_KEY_ID`, `EARVELDAJA_API_PUBLIC_VALUE`, `EARVELDAJA_API_PASSWORD`
2. **`EARVELDAJA_API_KEY_FILE`** env var pointing to a specific file
3. **`apikey*.txt` files** — scanned from the project root. Set `EARVELDAJA_SCAN_PARENT=true` to also scan the parent directory.

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
- Example: `PATCH /transactions/{id}/register` with body `[{"related_table":"purchase_invoices","related_id":123,"amount":59.94}]`
- **Card payments often have `clients_id: null`** — confirmation fails with "buyer or supplier is missing". `TransactionsApi.confirm()` auto-fixes this by looking up the client from the linked invoice.

### Purchase invoice creation (non-VAT company)
- Do **not** pass `gross_price` at creation — the API computes it
- For VAT tracking on items: set `vat_rate_dropdown`, `vat_accounts_id`, `cl_vat_articles_id`, `project_no_vat_gross_price`
- The API will compute `vat_amount` on the item but invoice-level `vat_price` stays 0 for non-VAT companies

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
    bank-reconciliation.ts # Transaction matching and auto-confirmation
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
All mutating API methods (`create`, `update`, `delete`, `confirm`, `merge`, `deactivate`, `uploadDocument`, `deleteDocument`) call `cache.invalidate(this.basePath)` before the API call.

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
- Error messages are sanitized (no raw API response bodies)
- Cache is bounded to 500 entries with LRU eviction

## Estonian Tax Rules

- **KMD INF**: Partner detail annex, threshold 1000 EUR net per partner
- **Standard VAT rate**: 24% (from 1.07.2025)
- **VD**: Intra-community supply declaration (EU only)
- **CIT on dividends**: 22/78 corporate income tax rate
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
const { tools } = await client.listTools(); // 85 tools
```
