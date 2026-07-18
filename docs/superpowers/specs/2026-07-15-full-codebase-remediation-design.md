# Full Codebase Remediation Design

**Status:** Design approved; written specification pending user review before implementation planning

**Review baseline:** production code at `9915011`; the remediation worktree also contains `34487ed`, which only ignores local worktrees

**Scope:** all 19 high-severity, 29 medium-severity, and 2 defense-in-depth findings confirmed by the full-codebase review

**Total tracked findings:** 50

## Objective

Remove every verified defect and hardening gap from the full-codebase review without weakening the server's existing live-accounting safeguards. Work proceeds one finding at a time. Each finding has a stable identifier, a failing regression test, a minimal implementation, focused verification, an independent review, and its own commit before the next finding starts.

The remediation is ordered by shared root cause rather than by severity-list position. This lets the earliest changes establish compatibility, serialization, mutation, recovery, and validation primitives that later fixes can reuse without broad refactors.

## Scope and boundaries

In scope:

- `H01` through `H19`, `M01` through `M29`, and `D01` through `D02` in the inventory below.
- Production code, focused tests, affected workflow mirrors, release checks, and narrowly necessary documentation.
- Intentional contract tightening where unsafe behavior currently permits silent corruption, ambiguous mutation recovery, confirmed-ledger edits, or document substitution.
- Test fixtures that are necessary to reproduce the reviewed defect.

Out of scope:

- Unrelated cleanup, style changes, file reorganizations, dependency upgrades, or feature work.
- Replacing existing APIs or accounting workflows where a local correction is sufficient.
- New runtime dependencies unless the standard library and established repository helpers cannot implement the approved safety property.
- Live mutations during automated verification. All tests use mocks, fixtures, temporary directories, or existing integration-test safety controls.

## Global invariants

Every fix must preserve these invariants:

1. Safe existing behavior remains unchanged unless the review proved it unsafe.
2. A dry run never mutates local or remote accounting state and describes the same mutation mode that execution will use.
3. A live create, update, confirm, invalidate, delete, or reconcile operation still requires the existing approval and connection-safety gates.
4. Every attempted live mutation remains auditable, including explicit indeterminate and recovery outcomes.
5. A network-ambiguous mutation is never treated as a confirmed failure and never receives a speculative compensating mutation.
6. Confirmed journals and invoices cannot be ledger-edited through generic update tools.
7. External text is untrusted at the MCP boundary, but sandbox markers are never sent back to the accounting API, used as matching keys, or persisted as business data.
8. Monetary decisions use explicit source currency, base amount, allocation share, account, and dimension provenance. A nominal amount or default account cannot silently substitute for missing provenance.
9. No finding is marked complete from code inspection alone; the regression test, focused suite, build, diff check, independent review, and commit must all succeed.
10. A shared helper may be introduced by the current finding only when that finding needs it. Later findings must still receive their own regression test, acceptance check, review, and commit even if the helper already provides most of the implementation.

## Approved architecture

### Mutation outcome and cache semantics

Mutation-capable API boundaries distinguish three outcomes:

- `success`: the upstream response proves the requested operation completed.
- `failed`: the upstream response proves the operation was rejected or did not commit.
- `indeterminate`: the request may have reached the upstream service, but a timeout, connection loss, incomplete response, or response-decoding failure prevents a reliable commit decision.

An indeterminate outcome invalidates every affected list and object cache before returning control. It preserves known identifiers, attempted business keys, and a precise recovery instruction. It does not clear relationships, retry a non-idempotent write without a fresh lookup, delete a possibly created object, or otherwise guess the upstream state. A recovery path performs a fresh read using the strongest available immutable identity and reports whether the artifact is present, absent, or still ambiguous.

Pagination is fail-closed: malformed continuation metadata, a repeated page, an impossible next page, or an undecodable page rejects the complete list request and prevents partial data from entering the cache.

### Confirmed-record immutability

Generic journal, purchase-invoice, and sale-invoice update tools may change ledger-bearing fields only while the object is a draft/project. For confirmed objects, the generic update validator rejects line items, postings, totals, counterparty/account assignments, deletion flags, and any other accounting-content field. Editing confirmed accounting content requires the explicit sequence:

1. Invalidate the confirmed record through the dedicated mutation and approval gate.
2. Fetch the resulting draft again.
3. Apply the edit through the generic update tool.
4. Preview and explicitly reconfirm through the dedicated confirmation path.

This is a deliberate compatibility tightening. Existing callers that attempted one-step confirmed-ledger edits receive a structured error naming the required sequence; safe draft updates retain their current behavior.

### Cross-process duplicate protection

Check-then-create accounting workflows use a keyed filesystem lock plus a fresh upstream lookup inside the critical section. The key includes the active connection identity, artifact type, and canonical business identity so unrelated companies and bookings do not block each other. The implementation uses atomic exclusive file creation and the repository's established process-liveness/stale-lock approach; it does not add a lock dependency.

The critical section is:

1. Acquire the canonical key lock.
2. Invalidate the relevant cached collection.
3. Fetch a fresh upstream collection or exact object.
4. Return the existing artifact if the business key is already live.
5. Otherwise create once, recover an ambiguous response by fresh lookup, and record the result.
6. Release the lock in `finally`.

A live lock holder is never evicted by elapsed time alone. A lock whose recorded process is provably dead may be reclaimed. A malformed owner record is treated as live and produces an actionable busy/recovery error rather than risking concurrent creation. Dividend creation is routed through the same guarded pattern instead of retaining an unguarded special case.

### Document digest binding

Document extraction computes SHA-256 over the exact source bytes and returns the digest with reviewed metadata. Any later create, booking, attachment, or upload action that reopens the path must receive the approved digest and recompute it immediately before mutation. A mismatch or missing digest on the tightened path stops before any remote mutation and instructs the caller to extract and approve the current bytes again.

The digest binds approval to content, not merely to a pathname, modification time, or size. The affected receipt and PDF workflow contracts intentionally become stricter. Existing callers must carry the digest returned by extraction into the approved mutation call.

### External-input validation and output sandboxing

CAMT, Wise, receipt, registry, bank, and investment inputs are validated before normalization or matching:

- Monetary strings must be consumed in full and produce finite values.
- Calendar dates must be real ISO dates after source-format conversion.
- Currency codes and exchange-rate orientation must be explicit.
- Bank-account, reference, supplier, and security identifiers must meet the source-specific structural rules.
- A rejected candidate does not prevent examination of later valid candidates unless the source contract makes order authoritative.

Externally supplied text is sandboxed at every MCP output boundary where it could be interpreted as instructions. Matching, deduplication, API payload construction, rule-key generation, and audit persistence operate on the original normalized value, never on rendered sandbox delimiters. Boundary rendering is idempotent so an already wrapped value is not nested repeatedly.

### Monetary provenance

Any accounting calculation that can select an account or amount carries explicit provenance for:

- source currency and base currency;
- source nominal amount and authoritative base amount;
- exchange-rate value and orientation;
- transaction allocation amount when a bank row covers multiple invoices;
- liability, bank, expense, revenue, gain, loss, and dimension identifiers selected from the source record or confirmed configuration.

If required provenance is absent or contradictory, the workflow stops for review. It does not default to a common liability account, treat a foreign nominal amount as EUR, apply a whole bank transaction to a partial allocation, or infer FX orientation from arithmetic convenience.

### Preview/execution parity

Each preview is generated from the same normalized command object later passed to execution. The preview includes target connection, entity type, create/update/confirm/delete mode, identifiers, account dimensions, monetary values and currencies, and whether a subsequent fresh lookup is required. Execution rejects stale or structurally different approval data rather than silently choosing another mutation mode.

## Error handling and recovery contract

Errors returned by remediated tools include a stable category, whether any mutation may have occurred, known object identifiers, the canonical business key, affected cache names, and the next safe action. The minimum categories are `validation_failed`, `confirmed_record_immutable`, `duplicate`, `lock_busy`, `mutation_failed`, `mutation_indeterminate`, `digest_mismatch`, and `manual_review_required`.

Recovery follows evidence:

- For a proven pre-mutation validation failure, return without invalidating unrelated caches.
- For a proven upstream rejection, preserve the upstream status and do not retry unless the operation is read-only or upstream-declared idempotent.
- For an indeterminate mutation, invalidate affected caches, retain all recovery identifiers, perform only a fresh read, and never issue a compensating delete, clear, or retry before identity is checked.
- If a create is later proven committed, return its identifier and current status. If proven absent, a later approved run may create it. If identity is insufficient, stop for manual review.
- If a multi-step workflow creates an object and a later read fails, return the created identifier and partial-completion state. Do not represent the whole workflow as having made no change.
- Lock cleanup occurs in `finally`; a process crash is recovered only after process-liveness verification.
- Digest mismatch is a pre-mutation terminal result for that approval. Recovery is re-extraction and re-approval of the current bytes.

## Compatibility impact

- Node.js `>=18.0.0` remains the supported engine range. `H01` is fixed with Node 18-compatible module-path derivation rather than raising the engine floor.
- MCP response shape remains JSON-compatible. TOON remains an optimization only when decode-round-trip equivalence proves it lossless; otherwise the response uses JSON.
- Safe draft updates, read tools, existing approval prompts, and existing audit formats remain compatible.
- Confirmed-ledger generic updates are intentionally rejected and replaced by invalidate-edit-reconfirm.
- Receipt and PDF create/upload calls that depend on prior extraction intentionally require the approved SHA-256 digest.
- Strict input parsing may reject malformed values that were previously truncated, defaulted, or silently skipped.
- Newly sandboxed outputs may add visible trust-boundary delimiters to untrusted text; server-side identities and persisted values remain delimiter-free.
- Any workflow prompt or mirrored command changed by a fix must be regenerated with `npm run sync:workflow-prompts` and committed together with its source workflow.

## Sequential remediation waves

No two findings are implemented concurrently. Waves define order and shared prerequisites; they do not authorize batch commits.

1. **Compatibility and serialization:** `H01`, `H02`.
2. **Mutation, cache, idempotency, and rollback:** `H03`, `H04`, `H06`, `H14`, `M01`, `M02`.
3. **Accounting calculations and reporting:** `H05`, `H07`, `H16`, `H17`, `H18`, `M19`, `M20`, `M21`, `M22`, `M23`, `M26`.
4. **CAMT, Wise, and bank reconciliation:** `H08`, `H09`, `H10`, `M03`, `M04`, `M05`.
5. **Receipt extraction, supplier resolution, and document integrity:** `H11`, `H12`, `H13`, `H15`, `M06`, `M07`, `M08`, `M09`, `M10`.
6. **Accounting-inbox orchestration and audit behavior:** `H19`, `M11`, `M12`, `M13`, `M14`, `M15`, `M16`, `M17`, `M18`.
7. **Configuration, prompts, release validation, and defense in depth:** `M24`, `M25`, `M27`, `M28`, `M29`, `D01`, `D02`.

Within a wave, the listed order is the execution order. Wave-level verification must pass before the next wave begins.

## Complete finding inventory

Evidence anchors below refer to the reviewed production code at `9915011`. Line numbers are review anchors, not permanent post-fix locations. Each row names the primary regression suite; an implementation may add a narrowly named adjacent test file when that is clearer than enlarging an existing suite.

### High severity

| ID | Verified finding and evidence | Primary regression test | Required acceptance outcome |
|---|---|---|---|
| H01 | Node 18 support is broken because `src/paths.ts:6` uses `import.meta.dirname` while `package.json:36` advertises Node 18+. | `src/paths.test.ts` plus packed-runtime smoke coverage | Project-root discovery uses `fileURLToPath(import.meta.url)` or an equivalent Node 18 API; source and built entry points resolve packaged resources under the declared Node 18 floor. |
| H02 | TOON can silently change keys or value types because `src/mcp-json.ts:83` checks only whether decoding throws. | `src/mcp-json.test.ts` | TOON is emitted only when decoding is deeply equivalent to the JSON source, including keys, scalar types, arrays, nulls, and nesting; any mismatch falls back to canonical JSON. |
| H03 | An indeterminate transaction confirmation can clear `clients_id`: `src/tools/crud/transactions.ts:215` performs cleanup after every error despite the ambiguity protection in `src/api/transactions.api.ts:63`. | `src/api/transactions.api.test.ts` and the transaction CRUD tool suite | A proven rejection may use the existing safe cleanup path; an indeterminate confirmation invalidates transaction caches, preserves `clients_id`, returns recovery data, and performs no speculative clear. |
| H04 | Generic updates can rewrite confirmed accounting content: `src/tools/crud/journals.ts:184` forwards postings, invoice tools forward items/totals, and `src/tools/crud/shared.ts:276` omits material fields including `is_deleted`. | CRUD journal, purchase-invoice, sale-invoice, and shared-validator tests | Confirmed journals and invoices reject every ledger-bearing or lifecycle-field update. The error names invalidate-edit-reconfirm. Draft/project updates retain the allowed behavior. |
| H05 | Purchase-invoice confirmation can overwrite exact supplier totals because `src/api/purchase-invoices.api.ts:195` recalculates item totals unless preservation is explicitly requested. | `src/api/purchase-invoices.api.test.ts` and `src/tools/pdf-workflow.test.ts` | Confirmation preserves source-approved invoice totals and legitimate rounding differences by default on document workflows; recalculation occurs only through an explicit, previewed correction mode. |
| H06 | Check-then-create idempotency in `src/booking-guard.ts:243` is not cross-process safe, and dividend creation bypasses the guard at `src/tools/estonian-tax.ts:496`. | `src/booking-guard.test.ts` and `src/tools/estonian-tax.test.ts` | Concurrent processes sharing a connection and business key can create at most one live artifact. A keyed filesystem lock encloses cache invalidation and fresh lookup; dividend creation uses the same guard. Dead-lock recovery and live-lock refusal are tested. |
| H07 | Currency reconciliation uses a default liability account and an entire transaction rather than the invoice allocation: `src/tools/currency-rounding.ts:93` and `:117`. | `src/tools/currency-rounding.test.ts` | The journal uses the invoice's actual liability account/dimension and the amount allocated to that invoice. Missing or conflicting provenance stops for review. |
| H08 | CAMT import does not bind statement IBAN to the selected bank dimension at `src/tools/camt-import.ts:994`. | `src/tools/camt-import.test.ts` and `src/tools/camt-import-tools.test.ts` | Import proves that the statement account belongs to the selected bank dimension, or stops before mutation with a mismatch requiring explicit resolution. |
| H09 | CAMT exact-reference duplicate identity is global because `src/tools/camt-import.ts:548` omits the bank dimension. | `src/tools/camt-import.test.ts` | Duplicate identity includes the selected bank dimension/account; an equal reference on another own account cannot suppress a legitimate row. |
| H10 | One-sided foreign-currency transfers post nominal foreign currency as EUR at `src/tools/bank-reconciliation.ts:1482`. | `src/tools/bank-reconciliation.test.ts` | A foreign-currency transfer uses the authoritative base-EUR amount or stops for missing FX provenance; nominal foreign currency is never posted as EUR. |
| H11 | Explicit zero VAT becomes 100% VAT because `src/tools/receipt-extraction.ts:556` removes zero candidates before classification. | `src/tools/receipt-extraction.test.ts` | An explicit `VAT 0.00` remains authoritative zero VAT and produces net equal to gross, VAT zero, with confidence reflecting the explicit source. |
| H12 | Receipt currency selection takes the first currency-bearing amount line at `src/tools/receipt-extraction.ts:839`, even when it is not the total. | `src/tools/receipt-extraction.test.ts` | Currency is bound to the authoritative gross/total line; earlier equivalents, fees, or secondary-currency lines cannot classify the invoice. Ambiguity triggers review. |
| H13 | Supplier matching falls back to name after conflicting registry/VAT identifiers fail at `src/tools/supplier-resolution.ts:137`. | `src/tools/supplier-resolution.test.ts` | A conflicting strong identifier vetoes name-only resolution. The result is unresolved/manual review unless a client matches the strong identifier. |
| H14 | Receipt classification can create an invoice and lose recovery information when the later transaction read at `src/tools/receipt-inbox.ts:2008` fails outside the protection surrounding creation at `:1972`. | `src/tools/receipt-inbox.test.ts` | Any post-create failure returns the created invoice ID, status, attempted transaction ID, and safe continuation action. It never invites a duplicate create or claims that no mutation occurred. |
| H15 | Reviewed metadata is not bound to uploaded bytes: paths are reopened at `src/tools/receipt-inbox-booking.ts:267` and `src/tools/pdf-workflow.ts:689`. | `src/tools/receipt-inbox.test.ts` and `src/tools/pdf-workflow.test.ts` | Extraction returns SHA-256; every dependent create/upload verifies the approved digest immediately before mutation. Changed bytes fail before remote state changes. |
| H16 | Lightyear trade-fee FX orientation is lost because `src/tools/lightyear-investments.ts:200` always divides the stored rate. | `src/tools/lightyear-investments.test.ts` | Extraction carries rate orientation and fee conversion applies the correct multiply/divide direction, with reconciliation against source/base amounts and review on contradiction. |
| H17 | Non-EUR Lightyear distributions lose currency at `src/tools/lightyear-investments.ts:447` and are later created as EUR at `:1369`. | `src/tools/lightyear-investments.test.ts` | Distribution currency and authoritative EUR conversion survive extraction through journal creation; non-EUR nominal values are never booked 1:1 as EUR. |
| H18 | Lightyear inexact gains matching at `src/tools/lightyear-investments.ts:554` accepts a unique date/ticker/quantity candidate without proceeds tolerance. | `src/tools/lightyear-investments.test.ts` | Inexact matching requires an explicit absolute/relative proceeds tolerance and surfaces candidates outside tolerance for review, even when only one candidate exists. |
| H19 | CAMT duplicate cleanup can delete an unrelated transaction because `src/tools/accounting-inbox.ts:1397` checks statuses but not bank identity, date, amount, or reference. | `src/tools/accounting-inbox.test.ts` | Cleanup requires the same bank dimension, date, signed amount/currency, and canonical reference identity. Any mismatch or insufficient identity blocks deletion for review. |

### Medium severity

| ID | Verified finding and evidence | Primary regression test | Required acceptance outcome |
|---|---|---|---|
| M01 | Mutation errors can leave stale caches and missing audit context because invalidation in `src/api/base-resource.ts:131` follows only successful responses. | `src/api/base-resource.test.ts` | Indeterminate mutations invalidate affected collection/object caches and expose auditable recovery metadata; proven rejections do not unnecessarily clear unrelated caches. |
| M02 | Malformed pagination at `src/api/base-resource.ts:99` silently returns and caches a partial dataset. | `src/api/base-resource.test.ts` | Invalid or cyclic continuation metadata rejects the list operation, identifies the failing page, and leaves no partial cache entry. |
| M03 | Wise treats `TRANSFER-*` identifiers as own-account transfers without ownership evidence at `src/tools/wise-import.ts:695`. | `src/tools/wise-import.test.ts` | Transfer classification requires verified ownership of both endpoints or explicit operator confirmation; identifier shape alone is insufficient. |
| M04 | Wise dry run at `src/tools/wise-import.ts:532` cannot preview the later inter-account confirmations. | `src/tools/wise-import.test.ts` | Dry run renders the same inter-account journal and confirmation actions execution would perform, with amounts, currencies, dimensions, and mutation mode. |
| M05 | Malformed CAMT/Wise amounts, dates, and identifiers are accepted or silently skipped; `parseFloat` at `src/tools/camt-import.ts:454` accepts `10oops`, and permissive Wise parsing begins at `src/tools/wise-import.ts:47`. | `src/tools/camt-import.test.ts` and `src/tools/wise-import.test.ts` | Both importers require fully consumed finite monetary values, real dates, and structurally valid required identifiers. Rejected rows are surfaced with row identity and reason and never mutate. |
| M06 | The first invalid IBAN suppresses later valid candidates at `src/document-identifiers.ts:228`, while impossible ISO dates pass at `src/tools/receipt-extraction.ts:859`. | `src/document-identifiers.test.ts` and `src/tools/receipt-extraction.test.ts` | Candidate extraction continues past invalid IBANs and selects a later valid one according to existing precedence; impossible calendar dates are rejected and cannot enter booking data. |
| M07 | Payment receipts match invoice numbers without supplier identity at `src/tools/receipt-inbox.ts:991`. | `src/tools/receipt-inbox.test.ts` | Invoice-number matching also requires compatible supplier identity or an explicit ambiguity review; identical numbers across suppliers cannot auto-match. |
| M08 | Receipt modified-date filters also remove bank transactions outside the receipt range at `src/tools/receipt-inbox.ts:1501`. | `src/tools/receipt-inbox.test.ts` | Filesystem modified-time filters apply only to receipt discovery. Bank transaction selection retains its accounting-date semantics and is not narrowed by file metadata. |
| M09 | Transient `invoice_info` failures silently disable own-company supplier protection at `src/tools/receipt-inbox.ts:897`. | `src/tools/receipt-inbox.test.ts` | Failure to load own-company identity blocks automatic supplier resolution/booking and returns a retryable protection-state error; it never proceeds as though the company had no identifiers. |
| M10 | Receipt nonce sandbox markers flow into saved rule keys and audit text at `src/tools/receipt-inbox.ts:1736`. | `src/tools/receipt-inbox.test.ts` | Rendering markers are stripped before normalization, matching, API payload construction, rule persistence, and audit persistence; saved keys contain only canonical business text. |
| M11 | Accounting-inbox exposes only five receipt/classification review items without resumable IDs at `src/tools/accounting-inbox-autopilot-service.ts:268`. | `src/tools/accounting-inbox-autopilot-service.test.ts` | Review output is complete or explicitly paginated and every item has a stable resumable ID accepted by the continuation call. No hidden remainder is represented as complete. |
| M12 | Reconciliation at `src/tools/accounting-inbox-autopilot-service.ts:420` runs against the old ledger while imports remain pending. | `src/tools/accounting-inbox-autopilot-service.test.ts` | Execution either applies approved imports before reconciliation or reports reconciliation as deferred. Dry run previews that same order and never presents stale-ledger reconciliation as final. |
| M13 | Only the largest discovered receipt folder is processed at `src/tools/accounting-inbox.ts:554`. | `src/tools/accounting-inbox.test.ts` | All eligible discovered receipt folders are processed deterministically, with per-folder counts and errors, unless the user explicitly selects a subset. |
| M14 | Unknown review items return `needs_answers` without questions at `src/tools/accounting-inbox.ts:1006`. | `src/tools/accounting-inbox.test.ts` | Every `needs_answers` result contains at least one actionable question tied to the item ID; an unrecognized type produces a supported-type/error response rather than an empty prompt. |
| M15 | Workspace scan limits count matching files rather than traversed entries at `src/tools/accounting-inbox.ts:198`. | `src/tools/accounting-inbox.test.ts` | The traversal budget counts every inspected directory entry, stops deterministically at the cap, and reports truncation and continuation guidance. |
| M16 | Audit `summary` fields are never rendered at `src/audit-log.ts:501`. | `src/audit-log.test.ts` | Non-empty summaries are visible once in the human-readable entry, escaped/sandboxed as appropriate, while machine-readable details remain intact. |
| M17 | Audit-log relabel/merge at `src/audit-log.ts:238` can lose concurrent appends. | `src/audit-log.test.ts` | Relabel/merge uses the established cross-process lock and rereads current contents inside the critical section; concurrent appends survive exactly once. |
| M18 | The advertised default audit limit of 100 is bypassed for unfiltered reads at `src/audit-log.ts:771`. | `src/audit-log.test.ts` | Omitted limit consistently returns at most the documented newest 100 entries for filtered and unfiltered reads; explicit valid limits retain their contract. |
| M19 | Client-debt and annual-report outputs omit opening-balance incompleteness warnings at `src/tools/account-balance.ts:158` and `src/tools/annual-report.ts:690`. | `src/tools/account-balance.test.ts` and `src/tools/annual-report.test.ts` | Both outputs visibly state when opening balances are absent or incomplete and distinguish a period movement from a complete balance. |
| M20 | Title-only legacy year-end closes remain in P&L at `src/tools/annual-report.ts:363` despite being recognized as closes elsewhere. | `src/tools/annual-report.test.ts` | The same canonical close detector is used across report paths; recognized legacy close journals are excluded from P&L exactly once without hiding ordinary journals. |
| M21 | Non-VAT companies can inherit deductible-VAT defaults at `src/tools/purchase-vat-defaults.ts:94`. | `src/tools/purchase-vat-defaults.test.ts` and purchase-invoice CRUD tests | When live company status is non-VAT, defaults cannot set deductible VAT account/article/rate fields; explicit contradictory input requires review rather than silent inheritance. |
| M22 | Accounting-rule migration at `src/accounting-rules.ts:1233` can overwrite normalized duplicate keys. | `src/accounting-rules.test.ts` | Migration detects normalized-key collisions before write, preserves all source rules, and returns a deterministic conflict requiring resolution instead of last-write-wins loss. |
| M23 | The tracked rule template at `src/accounting-rules.ts:158` directs company-specific rules into a repository path not ignored by `.gitignore:1`. | `src/accounting-rules.test.ts` plus ignore-policy verification | Generated company rules default to an ignored, connection-scoped local location; tracked templates contain no company data and the ignore rule covers the generated path. |
| M24 | Prompt schemas omit documented dimension arguments at `src/prompts.ts:148`. | `src/prompts.test.ts` | Every registered prompt schema exposes the dimensions its documented workflow accepts, with matching names, types, optionality, and descriptions. |
| M25 | Lightyear workflow recommendations use `statement_path` at `src/tools/workflow-recommendations.ts:349`, while the tool requires `file_path`. | `src/tools/workflow-recommendations.test.ts` and `src/prompts.test.ts` | Recommendation, prompt, workflow source, generated mirror, and tool schema use the same `file_path` argument; generated surfaces pass drift validation. |
| M26 | Lightyear portfolio summary at `src/tools/lightyear-investments.ts:1471` includes instruments skipped by default booking. | `src/tools/lightyear-investments.test.ts` | Summary separates booked, previewed, skipped, and review-required instruments and never represents skipped instruments as included in booked portfolio totals. |
| M27 | Credential metadata permits newline injection into `.env` at `src/config.ts:760`. | `src/config.test.ts` | Credential values and metadata are serialized with one validated assignment per line; control characters in names/comments/metadata are rejected or safely encoded and cannot create a second setting. |
| M28 | Importing over an insecure regular `.env` discards its existing contents at `src/config.ts:403`. | `src/config.test.ts` | Permission hardening occurs without truncation. Existing bytes are preserved atomically on success and on any failure; import aborts with recovery guidance if safe permissions cannot be established. |
| M29 | The stderr tee continues after private-permission hardening fails at `src/stderr-tee.ts:78`. | `src/stderr-tee.test.ts` | Tee startup fails closed or disables file logging when mode `0600` cannot be verified, reports the condition on original stderr, and writes no sensitive output to an insecure file. |

### Defense in depth

| ID | Verified gap and evidence | Primary regression test | Required acceptance outcome |
|---|---|---|---|
| D01 | Stored bank, registry, and investment text is not consistently sandboxed at MCP output boundaries, notably `src/resources/dynamic-resources.ts:96`. | `src/resources/dynamic-resources.test.ts` plus focused output tests for affected tools | All untrusted stored text is wrapped at MCP rendering boundaries with one consistent helper; matching and persistence receive canonical unwrapped values, and already wrapped data is not nested. |
| D02 | Release validation at `scripts/validate-release-metadata.mjs:6` neither requires nor smoke-tests the packed `dist/` executable payload. | `src/release-metadata.test.ts` and a package smoke fixture | Release validation builds and packs the publish payload, proves required runtime files are present, installs or extracts the tarball in isolation, and starts the declared `dist/index.js`/bin under the supported Node floor far enough to catch missing-resource and syntax failures. |

Inventory control totals:

- High severity: 19 (`H01`-`H19`).
- Medium severity: 29 (`M01`-`M29`).
- Defense in depth: 2 (`D01`-`D02`).
- Total: 50.

## Per-finding execution protocol

The following gate is mandatory for each finding and completes before work begins on the next ID:

1. Re-read the evidence function and adjacent callers/tests at the current branch head. Confirm that earlier fixes have not already changed the premise.
2. Write one minimal regression test that expresses the row's acceptance outcome. For paired-source findings such as `M05`, `M06`, and `M19`, add one focused assertion per affected surface within the same finding.
3. Run only the new test and confirm a meaningful red result caused by the reviewed defect, not by a test setup error.
4. Implement the smallest production change that makes the regression pass while preserving the global invariants.
5. Run the focused test file and the directly neighboring suites named in the inventory.
6. Run `npm run build` and `git diff --check`.
7. Send the finding's diff and acceptance outcome to an independent verifier or code-review task that did not author the change. Authoring and approval are separate passes.
8. Resolve every actionable review result, rerun steps 5 and 6, resubmit the final diff, and obtain a clean independent verdict on the code that will be committed.
9. Commit only that finding's code, tests, and directly required generated/doc surfaces. Include the stable ID in the commit body or remediation ledger so history is traceable.
10. Record the finding as complete with red-test evidence, passing commands, reviewer result, and commit hash.

An independent review may reject the proposed design, discover a safer local correction, or require stronger tests. It may not waive the approved invariant or merge two finding gates for convenience.

## Verification protocol

### Focused verification

Each finding selects the narrowest deterministic test command that proves the regression, then runs all touched suites. Typical commands are:

```bash
npx vitest run src/path/to/focused.test.ts
npm run build
git diff --check
```

Tests involving concurrency use controlled barriers or child processes, not timing-only sleeps. Tests involving ambiguous network outcomes explicitly prove which follow-up API calls did and did not occur. Monetary tests assert account/dimension identity, source amount, base amount, currency, allocation, and rounding. Document-integrity tests replace bytes at the same path and prove that no create/upload call occurs.

### Wave gate

After the final finding in every wave:

```bash
npm run validate:release
git diff --check
npm run build
npm test
npm run test:integration
```

The next wave does not begin until all commands pass and the worktree is clean after the wave's final per-finding commit. Existing integration skips remain acceptable only when they match the documented baseline and are unrelated to changed behavior.

### Final branch gate

After `D02`, run a separate whole-branch review against the baseline, followed by:

```bash
npm run sync:workflow-prompts
npm run validate:release
git diff --check
npm run build
npm test
npm run test:integration
npm pack --dry-run
```

The release validator's new packed-payload smoke path must also pass under the lowest supported Node major. Verify that all 50 IDs have exactly one completion record and no pending review task. A final reviewer checks backward compatibility, live-accounting safety, trust boundaries, and the absence of unrelated refactors.

## Live-accounting safety during implementation

- Unit and integration tests must not use real credentials or make live accounting mutations.
- Tool-level mutation tests assert dry-run, approval, audit, connection-snapshot, and post-mutation cache behavior together when the finding touches those paths.
- A fix may not bypass `registerTool` mutation annotations, approval presentation, connection-switch protection, or audit recording to simplify a test.
- Any new recovery operation is read-only until the caller gives a new explicit approval for a mutation proven necessary by fresh state.
- Delete/cleanup fixes require stronger identity proof than create/dedup fixes because a false positive destroys an existing accounting artifact.
- Generated previews and audit records redact credentials and local sensitive paths according to existing policy.

## Commit and rollback strategy

Each finding is an atomic commit. If its verification fails or its independent review remains unresolved, amend the uncommitted work; do not start the next finding. If a committed finding later causes a wave regression, add a narrowly scoped corrective commit tied to that finding rather than rewriting unrelated history.

Operational rollback means reverting the finding's code commit. It does not mean compensating against live accounting data. For an indeterminate live mutation, recovery is always fresh lookup and explicit operator action. A revert must not restore silent data corruption, speculative rollback, confirmed-ledger editing, or a known trust-boundary bypass; if the safe fix cannot be retained, the affected mutation path must fail closed until corrected.

## Completion definition

The remediation is complete only when:

- all 50 inventory rows meet their acceptance outcomes;
- every finding has red-green evidence, focused verification, independent approval, and an atomic commit;
- all seven wave gates and the final branch gate pass;
- workflow source/mirror drift is zero;
- the packed executable payload passes its smoke test at the supported Node floor;
- the final whole-branch review finds no unresolved high, medium, or defense-in-depth item from this inventory;
- the branch contains no unrelated changes and the worktree is clean.
