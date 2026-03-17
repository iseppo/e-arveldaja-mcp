# Changelog

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
- **7 MCP prompts**: `book-invoice`, `reconcile-bank`, `month-end-close`, `new-supplier`, `company-overview`, `quarterly-vat`, `lightyear-booking`. Client-agnostic workflow templates (unlike `.claude/commands/` which only work in Claude Code).
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
