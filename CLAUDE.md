# e-arveldaja MCP Server

TypeScript MCP server for the Estonian e-arveldaja (RIK e-Financials) REST API.
128 tools by default on the `standard` profile; opt-in `guided` / `guided-sales` expose 19 / 20 tools, and `full` exposes all 148. The prompt registry holds 16 workflow prompts (guided profiles register fewer — a prompt whose required tools are all absent is not registered) and there are 15 resources across 12 modules. Supports multiple companies/accounts.

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
The active connection is in-process state: a server respawned by the MCP host starts on
`EARVELDAJA_DEFAULT_CONNECTION` (index or name; default 0, unknown values fail startup).
With 2+ connections every non-readonly tool gains an optional `connection` argument
(index or name); a mismatch with the active connection is refused (`connection_mismatch`)
before any API request. Pass it on every write in multi-company sessions (GitHub #61).
Connection names are unique: when two distinct credentials derive the same name
(e.g. `apikey.txt` + `apikey.TXT`, or `env-local` from two working dirs), later ones
in load order get a deterministic `-2`, `-3`, … suffix, so a name-pinned call is never ambiguous.

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

e-arveldaja's REST API exposes "Algbilansi kanded" as `operation_type=INITIAL`.
`loadJournalsWithOpeningBalance` identifies the opening journal in the original
API journal set, preserving IDs, dates, clients, postings and dimensions. It never
synthesizes or prepends a second journal. All balances, statements, annual reports
and dividend checks use that same API data. INITIAL journals are starting
positions, never cash flows or year-end close candidates.

Registration, deletion, date, client and dimension filters still apply. A draft,
deleted or empty opening is disclosed without applying its amounts; multiple
non-deleted INITIAL journals or malformed D/C amounts fail for manual review.
Missing dimension attribution is disclosed without dropping account-level totals.
If no INITIAL exists after a complete API read, there is simply no opening entry;
this is not an API coverage failure.

The local parser, store and `import_opening_balances` tool have been removed.
Existing `opening-balances.json` user files are untouched and no longer read.

### Cash-flow report

The annual report retains the indirect method (`indirect-evidence-v2`). Its
per-journal profit, depreciation and working-capital bridge removes proved
noncash and nonoperating components exactly once. Investing and financing use
actual cash receipts/payments, with FX shown separately. A complete result needs
both the bridge and independently classified cash movements to agree; unresolved
amounts remain visible with gross totals and `requires_review`, never a plug.

Supplier/customer invoice chains require exact transaction item references to
registered invoice journals and matching transaction/posting amounts, direction,
accounts and dimensions. A homogeneous operating source proves the cash-flow
purpose even when the invoice was booked after payment or historical invoice
capacity is unavailable; classification does not certify the invoice's open
balance. Invoice-capacity safeguards still apply to capital and mixed sources.
An unrelated customer's clearing cannot veto a proved operating payment.
Exact invoice plus direct operating-account distributions are supported when
their signed amounts and account/dimension slices cover the registered cash
movement completely. Realized FX within an operating payment follows that
payment rather than becoming a separate cash revaluation.

Reads are selective and bounded to 500 transaction details, including exact
internal-cash plus external distributions. Proven internal cash legs are
eliminated; only the external portion contributes to cash flows. Partial mixed
capital invoices, shared VAT allocation and missing evidence remain unresolved.
Homogeneous capital payments include VAT in gross investing cash; a proved
investment-principal/FX-result bundle uses actual cash without a duplicate FX
effect. Principal/result proof requires a genuine nonzero asset principal,
compatible asset/result family and the correct signed cash direction. It
preserves securities acquisition fees and conventional fixed-asset disposals,
including chart-proved accumulated-depreciation reversals and zero book value.
An increasing asset plus income does not establish sale proceeds. Rejected
bundles cannot fall through into a generic complete classification. Unsupported
financing-principal/FX bundles require review; ordinary operating interest and
fees retain their category. Capital-invoice evidence must bind source, item and
payment to the same account/dimension and signed slice; an unsupported single
invoice with multiple settlement dimensions remains unresolved.

Malformed evidence keeps review status but retains every independently valued
cash receipt/payment and identifies unvalued cash separately. Foreign raw units
are never substituted for EUR, and INITIAL never becomes an external movement.
Proven received interest/dividends use the operating
default; ambiguous result-only accounts (3820/7100/7110/8330/8335) require review
without principal evidence or an explicit account rule. Standard 1420/1430
receivables retain their operating default. Explicit account rules take
precedence. Public provenance lists are capped at
500 rows with full counts/totals; pure calculation evidence remains uncapped.

The pinned standard for 2018–2026 is [RTJ 2](https://www.fin.ee/sites/default/files/documents/2020-10/RTJ%202%20N%C3%95UDED%20INFORMATSIOONI%20ESITUSVIISILE%20RAAMATUPIDAMISE%20AASTAARUANDES.pdf),
paragraphs 37–44 (indirect corrections, gross investing/financing and cash FX).
Opening balances are maintained in e-arveldaja. Statement-closing snapshots
(`statement-balances.json`) retain their separate connection-scoped bundle store.

### Tool exposure (per-session token cost)

`tools/list` is loaded into the client context on every session, so the tool
surface is a fixed per-session token cost. Eight env flags control optional
parts of the surface (see `getToolExposureConfig()` in `src/config.ts`):

`EARVELDAJA_PROFILE` provides one-choice surfaces: `guided` (19 merged daily-bookkeeping tools), `guided-sales` (those 19 plus the `manage_sale_invoice` sales façade — read plus the full prepare/execute mutation lifecycle: create/update/delete/confirm/invalidate/send/recurring and inline resolve-or-create customer, 20 total), `standard` (the absent-variable compatibility default, 128), or `full` (all 148, including granular/setup tools and the workflow-state paging tool `get_workflow_page`). Guided profiles are opt-in for this release. Any explicitly present legacy exposure flag forces the normalized profile to `custom` and preserves the flag combination below. Profile and catalog fingerprint are part of plan/file-reference scope: restart and obtain a fresh preview after changing them.

The guided surface is sized for routing clarity, not token cost (per-tool measurement shows no cost cliff at 20). The **≤ 20** figure is a target, not a hard wall: 21–24 is a deliberate-exception band (allowed only with a recorded `CHANGELOG` rationale when no existing tool can absorb the capability), and 24 is the hard backstop above which the surface must be redesigned by merging tools rather than adding. Before adding any guided tool, apply the add/don't-add criteria in [`docs/guided-tool-policy.md`](docs/guided-tool-policy.md) — prefer a new `mode` on an existing façade, a `continue_accounting_workflow` continuation, or `standard`/`full` placement (as with `get_server_status`) over growing the daily surface.

`EARVELDAJA_DOCUMENT_READING=1` is not an exposure flag: it adds the opt-in verified-reading modes `read` / `verify` to `process_accounting_document` (create and confirm route on the reading-domain handle), so no tool count and no profile changes (guided stays 19). Off, the tool's schema and description are byte-identical. The workflow guidance for the reading path is carried by the flag-gated tool description and the `read` / `verify` / `create` outputs, not by `workflows/book-invoice.md` (prompt feature sections are tool-gated, and the flag adds no tool).

Lost dot-leader values (`text_layer_value_lost`, a liteparse overlay bug): with the reading flag on, `read` also returns one PNG crop per lost leader row (300 dpi, label included; ≤ 6 crops, 64 KB each, 256 KB total, else `lost_value_images_omitted`) after fixed instructions that the pixels are untrusted. The client transcribes only `invoice_date` / `invoice_number` into `verify`'s `lost_value_reading` (`{field: {line, printed}}`), keeping them null in `document_reading`. `verify` (`src/documents/reading-operations.ts` `resolveLostValues`) accepts a value only when the field is null with no other hold, the cited line is a lost line cited once, the re-rendered crop's server OCR (`src/documents/lost-value-ocr.ts`, `src/document-reading-lost-value.ts` `matchLostValue`) shows exactly one candidate equal to it at confidence ≥ 0.6 on the same OCR row as the cell's label, with only leader glyphs and punctuation besides, and a second full checker pass raises no new hold (`image_agreed` allow-list: evidence/proof codes only). A date is not applied while the number stays lost. Every agreed value gets a mandatory confirm row and is re-checked at create; the audit records `image_ocr_agreed_fields`. Any failure leaves today's typed row (`lost_values` says why). A read invoice number whose evidence line starts with a lost cell's own label of at least two words followed by the number (Google's header `Arve number: …`; `printedUnderLostLabel`), with no other hold on the field, gets a confirm row instead of the typed row (audit `text_layer_number_kept_under_label`); the date never takes this route. Signature lines: before the hold is raised, `readingPacketOf` (`src/tools/document-text-hazards.ts`, used by every path that checks the hold) renders each lost row's full-width band and OCRs it. The band comes from `leaderRowBand`: the row is unique on its page, the band runs from two row heights (the tallest row item) above it to 0.4·h below, at most 6 rows on 2 pages, and each lost cell is bound to its own label item. `ocrItemsOnPage` maps OCR words to page points using the OCR's extent (`OcrPngResult.size`) over the crop's real rect (`croppedPixels`). `leaderRowIsBlank` clears the row only when both hold:
- OCR read each cell's last label word on that label item, on the row;
- every OCR item is accounted for. Host = the item under the OCR item's centre; a number keeps its sign and punctuation and gets no slack. "On the leader" means the host holds a leader run (a combined label+leader item counts wholly), the box reaches into such an item, or there is no host. On the leader, only the host's label words (counted) pass; a number, any other word, or punctuation other than leader glyphs holds, unless the item is a smudge (< 0.2·h, confidence < 0.5, no digit). Off the leader, a word must be the host's word (counted), or have no digit and not be only look-alikes. Each lost cell is bound to its own leader run (`lostLeaderRunIndex`); the row's items must hold the line's runs one for one.

Cleared rows go to `blank_leader_lines`. The digest is unchanged, but the reading plan binds the set: a different set at create is `packet_changed`, and the audit records `blank_leader_lines`. Any failure keeps the hold. Owner-accepted gaps: a digit-free lost value over printed text can be cleared, and OCR that skips a value entirely while reading every label is not detected. Off with `EARVELDAJA_READING_LOST_VALUE_IMAGES=0` or `EARVELDAJA_LITEPARSE_OCR_ENABLED=false`; a remote OCR server (`EARVELDAJA_LITEPARSE_OCR_SERVER_URL`) is accepted as the server check (owner decision). Unusual page geometry (`/Rotate`, `/UserUnit`, a non-zero MediaBox origin, a CropBox differing from the MediaBox, an indirect box, encryption, more than 256 or 32 MB of object streams; `pdfPageBoxRefusal`, name escapes decoded) and a page over 40 Mpx at 300 dpi get no crop.

Payment reference on the reading path: `ref_number` and `notes` are refused arguments; `verify` derives the viitenumber from the packet (`src/document-reading-reference.ts` `printedPaymentReference`: an Estonian label `Viitenumber`/`Viitenr` followed on the same line by a whole-token 2–20-digit number with a valid 7-3-1 check digit, `isValidEstonianReferenceNumber` in `src/ref-number.ts`; English `Reference` labels are not read). Exactly one distinct value is bound as the booking's `ref_number` (`bank_ref_number` on the draft, covered by the fingerprint, drift and readback checks); several distinct values bind nothing and `verify` returns `payment_reference_note`.

`get_server_status` is a compact read-only tool (version, active profile, any active point-of-use release notices, and `auth_brakes` — per-server 401 brake state `cooldown_until` / `distinct_connections_401`, present only while unexpired 401s (last 60 s) or a cooldown are present) registered unconditionally like `get_setup_instructions`; it needs no credentials and belongs to no opt-out group, so it is visible in `standard`/`full` (and setup mode) but not the guided surfaces. The fixed per-session `instructions` string is kept lean (built in `src/server/server-instructions.ts`, under 1.5 KiB; its entry-point tool names are profile-aware — the guided façades on `guided`, the granular entry points on `standard`): detailed VAT / bank-direction / reporting guidance lives in the owning `workflows/*.md` prompts, and the v0.22.0 incoming-direction regression advisory is a point-of-use release notice (`src/server/release-notices.ts`) surfaced only at the start of the affected bank flows, not in the global text.

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
  `reconcile_inter_account_transfers` is not granular-gated and stays registered
  on `standard`/`full`; the merged `reconcile_bank_transactions` also executes
  inter-account transfers via `mode="execute_inter_account"` (the only route on
  the guided profiles).
- **`EARVELDAJA_DEFAULT_CONNECTION=<index|name>`** — connection a freshly started
  server activates (default: index 0). An unknown index/name fails startup rather
  than silently using index 0. Pair with the per-call `connection` guard argument
  that multi-connection servers add to non-readonly tools.
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
  helpers (`check_vat_registration_threshold`, `prepare_dividend_package`,
  `create_owner_expense_reimbursement`, `check_tax_free_limits`, `limited_vat`) and the
  VAT-threshold prompt. The statutory tax-rules advisory layer used by
  `suggest_booking` is unaffected — only these five tools are unregistered.
  Use when the deployment never runs VAT-threshold/dividend/reimbursement/
  tax-free-limit workflows. Saves ≈1.5k tokens.
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

The standard surface is 128 tools; `DISABLE_LIGHTYEAR` in a custom profile drops it to 122.
`EXPOSE_GRANULAR_TOOLS` adds the 10 granular tools, `EXPOSE_SETUP_TOOLS` the 3
credential tools; enabling both (with `full`'s `get_workflow_page`) raises it to the full 148. The five opt-out
group flags trim the default further — `DISABLE_TAX_TOOLS` (−5),
`DISABLE_REFERENCE_ADMIN` (−9), `DISABLE_ANNUAL_REPORT` (−3), `DISABLE_SALES`
(−13), `DISABLE_PRODUCTS` (−7) — so a lean purchase-side-only deployment with
every disable flag set (incl. Lightyear) lands at 85 tools. (The former
`prepare_accounting_inbox` / `run_accounting_inbox_dry_runs` tools were
exact aliases of `accounting_inbox` `mode="scan"` / `mode="dry_run"` and have
been removed — use `accounting_inbox` with the matching `mode`.)

`recommend_workflow` filters its suggestions to the registered surface, so it
never names a tool an opt-out flag has dropped (and it hides a whole workflow
whose tools are all gated, e.g. `lightyear-booking` when Lightyear is off). The
MCP workflow prompts are profile- and exposure-aware too: `registerPrompts`
derives the registered tool set (`promptToolAvailability` in
`src/prompt-registry.ts`, the same derivation the server `instructions` use),
renders a `workflows/*.md` feature section only when its tools are registered
(e.g. the `standard` granular flow vs the `guided` façade flow, the `sales`
extension), and does not register a prompt whose `requiredTools` are all absent
(e.g. `lightyear-booking` / `new-supplier` on `guided`).
`src/prompt-tool-surface.test.ts` pins, for every profile, that rendered
prompts and instructions name only registered tools. The static
`.claude/commands/*.md` mirrors are profile-agnostic: they contain every
section, each wrapped in a capability condition ("run only when these tools are
advertised …") so the agent skips sections whose tools are not in `tools/list`.

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
- **User-uploaded docs**: `GET/PUT/DELETE /{entity}/{id}/document_user` (PUT to upload, not POST). Implemented generically on `BaseResource` (`getDocument`/`uploadDocument`/`deleteDocument`, keyed on `basePath`) and exposed by the entity-agnostic tools `attach_document` / `get_document` / `delete_document` (`entity_type` ∈ purchase_invoice, sale_invoice, journal, transaction) in `src/tools/document-attachments.ts`. RPS requires a source document on every entry, so manual journals and directly-booked bank transactions can carry one too — `find_missing_documents` flags those that don't. PUT replaces an existing document, so `attach_document` checks first and refuses with `document_exists` unless `replace_existing: true` (tool is destructive).
- **System-generated sale invoice PDF**: `GET /sale_invoices/{id}/pdf_system` (tool `get_sale_invoice_document`)
- **System-generated sale invoice e-invoice XML**: `GET /sale_invoices/{id}/xml` (tool `get_sale_invoice_xml`) — the structured machine-readable e-arve, distinct from the human-readable PDF

### Transaction registration
- Body is a **top-level JSON array** of `TransactionsDistribution` objects (not wrapped in `{items: [...]}`)
- Each distribution: `{related_table, amount, related_id?, related_sub_id?}`
- `related_table` values: `"accounts"` (book to a GL account), `"purchase_invoices"`, `"sale_invoices"`
- Example (purchase invoice): `PATCH /transactions/{id}/register` with body `[{"related_table":"purchase_invoices","related_id":123,"amount":59.94}]`
- Synthetic example (account with dimensions): `[{"related_table":"accounts","related_id":1360,"related_sub_id":42,"amount":100.00}]`
- **`related_sub_id` is REQUIRED when `related_table="accounts"` and the account has dimensions.** Pass the dimension ID there. Without it, the API rejects with `"Entry cannot be made directly to the account <code> since it has dimensions"`. Common case: account 1360 "Arveldused aruandvate isikutega" with one sub-account per reporting person.
- **Do NOT pass the dimension ID into `related_id`.** That makes the API try to interpret it as an account ID and produces confusing errors like `"Dimension ID=<truncated> not found"`.
- The dimension ID is the integer `id` value returned by `list_account_dimensions` (NOT a sub-account code or label). `related_id` is the integer account ID, `related_sub_id` is the integer dimension ID — both are the database IDs, not the human-readable account/dimension codes.
- **Card payments often have `clients_id: null`** — confirmation fails with "buyer or supplier is missing". `TransactionsApi.confirm()` auto-fixes this by looking up the client from the linked invoice.

### Inline confirmation policy
- When a workflow leaves behind `PROJECT` (unconfirmed) transactions, journals, or `needs_review` items and the agent has the IDs/amounts/counterparties loaded, **always offer inline confirmation** via `confirm_transaction` / `reconcile_inter_account_transfers` / `update_transaction` (for supported writable metadata, verified with a fresh readback; `bank_ref_number` is read-only) / `delete_transaction`. Ask the user yes/no for each item.
- **Never** close a workflow with "these need your manual confirmation in e-arveldaja" / "tee see e-arveldaja UI-s käsitsi" as the default. That is a last-resort fallback only when (a) no MCP tool can perform the action, AND (b) the exact API error has already been shown to the user with what was tried.
- If the API rejects an inline attempt, show the raw API error and the exact body that was sent before suggesting manual UI fallback.

### Transaction type field — SEMANTIC on the write path, not cosmetic
- **The API `type` field drives the cash-account (e.g. 1020) leg at confirmation.** The
  backend books the cash side OPPOSITE the stored `type`: `type: "D"` → cash **debited**
  ("Laekumine" / money in), `type: "C"` → cash **credited** ("Tasumine" / money out). So
  every newly created bank transaction MUST carry the true statement direction:
  incoming → `"D"`, outgoing → `"C"`. This is enforced in one place —
  `createBankTransaction` (`src/bank-transaction-create.ts`) — which sets `type` from the
  explicit direction the CAMT/Wise importers pass, or derives it from the payload's signed
  `source_direction` marker via `bankTransactionDirection`, else `"C"`. (Forcing
  `type: "C"` unconditionally in 0.22.0 booked every incoming row backwards — cash on the
  wrong side; the regression fix restored the directional mapping.)
- **Read-side classification** (is this row an expense? a receipt? an inter-account
  transfer?) uses only signed `source_direction` metadata (`CRDT`/`DBIT` or `IN`/`OUT`)
  via `bankTransactionDirection`; a row without it is `"unknown"` (the read-back `type`
  is always `C`, see below). Treat unknown as "could be either": duplicate scans check
  both bank sides, an invoice match takes the side from the invoice kind
  (`bankPostingSideForInvoiceMatch`), and automatic booking that needs a direction
  (classification apply, expense suggestions) leaves the row for review.
- **`type` is write-only through the API:** `GET /transactions` returns `type: "C"` for
  every row, whatever was stored (verified live 2026-10: an incoming row created with
  `"D"` books "Laekumine" D 1020, yet reads back `"C"`; all 2056 rows of a company read
  `"C"`). So no confirm-time check can compare a signed marker against the stored type —
  the 0.26.0 `stored_type_direction_mismatch` guard did exactly that, blocked every
  signed incoming row, and was removed. Correctness rests on `createBankTransaction`
  setting `type` right at creation. A legacy CAMT marker (no `dir=`) was signed over the
  then-stored type, so a legacy incoming row no longer verifies against the read-back `C`;
  the post-confirm ledger check (`expectedReceiptBankDirection`) re-verifies such a marker
  with both types and takes the single match (`camt_checksum_legacy`), never an invoice
  fallback. A signed outgoing row (DBIT/OUT) only ever matches
  purchase invoices; the sale-invoice fallback for outgoing rows exists only for legacy
  unsigned `C` rows.
- **Distribution + direction together** determine the journal at confirmation:
  - Confirming against another bank account → "Laekumine"/"Tasumine" per the account
    relationship (inter-account transfers use the source/target dimensions).
  - Confirming against an expense/purchase-invoice or a plain GL account (e.g. 2110) → the
    backend uses the transaction's `type` to place the cash leg, because a GL account has
    no inherent direction. This is why the create-time `type` must be correct.

### Transaction status
- **`status: "CONFIRMED"`** — registered/confirmed (not an `is_confirmed` boolean)
- **`status: "PROJECT"`** — unconfirmed/draft
- **`status: "VOID"`** — invalidated
- **To delete**: invalidate a confirmed transaction first, then re-read before deleting. The live API returned `PROJECT` after invalidation on 2026-10-18; do not require a `VOID` readback to recognize a successful invalidation.
- **Native GL distribution readback**: a confirmed transaction item may carry `relation_table: "accounts"`, explicit `accounts_id` / `accounts_dimensions_id`, and a composite `relation_id` formed from those two IDs (synthetic example: `1020`, `42`, `102042`). Accept that native shape only by exact equality with the explicit valid IDs, the reviewed target mapping and the actual unique registration journal. Never split a composite to infer missing IDs, and never send it as the request's `related_id`; write requests still use separate account and dimension fields.

### Purchase invoice creation
- **Always pass invoice-level `gross_price` and `vat_price`** — confirm fails without them ("Gross sum and net sum with taxes differ")
- **Guarded PDF workflow:** `create_purchase_invoice_from_pdf` with `require_confirm_plan:true` verifies the actual uploaded draft and returns `confirm_plan.plan_handle` only when readback matches. Pass that handle with the exact ID to `confirm_purchase_invoice` after approval of registration. The handle is scoped and single-use; confirmation checks a final fresh draft fingerprint after its other prerequisites. A held result retains the created invoice ID: do not recreate it or fall back to handle-free confirmation. Handle-free calls keep their existing manual workflow. The GET/register pair is not atomic.
- Do **not** pass item-level `gross_price` for non-VAT companies — the API computes it from `total_net_price`
- `client_name` is required on creation (API field `client_name2`)
- For VAT tracking on items: set `vat_rate_dropdown`, `vat_accounts_id`, `cl_vat_articles_id`, `project_no_vat_gross_price`
- **VAT-registered items with VAT need `vat_rate_dropdown`**: `createAndSetTotals` predicts item VAT as net × rate before the create; without a rate the item VAT is 0, so an explicit `vat_price` is refused pre-create (`purchase_totals_mismatch`, nothing written)
- **Readback residue (live 2026-10-19, 2026-10-28):** when the invoice VAT differs from the per-line maths by ≤ 1 cent per line, `createAndSetTotals` sends the residue in the last item's `project_no_vat_gross_price`; on a VAT-registered row the API ignores it (reads back null, item `vat_amount` = net × rate) while keeping the header `vat_price`. `draftReadbackMismatches` accepts exactly that shape on the last row only; the header VAT and every other row field are still compared.
- Non-VAT companies have two purchase forms: folded VAT (no VAT account, rate `"-"`, invoice `vat_price: 0`, gross in `project_no_vat_gross_price`) and non-deductible VAT (VAT account and dimension equal the item's cost account and dimension, article 11, one document rate, invoice `vat_price` equal to document VAT). Synthetic example: cost account 7910 / dimension 42, net 10.00 + VAT 0.90 = gross 10.90 at rate 9. Exact source readback evidence is retained outside the repository. The latter is EUR-only and requires the chart account's `is_vat_account === false`; never use input-VAT account 1510. The same proof checks intended rows, both create read-backs and the fresh draft/chart before registration. Unproven drafts are held, never corrected automatically; edit rows in the UI or recreate the draft. Receipt batches and auto-classification keep folding.
- **PATCH requires `items`** — updating invoice fields without including items fails with "Products/services are missing"
- **Accounts with dimensions**: If an expense account (e.g. 5120) has dimensions (sub-accounts), you MUST pass both `purchase_accounts_id` (the account ID) AND `purchase_accounts_dimensions_id` (the dimension ID) on each item. Passing only one fails with "Entry must be made to account's dimension." Use `list_account_dimensions` to find dimension IDs for an account.

### Inter-account transfer reconciliation
- CAMT-imported transactions confirmed as inter-account transfers create journal entries touching both bank accounts
- If the other side (e.g. Wise import) is also confirmed against the same bank account → **duplicate journal entries** and incorrect balance
- **Always use `reconcile_inter_account_transfers`** (or `reconcile_bank_transactions` `mode="execute_inter_account"`) for inter-account confirmation — it checks existing journals before confirming
- The Wise import tool (`import_wise_transactions`) has built-in duplicate detection for inter-account transfers (BookingGuard Lane B, ±1 day, labelled journals identity-only); it auto-confirms only same-currency EUR own transfers — cross-currency ones go to review for `reconcile_inter_account_transfers` (H10), and it never modifies confirmed purchase invoices (invoice FX corrections are advisory)
- When manually confirming transactions against another bank account, first check for existing journals at that date/amount — `confirm_transaction` warns (BookingGuard Lane B ±1 day + bank-posting scan) and refuses with `block_on_duplicate: true`
- Same-type reciprocal legs (both stored `C`, or both `D`) are auto-confirmed only when exactly one leg carries a signed outgoing marker agreeing with its stored `C`; otherwise they go to `ambiguous_pairs` with `code: "direction_unresolved"` (the stored type cannot say which account the money left)
- Inter-account pair distributions use authoritative EUR amounts on both legs, validated with the one-sided amount resolver. A foreign pair leg must carry an explicit `base_amount` agreeing with any supplied `currency_rate`; missing or conflicting evidence holds both legs for review, never substituting nominal currency or deriving a pair's value from the rate alone. One-sided transfers retain their existing amount-resolution rules (H10).

### Cross-mechanism bank-posting duplicate guard

The same real-world cash movement can be booked twice through *different*
mechanisms — a manual journal that credits a bank dimension directly, a
`create_transaction` bank row, a reconcile exact-match confirm, and a
receipt/PDF intake all land on the same bank account but each only detects
duplicates *within its own* mechanism. `src/bank-posting-duplicate-guard.ts`
closes that gap: it scans **all** registered journal postings on a bank
account's dimension for a same-direction, same-amount, nearby-date posting and
surfaces it as a **POSSIBLE duplicate** — a SUSPECT, never a certainty (two
legitimate identical payments are possible).

- **Advisory by default.** The guard is wired into `create_transaction`,
  `create_journal` (fast-pathed — consulted only when a posting touches a known
  bank dimension), the reconcile exact-match confirm + suggest flows, and the
  receipt/PDF intake (`create_purchase_invoice_from_pdf`, the inbox dry-run).
  It never auto-deletes or auto-merges. Each of the mutation tools takes an
  opt-in `block_on_duplicate` (default `false`) that REFUSES creation **only**
  when the scan is available AND actually found a suspect; an unavailable scan
  never blocks.
- **Exception: `receipt_batch` holds.** A batch has no person reading each
  advisory, so a receipt whose intake scan finds a suspect is `needs_review`
  with `possible_duplicate_journal_ids` in dry run AND execute (never created).
  Execute drops the journals list cache right before each pre-create scan, so a
  payment booked after the projection is still seen. An unavailable scan never
  holds. A legitimate second identical payment is booked through the
  single-document tools, which stay advisory.
- **`receipt_batch` also holds on a journal reference**
  (`src/journal-reference-scan.ts`). A receipt whose invoice number a live
  journal (`is_deleted !== true`, any type, drafts included) already carries
  in its `document_number` or `title` is `needs_review` with
  `referencing_journal_ids`, in dry run and execute (same cache drop before
  each create). The cash scan misses these: a manual prepayment journal
  `ETR1:EE1966453` has no bank posting in the ±7 day window. Matching is token
  equality, never substring: tokens split on anything but letters, digits and
  `-` `/` `.` `_`, then again on those internal delimiters; runs of 2-3
  adjacent tokens and of 2-4 adjacent sub-tokens across the whole field are
  joined (`ETR1-EE1966453` hits `EE1966453`, `ETR1-INV 2024/001` hits
  `INV-2024-001`; `XEE1966453` and `EE19664531` do not). A strong reference (6+ characters with a digit, not date-shaped)
  matches any token of document_number or title; a weak one (4-5 characters,
  or date-shaped) only the whole document_number or its remainder after one
  `PREFIX:` (`LY:1234`), never a title, sub-token or join; shorter or
  digit-less numbers are never matched. No date window. `receipt_batch` also
  scans the document's label-anchored prepayment references
  (`Ettemaksuarve nr EMSS70002960`, `Ettemaks`, `Prepayment invoice`; one
  unspaced value on the label's line, never an amount, date or IBAN) under the
  same strength gate. Generic payment references (viitenumber, makse viide)
  are not scanned: they repeat on every invoice of a customer. In `receipt_batch` an
  unavailable scan is retried once and, still unavailable, holds the row
  (`journal_reference_scan_unavailable: true`, dry run and execute alike); on
  the single-document tools it only adds a note (a
  `journal_reference_scan_unavailable` warning at
  `process_accounting_document` prepare). Receipt extraction never changes the
  captured invoice number (an invoice booked under it must still be found as
  a duplicate), but a number the line continues past through a delimiter
  (`AB1.234` read as `AB1`, `INV-0042.Date`) is held as
  `invoice_number_ambiguous`, so a cut-short number cannot slip under the
  strength gate. `process_accounting_document` and
  `create_purchase_invoice_from_pdf` get the advisory
  `invoice_referenced_by_journal` / `referencing_journal_ids` and still create
  (also with `block_on_duplicate`).
- **Match key:** account + dimension + amount (±0.01 EUR) + direction (`D`/`C`)
  + effective date within ±7 days (`DUPLICATE_SCAN_WINDOW_DAYS`). Intake mode
  scans every bank dimension (the invoice's settling account isn't known yet)
  and compares against a real EUR gross only — never a guessed conversion.
- **Fail-safe.** The guard's own reads degrade rather than fail the host tool:
  a journals-fetch past the 200-page cap, or a `getBankAccounts` /
  `getAccountDimensions` reference-read error (`resolveBankDimensionsSafe`),
  both surface a "Duplicate scan unavailable" note and let the booking proceed.
  An advisory sub-check must never be the reason a legitimate booking fails.
- **Untrusted text:** suspect journal titles are `wrapUntrustedOcr`-wrapped at
  every MCP output site; block-reason strings carry only numeric journal ids.

### Source-reference idempotency (`ref_number` / `document_number`)

- **`ref_number` is canonicalized at the single write boundary**
  (`createBankTransaction` → `canonicalRefNumber`, `src/ref-number.ts`): trimmed
  and capped at `REF_NUMBER_MAX_LENGTH = 20` (the maintainer-reported backend
  limit — a fallback, not demo-probe-confirmed). When a reference exceeds the
  cap, the FULL value is woven into `description` so it is never lost, inserted
  **before** any trailing `[source_direction=…]` / `[e-arveldaja-mcp:camt …]`
  marker so the end-anchored direction/metadata regexes still match (a
  marker-only description gets the ref on its own line to preserve the camt
  `(?:^|\n)` anchor). Wise dedup keys on the `WISE:{id}` description tag, not
  the reference, and the execute-time `createdTransactionMatchesApprovedPayload`
  mirrors the canonicalization, so an over-cap Wise row neither double-imports
  nor fails its stored-row precondition.
- **`create_journal` document_number advisory:** when `document_number` is set,
  the tool scans existing live journals for the same reference and warns
  "source reference already used by journal N" (creation still proceeds; a
  deleted journal with the same number does not warn). Use a stable source
  reference (`WISE:{id}`, `LY:{ref}`, `BANK:{stmt-ref}`) for imported or
  mechanism-crossing entries so duplicate detection has a key.

### Known issues — Wise account
- **Wise balance has ~0.03 EUR discrepancy** with the real account balance (8.71 vs 8.68 EUR as of 2026-03-22). Root cause not yet identified — likely a pre-existing duplicate or rounding issue from earlier imports. Does not affect LHV balance.
- **Statement closing-balance tripwire (CAMT).** When a CAMT statement carries a
  CLBD closing balance bound to a bank dimension, `import_camt053` compares it
  against the expected balance (opening-balance fold + booked postings up to the
  balance date + signed unconfirmed PROJECT rows) with a **0.10 EUR tolerance**
  (chosen to clear the ~0.03 EUR Wise drift with headroom) and surfaces a
  `statement_balance_check` with an advisory warning when they diverge. It is
  advisory-only and fail-safe (never blocks or throws out of the import), the
  comparison is EUR-base only (a non-EUR closing balance is reported but its
  warning is suppressed as an FX mismatch), and on `execute` the per-dimension
  closing balance is persisted to `statement-balances.json` in the accounting
  bundle (bundle mode only; skipped with a note under single-file rules mode).
- **Receipt attachment digests**: every successful purchase-invoice document
  upload (receipt batch, PDF / document booking, `attach_document`) records
  `{ sha256, entity_id, … }` in `receipt-attachment-digests.json` in the same
  bundle (connection-stamped, `src/connection-scoped-bundle-store.ts`; off in
  single-file rules mode). A record is a hint only: `receipt_batch` reports a
  file `already_attached` only after a fresh read of the invoice and a SHA-256
  of its current `document_user` bytes (≤ 20 downloads per run, incl. a dry-run
  backfill for invoices named by the receipt's number).
- **CAMT review acknowledgements**: an owner-approved "journal N books this
  statement row" check (`continue_accounting_workflow` prepare/execute on a
  `camt_journal_review` item) is stored in `camt-review-acknowledgements.json`
  (same store factory; off in single-file mode). The CAMT projection applies one
  only when its full key matches, an inbox scan in this server process kept the
  statement for import for the active connection (in-memory registry keyed by
  connection + statement digest; after a restart or on a direct import of an
  unscanned statement the row stays a review, `camt_ack_needs_inbox_scan`), the
  movement is unique in the statement and across that connection's kept
  statements, and the one journal still moves exactly the row's amount; never a
  booking. The candidate carries its statement digest, and prepare and execute
  refuse `camt_ack_needs_inbox_scan` unless that digest has scan context for the
  active connection (also for a candidate saved before a restart).

## Architecture

```
src/
  config.ts              # Env/file credential loading, server URL selection
  auth.ts                # HMAC-SHA-384 request signing
  http-client.ts         # Authenticated HTTP client (rate-limited, 60s timeout)
  cache.ts               # In-memory TTL cache (300s default, 500 entry max)
  index.ts               # Process entry point: stderr tee + createMcpServer() + fatal handling
  server-bootstrap.ts    # Thin re-export barrel (createMcpServer, buildSetupInstructionsPayload) — see server/
  server/
    create-server.ts     # createMcpServer composition root: config/setup-mode, McpServer, registration-order boundary, transport connect
    register-system-tools.ts # Multi-account + audit-log + credential + cache-control tool registrations (exact order)
    register-domain-tools.ts # Full domain-tool + resources + prompts registrations (exact order — security boundary)
    setup-mode.ts        # Setup-mode payloads/errors, credential-blocked API proxy, buildSetupInstructionsPayload
    server-instructions.ts # Lean per-session `instructions` string (< 1.5 KiB)
    release-notices.ts   # Point-of-use release notices + get_server_status payload
  runtime/
    connection-manager.ts  # Active-connection state + atomic switch_connection core (generation bump + dual cache clear)
    invocation-scope.ts    # Per-invocation AsyncLocalStorage snapshot store + connection-scoped API context
    audit-label-resolver.ts # Resolve-on-first-use audit-log company-name labelling
    runtime-context.ts     # Assembles + constructs the runtime safety context (plan/file-ref/op-result/workflow stores)
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
- **Duplicate detection**: Journal `document_number` field stores `LY:{reference}` (e.g., `LY:OR-EVN9C76R7A`). A distribution row with no reference match but a non-`LY:` journal debiting the broker account/dimension with its net EUR amount within ±1 day goes to review (`possible_existing_journal`, `candidate_journal_ids`) — legacy hand bookings used generic numbers such as `reward`
- **Dry run default**: `book_lightyear_trades`, `book_lightyear_distributions` and `book_lightyear_fx_revaluation` default to `dry_run=true`

### ECB reference rates (Lightyear FX)

`src/fx/ecb-rates.ts` reads the ECB euro reference rates from
`https://data-api.ecb.europa.eu/service/data/EXR/D.{CCY}.EUR.SP00.A?startPeriod=…&endPeriod=…&format=csvdata`
(public, no credentials; HTTPS, fixed host, 10 s timeout, ≤ 64 KiB body, every row's `KEY`,
`TIME_PERIOD` and `OBS_VALUE` checked; `OBS_VALUE` is foreign units per 1 EUR, kept as the
published string). Rule: the observation dated on the requested day, else the most recent
earlier one within 7 calendar days (weekends, TARGET holidays); today or later (Europe/Tallinn)
is `ecb_rate_not_final`; no observation / network / HTTP error is `ecb_rate_unavailable`; a
malformed answer is `ecb_response_invalid`. A rate is cached as final only when the same
response holds a later day's observation (the ECB may correct a rate until the next one is
published); otherwise the next resolve refetches. The cache is public data and survives
`switch_connection`. Dry runs freeze every outcome they used — successes and failures — in the
plan's private `fx_outcomes`; execute replays them with `replayFrozenFx` and never fetches
(a key the plan never resolved is `fx_rate_unbound` → `plan_drift`). A failure is always a
review row, never a guessed rate.

### Lightyear USD cash-fund pool

`src/lightyear/usd-pool.ts` keeps the USD Lightyear holds as cash or ICSUSSDP units at its EUR
carrying value inside the broker account/dimension, in the connection-scoped bundle file
`lightyear-usd-pool.json` (needs bundle storage; single-file `EARVELDAJA_RULES_FILE` mode →
`usd_pool_unavailable` reviews). Pool key = connection + Lightyear account (from
`AccountStatement-LY-<ACCOUNT>-…` or `lightyear_account`) + broker account/dimension; another
broker target for the same Lightyear account is `usd_pool_target_mismatch`. Records: one
owner-approved opening checkpoint (`book_lightyear_fx_revaluation` `mode: "opening"`, replayed
from the statement and valued at the ECB rate; set once — redoing it means deleting the pool's
entries from the store), `distribution_in` events (retained USD distributions,
`book_lightyear_distributions` `fx_source: "ecb"`; without a pool key or store they are reviews, never
booked unlogged; a new one dated on/before the approved opening is held `usd_pool_before_opening`), `sell_in` events (a USD sell with no 1:1
conversion keeps its net in the pool at the ECB rate; `book_lightyear_trades` needs its capital-gains row matched by
identity — exact statement date+time, ticker, quantity — else `pool_sell_gains_unmatched`, which stops later pool
commands; gain/loss = ECB consideration − Lightyear FIFO cost basis), `buy_relief` events (`book_lightyear_trades`: a USD
buy with no 1:1 conversion is paid N:1 — at most one remaining EUR→USD conversion in [buy − 60 s, buy] with a smaller
gross, pool part = buy gross − conversion USD (a conversion with a fee on its USD leg is held, `conversion_fee_conflict`) — or 100 % from the pool; a conversion missing a leg holds every
unpaired USD trade of its statement day as `invalid_conversion_pair`, never pool funding; only a `usd_pool_funded` trade
is valued — an intrinsic pairing/conversion error is a projection barrier that stops later pool commands, and every
state-independent bookability check (zero-rounded investment, unsafe cost basis, conflicts) runs before the projection; relief at average carrying value, realised FX
= relief − ECB value of the pool part, on 8500), `conversion_out` events (`book_lightyear_trades`: a USD→EUR
conversion with no trade relieves the pool; fee in EUR = the fee on the EUR leg, or USD fee × EUR net / USD net;
FX = relief − (EUR net + fee) on 8500; broker net = EUR net − relief; fee 0 and FX 0 books no journal — the event
carries `source_evidence` + `evidence_digest` and `validateUsdPool` accepts it only when the digest, the leg
arithmetic, the replayed state before it, the statement legs (when the statement covers its day), the absence of any
`LY:<ref>` journal and its own deltas all agree) and
revaluation checkpoints (`book_lightyear_fx_revaluation` `mode: "revalue"`, journal
`LY-FX:<account>:USD:<date>`, quantity proof against the Lightyear holding). Every write runs
under `withUsdPoolLock` (which drops the store's read cache once the lock is held, so records another
process committed are seen) as intent → create → readback → commit; a readback or commit failure stops the plan's remaining commands
(`partial_execution`, the created journal id reported, the intent kept); `recoverUsdPoolIntents` resolves
leftovers from the ledger and never recreates a journal. Every pool record carries its canonical `postings`
(account, dimension, side, cents; the opening and journal-free records `[]`): readback, recovery and validation
compare the journal's posting multiset with it, not only the broker net (a mismatch is `usd_pool_commit_deferred`,
`usd_pool_uncertain_outcome`, `usd_pool_chain_broken`); a record without postings breaks the chain. Journal-backed records and
revaluation checkpoints also carry the approved `effective_date`, checked the same way; one without it never matches
(recovery keeps such an intent, `usd_pool_uncertain_outcome`; journal-free records and the opening have none). Each statement-derived
event carries a `source_digest` of its USD rows (time, type, ticker, quantity, gross/fee/net cents); a later
statement covering that day that lacks the row, moves it or changes its amounts is `usd_pool_source_changed`. A row
whose digest cannot be computed (an amount finer than a cent) is `usd_pool_source_unbound` — never logged, later
pool commands stop — and a stored statement-derived event without `source_digest` breaks the chain. A
duplicate found only at create time is read back and committed like a fresh journal, or stops the run.
Same-second trade commands execute in the pool's (timestamp, reference) valuation order; a checkpoint (stamped at 23:59:59 of its day) orders after every event of that second, so a last-second event belongs to the day it closes. `validateUsdPool` replays the whole
chain from the opening against fresh journals; records ordered before the latest committed relief
or checkpoint are refused (`usd_pool_backdated_event`). Order: opening once → distributions →
trades → confirm drafts → period-end revaluation. FX amounts come only from the pool log and the
ECB rate, never from the 1020 balance.
Same-date revaluation retries retain duplicate protection and rerun the current chain, statement
coverage and supplied-holding checks before returning `already_booked`; changed prerequisites remain reviews.

Statement roles (`src/lightyear/pool-statement.ts`): every USD row gets exactly one role —
`pass_through` (1:1 trade↔conversion, converted distribution), `sweep` (ICSUSSDP Buy/Sell, never
booked, checked at price 1.00 / fee 0 / gross = quantity), `distribution_in`, `sell_in`, `buy_relief`,
`conversion_out`, `unsupported` (EUR→USD conversion with no trade, USD deposit/withdrawal),
`pairing_ambiguous` or `unplaceable` (no valid timestamp: blocks the whole pool for that statement).
Trade↔conversion pairing is computed over the whole statement before anything is consumed
(`assignOneToOne`): a same-day same-amount group pairs only when unambiguous (one trade + one
conversion, or unique ±60 s edges covering the smaller side); otherwise every member is
`invalid_conversion_pair` / `pairing_ambiguous`. A second holding both a pool inflow and an outflow
refuses that and every later pool command (`usd_pool_ambiguous_order`). `validateUsdPool`, the trades
valuation and the revaluation run these pure checks. A group still ambiguous after the ±60 s rule pairs only
when its same-second edges give every trade and conversion exactly one and each is exact to the cent (the only
matching on same-second edges); a group is never split, so no member gets the 1+1 distance exemption. A sell kept in the pool
takes its capital-gains row only when that row's identity (date and time, ticker, quantity, agreeing ISIN) belongs
to it alone; a 1:1 FX sell outside the 0.1 % proceeds tolerance may take its exact-identity row within 1 % under
the same ownership rules.

Read-only rebuild (`src/lightyear/rebuild.ts`, script `npm run lightyear:rebuild-compare`): `simulateLightyearYear`
runs the production planners `extractLightyearDistributions` / `planLightyearDistributions` / `planLightyearTrades`
(the code `book_lightyear_distributions` and `book_lightyear_trades` run after reading their files) over an
in-memory ledger and pool store from an asserted opening (every statement row after the opening is replayed; output is limited to `--from..--to`; pool coverage is the export's file-name period, else what its rows prove, never the replay bounds, and without a declared period covering the opening through `--to` no month-end holding is reported), so it stops with production's review codes;
`compareWithBooks` (pure) diffs the proposal with live journals over the run's inclusive `--from..--to` range per account/month, `LY:` reference (equal = one
journal, same effective date, same posting multiset) and broker TRANSACTION transfers. The script's `GetOnlyHttpClient` throws on any non-GET before sending; nothing is written.

## Security Notes

- File read operations (PDF, CSV) resolve symlinks via `realpath()` and re-check extensions
- `safeJsonParse` enforces 1MB input size limit
- `listAll()` is bounded to 200 pages max
- HTTP client rate-limits to ~10 req/sec
- No health probe: failure advice comes from the failing request alone, no extra request is sent. An unauthenticated probe cannot tell a healthy API from an all-401 incident / IP block — the healthy live API answers unauthenticated `GET /v1/openapi.yaml` with 401 (live-verified 2026-11-04) — so it was removed. A 401 gets the key/IP/clock list plus "if several connections fail at once or this one worked moments ago, suspect a server/IP-side block, do not change keys"; 5xx/network/timeout gets "API did not answer, probably not credentials, retry later"
- 401 brake (`src/api-health.ts`, `authBrakeFor(baseUrl)`): ONE brake per API server shared by every connection (switching connections does not bypass it). each connection keeps its own 401 history (a success resets only that connection's history, so a healthy connection cannot erase a stale one's failures); 3×401 within a sliding 60 s across those histories → 60 s local `auth_cooldown` (nothing sent) with `distinct_connections_401` (connection labels counted, never secrets; ≥ 2 = server/IP-side problem). The cooldown is rechecked immediately before every fetch (after rate-limit waits and retry delays); the local refusal is never counted as an upstream 401. Expired sub-threshold 401s drop out of `get_server_status`. The per-tool audit-label lookup (`GET /invoice_info`, `src/runtime/audit-label-resolver.ts`) is not retried for 5 min after a failure, never feeds the brake (`excludeFromAuthBrake`; the cooldown still refuses it), and never runs for `get_server_status` or the catalog's `setup` / `connection` groups, so credential-free tools on stale keys cannot trip the brake
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

**Tool inputs are strict.** The connection-scoping Proxy in
`src/server/create-server.ts` wraps every raw-shape input schema in
`z.object(shape).strict()` after adding the `connection` guard, so an argument a
tool does not declare is refused (SDK input-validation error) instead of being
silently dropped. A remapped action (`remapHiddenGranularTool`, derived from
the catalog's `granular_of` — `selector` names the branch argument, `mode` or
`action`; `remapGuidedBankFacade`; `remapGuidedInterAccount`) must emit only
keys its destination declares in that profile — pinned per profile by
`src/tool-surface-contract.test.ts`. A single-connection server declares no
`connection` argument, so passing one there is refused too.

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
- **ÄS § 157 lg 1 starts from the APPROVED annual report** (`src/dividend-capacity.ts`, called by `prepare_dividend_package`). Required inputs (schema-optional, handler-required → `approved_annual_report_figures_required` with a ledger diagnostic for the named cut-off): `approved_report_year` (Y−1 or Y−2, Y = dividend year; else `approved_report_year_out_of_range`), `approved_retained_earnings` and `approved_profit_for_year` = the balance-sheet lines "Eelmiste perioodide jaotamata kasum (kahjum)" and "Aruandeaasta kasum (kahjum)" of that report — taken from the owner or the report, never computed. lg 1 = approved − Σ d(j) over every non-deleted journal (registered or draft, any date) after R-12-31, d(j) = max(0, −ΔEQ, −ΔALLEQ) in cents (EQ = 2960/2970/9000 by number and name incl. inactive accounts + the configured result account; ALLEQ = every Omakapital account ∪ EQ): monotone, so nothing booked after the report raises lg 1 (credits, income, corrections into equity never add; a debit correction or a late legacy loss close counts, conservatively). Cross-check: ledger L_R = Σ(C−D) on EQ ∪ Tulud/Kulud of registered journals up to R-12-31 (plus a registered INITIAL dated exactly (R+1)-01-01, the boundary opening); a difference holds `approved_report_ledger_mismatch` unless `ledger_difference_acknowledged` equals approved − L_R to the cent (only after checking the owner's report). Other holds: `distribution_history_incomplete` (registered INITIAL after R-12-31 other than the boundary opening; no acknowledgement lifts it), `dividend_amount_unverified` (a foreign posting without `base_amount` on any account the calculation reads), `pre_report_equity_draft` (draft dated ≤ R-12-31 with an equity posting, unless ΔEQ = 0, ΔNA = 0 and it posts to no protected share-capital/restricted-reserve account, e.g. a draft RIK result entry or 2970 → 2960 transfer), `pre_report_draft_reduces_net_assets` (any other draft dated ≤ R-12-31 whose ΔNA < 0, e.g. a pending year-end expense: register or delete it so the books match the approved report; its postings are EUR-checked too). Holds return only a `diagnostic`, no maximum or verdict; `force` never lifts them. No closing-journal detection in the dividend path (`isYearEndClosingJournal` is reporting-only).
- **lg 2 net-assets floor is GROSS-based**: as-of net assets (registered, Σ(C−D) on ALLEQ ∪ Tulud/Kulud, verified cents) − floor (share capital clamped ≥ 0 + per-account clamped restricted reserves: name-detected "Kohustuslik reservkapital" ∪ 2940, override `restricted_reserve_accounts`) − commitments ≥ gross. Commitments: every draft after R-12-31 and every registered journal dated after the dividend date (d = 0 journals such as a split CIT draft included) reserves max(0, −ΔNA) + per-account increases of protected accounts. `maximum_distributable.max_net_dividend` = largest integer-cent net with net ≤ lg 1 and net + CIT (rounded as booked) ≤ headroom (`no_positive_capacity` when 0). `force=true` overrides only these two numeric shortfalls (use only alongside a legitimate action such as a capital reduction), never a hold or the ledger-imbalance block. Proposed journal targets are role-checked (`dividend_target_invalid`, also for a missing or inactive target, with a `diagnostic` and the compliance notes): retained target in EQ and Omakapital, CIT expense Kulud 8900–8999, payables Kohustused, share capital by name or 2900, no account in two roles, posting targets active; an override never establishes its own role. One journal per shareholder+date: an identical retry returns `duplicate`, a different amount `dividend_key_conflict`.
- **Year-end close (RIK method, calendar year).** e-arveldaja has no native closing; RIK's guide "Äriühingu majandusaasta lõpetamiskanded e-arveldajas" prescribes two manual entries, which `prepare_year_end_close` / `execute_year_end_close` propose and book as drafts: (1) Dec 31 profit D 9000 "Arvestuslik koondtulemus" / K 2970 "Aruandeaasta kasum" (loss reversed), document `YEC-RESULT-YYYY`; (2) Jan 1 of the next year D 2970 / K 2960 (optional `reserve_capital_amount` to 2940), document `YEC-RETAINED-YYYY`. Revenue/expense accounts are NOT zeroed and 9000 is not part of the income statement: every P&L surface (`compute_profit_and_loss`, `run_accounting_report`, `generate_annual_report_data`, prepare's result) excludes it, while the balance sheet keeps it in open P&L so equity balances. Existing entries are detected structurally (date + accounts touched, any document number, drafts included); legacy `YECL-YYYY` journals (the old zero-all-P&L close, `src/year-end-closing-journal.ts`) that post to 2970 count as entry 1 — never book either twice. Entry 2 is 2970 against 2960 and/or reserve accounts only (an all-to-reserve D 2970 / K 2940 counts); it is also recognised on any date of the next year when its amount matches (operators often transfer on another day), and by its `YEC-RETAINED-YYYY` number on any date; a journal numbered `YEC-RETAINED-`/`YEC-RESULT-` of another year is never this year's, not even on this year's 31 Dec / next 1 Jan; an unnumbered transfer-shaped journal on 31 Dec of the close year is dropped as an earlier year's late transfer when it moves exactly the earlier years' 2970 residual (ambiguous if it also equals this year's result), otherwise it needs manual review. Both entries are checked for direction and amount; a mismatch is reported as `mismatch`/`partially_closed` in `blocked_entries` and blocks booking — `allow_additional_transfer` acknowledges only a smaller same-direction 1 January transfer (the remainder is booked); an off-date, ambiguous, over- or reversed transfer and a wrong entry 1 always need manual correction.
- **Dividend dry run**: `prepare_dividend_package` defaults to `dry_run=true` and returns a connection-scoped single-use `plan_handle`. After approval, execute with the same material inputs, `dry_run=false` and that handle. Inputs and the complete proposed journal are bound; a change refuses as `plan_drift` with "Nothing was written." Fresh-ledger capacity checks still run at execution; a refusal consumes the handle and needs a new preview.
- **Year-end preview approval**: `prepare_year_end_close` returns a connection-scoped single-use `plan_handle` binding year, reserve options, `allow_additional_transfer` and the proposed journals (including resolved subaccounts). `execute_year_end_close` requires that handle and `confirm=true`; a fresh analysis must match or return `plan_drift` before writing. A failed or partial execution needs a new preview, which detects existing drafts. Reserve targets must be active `Omakapital` accounts independently identified as reserves and distinct from 9000/2970/2960 roles.
- **Verified EUR reporting amounts**: `verifiedPostingEurAmount` uses posting currency or inherited journal currency and the existing `eurGross` resolver. A foreign posting without finite `base_amount` holds financial calculations and existing-close comparisons as `posting_eur_amount_unverified`; EUR or absent currency can use `amount`. API types make `base_amount` optional and do not guarantee valuation.
- **Historical purchase VAT**: a purchase dated before full registration's `effective_from` holds as `purchase_vat_historical_review_required`; present-day full status never automatically authorizes its deduction. After owner review, granular purchase create/confirm and totals-correction preview accept `pre_registration_vat_deduction_approved:false` for the existing non-deductible route or `true` only for a statutory exception. Correction preview and confirmation check the fresh invoice date and require the same reviewed decision. Automated document paths hold before applying input-VAT defaults; correct deductible rows before non-deductible confirmation.
- **Dividend statutory prerequisites** are echoed as `compliance_notes` on every path: ÄS § 157 lg 1 requires an APPROVED annual report + profit-distribution decision (attach the decision via `attach_document`), and the CIT is declared on TSD annex 7 by the 10th of the month after payout (TuMS § 54).
- **Capital gains (company)**: securities gains are ordinary income in the P&L (Lightyear sells: gain balancing to 8330/8335); there is no tax at realisation — Estonian CIT is deferred until profit is distributed (dividend / TuMS § 50)
- **Third-party payer / receipt client alignment**: e-arveldaja copies a registration journal's `clients_id` from the bank transaction (payer), not from the linked invoice, and postings carry no client — so a payer that differs from the invoice client books the receivable credit into the wrong client sub-ledger (verified live 2026-09). `TransactionsApi.confirm` refuses such a confirm (`linked_invoice_client_mismatch`) unless `reassignClientToInvoice` (tool param `reassign_client_to_invoice`, an explicit approval) is set; a distribution linking invoices of several clients is always refused (`linked_invoice_clients_ambiguous`, no reassignment can fix one journal/one client — split the payment); the registration journal is located by `operation_type = "TRANSACTION"` + `operations_id = tx id` (the register call returns no journal id) and checked after every invoice-linked confirm (`src/banking/receipt-ledger-check.ts`); exact-match reconciliation routes these to `third_party_payer_reviews`; `run_accounting_report` `receipt_client_alignment` audits existing books. Repair is invalidate → reassign → re-confirm; a one-journal reclassification between two clients is not expressible.
- **Input-VAT deduction restrictions** (`src/estonian-tax-rules.ts`): single date-gated source for the standard VAT-rate timeline (20→22%→24%), the dividend-CIT timeline (20/80→22/78), the 40 000 EUR VAT registration threshold, current reduced rates, and the deduction detectors. `suggest_booking` returns these as `tax_notes` — `KMS § 30` (külaliste vastuvõtt / esinduskulu: input VAT non-deductible; also `TuMS § 49 lg 4` representation limit 50 €/month + 2% of payroll) and `KMS § 30 lg 4` (M1 passenger car: 50% cap). Notes are advisory; `workflows/book-invoice.md` requires surfacing each on the approval card. `validate_invoice_data` also uses the rate timeline to warn when a line's standard rate (20/22/24%) does not match the invoice date. The full dataset is browsable read-only at `earveldaja://tax_rules` — including the `TuMS § 49` representation/donation limits, `TuMS § 48` fringe-benefit pointer, the profit-distribution rules (`ÄS § 157 lg 1–2`, `TuMS § 50`), and the RPS process rules (`§ 10` corrections, `§ 12` 7-year retention, `§ 15` inventory) — plus a `verified_at` stamp (`TAX_RULES_VERIFIED_AT`). `check_tax_free_limits` computes the cumulative `TuMS § 49` representation/donation limits and the 22/78 tax on any excess from caller-supplied year-to-date figures (it does not read the ledger). Update the figures in this module when the law changes — the Estonian-tax tool descriptions render their rates/thresholds from these constants, so they follow automatically (pinned by tests).

- **Limited taxpayer (piiratud maksukohustuslane, KMS § 21)**: `/vat_info` only has `vat_number`, so the company VAT status (`none | limited | full`) is decided in one place, `resolveCompanyVatStatus` / `isCompanyVatRegistered` (`src/company-vat-status.ts`), used by every VAT-treatment site (receipts, PDF/document booking, document reading, classification, owner expense, VAT threshold, purchase-invoice CRUD, annual report). The API has no limited/full field (live-verified 2026-11-04: `/vat_info` = `tax_refnumber` + `vat_number` only), and e-arveldaja shows a limited taxpayer's new KMKR in `vat_number` at once, so a number alone never means `full`. Resolution: (1) an owner-approved `limited_vat` `mode: "set_status"` record made for the current `vat_number` wins (plan handle binds the previous stored setting and the VAT number — a number change between preview and execute is `plan_drift`; `effective_from` ≤ today Europe/Tallinn; a record saved before numbers were bound is bound to the current number on first read); (2) otherwise a number is looked up in EMTA's public KMKR query (`src/emta-kmkr.ts`: `GET https://apps.emta.ee/saqu/public/kmkrnr?lang=et` for the CSRF token + cookie, `POST …/kmkrnr/query` with only `personCode=EE…`; 10 s deadline per request including the body, 512 KiB cap while streaming, structural tag-by-tag parse of the one `table.grid` (any quoting; unclosed rows/cells, text outside cells, a nested or second grid table → invalid) and the limited marker count must equal the limited rows (a marker elsewhere is invalid, never `full`); concurrent lookups of one number share one request; a 403/429 or timeout starts a process-wide 60 s cooldown for every number): the one active row of that number (empty deletion date) is `limited` when its code cell carries the `Piiratud käibemaksukohustuslane` span, else `full`, `effective_from` = registration date, source `emta_lookup`; cached per number in `limited-vat.json` (`emta_lookup:<EE…>`) and in-process (public data, survives connection switch), re-checked after 7 days (one `emta_lookup` record per number holds the latest evidence: `success` (registration) or `contradiction` (`not_found` / `deleted` / `ambiguous` / `contradictory_page` = a parser-refused page carrying any registration content: the limited marker, an EE number or a dd.mm.yyyy date — even one deleted row); unavailability is never stored; written with `upsertIf` only when the evidence supersedes the stored record (newer `looked_up_at`, or equal time and more cautious: contradiction > limited > full); after every outcome the store is re-read and the superseding evidence of stored and own decides; a contradiction whose persistence fails still yields to an applicable owner decision — a contradiction is `unknown`, an expired success with an unavailable re-check is `stale`; the in-process cache never reuses an entry older than the stored record; an in-process failure is retried after 60 s); the store is re-read after the lookup so an owner decision saved meanwhile wins (re-read failure → `unknown`); a legacy unbound decision whose binding cannot be persisted is `unknown`; `set_status` and month execute resolve with `freshVatInfo` (`/vat_info` past its 10-minute cache); (3) a failed lookup (network, timeout, HTTP, shape → `company_vat_status_lookup_unavailable`) or an inconclusive one (no row, deleted only, several active → `company_vat_status_lookup_ambiguous`) is `unknown` until EMTA answers or the owner confirms with `set_status`; (4) no number is `none`. The business register does not show limited/full and is not used. Single-file rules mode cannot store a decision or lookup (in-process cache only; `set_status` unavailable). The store is re-read at every decision (another process may have written); an unreadable or invalid store is status `unknown` (`company_vat_status_unknown`). Every VAT decision throws `CompanyVatStatusUnknownError` (message = reason code + fix, with an Estonian owner sentence) on `unknown` (never a derived `full`); read-only displays (`limited_vat` `status`, annual-report flag, point-of-use notes) do not throw. Unit tests: the vitest setup file fakes the EMTA query as an active full registration for any number. Only `full` is VAT-registered: `limited` gets no input-VAT deduction and no reverse-charge input leg (a supplier-history `reversed_vat_id` is dropped). `limited_vat` (standard/full, tax group) modes: `guide` (Estonian guidance, `src/limited-vat-guidance.ts`, also in `earveldaja://tax_rules`), `status` (status, source, `vat_number`, `decision_status` / `decision_vat_number`, `effective_from`, the `emta_lookup` row with `looked_up_at` and `stale`, `reason` / `lookup_error` when unknown; for `none`: read-only foreign-service candidates and monthly would-be VAT), `set_status`, `month` (dry run → approval → `execute: true` + `plan_handle`). `month` (`src/limited-vat.ts`) takes confirmed purchase invoices of foreign (non-EST) suppliers whose KMS § 11 date (earliest of invoice date and linked payment date) is in the month; payments on the earliest prepayment date that do not alone cover its gross (invoice currency, cents, tolerance 0) or whose amount or sign is unproved (negative on an invoice, mixed on a credit note) make it a `limited_vat_partial_prepayment` review in every early-payment month and the invoice month (no split), and the fingerprint binds payment dates and amounts; EX-suffix suppliers are always excluded, financial-service suppliers by default (owner can override); an unclassified supplier, a supplier with an Estonian VAT number (EE…) or Estonian invoice country (even when classified), and an invoice or credit note where the supplier charged VAT (absolute values; OSS, an open point — ask EMTA) are review items, never booked; candidates are all invoices dated from the month start on (no look-ahead cutoff; a later invoice beyond the 300-read budget is a `limited_vat_coverage_incomplete` review); foreign currency at the frozen ECB rate of the § 11 day (failure → review); VAT per line = EUR base × date-gated standard rate, half-up; journal `PKM-YYYY-MM` D cost account/dimension / K output-VAT account (name-resolved "Käibemaks müügil (täismäär)" = standard 2511, else "Käibemaksukohustis" / "Arvestatud käibemaks", else an explicit `liability_account`, never guessed; always an active `Kohustused` account distinct from every cost target; the KMD collection account — name "Käibemaksu võlg"/"km.kogumiskonto", standard 2510 — is refused `limited_vat_liability_account_is_collection`, because e-arveldaja books every filed KMD as "EMTA KMD alusel kanne" D 2511 / C 1510 / remainder 2510 (live-verified Seppo AI 2025–2026; RIK #15766149 confirmed D2511/K2510 for a limited taxpayer), so a 2510 credit would double the debt), created and confirmed through `BookingGuard`; re-runs are `already_booked` (journal registered, not deleted, dated on its approved month-end date and equal to its stored booking record; the same check on a create-time duplicate), changes `limited_vat_journal_conflict`; the plan fingerprint binds every included invoice's calculation, the supplier country/VAT number and the KMD projection, late invoices a `PKM-YYYY-MM-Pn` correction delta. Output carries KMD rows 1/4/6/7 with RIK's e-arveldaja KMD steps (delete the "sh pöördmaksustamisega seotud käive" row and row 5, fill row 12 by hand when asked) and the 20th-of-next-month deadline; the MCP never files the KMD. Point-of-use notes (never holds) on `receipt_batch`, `suggest_booking` / `process_accounting_document` (`tax_notes` code `KMS § 21 lg 1`) and `create_purchase_invoice_from_pdf` (`limited_vat_note`).

**Non-goals — do NOT reimplement in MCP (e-arveldaja does these natively; reimplementing risks double-booking):**
- **No KMD/VAT return (käibedeklaratsioon)** — e-arveldaja generates it from the confirmed ledger and files it to EMTA. The tax-rules layer is advisory only.
- **No EMTA prepayment-account tax-expense entries** — a bank transfer to EMTA is booked as a prepayment-account (ettemaksukonto, acct 1516) top-up; the draw-down tax entries come from e-arveldaja's EMTA prepayment-account statement.
- **`update_transaction` is deliberately metadata-scoped** — bank-reference/description fields only; never amounts, postings, or distributions. On a CAMT-marked row every writable field is covered by the signed marker and `bank_ref_number` is read-only (never sent), so an edit that changes one is refused (`camt_identity_would_break`, no PATCH).

## Changelog style

Write `CHANGELOG.md` entries for a casual user first. Each bullet opens with a
bold plain-language sentence saying what changes for them (no tool names, error
codes or parameter names there), optionally a "Before, …" sentence describing
the old problem, then "Details:" with the technical part (tools, parameters,
codes, limits) in the same bullet. Applies to new entries; released sections
are not rewritten.

## Development

```bash
npx tsc --noEmit      # Type-check without emitting
npx tsc               # Full build to dist/
npm run typecheck:tests   # typecheck tests + fixtures against the ratchet baseline
```

Test typing ratchet: `npm run typecheck:tests` also counts explicit `any` and untyped `parseMcpResponse` calls in
test sources (codes `ANY` / `UNTYPED_PAYLOAD`); they may only go down. Parse tool payloads with
`parseToolPayload<T>()` from `src/__fixtures__/mcp-response.ts`, where `T` is the payload type the producing
presenter exports. After removing loose typing, run `npm run typecheck:tests:update`.
A change that alters a tool's output shape also exports or updates that payload's type (in the producing
presenter/tool module) in the same commit, so producer types appear where output changes, not only where tests are added.

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
const { tools } = await client.listTools(); // 128 tools (standard profile)
```
