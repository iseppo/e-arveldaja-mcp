# Changelog

## [0.9.6] - 2026-03-23

### Fixed
- **MCP SDK version** — reverted exact pin `1.12.1` to `^1.12.1` and updated to 1.27.1. The exact pin broke the build because `registerResource`, `registerPrompt`, and `sendLoggingMessage` types were only added in later SDK versions.

## [0.9.5] - 2026-03-23

### Fixed
- **CAMT import cleanup** — removed dead `byRefNumber` and `descriptions` structures from duplicate lookup that were no longer consumed after the overmatch fix in 0.9.4
- **HTTP retry test** — fixed unhandled promise rejection that caused CI exit code 1 despite all tests passing

### Changed
- **README** — updated Lightyear section to mention dividends/distributions/cash interest, corrected file access scope from "home directory" to "working directory", added Node.js 18+ requirement

## [0.9.4] - 2026-03-23

### Added
- **Lightyear Dividend/Interest support** — `book_lightyear_distributions` now imports Dividend and Interest entries from the account statement CSV alongside existing Distribution entries. Cash interest entries (no ticker) get a dedicated journal title.
- **Cash flow: full working capital coverage** — indirect cash flow statement now includes 13xx (short-term investments), 14xx (other receivables), 20xx/21xx (short-term liabilities), and 29xx (accrued liabilities) in operating adjustments.
- **HTTP retry for all methods** — network errors (timeout, connection reset) now trigger retries for PATCH/POST/DELETE, not just GET. Confirmations and registrations are idempotent and benefit from retry on flaky connections.
- **Balance sheet: 13xx/14xx accounts** — current assets now includes short-term financial investments (13xx) and other short-term receivables (14xx).
- **Pagination timeout** — `listAll()` enforces a 5-minute overall timeout to prevent indefinite hangs.
- **Node.js engine requirement** — `package.json` now declares `engines.node >= 18.0.0`.

### Fixed
- **CRITICAL: parseAmount thousands separator** — `"1.000"` (European thousands format) was parsed as 1.00 instead of 1000, producing invoices with 1000x wrong amounts. Now correctly detects single-dot thousands separator pattern.
- **CRITICAL: CAMT duplicate detection overmatch** — bank_reference was incorrectly looked up in the ref_number map (cross-field), and description substring matching could silently discard legitimate transactions. Removed both overmatch paths; duplicate detection now uses only the correct `bank_reference` field.
- **Lightyear sell journal balance** — gain/loss is now derived as `proceeds - costBasis` instead of using independently rounded CSV columns, ensuring the journal entry always balances.
- **Lightyear distribution credit rounding** — added missing `roundMoney()` on distribution income credit amount to prevent IEEE 754 drift.
- **Wise inter-account key rounding** — replaced `Math.round(x*100)/100` with `roundMoney()` to prevent potential duplicate journal entries on specific float values.
- **FX invoice bank-link amount** — receipt inbox now uses `base_gross_price` instead of transaction amount for distribution, preventing partial/over payment on foreign currency invoices.
- **Inter-account partial confirmation** — if incoming transaction confirmation fails after outgoing is confirmed, the outgoing is now automatically invalidated instead of leaving books in an inconsistent state.
- **Supplier fuzzy match false positives** — added Levenshtein distance ratio gate (≥ 0.5) to prevent short names (e.g. "LHV") from matching wrong clients.
- **PDF VAT double-rounding** — per-item VAT is now accumulated unrounded; `roundMoney()` applied only on the final total.
- **Receipt batch double-failure** — DRAFT invoices from failed rollbacks are no longer pushed into batch context, allowing re-processing on next run.
- **Transaction rollback error surfacing** — when `clients_id` rollback fails after a failed confirmation, the error is now included in the thrown exception so callers know the transaction may be in an inconsistent state.
- **Purchase invoice partial-create error** — `invoiceId` is now attached as a structured field on the error object for programmatic recovery.
- **Wise fee assertion** — replaced fragile `!` non-null assertion on `feeAccountDimensionsId` with explicit runtime check.
- **Lightyear ambiguous gains detection** — exact-duplicate capital gains rows (same date+ticker+qty+proceeds) are now counted in the ambiguity warning.
- **roundMoney(Infinity)** — now throws instead of silently returning 0, surfacing upstream division-by-zero bugs.
- **Cache key stability** — `list()` cache keys now use sorted params, preventing silent cache misses from parameter order variation.
- **Registry API response limit** — 64KB response size cap on `ariregister.rik.ee` fetch to prevent OOM from oversized/hijacked responses.

### Changed
- **Source maps enabled** — `tsconfig.json` now enables `sourceMap` and `declarationMap` for debuggable production builds.
- **MCP SDK pinned** — `@modelcontextprotocol/sdk` pinned to exact `1.12.1` (removed `^`).
- **Sale invoice API rename** — `saleInvoices.getDocument()` renamed to `saleInvoices.getSystemPdf()` to accurately reflect the endpoint (`/pdf_system`).
- **Debug stack traces gated** — tool handler stack traces now require `EARVELDAJA_DEBUG=true` instead of writing unconditionally to stderr.
- **HTTP error truncation** — API error messages truncated to 500 chars to limit information leakage.
- **Fatal error stack trace** — startup fatal errors now include the full stack trace in stderr output.

### Removed
- **Dead code cleanup** — removed 14 unused methods across API files (`merge`, `findByVatNo`, `findByName`/`findByCode` on products, document operations on journals/transactions/sale-invoices), dead `loadConfig()`, dead `summarizeIdentifierHintFallback()`, dead `EXPECTED_HEADERS` constant, and 25-line re-export barrel in receipt-inbox.
- **Duplicate code consolidated** — extracted `buildBankAccountLookups()` (was duplicated verbatim in 2 files), `effectiveGross()` helper (replaced 12 inline copies), and reused `computeAccountBalance()` (deleted duplicate `computeRetainedEarningsBalance()`).

## [0.9.3] - 2026-03-23

### Changed
- **File access roots tightened** — file-reading tools now default to the working directory (and its subdirectories) + `/tmp`. Previously the default was the entire home directory. Set `EARVELDAJA_ALLOW_HOME=true` to restore the old behavior, or use `EARVELDAJA_ALLOWED_PATHS` for a custom allowlist.

### Fixed
- **`.env` symlink/permission blocking** — insecure `.env` files (symlinked or group/other-readable) are now skipped entirely, not just warned about. Matches the security posture of `apikey*.txt` validation.
- **Company name normalization** — strips Estonian legal suffixes (AS, OÜ, MTÜ, SA, TÜ) for better bank reconciliation matching
- **Upload filename sanitization** — special characters stripped, capped at 255 chars to prevent stored XSS on upstream UI
- **Intermediate rounding in balance computation** — `roundMoney()` applied on each accumulation step in account balances, financial statements, and retained earnings to prevent IEEE 754 drift
- **Short name false-positive matching** — company name substring matching now requires both strings >= 4 chars
- **Dividend dry_run** — `prepare_dividend_package` now supports `dry_run` parameter for previewing without creating journal entries
- **Expense debit rounding** — `owner_expense_reimbursement` now rounds `net_amount` for VAT-registered case
- **Resource ID validation** — dynamic MCP resources reject non-integer/negative IDs instead of passing `NaN` to API
- **Readonly API error message** — no longer leaks raw API response shape
- **Capital gains match warning** — accurately says "picked first match" instead of misleading "tiebreaker"
- **FX date extraction** — handles both space and `T` separators in Lightyear CSV dates
- **HTTP 204 response** — returns minimal `ApiResponse` instead of unsafe `undefined as T` cast
- **Dead code cleanup** — removed unreachable `|| 0` in `roundMoney` large-magnitude bypass
- **Comment accuracy** — journal batch comment says "parallel" not "sequential"
- **CLAUDE.md** — cache invalidation documentation now matches actual (post-mutation) behavior

## [0.9.2] - 2026-03-22

### Added
- **Auto-upload source document** — `create_purchase_invoice_from_pdf` now automatically uploads the source PDF/image to the created purchase invoice, eliminating the separate `upload_purchase_invoice_document` step
- **VOID transaction handling** — CAMT import, Wise import, receipt inbox, and analyze-unconfirmed tools now exclude VOID (invalidated) transactions from matching, duplicate detection, and reconciliation
- **Transaction confirm rollback** — if transaction confirmation fails after auto-setting `clients_id`, the change is now rolled back (best-effort with stderr logging on rollback failure)
- **`.env` file permission checks** — startup now warns about symlinked or group/other-readable `.env` files, matching the security posture of `apikey*.txt` validation

### Fixed
- **CRITICAL: Cache invalidation race condition** — all mutating API methods (create, update, delete, confirm, invalidate, upload/delete document) across 8 API files now invalidate cache *after* the API call succeeds, not before. Eliminates a window where concurrent reads could cache stale data for up to 300 seconds.
- **Purchase invoice tolerance** — `confirmWithTotals` now uses exact `roundMoney()` comparison instead of a 0.02 EUR tolerance that could silently accept accounting discrepancies. Also fixed falsy `!currentGross` check that treated zero-value invoices (credit notes) as needing repair.
- **Stack trace leakage** — error stack traces are now written to stderr only, no longer sent through the MCP logging protocol where they could expose internal paths to the AI model
- **Error message sanitization** — removed `inspect()` fallback in `toolError()` that could leak internal object structure; non-serializable errors now return `"Internal error"`
- **`roundMoney(NaN)` silent corruption** — now throws instead of silently returning `0`, surfacing upstream bugs immediately in a financial context
- **`roundToDecimals` IEEE 754 edge case** — receipt extraction now uses the same string-exponent rounding as `roundMoney()`, avoiding `.toFixed()` boundary errors
- **Unparseable VAT rates silently skipped** — `normalizeItemsForNonVat` now logs a warning when `vat_rate_dropdown` produces `NaN`
- **Journal batch fetch null id** — `listAllWithPostings` now guards against journals with `id == null` before attempting individual fetch
- **`sumCategory` floating-point drift** — return value now wrapped in `roundMoney()` for defense-in-depth
- **`parseInt` without radix** — all 3 call sites now pass explicit radix 10
- **Cache iterator fragility** — `invalidate()` now collects keys first, then deletes in a second pass (safe against future refactors)
- **CSV size limit** — `parseCSV` now enforces a 1 MB size limit, consistent with `safeJsonParse`
- **Project root silent fallback** — `getProjectRoot()` now logs a warning when falling back to `process.cwd()`
- **`invalidateReadonlyCache` accidental full clear** — `pattern` parameter is now required, preventing callers from accidentally clearing all reference data caches
- **Receipt inbox VOID rollback** — receipt batch processing now correctly handles VOID transactions during rollback and skips them during bank matching

### Changed
- **Prompts and commands updated** for the auto-upload workflow in `create_purchase_invoice_from_pdf`
- **410 tests** total (up from 396 in 0.9.1)

## [0.9.1] - 2026-03-22

### Added
- **`analyze_unconfirmed_transactions` tool** — read-only tool that categorizes unconfirmed bank transactions into actionable suggestions: likely duplicate (with confidence scoring), confirm against invoice, confirm as inter-account transfer, confirm as expense, or manual review. Includes ready-to-use distribution objects for each suggestion.
- **Wise import auto-reconciliation** — `import_wise_transactions` now auto-detects inter-account transfers (TRANSFER-*, BANK_DETAILS_PAYMENT_RETURN-*) after import and checks existing journal entries before confirming, preventing double-counting. New `inter_account_dimension_id` parameter (auto-detected when only one other bank account exists).
- **Shared `buildInterAccountJournalIndex` utility** (`inter-account-utils.ts`) — extracted from bank-reconciliation and wise-import to eliminate duplicate journal-scanning logic

### Fixed
- **Reconciliation type bias** — `reconcile_transactions` and `auto_confirm_exact_matches` now match against both sale and purchase invoices regardless of transaction type. Previously, sale invoice matching was dead code because the API stores all bank transactions as type C.
- **Wise `isJarTransfer` documentation** — clarified why the self-transfer heuristic works (bank registrations use different name variants) and when to use `skip_jar_transfers=false`

### Changed
- **CLAUDE.md documentation overhaul**:
  - Documented that transaction `type` field is cosmetic; journal direction is determined by distribution at confirmation time
  - Documented transaction status values (PROJECT/CONFIRMED/VOID) and invalidate→delete workflow
  - Fixed misleading `gross_price` guidance: invoice-level `gross_price`/`vat_price` ARE required; only item-level is auto-computed
  - Added inter-account transfer duplicate risk documentation and mitigation guidance
  - Noted Wise balance ~0.03 EUR discrepancy (root cause pending)
- Exported `matchScore` and `normalizeCompanyName` from bank-reconciliation for reuse
- **90 tools**, 10 prompts, 12 resources
- **396 tests** total (up from 376 in 0.9.0)

### Security
- Hardened API key file loading — restricted to package directories
- Fixed TOCTOU vulnerability in receipt inbox file revalidation
- Bounded reconcile transfer date gap to prevent DoS
- Fixed parent dotenv scanning opt-in
- Fixed `roundMoney` for extreme magnitudes

## [0.9.0] - 2026-03-22

### Added
- **Inter-account transfer reconciliation** — new `reconcile_inter_account_transfers` tool matches and confirms own-account-to-own-account bank transfers (e.g. LHV↔Wise). DUPLICATE-SAFE: checks existing journal entries before confirming, preventing double-booking when the other side was already confirmed via CAMT import. Supports Phase 1 (paired C↔D matching) and Phase 2 (one-sided transfers by IBAN/company name). Dry run by default.
- **4 new MCP prompts** (10 total, up from 6):
  - `receipt-batch`: guided receipt folder scan with preview and explicit approval before booking
  - `import-wise`: Wise CSV transaction import workflow with fee account selection and dry-run preview
  - `import-camt`: CAMT.053 bank statement import workflow with duplicate detection guidance
  - `classify-unmatched`: unmatched bank transaction classification and batch-apply workflow
- **4 new Claude Code commands** (`.claude/commands/`): `receipt-batch`, `import-wise`, `import-camt`, `classify-unmatched` — matching the new MCP prompts
- **4 new workflow guides** (`workflows/`): editor-agnostic runbooks for the new prompts
- **Wise Jar filtering** — Wise import now recognizes and filters Jar (savings pot) transfers so they don't create spurious bank transactions
- **Wise multi-currency handling** — target fee amount/currency and source name fields now parsed from CSV; currency detection improved for non-EUR transactions
- **.env.example** added with all configurable environment variables documented

### Fixed
- **Booking approval safeguard**: `book-invoice` prompt and command now require explicit user approval of a booking preview before creating the purchase invoice — prevents silent mis-bookings
- **Connection switching safety**: race guard error message now warns about inspecting side effects; `requestGuard()` added to block API requests after mid-tool connection changes
- **Diacritics in reconciliation matching**: `normalizeCompanyName()` strips diacritics (ü→u, ö→o, etc.) for consistent fuzzy name matching across bank reconciliation and inter-account transfers
- **Invoice number prefix nullability**: `number_prefix` concatenation no longer produces `"undefined123"` when prefix is null
- **Wise import edge cases**: direction normalization handles case variations; fee rows use correct target fee currency; preview metadata includes currency info
- **OCR hardening**: default integration checks enabled; document parser handles edge cases more robustly
- **`.env` loading**: explicit `loadDotenvFiles()` call at startup ensures environment variables are available before config loading
- **Allowed roots startup warning**: `getAllowedRootsStartupWarning()` now runs at server start and logs a warning if `EARVELDAJA_ALLOWED_PATHS` is set to filesystem root

### Changed
- **Receipt inbox refactored** into three focused modules:
  - `receipt-extraction.ts` (1318 lines): regex-based field extraction, VAT detection, supplier inference, classification logic
  - `supplier-resolution.ts` (176 lines): Levenshtein-based supplier matching, country inference, counterparty normalization
  - `receipt-inbox.ts`: orchestration layer importing from the above
- **Prompt accuracy improvements**:
  - `book-invoice` step numbering updated for the new approval checkpoint (steps 11→14)
  - `reconcile-bank` prompt includes Phase 4 for inter-account transfers with duplicate safety workflow
  - `company-overview` prompt steps parallelized for faster execution
  - `new-supplier` command updated with safer resolution workflow
  - Server instructions updated with inter-account transfer guidance and approval checkpoint in document flow
- **CSV parsing**: Wise import switched from line-by-line `parseCSVLine` to full `parseCSV` for correct multi-line field handling
- **Code deduplication**: keyword lookup deduplicated, journal data preloaded, types narrowed across multiple modules
- **Test coverage improvements**: bank reconciliation tests (46), Wise import tests (27), prompt content validation tests, config tests, integration connection tests hardened
- **89 tools**, 10 prompts, 12 resources
- **376 tests** total (up from 325 in 0.8.0)

## [0.8.1] - 2026-03-21

### Changed
- **README improvements**:
  - Added batch receipt processing usage example
  - Added CAMT.053 bank statement import usage example (LHV, Swedbank, SEB, Coop, Luminor)
  - Added Estonian tax tools usage examples (dividends, owner expense reimbursement)
  - Added "Good to know" section: dry-run defaults, 200-page pagination limit, caching behavior, EUR default, multi-company switching
  - Added privacy note clarifying that local OCR is used but extracted text flows through the connected LLM

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
