# e-arveldaja MCP Server

TypeScript MCP server for the Estonian e-arveldaja (RIK e-Financials) REST API.
122 tools by default (117 with Lightyear disabled; up to 135 with the optional granular and setup tools exposed — see Tool exposure below), 16 workflow prompts, 15 resources across 12 modules. Supports multiple companies/accounts.

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

### Accounting-knowledge storage location

Company-specific booking rules (see `src/accounting-rules.ts`) are stored as an
Open Knowledge Format bundle. Two env vars control where it lives:

- **`EARVELDAJA_RULES_DIR`** — points to the bundle directory (OKF: one concept
  per `.md` file + reserved `index.md`/`log.md`). This is the recommended override.
  In this (default) bundle mode, a legacy `accounting-rules.md` found in the
  bundle's parent dir is migrated non-destructively into the bundle on first write.
- **`EARVELDAJA_RULES_FILE`** — opts into legacy single-file mode: rules stay in
  that one `accounting-rules.md` (no bundle, no migration). For people who want
  the old behaviour byte-for-byte.

Without either var the default location is chosen by `chooseDefaultBundleStorage()`:

- If rules already live next to the project (an initialized `accounting-rules/`
  bundle or a legacy `accounting-rules.md` at `getProjectRoot()`), that location
  is kept in place — existing setups never move.
- Otherwise (a fresh / packaged install) the bundle defaults to the per-user
  global config dir — `getGlobalConfigDir()` (`~/.config/e-arveldaja-mcp/accounting-rules`
  or the platform equivalent), the **same convention credentials use** — so the
  knowledge survives reinstalls and is shared across MCP clients.

Set `EARVELDAJA_RULES_DIR` explicitly for a stable per-company path
(e.g. `~/.config/e-arveldaja-mcp/<firma>/accounting-rules`) when running several
companies. Concurrent writes from multiple MCP clients sharing one bundle dir are
serialized with an `O_EXCL` lock file at `<dir>.lock` (`withBundleLock()`).

### Opening balances (algbilanss)

e-arveldaja's REST API omits the "Algbilansi kanded" (opening-balance entries)
section, so the MCP server is otherwise blind to opening balances. The operator
can paste that register once via the `import_opening_balances` tool
(`src/tools/opening-balance-import.ts`): it parses the pasted text
(`src/opening-balance-parse.ts`), checks that debit equals credit, previews
the result under `dry_run` (default `true`), and on `dry_run=false` persists
it as `opening-balances.json` in the same accounting-rules bundle described
above (`src/opening-balance-store.ts`; requires bundle mode — not available
under `EARVELDAJA_RULES_FILE` single-file mode). At compute time the stored
balances are folded in as one synthetic journal dated at the opening date
(`src/opening-balance-journal.ts`), so `compute_account_balance`,
`compute_trial_balance`, `compute_balance_sheet`, `compute_profit_and_loss`,
`generate_annual_report_data`, and the ÄS §157 dividend legality checks in
`prepare_dividend_package` all include it automatically. The feature is
**optional**: with nothing stored, everything behaves exactly as before,
except the old blind "verify in the UI" warning becomes an actionable prompt
pointing at `import_opening_balances` (`src/opening-balance-limitations.ts`).

### Tool exposure (per-session token cost)

`tools/list` is loaded into the client context on every session, so the tool
surface is a fixed per-session token cost. Eight env flags control optional
parts of the surface (see `getToolExposureConfig()` in `src/config.ts`):

- **`EARVELDAJA_DISABLE_LIGHTYEAR=1`** — do not register the Lightyear
  investment tools (`book_lightyear_*`, `parse_lightyear_*`,
  `lightyear_portfolio_summary`) or the `lightyear-booking` prompt. Use when
  the company does not track investments. Default: Lightyear is enabled.
- **`EARVELDAJA_EXPOSE_GRANULAR_TOOLS=1`** — also register the 10 granular
  constituent tools whose functionality is fully covered by merged mode-based
  entry points: `reconcile_transactions`, `auto_confirm_exact_matches`
  (→ `reconcile_bank_transactions`), `parse_camt053`, `import_camt053`
  (→ `process_camt053`), `scan_receipt_folder`, `process_receipt_batch`
  (→ `receipt_batch`), `classify_unmatched_transactions`,
  `apply_transaction_classifications` (→ `classify_bank_transactions`),
  `resolve_accounting_review_item`, `prepare_accounting_review_action`
  (→ `continue_accounting_workflow`). Default: hidden — the merged tools keep
  routing to the same handlers internally, so no functionality is lost.
  `reconcile_inter_account_transfers` is never gated (no merged execute mode).
- **`EARVELDAJA_EXPOSE_SETUP_TOOLS=1`** — also register the credential-management
  tools (`import_apikey_credentials`, `list_stored_credentials`,
  `remove_stored_credentials`) when the server already has configured
  connections. They are always registered in setup mode (no connections) and
  hidden by default once credentials exist, since they are only needed to add or
  rotate credentials. `get_setup_instructions` is never gated, so the agent can
  always explain how to add a connection (set this flag to add a second company
  without a restart).

The next five are opt-out feature-group flags (default enabled; the group is
registered unless the flag is set). They cut the surface for a lean deployment
without changing the default:

- **`EARVELDAJA_DISABLE_TAX_TOOLS=1`** — do not register the Estonian tax
  helpers (`prepare_dividend_package`, `create_owner_expense_reimbursement`,
  `check_tax_free_limits`). The statutory tax-rules advisory layer used by
  `suggest_booking` is unaffected — only these three tools are unregistered.
  Use when the deployment never runs dividend/reimbursement/tax-free-limit
  workflows. Saves ≈1.5k tokens.
- **`EARVELDAJA_DISABLE_REFERENCE_ADMIN=1`** — do not register the reference-data
  administration tools that create, update, or delete configuration:
  `create/update/delete_bank_account`, `create/update/delete_invoice_series`,
  `update_invoice_info`, and the single-record `get_bank_account` /
  `get_invoice_series` reads. The `list_*` / `get_invoice_info` / `get_vat_info`
  reads stay registered so the agent can still inspect the configuration. Use
  when the chart of accounts, bank accounts, and invoice series are already set
  up and managed in the e-arveldaja UI. Saves ≈1.7k tokens.
- **`EARVELDAJA_DISABLE_ANNUAL_REPORT=1`** — do not register the annual-report /
  year-end tools (`prepare_year_end_close`, `generate_annual_report_data`,
  `execute_year_end_close`). Use for the bulk of the year; re-enable at closing
  time. Saves ≈0.4k tokens.
- **`EARVELDAJA_DISABLE_SALES=1`** — do not register the sales-invoicing side:
  the 11 sale-invoice tools (`list/get/create/update/delete/confirm/invalidate_sale_invoice`,
  `get_sale_invoice_delivery_options`, `send_sale_invoice`,
  `get_sale_invoice_document`, `get_sale_invoice_xml`),
  `create_recurring_sale_invoices`, and the accounts-receivable report
  `compute_receivables_aging`. The accounts-payable report
  `compute_payables_aging` and all purchase-invoice tools stay. Use on a
  purchase-side-only bookkeeping deployment. Saves ≈2.7k tokens (13 tools).
- **`EARVELDAJA_DISABLE_PRODUCTS=1`** — do not register the product-catalog tools
  (`list/get/create/update/deactivate/reactivate/delete_product`). Products are
  the sale-invoice line-item catalog (not used by purchase invoices), so a
  `DISABLE_SALES` deployment usually sets this too — but the flags are
  independent. Saves ≈1.3k tokens (7 tools).

The default surface is 122 tools; `DISABLE_LIGHTYEAR` drops it to 117.
`EXPOSE_GRANULAR_TOOLS` adds the 10 granular tools, `EXPOSE_SETUP_TOOLS` the 3
credential tools; enabling both raises it to the full 135. The five opt-out
group flags trim the default further — `DISABLE_TAX_TOOLS` (−3),
`DISABLE_REFERENCE_ADMIN` (−9), `DISABLE_ANNUAL_REPORT` (−3), `DISABLE_SALES`
(−13), `DISABLE_PRODUCTS` (−7) — so a lean purchase-side-only deployment with
every disable flag set (incl. Lightyear) lands near 80 tools. (The former
`prepare_accounting_inbox` / `run_accounting_inbox_dry_runs` tools were
exact aliases of `accounting_inbox` `mode="scan"` / `mode="dry_run"` and have
been removed — use `accounting_inbox` with the matching `mode`.)

`recommend_workflow` filters its suggestions to the registered surface, so it
never names a tool an opt-out flag has dropped (and it hides a whole workflow
whose tools are all gated, e.g. `lightyear-booking` when Lightyear is off). The
static workflow prompts (`company-overview`, `month-end`, …) are shared across
purchase- and sales-side deployments and are not gated per flag, so they may
still mention a dropped tool (e.g. `compute_receivables_aging` under
`DISABLE_SALES`); the agent simply skips a tool that is not in `tools/list`.

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
- **User-uploaded docs**: `GET/PUT/DELETE /{entity}/{id}/document_user` (PUT to upload, not POST). Implemented generically on `BaseResource` (`getDocument`/`uploadDocument`/`deleteDocument`, keyed on `basePath`) and exposed by the entity-agnostic tools `attach_document` / `get_document` / `delete_document` (`entity_type` ∈ purchase_invoice, sale_invoice, journal, transaction) in `src/tools/document-attachments.ts`. RPS requires a source document on every entry, so manual journals and directly-booked bank transactions can carry one too — `find_missing_documents` flags those that don't.
- **System-generated sale invoice PDF**: `GET /sale_invoices/{id}/pdf_system` (tool `get_sale_invoice_document`)
- **System-generated sale invoice e-invoice XML**: `GET /sale_invoices/{id}/xml` (tool `get_sale_invoice_xml`) — the structured machine-readable e-arve, distinct from the human-readable PDF

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
  prompt-registry.ts     # Canonical workflow-prompt registry (names, string-only arg schemas, sales variants)
  prompt-arguments.ts    # Strict string→typed parsers for prompt arguments
  workflow-prompt-source.ts # Loads workflows/*.md bodies + run-data for the registry
  prompt-surface.ts      # Shared renderer: safety wrapper, external-text sandbox, 64k budget
  prompts.ts             # Registers the rendered prompts as MCP prompts (text comes from the pipeline above)
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

Workflow prompt text is generated by one pipeline — the canonical registry
`src/prompt-registry.ts` (names, string-only argument schemas, sales variants) →
the `workflows/*.md` bodies loaded by `src/workflow-prompt-source.ts` → the
shared renderer `src/prompt-surface.ts` → MCP prompts registered in
`src/prompts.ts` and the generated `.claude/commands/*.md` mirrors. It is not
hand-written in `src/prompts.ts`. See `ARCHITECTURE.md` → Workflow prompt
pipeline.

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
  `parse_lightyear_statement`, `import_wise_transactions`, etc. (Granular-gated
  tools listed here stay wrapped when exposed; the merged entry points that
  delegate to them — `process_camt053`, `receipt_batch`, … — inherit the same
  wrapped output.)
- `get_document`: the stored/uploaded-document filename (`name`) — it is
  user-supplied content, so it is wrapped in both the metadata-only and
  full-payload branches.
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

**Length cap on OCR blobs:** the OCR `raw_text` inlined by `extract_pdf_invoice`
and the receipt-batch output is truncated to `MAX_UNTRUSTED_TEXT_CHARS` (~20k
chars) via `capUntrustedText` before wrapping, with `raw_text_truncated` /
`raw_text_length` markers when cut — booking uses the structured `extracted`
fields, so a pathological/oversized document cannot flood the consuming LLM's
context.

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
- MCP resources in `src/resources/accounting-knowledge-resources.ts`
  (`earveldaja://accounting_knowledge` and `…/{path}`) expose the OKF
  accounting-rules bundle. This is operator-curated configuration entering
  only through the approval-gated `save_auto_booking_rule` path, so it is
  treated as trusted and emitted unwrapped, same as static reference data.
  Concept reads are path-traversal-guarded (resolved/realpath must stay
  inside the bundle, `.md` only).

**When adding a new tool:** if it emits text from OCR/CAMT/CSV, upstream API
errors, or fields known to be populated by import flows (journal title
originating from auto-booking, client/supplier names auto-created from
receipt OCR), wrap at MCP output. CRUD `get_*`/`list_*` over unfiltered
API data remains raw.

## Estonian Tax Rules

- **KMD INF**: Partner detail annex, threshold 1000 EUR net per partner
- **Standard VAT rate**: 24% (from 1.07.2025)
- **VD**: Intra-community supply declaration (EU only)
- **CIT on dividends**: 22/78 from 2025-01-01; 20/80 before (date-gated `CIT_RATE_TIMELINE` / `getCitRateForDate` in `src/estonian-tax-rules.ts`, re-exported from `src/tools/estonian-tax.ts`)
- **Dividend booking (net vs. gross)**: `prepare_dividend_package` debits **only the net dividend** to retained earnings (Jaotamata kasum; account resolved by name against the company chart, standard 2960, override with `retained_earnings_account`). The CIT is a current-period **income-tax expense** (the P&L "Tulumaks" line), booked to an 8900-series Kulud account (auto-detected via `resolveIncomeTaxExpenseAccount`, override with `income_tax_expense_account`, default 8900), NOT a second debit to retained earnings. Per Estonian GAAP / RTJ the dividend income tax (TuMS § 50) is charged against current-year profit, not equity directly. All equity/liability accounts (retained earnings, dividend payable → standard 2650, dividend income-tax payable → standard 2656, share capital → standard 2900) are **name-resolved** against the actual chart via `src/account-resolution.ts`, with the standard number as fallback.
- **ÄS § 157 legality checks are split by clause**: the **lg 1 retained-earnings ceiling is NET-based** — the ENTIRE retained-earnings balance is distributable as net dividend, since the CIT is not part of the payout; the **lg 2 net-assets floor is GROSS-based** (net assets fall by dividend payable + tax liability) at share capital **+ non-distributable reserves** (reservkapital, name-detected in the chart, standard 2940; override with `restricted_reserve_accounts`). The tool hard-blocks violations of either clause unless `force=true` (use only alongside a legitimate action such as a capital reduction), and always reports `maximum_distributable.max_net_dividend` = min(retained earnings, (net assets − floor) × den/(den+num)).
- **Dividend statutory prerequisites** are echoed as `compliance_notes` on every path: ÄS § 157 lg 1 requires an APPROVED annual report + profit-distribution decision (attach the decision via `attach_document`), and the CIT is declared on TSD annex 7 by the 10th of the month after payout (TuMS § 54).
- **Capital gains**: Securities taxed at 22% income tax
- **Input-VAT deduction restrictions** (`src/estonian-tax-rules.ts`): single date-gated source for the standard VAT-rate timeline (20→22%→24%), the dividend-CIT timeline (20/80→22/78), the 40 000 EUR VAT registration threshold, current reduced rates, and the deduction detectors. `suggest_booking` returns these as `tax_notes` — `KMS § 30` (külaliste vastuvõtt / esinduskulu: input VAT non-deductible; also `TuMS § 49 lg 4` representation limit 50 €/month + 2% of payroll) and `KMS § 30 lg 4` (M1 passenger car: 50% cap). Notes are advisory; `workflows/book-invoice.md` requires surfacing each on the approval card. `validate_invoice_data` also uses the rate timeline to warn when a line's standard rate (20/22/24%) does not match the invoice date. The full dataset is browsable read-only at `earveldaja://tax_rules` — including the `TuMS § 49` representation/donation limits, `TuMS § 48` fringe-benefit pointer, the profit-distribution rules (`ÄS § 157 lg 1–2`, `TuMS § 50`), and the RPS process rules (`§ 10` corrections, `§ 12` 7-year retention, `§ 15` inventory) — plus a `verified_at` stamp (`TAX_RULES_VERIFIED_AT`). `check_tax_free_limits` computes the cumulative `TuMS § 49` representation/donation limits and the 22/78 tax on any excess from caller-supplied year-to-date figures (it does not read the ledger). Update the figures in this module when the law changes — the Estonian-tax tool descriptions render their rates/thresholds from these constants, so they follow automatically (pinned by tests).

**Non-goals — do NOT reimplement in MCP (e-arveldaja does these natively; reimplementing risks double-booking):**
- **No KMD/VAT return (käibedeklaratsioon)** — e-arveldaja generates it from the confirmed ledger and files it to EMTA. The tax-rules layer is advisory only.
- **No EMTA prepayment-account tax-expense entries** — a bank transfer to EMTA is booked as a prepayment-account (ettemaksukonto, acct 1516) top-up; the draw-down tax entries come from e-arveldaja's EMTA prepayment-account statement.
- **`update_transaction` is deliberately metadata-scoped** — bank-reference/description fields only; never amounts, postings, or distributions.

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
const { tools } = await client.listTools(); // 122 tools (default exposure)
```
