# Session Log

## 2026-03-23: Comprehensive code review and cleanup (0.9.3 → 0.9.6)

### AI Slop Cleaning Pass
- Removed 14 dead methods/functions across API and core modules
- Consolidated 3 duplication patterns: `buildBankAccountLookups`, `effectiveGross`, `computeAccountBalance`
- Deleted 25-line re-export barrel in receipt-inbox
- Net result: -159 lines

### Comprehensive Code Review (6 parallel agents)
Scanned entire codebase across 6 dimensions:
1. API layer correctness
2. Core tool modules
3. Financial/accounting tools
4. Security (OWASP)
5. Test coverage (incomplete — agent failed)
6. Infrastructure & config

**Found ~50 issues total.** All actionable items fixed.

### Critical Fixes Applied
- **parseAmount thousands separator** — `"1.000"` was parsed as 1.00 instead of 1000
- **CAMT duplicate detection** — cross-field overmatch silently dropped legitimate transactions
- **Lightyear sell journal** — independent CSV rounding could produce unbalanced entries
- **roundMoney(Infinity)** — silently returned 0 instead of throwing

### Financial Precision Fixes
- Wise inter-account key: `roundMoney()` instead of `Math.round(x*100)/100`
- Lightyear distribution credit: added missing `roundMoney()`
- PDF VAT validation: single-round accumulation instead of double-rounding
- FX invoice bank-link: use `base_gross_price` instead of transaction amount

### Resilience Improvements
- HTTP retry for all methods (not just GET) on network errors
- `listAll()` null guard on `response.items` + 5-minute pagination timeout
- Inter-account partial confirmation: auto-invalidate outgoing on incoming failure
- Transaction rollback: error surfaced to callers (not just stderr)
- Purchase invoice partial-create: `invoiceId` on error object
- Supplier fuzzy match: Levenshtein distance gate (≥ 0.5)
- Cache key stability: sorted params

### Security Hardening
- Debug stack traces gated behind `EARVELDAJA_DEBUG=true`
- Registry API fetch: 64KB response size limit
- HTTP error messages truncated to 500 chars
- CAMT import: 50,000 entry limit
- Fatal error exit includes stack trace

### Features Added
- **Lightyear Dividend/Interest** — `book_lightyear_distributions` now imports all income types
- **Cash flow working capital** — added 13xx, 14xx, 20xx/21xx, 29xx account ranges
- **Balance sheet** — added 13xx/14xx to current assets

### Infrastructure
- Source maps enabled for debuggable production builds
- Node.js >=18.0.0 engine requirement
- MCP SDK updated to 1.27.1 (^1.12.1)
- `saleInvoices.getDocument` renamed to `getSystemPdf`

### Known Remaining Issues
- Multi-connection global state (single-user by design)
- OCR raw_text prompt injection (mitigated with text warnings)
- Overdue check uses `create_date` (needs API spec verification)
- Test coverage analysis never completed
- Logger ignores log level (by design for MCP stdio)

### Review Results
- 4 code reviews performed (2 by opus agents)
- Final review: **APPROVED** — 0 critical, 0 high, 0 medium, 0 low
- Build: clean (`npm run build`)
- Tests: 410 passed, 0 failed, 0 unhandled rejections
