# Changelog

## [0.8.0] - 2026-03-21

### Added
- **Local document parsing with LiteParse** — PDF, JPG, and PNG invoice documents are now parsed locally using `@llamaindex/liteparse` with built-in Tesseract OCR (Estonian + English). No external service required.
  - Configurable via environment variables: `EARVELDAJA_LITEPARSE_OCR_ENABLED`, `EARVELDAJA_LITEPARSE_OCR_LANGUAGE`, `EARVELDAJA_LITEPARSE_OCR_SERVER_URL`, `EARVELDAJA_LITEPARSE_NUM_WORKERS`, `EARVELDAJA_LITEPARSE_MAX_PAGES`
- **Invoice extraction fallback** — when deterministic regex extraction is incomplete, `extract_pdf_invoice` returns structured `llm_fallback` hints alongside `raw_text` so the LLM can fill gaps from the full document text
- **Document identifier extraction** — dedicated `src/document-identifiers.ts` module for extracting Estonian registry codes, VAT numbers, IBANs (with ISO 7064 mod-97 validation), and reference numbers from OCR text
- **144 new unit tests** (181 → 325 total across 32 test files):
  - `financial-statements.test.ts` (34): balance computation, contra-accounts, trial balance, balance sheet, P&L, month-end close, leap year
  - `account-balance.test.ts` (14): D/C direction, date filters, client filter, multi-currency
  - `aging-analysis.test.ts` (16): bucket boundaries, due-date edge cases, `base_gross_price` fallback
  - `estonian-tax.test.ts` (21): 22/78 CIT arithmetic, retained earnings, net-assets §157, VAT branching
  - `document-identifiers.test.ts` (26): registry codes, VAT numbers, IBAN mod-97 validation, reference numbers
  - `csv.test.ts` (7): quoted fields, escaped double-quotes, custom delimiters
  - `base-resource.test.ts` (20): pagination cap, cache invalidation, namespace isolation
  - `account-validation.test.ts` (6): missing/inactive accounts, deduplication

### Fixed
- **Security hardening**:
  - Updated `fast-xml-parser` to fix entity expansion bypass (GHSA-jp2q-39xq-3w4g) — 0 npm audit vulnerabilities
  - `EARVELDAJA_ALLOWED_PATHS` now warns when set to filesystem root `/`
  - OCR server URL (`EARVELDAJA_LITEPARSE_OCR_SERVER_URL`) validated for http/https protocol to prevent SSRF
  - `toolError()` inspect depth reduced to 2 and output truncated to 500 chars to limit information disclosure
  - Stack trace logging demoted from stderr to MCP debug level
  - `getAllowedRoots()` deduplicated — single source of truth in `file-validation.ts` (removed duplicate from `receipt-inbox.ts`)
  - `resolveFilePath()` exported from `file-validation.ts` (removed duplicate `resolveInputPath` from `receipt-inbox.ts`)
- **Error handling**: all `catch (err: any)` blocks converted to `catch (err: unknown)` with safe `err instanceof Error ? err.message : String(err)` pattern in `wise-import.ts` and `recurring-invoices.ts`
- **Cache consistency**: `sendEinvoice()` now calls `invalidateCache()` before the API call, matching every other mutating method
- **Type safety**: removed unnecessary `(inv as any).payment_status` cast in `bank-reconciliation.ts`; removed dead `if (vat !== undefined || gross !== undefined)` guard in `purchase-invoices.api.ts`
- **Prompt accuracy**:
  - `book-invoice` step cross-references fixed (steps 5 and 11, not 4 and 10)
  - `lightyear-booking` account parameters changed from `z.string()` to `z.number()` to match actual tool schemas
  - `month-end-close` duplicate detection step clarified (scans all suppliers, explains `exact_duplicates` vs `suspicious_same_amount_date`)
  - `reconcile-bank` mode description clarified as numeric transaction ID
- **Receipt inbox reliability**:
  - VAT extraction and supplier name detection improved for OCR edge cases (split lines, Estonian text, mixed formats)
  - Auto-booking accuracy improved for domestic expenses and foreign supplier reverse-charge detection
  - Currency detection and amount extraction hardened against malformed OCR output

### Changed
- **New dependency**: `@llamaindex/liteparse` ^1.0.0 for local document parsing
- **88 tools**, 6 prompts, 12 resources (unchanged from 0.7.x; corrected from previously overcounted README)
- **325 tests** total (up from 133 in 0.7.1)

## [0.7.1] - 2026-03-20

### Fixed
- **MCP prompt accuracy**:
  - aligned `book-invoice`, `reconcile-bank`, `month-end-close`, `new-supplier`, `company-overview`, and `lightyear-booking` with the real tool names, parameter names, and output shapes
  - fixed stale prompt guidance that previously referred to invalid fields such as `query`, `client_id`, `invoice_id`/`id` mixups, `start_date`/`end_date`, and `dry_run` flags where tools now expect `execute`
  - improved Lightyear guidance around `gain_loss_account`, `tax_account`, dimensions, and preview/execute flow so prompts no longer encourage half-configured bookings
- **Server instructions**:
  - updated the global MCP instructions to match the corrected purchase-invoice and bank-reconciliation workflows

### Changed
- **Prompt regression coverage**:
  - expanded prompt tests from name-only registration checks to content checks that validate the generated workflow text against actual tool schemas
- **133 tests** total, up from 128 in v0.7.0
- **Release metadata** updated to `0.7.1`

## [0.7.0] - 2026-03-20

### Fixed
- **Recurring invoice safety**:
  - `create_recurring_sale_invoices` is now idempotent for reruns by marking created clones and skipping already-created target-period copies
  - auto-confirm failures are now counted and reported as errors instead of being folded into success-only output
- **Wise import retry behavior**:
  - missing fee rows can now be backfilled on rerun even when the main Wise transaction already exists
  - fee rows are no longer created if main transaction creation fails, preventing orphan fee entries
- **Runtime config discovery**:
  - `EARVELDAJA_SCAN_PARENT=true` now applies to `.env` loading as well as `apikey*.txt` discovery

### Removed
- **KMD workflow prompt**:
  - removed the MCP KMD/VAT-declaration prompt and related documentation as unnecessary, because e-arveldaja already handles KMD declarations in its own product
  - prompt surface is now back to **6 MCP prompts**

### Changed
- **Test coverage**:
  - regression tests added for recurring invoice idempotency and confirm-error reporting, Wise partial-import recovery, parent `.env` discovery, and prompt registration
- **128 tests** total, up from 122 in v0.6.0
- **Release metadata** updated to `0.7.0`

## [0.6.0] - 2026-03-20

### Added
- **Receipt inbox and expense auto-booking** — 4 new tools:
  - `scan_receipt_folder`: scan a folder for receipt PDFs/images without recursing
  - `process_receipt_batch`: extract, classify, book, and bank-match receipt files in one pass (`execute=false` by default)
  - `classify_unmatched_transactions`: classify unreconciled bank transactions into expense-like and review-only categories
  - `apply_transaction_classifications`: batch-apply those classifications as purchase invoices and transaction links
- **MCP compatibility layer**:
  - new `src/mcp-compat.ts` bridges legacy `tool/prompt/resource` registrations to SDK `registerTool` / `registerPrompt` / `registerResource`
  - resource and tool registrations now preserve first-class MCP titles through the compatibility wrapper

### Fixed
- **Receipt inbox booking and totals**:
  - auto-booked purchase invoices now preserve explicit gross/VAT totals correctly during confirm
  - domestic expense auto-booking no longer overstates net/gross amounts
  - reverse-charge handling and foreign supplier detection were corrected for imported receipts and transaction classifications
  - small incoming bank movements no longer fall into the `bank_fees` auto-booking bucket
- **Runtime config lookup**:
  - `.env` and `apikey*.txt` are now resolved from the working directory as well, fixing `npx` / installed-package MCP setups that previously looked in the wrong place
- **MCP reliability and protocol behavior**:
  - tool and resource handlers are pinned to a connection snapshot, so `switch_connection` cannot race resource reads onto the wrong company
  - tool-level validation and business errors now return proper MCP `isError: true` results
  - `import_wise_transactions` now skips duplicate main and fee rows both by `WISE:{id}` markers and by a legacy date/amount/counterparty/reference signature, preventing re-imports when older rows lack the newer description prefix
  - `create_recurring_sale_invoices` creates invoices again by default; preview mode is now explicit via `dry_run=true`, and the tool description matches the actual behavior
  - `toolError()` now handles `undefined`, circular objects, and other non-JSON-serializable throws without failing inside the error wrapper
- **Release metadata drift**:
  - package metadata and lockfile root version are now aligned again

### Changed
- **MCP metadata and SDK usage**:
  - prompts, resources, and tools now register through the modern SDK registration path via the compatibility layer
  - file/folder-input tools now advertise `openWorldHint=true`, including PDF import/upload, Lightyear CSV tools, Wise import, receipt-folder tools, and CAMT.053 parse/import
  - prompt/resource listings now carry first-class titles consistently
- **Documentation and assistant guidance**:
  - README and Claude guidance were updated for the newer MCP workflow and dry-run semantics
- **96 tools** total (up from 90 in v0.5.0).
- **122 tests** total (up from 88 in v0.5.0) — added focused regression coverage for receipt inbox flows, config lookup, purchase invoice totals, recurring invoice execution defaults, Wise duplicate detection, file-input metadata flags, MCP compat behavior, and robust tool error serialization

## [0.5.0] - 2026-03-19

### Added
- **Annual report automation** — 3 new tools (1137 lines):
  - `prepare_year_end_close`: analyze fiscal year, propose closing entries and accruals, detect unresolved items (dry_run by default)
  - `generate_annual_report_data`: map trial balance to Estonian RTJ micro/small entity format — bilanss (balance sheet), kasumiaruanne (income statement Schema 1), rahavoogude aruanne (cash flow, indirect method), key financial ratios, and notes data
  - `execute_year_end_close`: create closing journal entries with explicit confirmation, duplicate detection, and draft-only safety
- **CAMT.053 bank statement import** — 2 new tools (669 lines):
  - `parse_camt053`: read-only XML parsing with metadata, entries, and duplicate detection by bank reference (AcctSvcrRef)
  - `import_camt053`: batch import as bank transactions (dry_run by default), auto-resolves counterparties by registry code/name, maps CRDT→D/DBIT→C
  - Supports all Estonian banks (LHV, Swedbank, SEB, Coop, Luminor) via ISO 20022 camt.053.001.02 format
  - Handles batched entries (multi-NtryDtls), mixed-currency transactions, proportional amount splitting
- **New dependency**: `fast-xml-parser` v5 for CAMT.053 XML parsing with `processEntities: false` (XXE defense-in-depth)

### Fixed
- **`roundMoney` now correct at ALL magnitudes.** Replaced EPSILON approach with string exponent trick (`parseFloat(abs + "e2")`), which bypasses IEEE 754 intermediate multiplication errors. Correctly handles 0.005, 1.005, 10000.005, 999999.995, negatives, -0, NaN, Infinity.
- **Annual report equity mapping** — dynamically sums all `Omakapital` accounts instead of hardcoding 3000/3010/3200. Correctly handles post-close scenario by excluding YECL closing journals from P&L computation.
- **CAMT multi-NtryDtls** — batched payment entries are no longer silently dropped; all transaction details are flattened and split proportionally.
- **CAMT mixed-currency** — uses entry-level booked amount (account currency), not TxAmt/InstdAmt (original currency).
- **HTTP retry safety** — retries limited to GET+429 only for 5xx; all methods retry on 429. Auth headers regenerated fresh on each retry attempt.
- **`vat_rate_dropdown` number crash** — coerced to String() before `.replace()` in purchase invoice normalization, preventing TypeError when LLM passes a number.
- **Lightyear `total_invested_eur`** — replaced last `Math.round(x*100)/100` with `roundMoney()`.
- **XMLParser** `processEntities: false` for defense-in-depth against entity expansion.
- **`as Transaction` unsafe cast** removed in CAMT import, replaced with proper partial type.
- **`as any` casts** removed in `wise-import.ts`, `catch (err: any)` → `catch (err: unknown)`.
- **Multi-statement CAMT** error message now suggests splitting the file.

### Changed
- **90 tools** total (up from 85 in v0.4.0).
- **88 tests** total (up from 79 in v0.4.0) — new tests for annual report equity/closing, CAMT multi-entry/currency, HTTP retry, roundMoney edge cases.

## [0.4.0] - 2026-03-18

### Fixed
- **CRITICAL: `roundMoney` IEEE 754 half-cent rounding bug.** `Math.round(v * 100) / 100` misrounded at half-cent boundaries (e.g. `1.005` → `1.00` instead of `1.01`). Now uses sign-aware EPSILON approach. Affects all VAT calculations, gross prices, and balance aggregations.
- **Purchase invoice VAT normalization.** `confirmWithTotals()` now also repairs mismatched `vat_price` (previously only checked `gross_price`). `createAndSetTotals()` now PATCHes totals for zero-value and negative invoices (credit notes).
- **Cache invalidation race on connection switch.** Generation counter now increments *before* clearing caches, and both old and new connection caches are cleared to prevent stale data.
- **Bank reconciliation double-match.** `consumedInvoiceKeys` is now added *after* successful confirmation, not before — failed confirms no longer block the invoice from later matching.
- **`Cache.set(key, data, 0)` TTL bug.** Zero TTL previously used the 300s default (falsy check); now correctly skips storage.

### Added
- **HTTP retry with exponential backoff.** 429/5xx/network errors are retried up to 3 times with 1s/2s/4s backoff.
- **Currency parameter on `create_purchase_invoice_from_pdf`.** No longer hardcoded to EUR; defaults to EUR if omitted.
- **`CreatePurchaseInvoiceData` type** in `types/api.ts` — replaces `as any` casts in purchase invoice creation.
- **`base_amount` field** added to `Transaction` interface for multi-currency reconciliation.
- **Date format validation** on Zod params: `YYYY-MM-DD` regex on journal/invoice/transaction date fields, `YYYY-MM` on month-end checklist.
- **New shared utilities:** `src/paths.ts` (project root), `src/csv.ts` (CSV line parser), `src/account-validation.ts` (account existence checks).
- **New tests:** HTTP client retry logic, CSV parsing, account validation (79 total, up from 76).

### Changed
- **Reduced `as any` casts** across 6 files: `transactions.api.ts`, `crud-tools.ts`, `pdf-workflow.ts`, `bank-reconciliation.ts`, `purchase-invoices.api.ts`, `wise-import.ts`. Replaced with proper typed generics and interfaces.
- **Deduplicated code:** `getProjectRoot()` extracted to `paths.ts` (was in `config.ts` + `file-validation.ts`), `parseCSVLine()` extracted to `csv.ts` (was in `lightyear-investments.ts` + `wise-import.ts`), `checkAccount()` consolidated in `account-validation.ts` (was in `estonian-tax.ts` + `lightyear-investments.ts`).
- **`month_end_close_checklist` parallelized:** 4 sequential `listAll()` calls replaced with `Promise.all()`.
- **`wrapHandler` error logging:** Full stack trace now logged to stderr before converting to MCP tool error.
- **18 files changed, 4 new files, -33 net lines.**

## [0.3.2] - 2026-03-17

### Changed
- **Server instructions** restructured into sections (Purchase invoices / Bank reconciliation / Reporting) for clearer LLM guidance.
- **25 tool titles and descriptions improved** based on Codex review: more specific naming (e.g. "Find Client by Registry Code", "Extract Supplier Invoice PDF", "Compute Client Net Position"), clearer action descriptions, consistent terminology.

## [0.3.1] - 2026-03-17

### Added
- **Server instructions**: Global cross-tool guidance for LLMs — PDF workflow order, VAT checking, dry-run defaults, reverse charge rules. Injected via MCP `instructions` field.
- **Tool titles**: All 85 tools have human-readable `title` annotations for better client UI rendering.
- **Progress notifications**: MCP `notifications/progress` emitted during multi-page fetches (`listAll`), bank auto-confirmation, Wise import, and Lightyear trade booking.

### Changed
- Simplified README setup: leads with "ask your AI assistant" approach, one-liner `claude mcp add`, collapsible details for manual config. MCP prompts highlighted as primary workflow mechanism.

## [0.3.0] - 2026-03-17

### Added
- **MCP tool annotations** on all 85 tools: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. Clients can auto-approve read-only tools and require confirmation for destructive ones.
- **6 MCP prompts**: `book-invoice`, `reconcile-bank`, `month-end-close`, `new-supplier`, `company-overview`, `lightyear-booking`. Client-agnostic workflow templates (unlike `.claude/commands/` which only work in Claude Code).
- **6 dynamic resource templates**: `earveldaja://clients/{id}`, `products/{id}`, `journals/{id}`, `sale_invoices/{id}`, `purchase_invoices/{id}`, `transactions/{id}`. Direct resource access by ID.
- **Structured error responses**: All tools return `{ isError: true }` on failure instead of throwing, letting clients distinguish tool errors from protocol errors.
- **MCP protocol logging**: Configurable logger (`src/logger.ts`) that uses MCP `sendLoggingMessage` after connection, with stderr fallback during startup.
- **Journal invalidation** (`invalidate_journal`): Reverse a confirmed journal entry back to editable state.
- **Shared `roundMoney()` utility** (`src/money.ts`): Consistent 2-decimal rounding across all monetary calculations.
- **`listAll()` progress logging**: Logs page count to stderr/MCP when fetching multi-page datasets.

### Changed
- **`number_suffix` optional** on `create_sale_invoice`: Omit for auto-assign from invoice series.
- **`reconcile_transactions`** now fetches all pages (was single-page only).
- **`fee_account_relation_id` required** on `import_wise_transactions`: No more hardcoded default; use `list_account_dimensions` to find the correct ID.
- **Renamed** `delete_client` → `deactivate_client`, `delete_product` → `deactivate_product` to match actual behavior (soft-delete, reversible).
- **Connection-scoping proxy** replaces fragile `server.tool` monkey-patching. Forward-compatible with any MCP SDK overload changes.
- **`safeJsonParse`** exported from `crud-tools.ts`; duplicate in `pdf-workflow.ts` removed.
- **Allowed path roots** in file validation now resolve symlinks (fixes `/tmp` → `/private/tmp` on macOS).
- **Standardized logging**: `console.warn`/`console.error` replaced with `process.stderr.write` or MCP logger.

### Fixed
- **Floating-point money**: 60+ inline `Math.round(x * 100) / 100` replaced with shared `roundMoney()`.
- **`(invoice as any)` casts** in `purchase-invoices.api.ts` replaced with proper `PurchaseInvoiceDetail` type.
- **Redundant branch** in `normalizeVatRate`: both sides of a ternary were identical.
- **Unused `idParam`** removed from `BaseResource` constructor and all subclasses.
- **Version mismatch**: `index.ts` said `1.0.0` while `package.json` said `0.2.1`.
- **Duplicate account lookup** in `computeAccountBalance`: account info now fetched once in parallel with journals.
- **Recurring invoices** missing `number_suffix` field (could produce empty-numbered invoices).

## [0.2.1] - 2026-03-16

### Fixed
- **Reverse charge VAT** (`reversed_vat_id: 1`): Book-invoice skill and workflow now always check if supplier is outside Estonia and set reverse charge accordingly. Prevents missing pöördkäibemaks on foreign invoices.

## [0.2.0] - 2026-03-16

### Added
- **Wise transaction import** (`import_wise_transactions`): Parse Wise transaction-history.csv and create bank transactions. Fees as separate entries auto-confirmed to expense account 8610. Duplicate detection by Wise ID. Dry run by default.
- **Transaction invalidate** (`invalidate_transaction`): Unconfirm confirmed bank transactions for editing or deletion.
- **Accounting workflow skills** (`.claude/commands/`): `/book-invoice`, `/reconcile-bank`, `/month-end`, `/new-supplier`
- **Generic workflow guides** (`workflows/`): Editor-agnostic runbooks for all workflows, usable with any MCP client.
- **401 troubleshooting**: Shows public IP and setup instructions when API authentication fails.
- **npm publishing**: Available via `npx -y e-arveldaja-mcp`.

### Changed
- README rewritten to be editor-agnostic: setup instructions for Claude Code, Codex CLI, Gemini CLI, Google Antigravity, Cursor, Windsurf, and Cline.
- API key placement instructions clarified for working directory context.

## [0.1.0] - 2026-03-16

### Added
- Initial npm release with 84 MCP tools across 11 modules.
- **CRUD tools**: Clients, products, journals, transactions, sale invoices, purchase invoices, reference data.
- **PDF workflow**: Extract invoice text, validate data, resolve supplier, suggest booking, create purchase invoice from PDF, upload documents.
- **Bank reconciliation**: Match unconfirmed transactions to invoices with confidence scoring, auto-confirm exact matches.
- **Financial statements**: Trial balance, balance sheet, profit & loss, month-end close checklist.
- **Aging analysis**: Receivables and payables aging buckets.
- **Account balances**: D/C balance computation, client debt.
- **Document audit**: Missing documents detection, duplicate invoice detection.
- **Recurring invoices**: Clone sale invoices for recurring billing.
- **Estonian tax**: Dividend package preparation, owner expense reimbursement.
- **Lightyear investments**: Parse account statements, book trades with FX pairing and FIFO cost basis, book distributions, portfolio summary.
- **Multi-account support**: Multiple API keys for different companies, connection switching.
- **Security**: HMAC-SHA-384 authentication, file path validation with allowed-directory restriction, rate limiting, cache with LRU eviction.
- **6 MCP resources**: Accounts, articles, templates, dimensions, currencies, bank accounts.
