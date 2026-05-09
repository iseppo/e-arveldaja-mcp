# Changelog

## [Unreleased]

### Changed
- **Receipt inbox service split** — split receipt batch file discovery, booking execution, bank/duplicate matching, output sanitization, and summary assembly into focused modules while keeping the public MCP tool shape stable. (#28)
- **Accounting workflow test fixtures** — added shared typed MCP server/API fixture builders for workflow tests and migrated accounting inbox, CAMT import, and receipt wrapper setup code away from repeated inline mocks. (#30)
- **Workflow prompt source of truth** — MCP workflow prompts now append the canonical packaged `workflows/*.md` source, Claude command prompts are generated from those workflow files, and release validation fails if generated command prompt artifacts drift. (#31)
- **Workflow tool surface cleanup** — extracted reference-data registrations from `crud-tools.ts` into a focused module with registration snapshot coverage, and updated shipped workflow docs to prefer the merged `accounting_inbox` / `continue_accounting_workflow` / `receipt_batch` entry points while keeping older focused tools documented as compatibility primitives. (#39)
- **CAMT and receipt entry points** — added `process_camt053` and `receipt_batch` as mode-based wrappers over the existing parse/import/receipt tools. Existing focused CAMT and receipt tools stay registered for compatibility. (#36)
- **Bank workflow entry points** — added `reconcile_bank_transactions` and `classify_bank_transactions` as mode-based wrappers over the existing reconciliation, auto-confirm, inter-account transfer, and unmatched classification tools. Existing focused tool names stay registered for compatibility. (#38)

## [0.13.1] - 2026-05-03

### Fixed
- **Year-end close current-year profit account** — changed the default current-year profit/loss account from `3310` to the e-arveldaja standard `2970`, and added an `accounting-rules.md` override (`Current year profit account: ...`) for companies with custom charts of accounts. The year-end close proposal, validation, annual report equity mapping, warnings, and tests now use the resolved account consistently.
- **Opening balance API coverage warning** — added a visible warning to `compute_balance_sheet`, `compute_account_balance`, `compute_trial_balance`, `compute_profit_and_loss`, and `list_journals` that e-arveldaja's separate "Algbilansi kanded" section is not exposed by the documented `/journals` API data available to the MCP server. Documented the API gap and requested behavior in `spec_problems.md`.

## [0.13.0] - 2026-04-29

### Fixed
- **`process_receipt_batch` approval boundary for #19** — added explicit `execution_mode` phases: `dry_run`, `create`, and `create_and_confirm`. Legacy `execute=true` now maps to `execution_mode="create"` with a warning, so batch receipt processing creates/uploads PROJECT purchase invoices but leaves confirmation and bank matching behind a separate approval step. Receipt approval previews and prompts now recommend `execution_mode="create"` instead of the old one-shot create+confirm path.
- **Lightyear capital-gains export drift** — `parse_lightyear_capital_gains` now reads required columns by header name instead of fixed positions, so newer Lightyear FIFO exports that insert `Asset Class` before `Fees (EUR)` parse correctly while the legacy 10-column export remains supported.
- **Wise date filter validation** — `import_wise_transactions` now rejects malformed `date_from` / `date_to` values and reversed ranges before reading or creating transactions, preventing typoed filters from silently producing partial or surprising imports.

## [0.12.6] - 2026-04-28

### Fixed
- **Shipped workflow prompt drift** — synced the packaged `book-invoice`, `lightyear-booking`, and `reconcile-bank` workflow/Claude command docs with the current tool behavior and safety rails. The prompts now include the VAT-registration precheck, more precise reverse-charge guidance, required Lightyear distribution account inputs, external-file data handling, and the current inter-account transfer duplicate-cleanup contract.
- **Receipt inbox Windows path and stale transaction status handling** — folder validation now uses the shared path-root containment helper so Windows-style allowed child folders are accepted correctly. `apply_transaction_classifications` now reports `failed` instead of `applied` when invoice creation was attempted but stale transaction detection invalidated the draft and left no invoice or transaction link behind.

## [0.12.5] - 2026-04-27

### Fixed
- **Claude Code MCP transport still dropped on fast paginated tools after 0.12.3** — the 100 ms throttle introduced in 0.12.3 only suppressed the *second and later* `reportProgress` calls within an invocation. The first emit always passed (the throttle map's default is 0, so `Date.now() - 0` is far larger than 100 ms), so any tool whose first `await reportProgress(...)` fired right after a fast page-1 fetch still raced its own response. Production logs from 2026-04-26 captured three drops in one session (`list_transactions`, `detect_duplicate_purchase_invoice`, `reconcile_inter_account_transfers`) where the tool completed in 7–42 ms and the leading `progress: 0` notification arrived at the client *after* the response had cleared the progressToken — Claude Code closed the stdio transport and the server had to reconnect. The throttle baseline is now pre-seeded to invocation start via a new `runWithExtra` wrapper around `toolExtraStorage.run`, so tools that finish inside the 100 ms window emit zero progress notifications. Slow tools (>100 ms first-emit latency) still report progress as before. (#26)

## [0.12.4] - 2026-04-26

### Added
- **Optional stderr debug log file** — set `EARVELDAJA_LOG_FILE=/path/to/mcp.err.log` to tee everything the server writes to stderr (startup warnings, fatal errors, and the structured logger output once the MCP transport is up) into the given file in append mode (`0o600`). Off by default. Cross-platform (Linux, macOS, Windows). Useful when the MCP host swallows stderr. The path is required to be a regular file — pipes, devices, sockets, `/dev/stdout`, and `/proc/self/fd/*` are refused with a warning so the tee cannot corrupt the MCP stdio transport.

### Fixed
- **`process_receipt_batch` dry-run preview lied about what `execute=true` would do** — the contract gate (#19) for `low` confidence and `foreign_reverse_charge_default_unverified` only ran when `execute=true`. In dry-run mode, gated rows were still labelled `dry_run_preview` and surfaced in the approval card, even though running with `execute=true` would refuse them and route to review. The gate now mirrors in both modes, so dry-run output and approval previews truthfully reflect what execution would do. Existing summary fields and review wording adapt (`Auto-create would be skipped: ...` in dry-run vs `Auto-create skipped: ...` on execute).
- **`recommend_workflow` `receipt-batch` next-action was not directly runnable** — the suggested args for `process_receipt_batch` omitted the required `accounts_dimensions_id`, so the recommendation failed schema validation when invoked verbatim. Now includes the placeholder `<bank account dimension id used when matching bank transactions>`, matching the CAMT/Wise next-action shape.

### Changed
- **Reduced MCP response token cost** — two changes targeting the heaviest response paths:
  - `tool-response.ts` envelope no longer spreads `raw` fields at the root in addition to keeping the `raw:` payload. Previously every `toolResponse(...)` call duplicated the full API payload (~2× envelope size). Consumers now read API fields under `result.raw.*`; envelope meta (`ok`, `action`, `entity`, `id`, `found`, `message`, `warnings`, `next_actions`) and explicit `extra` fields stay at the root.
  - `list_clients`, `list_products`, `list_journals`, `list_transactions`, `list_sale_invoices`, `list_purchase_invoices` now default to a brief view (`view: "brief" | "full"`, default `brief`) that returns only triage fields (id + key business fields). Pass `view="full"` for the legacy full payload, or use the matching `get_*` tool for full detail of a specific row. Measured TOON-encoded reduction on synthetic 30-row payloads: clients ~93%, transactions ~85%, sale_invoices ~73%; brief output also re-enables TOON tabular form by stripping nested objects/arrays, compounding the saving. Internal tools (`accounting-inbox`, `bank-reconciliation`, `analyze-unconfirmed`, etc.) call the API layer directly and are unaffected.

## [0.12.3] - 2026-04-26

### Fixed
- **Long-running tools crashed the Claude Code MCP transport with "Received a progress notification for an unknown token"** — call sites in `camt-import`, `bank-reconciliation`, `receipt-inbox`, `wise-import`, `analyze-unconfirmed`, `lightyear-investments`, and `api/base-resource` invoked `reportProgress` once per item across loops of 50–69+ entries. Each emit was awaited but landed in the OS stdio buffer; on slow clients the response was matched and the progressToken handler cleared *before* the trailing notifications were drained, and Claude Code treats any "unknown token" progress notification as a fatal transport error (closes the stdio pipe; the user must reconnect via `/mcp`). `reportProgress` now (a) throttles to at most one notification per 100 ms within an invocation, (b) skips the trailing `progress >= total` emit since the response itself signals completion, and (c) honors a `EARVELDAJA_DISABLE_PROGRESS=1` env-var kill switch for environments still affected. Throttle state is per-invocation (WeakMap keyed by the SDK's tool extra), so concurrent tool calls and back-to-back invocations never share a window.

## [0.12.2] - 2026-04-26

### Fixed
- **Booking suggestion miscoding SaaS as Buildings** (closes #17) — `findAccountByKeywords` used `String.prototype.includes`, so the keyword `"it"` matched as a substring of `"Ehitised"` (Buildings, id=1810) and routed OpenAI/ChatGPT/Anthropic receipts into a fixed-asset acquisition account. The matcher is now a prefix-at-word-boundary regex (Unicode `\p{L}\p{N}` boundaries so Estonian suffixes like `muud`/`muude` still match `muu`), and any `is_fixed_asset` account is filtered out of keyword/fallback paths — even when reached via a misconfigured purchase-article's `accounts_id`. The keyword map is expanded for OpenAI / ChatGPT / Anthropic / Claude / Cursor and prefers `tarkvara` / `internet` / `sideteenus` keys before generic ones.
- **Reverse-charge VAT not auto-detected for foreign suppliers** (closes #18) — `BookingSuggestion` gains a `reverse_charge_reason` field. `applyReverseChargeAutoDetection` (a) preserves any `reversed_vat_id` already set by supplier history / local rules; (b) auto-applies reverse-charge when an explicit phrase matches in OCR text — Estonian `pöördmaksustamise alusel`, English `reverse charge`, German `Steuerschuldnerschaft des Leistungsempfängers`, French `autoliquidation`; (c) falls back to a foreign-supplier default when the active company is VAT-registered AND the resolved supplier country is not `EST`. Decisions are surfaced as human-readable notes plus `reverse_charge_reason` for downstream review.
- **process_receipt_batch contract gate** (closes #19) — added per-row in-batch duplicate detection (same supplier + invoice number across two files in the same scan) and a confidence-based contract gate: rows whose final `llm_fallback.confidence` is `low` are routed to `needs_review` even when `execute=true`, so silent miscoding is no longer possible through the auto-create+confirm path. `medium` and `high` rows behave as before.
- **`llm_fallback.recommended` was a presence check, not a plausibility check** (closes #20) — `summarizeInvoiceExtraction` now returns `confidence: "low" | "medium" | "high"` and `confidence_signals: string[]` alongside the legacy `recommended` flag. Confidence is downgraded to `low` on any of: missing required fields, currency-defaulted (#16), self-VAT-on-page (#14), in-batch duplicate invoice number (#19), or reverse-charge phrase present but the booking suggestion did not flag it (#18); to `medium` on supplier-resolution failure or improbable fixed-asset (#17), or when the booking source was not supplier history. `recommended` is now a derived alias (`recommended === confidence !== "high"`) so existing callers keep working.
- **Self-match guard misses own-company client without VAT** (closes #22) — `SupplierResolutionOptions.ownCompanyRegistryCode` accepts the active company's reg code as a second self-match signal alongside `ownCompanyVat`. `process_receipt_batch` derives the value heuristically: a client matching `/vat_info` by VAT, or — when the active company's record was created before VAT registration — a unique normalized-name match against `/invoice_info.invoice_company_name`. The previewed new client also strips a `supplier_reg_code` that equals our own, mirroring the VAT scrub from #14. `getInvoiceInfo` is consumed defensively so older test stubs that don't implement it still work.
- **Payment receipt result lacked machine-readable invoice cross-reference** (closes #23) — `ReceiptBatchFileResult.referenced_invoice` is now a typed field populated when `classification === "payment_receipt"`. It carries the receipt's referenced invoice number, a `matched: boolean`, and (when matched) `matched_invoice_id` resolved against existing live (non-DELETED/INVALIDATED) purchase invoices. Auto-attach via `upload_invoice_document` and similar follow-ups can consume the cross-reference programmatically instead of parsing it back out of the human note.
- **Self-VAT supplier resolution** (closes #14) — when an invoice prints only the buyer's VAT (e.g. Anthropic receipts that carry no supplier VAT), the deterministic extractor used to pick up the buyer's own EE-VAT and resolve the supplier to the active company itself. `extractVatNumber` now accepts an `exclude` option, `extractPdfIdentifiers` / `extractReceiptFieldsFromText` accept `ownCompanyVat`, and `resolveSupplierInternal` refuses any registry-code / VAT / fuzzy-name match that resolves to a client whose VAT equals the active company's. The previewed new-client never carries the buyer's own VAT. `process_receipt_batch` now reads `/vat_info` once, threads ownCompanyVat through extraction and resolution, surfaces `self_match_blocked` in the response, and adds explanatory notes when the only VAT on the page was ours.
- **Currency silently defaulting to EUR for USD invoices** (closes #16) — Estonian-language OpenAI invoices print amounts as `40,00 $`. `RECEIPT_CURRENCY_PATTERNS` now matches `$` adjacent to digits as USD and `£` as GBP, in addition to the bare currency codes. `detectReceiptCurrency` returns `string | undefined` rather than silently falling back to "EUR" when no currency token can be bound to an amount line. `summarizeInvoiceExtraction` treats currency as a required field when `total_gross` is set, so missing-currency cases trigger the LLM-fallback recommendation.
- **Payment receipts double-booking as separate invoices** (closes #15) — Anthropic / Stripe-style payment confirmations (filename `Receipt-*.pdf`, "Receipt" header line, body containing "Date paid" / "Amount paid" / "Payment history" with a referenced invoice number) used to be classified as `purchase_invoice`. `process_receipt_batch` then queued them alongside the underlying invoice and would have created a duplicate on execute. `ReceiptClassification` gains a `payment_receipt` variant; the classifier requires both indicator phrases AND an invoice-number reference AND a structural signal (header or filename) before flagging the new class; `process_receipt_batch` routes payment receipts to `needs_review` with a note pointing at the underlying invoice number.
- **Supplier resolution misses corporate-form variants** — `LEGAL_SUFFIXES` in `company-name.ts` now strips `Corp`, `Corporation`, `Co`, `LP`, `LLP`, `PLC`, `PBC`, `PLLC`, `AG`, `SAS`, `SARL`, `SRL`, `SPA`, `NV`, and `BV` in addition to the existing Estonian / Baltic / German set. Dotted single-letter abbreviations (`N.V.`, `B.V.`, `S.A.`, `S.A.S.`, `S.r.l.`) are pre-collapsed to their bare-letter forms before suffix matching, so they reduce too. `resolveSupplierInternal` gains a `name_normalized` match tier that runs before the fuzzy fallback (with a ≥4-char floor and an ambiguity bail-out when multiple clients share the same normalized key): an invoice supplier "Anthropic, PBC" now resolves to an existing "Anthropic" client (the fuzzy 0.7 threshold rejected the pair at ≈0.6), so `suggestBookingInternal` reuses prior bookings instead of falling through to the keyword fallback. Note: the broader normalization is also used by `camt-import`, `bank-reconciliation`, `analyze-unconfirmed`, `wise-import`, and the `accounting-rules` auto-booking-rule lookup. User-defined rule keys keyed on the previous (narrower) normalized form may now match a wider set of counterparties; review your `accounting-rules.md` if you have rules that relied on the old behaviour.

## [0.12.1] - 2026-04-25

### Changed
- **README release callout** — updated the top-level README version note to describe the v0.12 guided workflow action UX, including `recommend_workflow`, `workflow_action_v1`, `recommended_next_action`, and approval previews.

## [0.12.0] - 2026-04-25

### Added
- **Workflow recommendation tool** — `recommend_workflow` suggests the safest e-arveldaja workflow for a natural-language accounting goal, or lists common workflows when the goal is not yet known.
- **Guided workflow continuation** — `continue_accounting_workflow` reads a previous accounting inbox or workflow response and returns the next user-facing action: one question, one review item, one approval card, or one safe dry-run call.
- **Standard workflow action envelope** — workflow recommendation, accounting inbox, CAMT import, Wise import, receipt batch, and classification batch responses now include a `workflow_action_v1` block with `done`, `needs_decision`, `needs_review`, `recommended_next_action`, `available_actions`, and `approval_previews`.

## [0.11.8] - 2026-04-24

### Added
- **User-facing workflows and Claude command docs** — package the setup, company overview, and Lightyear booking guides under both `workflows/` and `.claude/commands/` so MCP users can discover the intended flows from installed package files.

### Fixed
- **Product sale dimension creation** (closes #12) — `create_product` now exposes `cl_sale_accounts_dimensions_id` in the MCP input schema, forwards it to the products API, and documents that `list_account_dimensions` can be used to find valid dimension IDs.
- **MCP JSON and file-input hardening** — tightened JSON response handling, file validation coverage, and process-invoice syntax checks so malformed inputs fail predictably without losing useful diagnostics.

## [0.11.7] - 2026-04-22

### Fixed
- **Base64 oversize guard off-by-padding** — the pre-decode size check introduced in 0.11.6 over-counted decoded length by up to 2 bytes when the decoded byte count wasn't divisible by 3, because it ignored the trailing `=` padding characters. A remote client sending a valid payload of exactly `maxSize` got rejected before the post-decode check could approve it. The estimate now accounts for padding (`floor(length / 4) * 3 - padCount`) and is exact for well-formed base64. Caught by an independent Codex review pass; a regression test at the 50 MiB − 1 boundary locks the fix in.

## [0.11.6] - 2026-04-22

### Added
- **Base64 payload defence-in-depth** — `decodeBase64Strict` now rejects obviously-oversized inputs (~75% of the encoded length) before allocating the decoded buffer, so a multi-hundred-MB base64 payload can no longer force a full-size `Buffer.from` allocation before the post-decode size check would have caught it.
- **UTF-8 BOM tolerance for XML magic-byte sniff** — CAMT files that start with `0xEF 0xBB 0xBF<?xml` (some bank exports do) are now detected as `.xml` instead of requiring an explicit `base64:xml:<data>` hint.
- **`.jpg` / `.jpeg` variant matching** — the JPEG magic signature is marked as equivalent to both extensions. A caller who lists only `.jpeg` (or only `.jpg`) in its allow-list accepts base64 JPEG payloads either way, and the tmp file suffix matches the caller's vocabulary. Explicit `base64:jpeg:<data>` and `base64:jpg:<data>` hints are canonicalised before the spoof-conflict check.
- **Tests covering the new edges** — oversize pre-decode guard, UTF-8 BOM XML, `.jpeg`-only allow-list, `.jpg`/`.jpeg` hint-vs-magic canonicalisation, and idempotent cleanup.

### Changed
- **`server.json`** description tightened to 85 characters (was 81) to fit the registry's 100-character limit with more room for useful context: "Estonian e-arveldaja (RIK e-Financials) accounting — invoices, bank import, reports."
- **README** now has a short "Releasing to the MCP Registry" section pointing maintainers at the official `mcp-publisher` GitHub release (the snap package shipped by `habedi` ships an old CLI that rejects the current schema as "deprecated").

## [0.11.5] - 2026-04-22

### Added
- **MCP Registry publication metadata** (towards #8) — `package.json` now exposes an `mcpName` property (`io.github.iseppo/e-arveldaja-mcp`) and a new top-level `server.json` describes the server for the Model Context Protocol Registry (repository, transport, environment variables). Once this version is published to npm and `mcp-publisher publish` is run against the project, the server becomes discoverable in the registry so clients like Claude Cowork (which only loads registry-listed servers) can connect without the `claude mcp add` CLI step. Registry submission itself still requires a maintainer to run `mcp-publisher login github` + `mcp-publisher publish`.

## [0.11.4] - 2026-04-22

### Added
- **Cross-system file transfer via base64** (closes #9) — every file-reading tool now accepts an inline base64 payload as its `file_path` parameter in addition to a regular local path. Remote MCP clients (Claude desktop, Cowork, Cursor on another host, etc.) that cannot expose their local filesystem to the server can now pass the file contents directly, unblocking `extract_pdf_invoice`, `create_purchase_invoice_from_pdf`, `upload_invoice_document`, `import_camt053`, `parse_camt053`, `import_wise_transactions`, `parse_lightyear_statement`, `parse_lightyear_capital_gains`, `book_lightyear_trades`, `book_lightyear_distributions`, and `lightyear_portfolio_summary`. Syntax:
  - `base64:<b64data>` — magic-byte detection for PDF / PNG / JPEG / CAMT XML
  - `base64:<ext>:<b64data>` — explicit extension hint (required for CSV and any format without a reliable magic-byte signature). Example: `base64:csv:QSxCLEMK...`.
- **`resolveFileInput` helper in `file-validation.ts`** — single entry point that validates either a local path (delegating to `validateFilePath`) or decodes a base64 payload, materialises it to a per-call tmp file (mode `0600`), and returns `{ path, cleanup }`. Size limit is enforced before writing to disk and hint/magic-byte conflicts are rejected to block extension spoofing. Callers run the existing logic against `path` and invoke `cleanup()` in a `finally` block so the tmp file is removed after use.
- **Tests** — 8 new cases in `src/file-validation.test.ts` cover path pass-through, magic-byte detection for PDF, explicit-extension CSV, missing extension rejection, disallowed extension rejection, oversize rejection, malformed base64 rejection, and hint/content mismatch rejection.

### Added
- **OCR trust boundary on tool output** — new `wrapUntrustedOcr` helper applies per-call nonce delimiters (`<<UNTRUSTED_OCR_START:{nonce}>>` / `<<UNTRUSTED_OCR_END:{nonce}>>`) to `raw_text` returned by `extract_pdf_invoice` and `process_receipt_batch`, plus `description` in receipt-batch results. Prevents a malicious scanned receipt from smuggling instructions into the downstream LLM via a fixed, guessable delimiter.
- **`vat_explicit` flag on extracted receipt fields** — `extractAmounts` now reports whether `total_vat` came from an explicit OCR VAT / net label or a structural fallback, so downstream auto-booking can tell "real zero" apart from "derived zero".
- **Regression tests** — `extractAmounts("Kokku 100 EUR KM 20%")` no longer collapses the gross total to `total_vat`; `resolveSupplierFromTransaction` returns `found: false` without creating a placeholder supplier when the transaction has no counterparty signal; `wrapUntrustedOcr` delimiter spoofing cannot escape the sandbox.

### Fixed
- **Lightyear FX drift on non-EUR cash-equivalent sells** — `book_lightyear_trades` used to book USD-denominated cash-sweep sells (e.g. `ICSUSSDP`) at 1:1 EUR proceeds against cost basis, leaving permanent FX drift on the investment account. Non-EUR cash-equivalent sells without capital gains data are now skipped with a clear reason; EUR sweeps (e.g. `BRICEKSP`) still book 1:1 as before.
- **VAT mis-extraction from embedded percent rates** — a line like `"Kokku 100 EUR KM 20%"` previously assigned the gross total (100) as VAT because the percent-rate filter left only the gross as the last VAT candidate. The pickedVat path now drops that fallback so `total_vat` stays undefined for the later gross − net reconciliation.
- **Silent VAT stripping on derived zero** — auto-booking used to set `vat_rate_dropdown = "-"` whenever `total_vat === 0`, including structurally derived zeros. It now requires `vat_explicit` so only OCR-stated zero invoices strip VAT.
- **Bogus `"Transaction <id>"` suppliers** — `resolveSupplierFromTransaction` now early-returns when both `bank_account_name` and `description` are null, instead of creating a placeholder client name.
- **Lightyear legacy duplicate detection** — journals with raw `OR-`/`CN-`/`DT-`/etc. document numbers (pre `LY:` prefix) are now recognised as duplicates alongside the current `LY:{ref}` format.
- **Lightyear FX fee fallback** — when the EUR side of a conversion reports zero fee, the FX fee is now derived from the foreign side using the available rate instead of silently rounding to 0.
- **Dead inter-trade fields removed** — `TradeExtractionResult` no longer returns `tradeRowIndexes` / `consumedConversionRowIndexes`; the caller uses `trade.conversion_row_indexes` directly, collapsing an O(trades × rows) lookup to O(trades).

### Changed
- **`book-invoice` workflow prompt** — `get_vat_info` is now the first step so VAT treatment decisions reflect the current VAT-registration status. Subsequent steps renumbered and the VAT-treatment step references step 1.
- **Inline-confirmation rail coverage** — `receipt-batch`, `import-camt`, `import-wise`, and `classify-unmatched` prompts now append `INLINE_CONFIRMATION_RAIL`, and the rail itself is split into explicit PROJECT/unregistered-journal inline handling vs `needs_review` (accountant judgment) handling via `resolve_accounting_review_item` / `prepare_accounting_review_action`.
- **`reconcile-bank` prompt** — `min_confidence` tiers (0 include-all, 30 noise floor, 80 high-confidence) documented at both call sites instead of left as magic numbers.
- **`new-supplier` prompt** — former steps 3 and 5 merged so `resolve_supplier` is not called twice; downstream steps renumbered.
- **`lightyear-booking` prompt** — first parse step no longer sets `include_rows: true`; the summary view is enough for the overview and row-level inspection is only done on demand.
- **`skip_tickers` semantics in `book_lightyear_trades`** — empty string is now treated as the default skip list; the literal value `"none"` disables the filter. `describe` text updated accordingly.

## [0.11.2] - 2026-04-14

### Fixed
- **Prompt and workflow alignment** — synced prompt surfaces, shipped workflow markdown, and command docs with the current tool behavior for CAMT duplicate handling, setup credentials, month-end input requirements, reconcile-bank wording, and purchase-invoice VAT dimension fields.
- **Account validation coverage** — account preflight checks now validate account existence and active status alongside dimension requirements across journal creation, transaction confirmation, sale invoice creation, purchase invoice creation, and purchase-invoice-from-PDF flows.
- **Transaction confirm safety** — `confirm_transaction` now completes distribution parsing and account validation before applying a temporary `clients_id`, preventing partial mutation on pre-confirm validation failures.
- **Transaction metadata update scope** — `update_transaction` is now restricted to safe CAMT-enrichment metadata fields (`bank_ref_number`, counterparty name/account details, description, reference) instead of accepting arbitrary transaction patches.

## [0.11.1] - 2026-04-14

### Fixed
- **CAMT duplicate cleanup partial failure** — if the delete step throws after the keep-transaction was already patched, the response now returns `partial: true` with an error message and a `DELETE_FAILED` audit entry so the trail is complete and the gap is actionable.
- **Autopilot re-recommends failed steps** — `next_recommended_action` no longer suggests a step that already ran and failed; the exclusion set now covers all executed steps regardless of status.
- **Autopilot re-recommends skipped steps** — `next_recommended_action` now also treats skipped steps as handled, so `classify_unmatched_transactions` is no longer re-suggested while materialization is still pending.
- **Patch field structured values** — `extractTransactionPatchFields` now keeps numeric and bigint values (coerced to strings) but drops objects/arrays instead of turning them into `"[object Object]"` junk.
- **Rule prefill from heuristic suggestions** — `save_auto_booking_rule` is no longer pre-filled from generic keyword-match suggestions; only `supplier_history` and `local_rules` sources (where the booking target was already trusted) seed the rule fields. Heuristic suggestions still surface `save_auto_booking_rule` in the suggested tools list without a prefilled `proposed_action`.
- **Rule booking field whitelist clarity** — `extractSuggestedRuleFields` renamed to `extractRuleBookingFields`; comment documents why `match`/`category` are intentionally absent from the whitelist. Type guards added for all fields (number vs string) so malformed values are dropped cleanly.
- **Uncapped existing-IDs label** — CAMT duplicate follow-up summary now shows at most 5 existing transaction IDs, appending `, +N more` when over 5.
- **Ambiguous materialization skip reason** — `classify_unmatched_transactions` skip summary now distinguishes `pending_materialization` (import ran and has work to apply) from `earlier_step_failed` (import was skipped or threw), giving a more actionable message in each case.
- **VAT hint missing in review-only suggestion** — when a metadata-only auto-booking rule exists (has `vat_rate_dropdown`/`reversed_vat_id` but no article/account), those fields are now threaded through to the keyword-match suggestion so reviewers see the reverse-charge hint even in review-only mode.

## [0.11.0] - 2026-04-07

### Added
- **Accounting inbox autopilot** — new `run_accounting_inbox_dry_runs` tool scans a workspace, automatically executes safe dry-run steps (CAMT parse, Wise preview, receipt scan), and returns one consolidated preview. Designed as a non-accountant-friendly first pass that requires no manual tool sequencing.
- **Accounting review resolver** — new `resolve_accounting_review_item` tool turns review items (CAMT duplicates, classification groups, unmatched transactions) into concrete next-step plans with default handling, unresolved questions, compliance basis (RPS/RTJ references), and the safest follow-up tool.
- **Accounting review action preparation** — new `prepare_accounting_review_action` tool converts resolved review items into ready-to-approve tool calls (e.g. delete duplicate, save booking rule, confirm transaction).
- **CAMT duplicate cleanup** — new `cleanup_camt_possible_duplicate` tool enriches missing CAMT metadata onto the kept older transaction and deletes the newly imported duplicate.
- **Auto-booking rules** — new `save_auto_booking_rule` tool saves stable counterparty booking defaults to `accounting-rules.md` after approval, so repeat transactions from the same supplier are booked consistently.
- **Review workflow prompts** — new `resolve-accounting-review` and `prepare-accounting-review-action` prompts guide multi-step review resolution with standards-aware compliance references.

### Fixed
- **Accounting rule merge** — fixed edge cases where rule overrides from `accounting-rules.md` could clobber confirmed supplier history or produce incomplete booking defaults.
- **CAMT duplicate handling** — when multiple confirmed transactions match a CAMT row, the resolver now asks which is authoritative instead of silently picking the first match.
- **list_accounts token overflow** — response now returns only essential fields (id, balance_type, name_est, account_type_est, etc.), roughly halving the response size so it stays within Claude Code's context limit.
- **Accounting inbox defaults** — improved default bank account dimension selection and receipt matching suggestions.
- **Wise prompt guidance** — tightened CAMT duplicate and Wise import prompt wording to reduce false-positive duplicate warnings.
- **Prompt field name drift** — `setup-credentials` prompt referenced camelCase fields (`envFile`, `storageScope`) but `import_apikey_credentials` returns snake_case (`env_file`, `storage_scope`). All field names now match the tool response.
- **Month-end missing documents** — prompt now mentions transactions alongside purchase invoices and journal entries, matching what `find_missing_documents` actually returns.
- **Credential precedence in CLAUDE.md** — corrected to match actual `config.ts` load order: `EARVELDAJA_API_KEY_FILE` first, then env vars, `.env` files, `apikey*.txt` last.

### Changed
- **109 tools** (was 103), **15 workflow prompts** (was 12), **12 resources**.
- **Accounting inbox** now supports an autopilot mode that chains dry-run steps automatically, review items that need accountant decisions, and one-click resolution of common patterns (duplicate cleanup, rule saving).

## [0.10.3] - 2026-04-01

### Fixed
- **Markdown accounting rules reload** — `accounting-rules.md` is now reloaded when the file changes, so corrected or updated company rules take effect without restarting the server.
- **Owner expense VAT defaults** — markdown rules can now define partial VAT-deduction defaults with a ratio, and stable company policy can be reused without re-answering the same question every time.
- **Receipt inbox VAT preservation** — supplier-history VAT metadata is now preserved when OCR misses an invoice VAT total, avoiding accidental loss of reverse-charge or prior confirmed VAT treatment.
- **User guidance cleanup** — accounting override messages now consistently point to `accounting-rules.md`, and documented examples in the template are no longer misread as active rules.

## [0.10.2] - 2026-03-30

### Security
- **XXE defense-in-depth** — CAMT XML parser now rejects files containing `<!DOCTYPE` or `<!ENTITY` declarations before parsing, preventing potential XXE attacks even if `processEntities` is bypassed in a future parser update.
- **Audit log path traversal prevention** — `sanitizeAuditLogName` now strips `..` sequences from company-name-derived filenames, preventing writes outside the `logs/` directory.
- **npm audit clean** — fixed transitive ReDoS vulnerabilities in `path-to-regexp` and `picomatch`.
- **Audit log file permissions** — `clearAuditLog` now writes with mode `0o600` via the shared `writePrivateTextFile` helper.

### Added
- **Shared company name normalizer** (`src/company-name.ts`) — unified three divergent implementations (bank-reconciliation, wise-import, receipt-extraction) into a single function with comprehensive international legal suffix list (`ou`, `as`, `mtu`, `llc`, `ltd`, `gmbh`, `oy`, etc.) and NFKD normalization. Optional `stripNonAlphanumeric` mode for grouping/deduplication.
- **Centralized account defaults** (`src/accounting-defaults.ts`) — named constants for standard Estonian chart-of-accounts numbers (`DEFAULT_LIABILITY_ACCOUNT`, `DEFAULT_VAT_ACCOUNT`, `CURRENT_YEAR_PROFIT_ACCOUNT`, etc.), replacing magic numbers across 6+ files.
- **Shared test fixtures** (`src/__fixtures__/accounting.ts`) — `makeAccount`, `makePosting`, `makeJournal`, `makeTransaction`, `makeBankAccount` factory functions, eliminating duplicate fixture builders across test files.
- **158 new unit tests** — `inter-account-utils.test.ts` (26 tests), `receipt-extraction.test.ts` (80 tests), `transaction-status.test.ts` (8 tests), `invoice-extraction-fallback.test.ts` (41 tests), plus additional security tests for XXE and path traversal.

### Fixed
- **Unsafe type cast in `buildInterAccountJournalIndex`** — replaced `as number` cast with null guard to prevent potential `NaN` keys in the journal index map.
- **Unsafe `(err as any).invoiceId`** — replaced with typed `InvoiceCreationError` class in `purchase-invoices.api.ts`.
- **Runtime type validation on JSON parse helpers** — `requireNumericFields` now validates that `amount`, `accounts_id`, `total_net_price`, and other critical numeric fields are actual numbers (not strings), catching malformed LLM-generated JSON at the trust boundary.
- **CSV size limit mismatch** — `parseCSV` now accepts a caller-specified `maxSize` parameter. Wise import passes 10MB to match its file-read limit, preventing confusing errors on large CSV files.
- **Unnecessary re-export removed** — `analyze-unconfirmed.ts` now imports `normalizeCompanyName` directly from `company-name.ts` instead of through `bank-reconciliation.ts`.

### Changed
- **664 unit tests** across 44 test files (was 442 across 38).

## [0.10.1] - 2026-03-30

### Fixed
- **Purchase invoice VAT rounding** — `createAndSetTotals` now auto-adjusts `project_no_vat_gross_price` on the last item when explicit `vat_price` differs from API-computed item VAT by a rounding cent (e.g. 9% on 9.16 → 0.82 vs invoice's 0.83). Previously this caused "Invoice rows net sum and VAT does not match invoice gross sum" and required manually splitting items.
- **Purchase invoice PATCH preserves `cl_fringe_benefits_id`** — `createAndSetTotals` now sends original items (with all required fields) back in the PATCH instead of API-returned items that lacked `cl_fringe_benefits_id`, preventing NOT NULL constraint errors.
- **String-typed numbers in JSON coerced** — `requireNumericFields` now auto-coerces valid numeric strings to numbers before validation (e.g. `related_id: "102011324307"` → `102011324307`), matching the `z.coerce` behavior on top-level ID parameters. LLMs often quote numbers in JSON string arguments.

### Added
- **`clients_id` parameter on `confirm_transaction`** — CAMT-imported transactions often lack `clients_id`, causing "buyer or supplier is missing" when confirming against accounts (not invoices). The new optional parameter sets the client on the transaction before confirming, avoiding the workaround of recreating the transaction manually.

## [0.10.0] - 2026-03-29

**Major update.** Large parts of the codebase have been rewritten — credential management, bank reconciliation, audit logging, and batch workflows all received significant changes. **You may need to re-add your API credentials** after updating, as the credential storage system has been redesigned.

### Breaking Changes
- **Credential storage redesigned** — credentials are now stored in `.env` files (local or global config directory) instead of being read directly from `apikey*.txt` at startup. Existing `apikey*.txt` files are detected and can be imported via the new `import_apikey_credentials` tool or the `setup-credentials` workflow prompt. After import, the `.env` file becomes the canonical credential store.
- **Parent directory scanning removed** — the server no longer searches parent directories for `apikey*.txt` files. Only the working directory is scanned.
- **Global config directory** — credentials can now be stored in a platform-native global config directory (`~/.config/e-arveldaja-mcp` on Linux, `~/Library/Application Support/e-arveldaja-mcp` on macOS, `%APPDATA%/e-arveldaja-mcp` on Windows). Override with `EARVELDAJA_CONFIG_DIR`. This lets the server find credentials regardless of which directory you launch it from.

### Added
- **Credential import workflow** — new `import_apikey_credentials` tool verifies API credentials against the live server and saves them to a `.env` file (local or global). Startup auto-detects `apikey*.txt` files and offers to import them via the `setup-credentials` prompt.
- **Stored credential management** — `list_stored_credentials` shows all saved `.env` credential sets. `remove_stored_credentials` removes a stored credential by index.
- **Setup credentials prompt** — new `setup-credentials` workflow prompt guides through credential verification and storage.
- **`.env` value quoting** — `serializeEnvFile` now quotes values containing special characters (`#`, `$`, `\`, `` ` ``, `"`, newlines) and escapes them properly, preventing credential corruption on re-read.
- **Invoice index for O(1) matching** — `reconcile_transactions` and `auto_confirm_exact_matches` now build index maps by ref_number and amount for fast candidate narrowing instead of O(n*m) full scans.
- **Multi-currency matching fallback** — `matchScore` computes `base_gross_price` from `gross_price * currency_rate` when the base price field is absent, fixing false-negative matches on foreign-currency purchase invoices.
- **ClientsApi aggregate cache** — `findByName` and `findByCode` now use a 120s TTL cached `listAll()`, avoiding redundant pagination on repeated lookups.
- **`EARVELDAJA_TAG_NOTES` option** — set to `true` to append `(e-arveldaja-mcp)` to the notes field of all invoices created by the server.
- **Standardized batch execution contracts** — all batch tools now use a consistent `DRY_RUN`/`EXECUTED` mode pattern with typed result/skipped/error arrays and audit references.

### Fixed
- **Credential source precedence** — `EARVELDAJA_API_KEY_FILE` now takes priority over env vars and `.env` files. Incomplete credential sets in one `.env` no longer block a complete set in another. Standalone `EARVELDAJA_SERVER` in a local `.env` no longer overrides the server setting from a complete credential file.
- **FX transfer reconciliation** — fixed multiple edge cases in foreign currency inter-account transfers, CAMT split imports, and Wise import FX handling.
- **Inter-account transfer pairing** — refined target inference, dedupe rules, and blocking logic for CAMT-imported inter-account transfers. Unified invoice direction rules across all bank matching tools.
- **Annual report liability classification** — tightened account classification for balance sheet reporting.
- **Supplier fuzzy match hardened** — raised Levenshtein similarity threshold from 0.5 to 0.7 and added minimum name length of 4 characters to prevent false-positive matches on short company names.
- **Journal ID null guard** — `buildInterAccountJournalIndex` now checks `j.id == null` before use instead of relying on a non-null assertion.
- **Connection-scoped VAT warnings** — fallback warning dedup keys are now scoped per connection, preventing one connection's warnings from suppressing another's.
- **Runtime input validation** — all optional numeric fields in `parsePostings`, `parseSaleInvoiceItems`, and `parsePurchaseInvoiceItems` are now type-checked at the trust boundary, catching string-as-number bugs from LLM-generated JSON.
- **Cross-platform invoice file handling** — fixed file path handling for invoice documents across different platforms.
- **Audit log label resolution** — company-based labels, refreshed on raw log lookup, with proper permission hardening.
- **MCP error handling** — fixed prompt workflow drift and error propagation in edge cases.

### Changed
- **96 tools** (was 93), **11 workflow prompts** (was 10), **15 resources** (was 12).
- **Audit log labels** — now company-specific with bilingual label resolution and improved metadata.
- **Claude command prompts** — normalized to match workflow definitions.
- **663 unit tests** covering all changes.

## [0.9.12] - 2026-03-25

### Fixed
- **Security: `isSecureEnvFile` fail-closed** — catch block now only returns `true` for ENOENT (file not found). Previously any `lstatSync` error was silently treated as safe.
- **Security: stack traces gated behind debug mode** — fatal error handler no longer writes `err.stack` to stderr unless `EARVELDAJA_DEBUG=true`.
- **Security: audit log permissions** — log directory created with mode `0700`, files with mode `0600` to prevent other users reading financial data.
- **Rounding consistency** — trial balance totals, `sumCategory`, client debt totals, aging analysis bucket/debtor/creditor accumulators, and overdue receivables/payables totals now use `roundMoney()` at each accumulation step, matching the pattern already used in `computeAllBalances`.
- **Inter-account duplicate detection** — replaced `Math.round(x*100)/100` with `roundMoney()` in journal key generation (`inter-account-utils.ts`, `bank-reconciliation.ts`), fixing potential false negatives at X.XX5 boundaries.
- **Dividend `grossDividend`** — now rounded before use in journal posting amounts.
- **Rate limiter race condition** — `waitForRateLimitTurn()` uses `.then(onFulfilled, onRejected)` so concurrent callers chain correctly instead of potentially bypassing the 100ms spacing.
- **Wise CSV import** — malformed numeric values now throw instead of silently defaulting to 0. Exchange rate no longer silently defaults to 1 on parse failure. Required header validation expanded from 4 to 6 columns.
- **CSV BOM stripping** — `parseCSV()` now strips UTF-8 BOM (`\uFEFF`), fixing header matching issues with Windows/Excel exports.
- **VAT rate comma replacement** — `normalizeVatRate()` uses regex `/,/g` for global replacement instead of string `.replace()` which only replaced the first comma.
- **`toMcpJson` error handling** — circular reference serialization now throws a descriptive error instead of an opaque `TypeError`.
- **Readonly pagination** — `readonlyCachedGetAll` now updates `totalPages` from each subsequent response, matching `BaseResource.listAll()` behavior.

### Added
- **Account dimension validation** — `create_purchase_invoice` and `create_purchase_invoice_from_pdf` now validate that items targeting accounts with dimensions include `purchase_accounts_dimensions_id`. When the account has exactly one dimension, it is auto-filled. When there are multiple, the error lists all available dimension IDs.

- **ID parameter coercion** — all 22 ID parameters across all tools now use `z.coerce.number().int().positive()`, automatically converting string-typed numbers (e.g. `"5060945"` → `5060945`) while still rejecting invalid values. Prevents LLM tool-calling failures when IDs are passed as strings.

### Changed
- **Aging report field rename** — `total_unpaid` renamed to `total_unpaid_face_value` to clarify that partially-paid invoices are shown at full invoice amount. Warning message updated.
- **Owner expense `vat_rate` validation** — values > 1 are rejected with a clear error ("looks like a percentage, pass a decimal fraction instead").
- **Purchase invoice tool descriptions** — `create_purchase_invoice` and `create_purchase_invoice_from_pdf` now document `purchase_accounts_dimensions_id` (required for accounts with sub-accounts). `suggest_purchase_booking` output includes the dimension ID from historical invoices.
- **Book-invoice prompt/workflow/command** — all three now reference `purchase_accounts_dimensions_id` in the booking suggestion and invoice creation steps.
- **CLAUDE.md** — documented the account dimensions requirement under "Purchase invoice creation".

## [0.9.11] - 2026-03-24

### Fixed
- **Prompt field name mismatches** — import-camt prompt and workflow now reference correct field names (`skipped_count`, `error_count`, `sample`, `skipped_summary`). Import-wise prompt now correctly describes `created`/`skipped` as counts and `results`/`skipped_details` as the arrays.
- **Reconcile-bank workflow** — added missing inter-account transfers step with `reconcile_inter_account_transfers` dry-run/execute flow and duplicate journal warning.

## [0.9.10] - 2026-03-24

### Added
- **TOON format** — all MCP tool and resource responses now use Token-Oriented Object Notation (TOON) instead of JSON. TOON achieves 30-60% fewer tokens with indentation-based structure, CSV-style tabular arrays, and minimal quoting. Lossless — fully roundtrippable to JSON.
- **`@toon-format/toon` dependency** for encoding/decoding.

### Changed
- **Null field stripping** — `toMcpJson()` removes all null/undefined fields before encoding, reducing response noise across all 85+ tool call sites.
- **Default value omission** — `duplicate: false`, `duplicate_transaction_ids: []`, `partially_paid_warning: false`, `distribution_ready` removed from responses when at default values.
- **CAMT import results compacted** — returns summary + sample (first 10) instead of full arrays. Skipped duplicates grouped into `skipped_summary`.
- **Wise import results compacted** — skipped entries grouped by reason with count and sample IDs. Descriptions stripped from created entries.
- **Reconciliation results compacted** — `other_candidates` replaced with `other_candidate_count`. Transaction `type` field removed (always "C").
- **Static guidance moved to tool descriptions** — `extract_pdf_invoice` instructions string and UTC date warnings no longer in response bodies.
- **Resource mimeType** — changed from `application/json` to `text/plain` to match TOON content.
- **Prompts updated** — 5 prompts and 2 markdown workflow files updated for changed response field names (`distribution_ready` → `distribution` key presence, `skipped_duplicate_details` → `skipped_summary`).

## [0.9.9] - 2026-03-24

### Changed
- **Token optimization for list responses** — all 14 `list_*` tools now use compact JSON (no pretty-printing), saving ~40% tokens on large paginated results.
- **`list_journals` strips postings** — journal list responses no longer include the `postings` array. Use `get_journal` for full details with postings.
- **`parse_lightyear_statement` summary mode** — returns summary only by default (trade counts, totals by ticker). Set `include_rows=true` for individual trade details as compact markdown tables instead of JSON arrays.
- **`parse_lightyear_statement` date filters** — new `date_from`/`date_to` parameters to filter entries before processing, avoiding token overflow on large CSV files.

### Fixed
- **Config tests** — updated to use `process.chdir()` instead of mocking `getProjectRoot()`, matching the cwd-based credential search from 0.9.8.

## [0.9.8] - 2026-03-24

### Changed
- **API key search location** — `apikey*.txt` and `.env` files are now scanned from the working directory (`cwd`) instead of the npm package root. This means `npx` users place credentials in the directory where they launch their AI assistant, not inside `node_modules`.

## [0.9.7] - 2026-03-24

### Added
- **Session audit log** — every mutating MCP operation now logs a detailed Markdown entry to `logs/{connection}.audit.md` in the working directory. Includes timestamps, tool name, entity details, account postings (D/K), financial amounts, and file uploads. Persists across sessions, one file per company/connection.
- **`get_session_log` tool** — view the audit log with filters (entity_type, action, date_from, date_to, limit). Supports `connection` parameter to view other companies' logs.
- **`list_audit_logs` tool** — list all available audit log files with entry counts and last entry dates.
- **`clear_session_log` tool** — reset the current connection's audit log.
- **Bilingual audit labels** — Estonian by default, set `EARVELDAJA_AUDIT_LANG=en` for English.
- **66 logAudit calls** across 12 tool files covering all mutating operations: CRUD, imports (CAMT, Wise, Lightyear), batch processing, reconciliation, tax operations, and recurring invoices.

### Fixed
- **Audit log security** — user-controlled values (client names, descriptions, invoice numbers) are escaped to prevent Markdown injection. File names are sanitized (no path traversal). Rollback/error-recovery operations are intentionally excluded from the log.

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
