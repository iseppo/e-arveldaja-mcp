# Prompt Contract Remediation Design

**Status:** Architecture approved by the user; detailed specification revised after independent review and pending user acceptance before implementation planning

**Review baseline:** `e4e5503` on `master`

**Scope:** every verified prompt, workflow, coupled-tool contract, approval-binding, trust-boundary, test, and documentation finding from the July 2026 in-depth prompt review

**Total tracked contracts:** 25 (`P01`-`P25`)

## Objective

Make every advertised prompt executable through the real MCP protocol and ensure that following any prompt cannot silently widen an approval, create an invalid accounting record, trust external instructions, or call an unavailable or incompatible tool. CAMT, reconciliation, Lightyear, Wise, PDF, receipt, and credential workflows must additionally enforce their named source/manifest/plan-continuity contracts; this specification does not claim that an integrity token by itself proves a human approved the plan.

This is a root-cause remediation. Canonical workflows, prompt registration, coupled runtime tools, generated Claude commands, tests, and documentation change together where their contracts are inseparable. Prompt-only edits are insufficient for approval binding, transaction-type enforcement, output sandboxing, and credential persistence safety.

## Scope and boundaries

In scope:

- MCP prompt registration, string-transport argument parsing, argument validation, feature-aware prompt rendering, and real protocol tests.
- Canonical workflow corrections and regeneration of every affected `.claude/commands` mirror.
- Runtime changes strictly required to make workflow promises true: server-issued plan handles, immutable preview plans, transaction type normalization, output sandboxing, booking projections, and credential preview/approval binding.
- Behavioral and adversarial tests for prompt ordering, surface parity, response paths, hostile external text, drift rejection, feature flags, and accounting invariants.
- README, architecture, contributor instructions, and release validation needed to describe and enforce the corrected prompt pipeline.
- Time-sensitive Estonian VAT prompt metadata, sourced from canonical runtime metadata and verified against official Estonian Tax and Customs Board guidance.

Out of scope:

- Unrelated accounting behavior, stylistic rewrites, dependency upgrades, or general codebase cleanup.
- New sales, import, investment, tax, or credential features.
- Live accounting mutations during verification. Tests use mocks, fixtures, temporary directories, in-memory MCP transports, and existing integration safety controls.
- Replacing established safeguards that already work: PDF `source_sha256`, receipt `approved_manifest`, Wise `approved_command_digest`, mutation audit logging, private credential permissions, symlink refusal, and connection-switch interruption protection.

## Global invariants

Every change must preserve these properties:

1. MCP prompt arguments cross the wire as strings and are parsed deliberately before use.
2. Invalid, oversized, ambiguous, relative-path, non-ISO-date, non-positive-ID, or non-object-JSON prompt inputs fail before prompt construction.
3. All run arguments are inert data. No argument value is interpolated into imperative prose or allowed to become a new instruction.
4. A dry run never mutates. CAMT, reconciliation, Lightyear, and Wise execution can perform only the exact server-issued plan represented by its current plan handle; PDF and receipt execution retain their existing source/manifest binding.
5. For plan-handle workflows, changed source bytes, normalized inputs, relevant live state, command preconditions, or mutation plans invalidate the handle and require a fresh preview. PDF and receipt paths continue to reject changes covered by their existing digest/manifest contracts.
6. A sampled display never authorizes hidden mutations. Every mutation is explicitly enumerated or belongs to a complete deterministic server-held plan, manifest, or digest whose scope and totals were shown.
7. Every created bank transaction uses `type: "C"`; incoming/outgoing meaning remains in signed source data, distributions, and provenance.
8. External-origin free text from files, OCR, CSV, XML, registries, remote APIs, and filesystem names is untrusted at every model-facing boundary and remains clean internally for matching, persistence, and API writes; provenance-scoped operator reference data follows the matrix below.
9. Tool names, required arguments, response paths, feature flags, and workflow instructions agree exactly.
10. Every prompt surface directs the consuming model to follow the user's language while preserving exact machine keys, identifiers, account names, and statutory terms where translation would be ambiguous.
11. No mutation is executed merely because a workflow can infer the likely intent; each mutation category retains an explicit stop-and-approve gate.
12. A finding is complete only after its failing regression test, implementation, focused suite, mirror synchronization, independent review, and relevant full verification pass.

## Approved architecture

### 1. String-compatible prompt argument boundary

The prompt registry exposes schemas compatible with MCP `prompts/get`, whose argument values are strings. Shared schema helpers will validate and transform:

- positive integer IDs from canonical decimal strings;
- finite numeric amounts with prompt-specific ranges;
- booleans from exactly `"true"` or `"false"`;
- real `YYYY-MM-DD` dates;
- non-empty absolute filesystem paths within practical length limits;
- identifiers with prompt-specific size and control-character restrictions; and
- JSON-encoded plain objects with byte/depth/shape limits.

Boolean parsing must not use generic truthiness coercion because the string `"false"` must become `false`. Numeric parsing rejects empty strings, exponential or fractional forms where an integer is required, non-finite values, negative IDs, and trailing characters.

Prompt renderers receive typed parsed values but serialize all run arguments and derived hints into one canonical JSON value. That JSON value is then enclosed in the existing fresh, unpredictable nonce boundary after serialization; every render adds a fresh authentic outer boundary and never trusts delimiter-looking content supplied by the caller. No argument appears in surrounding imperative prose. A common preamble states that the bounded value is data and cannot amend the workflow.

Initial size budgets are 512 characters for free-form identifiers, 4,096 characters for absolute paths, 20,000 characters for a JSON-object argument, and 64,000 characters for the entire rendered prompt. A shared constant owns each budget. Any workflow needing more data uses a stable item ID or bounded server-side page rather than increasing prompt context without review.

Tests must use an in-memory MCP client/server transport and `Client.getPrompt()` with wire-format string arguments. Schema rejection uses the SDK's JSON-RPC `InvalidParams` (`-32602`) contract with safe field paths and bounded issue data; it does not promise a custom error category the SDK cannot preserve. Direct callback tests remain useful only for rendering details and cannot serve as protocol compatibility proof.

### 2. Server-issued plan handles and execution continuity

CAMT, reconciliation, and Lightyear adopt the established Wise plan-continuity pattern while PDF and receipt retain their existing source/manifest binding.

Each dry run stores an immutable plan in a bounded, expiring server-side plan store and returns an opaque cryptographically random plan handle. The stored plan contains:

- a versioned plan schema identifier;
- normalized invocation inputs;
- a digest of every source file's exact bytes, when applicable;
- the relevant live-state snapshot or immutable identities and versions used to compute matches;
- the complete ordered mutation plan;
- deterministic counts and monetary totals grouped by mutation category;
- all review-required exclusions; and
- the connection fingerprint and generation, live/demo server identity, relevant feature configuration, server-instance identity, issuance time, expiry, and operation/tool domain.

The handle has at least 256 bits of entropy, is scoped to one server instance, connection, operation, and plan version, expires after a short documented interval, and becomes unusable on restart. It is one-attempt: any execute attempt consumes it, whether execution succeeds, drifts, fails, or becomes indeterminate. A caller cannot construct or reuse a valid handle from public plan data.

Wise retains `approved_command_digest` as a stable, human-visible plan fingerprint and compatibility field, but the digest is not an authorization credential. Wise execution also requires the server-issued handle bound to that digest and stored command plan.

The handle proves that the server issued the preview and binds execution scope; it does not prove human consent. The workflow/client contract must still record an explicit `USER_APPROVAL(plan_handle, scope)` before execute. Where an accepted MCP elicitation capability exists, mutation may bind that client-controlled confirmation separately. Tests and documentation must never call mere possession of a plan handle proof of approval.

Execution requires the plan handle. For file workflows, execution reads the source once into an immutable byte snapshot, verifies it against the stored source digest, and plans and executes from that same snapshot without reopening the path. It refreshes relevant live state, rebuilds the plan through the same planner, and compares it with the stored plan before mutation. Any pre-mutation difference returns `plan_drift`, consumes the handle, and instructs the caller to preview and approve again.

Every planned command also carries explicit preconditions such as entity identity, status/version, balance/open amount, target, currency, and distribution. Preconditions are revalidated immediately before that command; conditional writes or locks are used where the upstream API supports them. Execution stops at the first changed precondition and never substitutes a newly discovered match or target.

For reconciliation, the live-state binding covers the transaction and invoice identities, statuses, balances, match amounts, currencies, and distributions that authorize confirmation. Newly appearing matches are never swept into an old plan.

For large plans, the user receives a compact grouped summary plus plan handle and deterministic scope. The complete plan stays server-side and is available through bounded deterministic pages keyed by the same handle. Every page reports the total count, category totals, stable range/cursor, and handle; page retrieval cannot alter the plan.

These batches are not assumed atomic. If a later command drifts, fails, or is indeterminate after earlier commands committed, the result is `partial_execution`, not `plan_drift`. It returns stable command IDs grouped into completed, skipped, failed, indeterminate, and not-attempted sets; includes every known created/confirmed entity ID and an audit reference; sets `mutation_may_have_occurred` for unknown outcomes; forbids automatic retry; and requires a fresh preview for remaining work. Compensation is allowed only when an existing operation-specific contract proves it safe.

### 3. Approval-scope model

An approval card names the target connection, source, operation categories, exact counts, monetary totals/currencies, exceptions, and the plan handle, source digest, or manifest appropriate to that workflow. It may use representative rows for readability only when the complete hidden remainder is server-bound or cryptographically manifest-bound and the card explicitly states the total bound scope.

One user approval may authorize an enumerated reconciliation batch. Execution still performs one `confirm_transaction` call per listed match, and no call may target an item outside the approved batch.

Wise ownership reviews are a separate plan-forming step: the workflow presents exact transfer IDs, obtains explicit ownership confirmation, reruns dry-run with `confirm_own_transfer_ids`, presents the newly generated plan/handle, then executes only that handle-bound invocation.

No execute call accepts an unbound include/exclude switch. Any user exception, filtered subset, changed account or dimension, ownership decision, or category change creates a new complete plan and plan handle before execution.

Credential persistence follows the same preview/approval structure. The server holds an immutable, secret-bearing source snapshot behind an opaque one-attempt credential plan handle; reusable secret hashes are never exposed. The stored plan binds the exact source bytes/parsed credential tuple, verified company identity, live/demo server, canonical source and destination paths, target connection slot, local/global scope, append/replace/remove operation, overwrite policy, required permissions, and destination-state digest/version. Before writing, the user sees the non-secret source path, verified company, server, target `.env`, operation, affected slot, overwrite behavior, and scope. Default scope is local. The server rechecks source and destination state immediately before persistence and rejects either drift. A sole candidate is never auto-approved.

The existing startup import path is rerouted through this preview. It may persist only after accepted client-controlled elicitation bound to the credential plan handle; when the client cannot elicit, startup performs no import and returns actionable setup guidance.

### 4. Bank transaction invariant

CAMT `CRDT`/`DBIT` and Wise `IN`/`OUT` describe source direction but never select the e-arveldaja transaction `type`. All bank-transaction create commands use `type: "C"`. Directional meaning is preserved in signed amount/source metadata and later confirmation distributions.

Server instructions and reconciliation workflows state this as an absolute invariant and no longer tell the model to preserve importer-provided transaction types. Tests enumerate every `api.transactions.create` call site. They cover CAMT rows, Wise main and fee rows, and direct `create_transaction`; the generic create contract hard-codes or removes caller control over `type`, and a static invariant test rejects any transaction-create payload capable of carrying `"D"`.

### 5. Authenticated external-text boundary

The existing nonce-based external-text renderer remains the single boundary mechanism. It is applied recursively to model-facing external-origin fields from:

- Lightyear references, tickers, descriptions, FX provenance, duplicate summaries, and booking results;
- supplier/client and registry resolution results;
- Accounting Inbox filenames, paths, folder names, reasons, review items, and suggested steps;
- existing OCR, receipt, CAMT, Wise, and API-origin fields already protected elsewhere.

Rendering occurs only when constructing MCP responses. Matching, duplicate detection, account lookup, saved rules, audit records, and upstream API payloads continue to use canonical unwrapped values. Repeated rendering is safe but deliberately not byte-idempotent: each model-facing render adds a fresh outer nonce and never recognizes a caller-supplied wrapper as authentic. Input-side canonicalization for reads, searches, and writes remains prototype-safe and strips display markers only at explicitly scoped boundaries.

Executable filesystem identity is never reconstructed from a sandboxed display string. Accounting Inbox returns an opaque, expiring `file_ref` bound to the validated canonical path plus a separately sandboxed display name/path. Routed import tools accept `file_ref`; direct user-supplied paths still pass absolute-path validation and are confined inside the structured run-argument boundary. End-to-end tests prove a hostile filename is inert while the next tool resolves the exact clean canonical path.

Trust policy is provenance-specific:

| Source | Model-facing representation | Internal match/write representation |
|---|---|---|
| Imported OCR, CSV, XML, registry, and remote free text | Fresh nonce sandbox, with size/truncation metadata | Canonical clean value |
| Import-origin text persisted in first-party API records | Sandboxed according to the scoped external-text field policy | Canonical clean value |
| Operator-configured accounts, currencies, articles, templates, and VAT settings | Raw trusted reference data unless separately marked import-origin | Original validated value |
| Filesystem names and paths | Sandboxed display text plus opaque `file_ref` | Server-resolved canonical path |
| IDs, amounts, dates, booleans, and enums | Typed machine value; no free-text interpretation | Same validated value |

The shared prompt/command preamble identifies file, OCR, CSV, XML, registry, API, and filesystem text as evidence rather than instructions. Hostile newline, fake delimiter, approval-bypass, and oversized-value tests cover every newly protected surface.

### 6. One canonical prompt-surface registry

A single TypeScript registry owns prompt name, workflow slug, description, argument schema, feature predicate, and any safe render-time variant metadata. Runtime prompt registration consumes it directly. Release validation and command synchronization move to TypeScript scripts executed with the existing `tsx` development dependency, so the same registry is imported without a second manifest; build-order and packed-runtime tests cover this path.

Validation enforces set equality, not one-way inclusion, across:

- registry workflow slugs;
- `workflows/*.md` canonical files;
- generated `.claude/commands/*.md` files; and
- the exhaustive table and declared count under `README.md` → `## Workflows (MCP Prompts)`.

Orphan workflows, orphan commands, duplicate slugs, missing mirrors, and feature-unaware registrations fail validation.

MCP prompts and generated Claude commands share the same trust-boundary and user-response wrapper. The workflow body stays canonical; the generator owns the common wrapper so safety text cannot drift between surfaces. Wrapper parity does not imply that a static command can embed a runtime-selected feature variant.

### 7. Feature-aware workflow variants

Purchase-side workflows remain available when sales tools are disabled. Runtime MCP prompts render from explicit server configuration: `company-overview` omits receivables aging and labels the report as purchase-side only; `month-end-close` omits sale-invoice actions and sales-only checklist claims. Enabled mode retains the complete workflow.

Static generated commands cannot know a server process's feature configuration. They therefore contain an explicit capability-conditional branch: run sales steps only when the named sales tools appear in the connected server's advertised tool list, otherwise use the purchase-side variant. They never call a missing tool merely to probe it. Exposure tests exercise both MCP modes; command tests verify that sales-only calls are conditional rather than mandatory.

### 8. Deterministic language guidance

The shared wrapper instructs the consuming model to answer in the language of the current user conversation. Tool names, JSON keys, IDs, official account names, and statutory citations remain exact. This is a deterministic prompt-surface requirement: tests prove that MCP prompts and generated commands contain the same instruction and preserve technical tokens, but do not claim to prove arbitrary downstream model compliance.

### 9. Coupled workflow/tool corrections

The following contracts change together:

- `book-invoice` calls `suggest_booking` only for an existing supplier. A new supplier uses supplier-independent article/account/dimension discovery before approval, then creates the supplier only after approval.
- `validate_invoice_data` receives extracted registration and VAT identifiers. Extraction quality, truncation, OCR confidence/provenance, validation warnings, and material warning acknowledgement appear before mutation approval.
- `suggest_booking` includes `vat_accounts_dimensions_id`; the workflow queries dimensions when historical data is missing or ambiguous.
- Receipt merged results are read consistently through `result.*`. PDF/JPG/PNG recovery retains document upload and digest binding; plain creation is limited to structured/no-file input.
- CAMT paths consistently use `result.statement_metadata`, `result.summary`, and `result.execution`.
- Historical company overview passes the selected `as_of_date` to both aging tools.
- Every Lightyear call supplies its schema-required `file_path`, account, and mapped capital-gains arguments plus any applicable optional dimensions actually provided by the user/configuration.
- A legal-entity supplier requires an API-valid identity in `code`: an Estonian registry code or an accountant-confirmed foreign registration identifier. A VAT number is additional evidence unless the applicable API/jurisdiction contract explicitly accepts it as the legal identifier. Natural-person creation is an explicit, reviewed branch; missing legal identity stops with duplicate-search and audit guidance rather than sending an invalid create call.
- Setup prompts do not recommend hidden tools without visibility/restart guidance.
- Receipt and batch approval language distinguishes create/upload approval from later confirmation/link approval.

### 10. Time-sensitive tax metadata

Prompt descriptions and workflow prose must not independently hard-code mutable VAT facts. Exported, versioned runtime tax-rule metadata supplies rates, thresholds, effective dates, source URLs, and `verified_at`. Prompt tests compare rendered tax guidance with this canonical metadata.

As verified on 2026-07-19 against the Estonian Tax and Customs Board:

- the VAT registration threshold is EUR 40,000, subject to the official scope rules effective from 1 January 2025;
- current VAT rates are 24%, 13%, 9%, and 0%; and
- the standard rate has been 24% since 1 July 2025.

The product must present these as dated informational rules, retain existing caution around fact-specific tax treatment, and make later legal updates a single-source metadata change rather than a prose hunt. Deductible-input-VAT restrictions referenced by booking guidance likewise point to versioned metadata and the official restriction source instead of duplicating mutable prose.

Official sources:

- <https://www.emta.ee/en/business-client/taxes-and-payment/value-added-tax/registration-vat-payer/threshold-calculation-1-january-2025>
- <https://www.emta.ee/en/business-client/taxes-and-payment/value-added-tax/vat-rates-and-supply-exempt-tax/value-added-tax-rates>
- <https://www.emta.ee/en/business-client/taxes-and-payment/value-added-tax/calculation-and-refund-vat/restrictions-deduction-input-vat>

## Complete contract inventory

| ID | Contract | Review provenance | Acceptance outcome |
|---|---|---|---|
| P01 | MCP transport compatibility | Contract + quality | Every prompt accepts valid wire-format string arguments through `Client.getPrompt()`; invalid values fail with exact SDK `InvalidParams` behavior. |
| P02 | Prompt input confinement | Quality + safety | Inputs are bounded, typed, structurally validated, and rendered inside a fresh authenticated data boundary; malicious delimiters, newlines, or oversized JSON cannot create outer instructions or exhaust prompt context. |
| P03 | CAMT plan continuity | Safety | Preview issues a source/plan handle; execution requires it and rejects changed XML, normalized inputs, or plan before mutation. |
| P04 | Reconciliation plan continuity | Safety | Execution confirms only handle-bound matches from the reviewed live-state snapshot and checks every command precondition without substituting new matches. |
| P05 | Lightyear plan continuity | Safety | Trade and distribution execution require handles covering source bytes, inputs, and complete plans; changed CSV or plan fails closed. |
| P06 | Bank transaction type | Safety | CAMT CRDT/DBIT, Wise IN/OUT and fee rows, and direct creation all generate transactions with `type: "C"`. |
| P07 | External-text sandbox coverage | Safety + quality | Lightyear, supplier/registry, and Accounting Inbox display strings receive fresh nonce boundaries while clean machine identity uses canonical values or opaque references. |
| P08 | New-supplier invoice branch | Contract | `book-invoice` never calls a supplier-dependent tool before a new supplier exists and never creates that supplier before explicit approval. |
| P09 | Invoice validation completeness | Root synthesis | Registration/VAT IDs, extraction quality, truncation, OCR provenance/confidence, and material warnings are reviewed before mutation. |
| P10 | VAT booking dimension | Contract | `suggest_booking` returns the historical VAT dimension when present; ambiguity triggers explicit dimension lookup/review. |
| P11 | Receipt result and recovery contracts | Contract + quality | Merged output uses `result.*`; supported image files retain digest-bound create/upload; separate mutation approvals are accurately described. |
| P12 | Wise ownership approval | Contract + safety | Exact ownership-unverified IDs are approved, incorporated into a fresh dry run, and bound to the newly issued plan handle. |
| P13 | Historical overview date consistency | Contract | Balance sheet, P&L, receivables aging, and payables aging use the same selected historical cutoff. |
| P14 | CAMT response paths | Contract | Every documented parse, preview, execute, error, and audit path matches the actual `result.*` wrapper. |
| P15 | Lightyear required arguments | Contract | Summary, trade, distribution, and capital-gains calls state and receive every schema-required argument. |
| P16 | Sales feature awareness | Contract + quality | Sales-disabled MCP prompts never require unavailable sales tools; static commands make those steps explicitly capability-conditional. |
| P17 | Legal-entity identity | Contract + quality | A legal entity cannot be created without an API-valid domestic or foreign registration identifier; natural-person handling is explicit. |
| P18 | Credential preview and tool visibility | Safety + contract | Source and destination state, identity, server, operation, and local-default scope are handle-bound and explicitly approved; startup cannot auto-import a sole candidate. |
| P19 | Approval presentation | Quality + safety | Large plans use compact human summaries and bounded pages without losing complete server-side binding; enumerated batch semantics are unambiguous. |
| P20 | Shared prompt/command wrapper | Quality | MCP prompts and generated commands contain the same untrusted-data rail, approval rules, and language/response contract. |
| P21 | Canonical set equality | Quality | Release validation rejects missing or orphan workflows, registry entries, commands, and README workflow entries/counts. |
| P22 | Behavioral safety tests | Quality + safety | A trace harness proves preview/approval/execution ordering, exact response paths, feature modes, drift/partial-execution handling, malicious inputs, and transaction invariants instead of relying only on phrase presence. |
| P23 | User-language guidance | Quality | Every surface deterministically instructs the consuming model to answer in the conversation language while preserving exact technical keys, IDs, accounts, and statutes; it does not claim to prove arbitrary model compliance. |
| P24 | Canonical tax metadata | Quality | Prompt VAT facts render from versioned runtime metadata and tests prevent divergence from effective-date/source information. |
| P25 | Documentation consistency | Quality + root synthesis | README, architecture, contributor guidance, generated commands, and release metadata describe the actual multi-stage approval and canonical prompt pipeline. |

## Error and recovery contract

New or tightened failures are actionable and distinguish pre-mutation rejection from partial execution:

- JSON-RPC `InvalidParams` (`-32602`): names the safe argument path and format/range requirement without echoing unsafe content.
- `plan_handle_required`, `plan_handle_expired`, or `plan_handle_consumed`: directs the caller to obtain a fresh dry run.
- `plan_drift`: states whether source, invocation, connection, live state, command precondition, or plan changed; if returned before the first mutation, no mutation occurred.
- `partial_execution`: identifies every completed, failed, indeterminate, skipped, and not-attempted command after at least one mutation may have occurred and forbids blind retry.
- `external_text_too_large`: identifies the affected response field/category and applies the established safe truncation policy.
- `material_invoice_warning`: lists the warning and required resolution or explicit acknowledgement before approval.
- `legal_entity_identity_required`: requires an API-valid domestic/foreign registration identifier or an explicit natural-person branch.
- `credential_preview_required`: returns preview data and requires a separate bound approval before persistence.

Errors must preserve existing audit semantics. A rejected handle or validation error records no successful mutation. After the first mutation, the result and audit entry preserve exact partial progress and known IDs. An indeterminate command sets `mutation_may_have_occurred`, invalidates the handle, stops the batch, and follows the established indeterminate-mutation recovery contract.

## Compatibility impact

- Prompt callers continue sending strings as required by MCP; callers that relied on direct native number/boolean callback invocation must use canonical string forms.
- CAMT, reconciliation, Lightyear, and Wise execute calls intentionally become stricter by requiring a current one-attempt server-issued plan handle; Wise retains its command digest as a visible fingerprint.
- Credential import intentionally adds a preview/approval round trip and defaults to local rather than global scope.
- Newly sandboxed MCP output contains visible authenticated boundary markers around untrusted text. Stored values and upstream payloads do not.
- Accounting Inbox recommendations use an opaque `file_ref` for executable identity and a separately sandboxed display path.
- Sales-disabled prompt text becomes a reduced valid variant rather than advertising unavailable tools.
- Bank transaction source direction no longer changes the API `type`; all new bank transactions use `"C"`.
- Safe existing PDF, receipt, Wise, audit, credential-permission, and connection-selection safeguards retain their contracts.

## Implementation waves

The detailed implementation plan will split each wave into small test-first tasks and separate commits. Shared primitives are implemented before consumers; no task may mark a later contract complete merely because it benefits from an earlier helper.

1. **Prompt boundary and canonical registry:** `P01`, `P02`, `P20`, `P21`, `P23`.
2. **Approval binding and presentation:** `P03`, `P04`, `P05`, `P12`, `P18`, `P19`.
3. **Accounting and trust invariants:** `P06`, `P07`.
4. **Workflow/tool contract corrections:** `P08`-`P17` excluding `P12`.
5. **Tax metadata, behavioral coverage, and documentation:** `P22`, `P24`, `P25`.

Each task follows red-green-refactor: add one focused failing regression, observe the intended failure, implement the smallest contract correction, run the focused suite, synchronize generated surfaces if affected, and commit only after independent specification and quality review.

## Verification strategy

Focused verification must include:

- real MCP protocol prompt retrieval with valid and invalid string arguments;
- prompt-schema adversarial tables for booleans, numbers, dates, paths, IDs, JSON shape/depth/size, control characters, and instruction-shaped text;
- plan-handle entropy, expiry, one-attempt, restart, cross-operation, cross-connection, pagination, and replay tests;
- source/live-state drift tests before command 1 and concurrency tests changing preconditions between later commands, including exact `partial_execution` evidence;
- CAMT/Wise direction matrices, Wise fee rows, direct creation, and static call-site checks asserting `type: "C"`;
- hostile external strings for each new response boundary plus clean-value persistence/API assertions, repeated-render and forged-wrapper tests, and an Inbox `file_ref` round trip;
- a workflow trace harness with `PROMPT`, `TOOL_RESULT`, `USER_APPROVAL(scope)`, `TOOL_CALL`, and `MUTATION` events, including negative early-execution and unavailable-tool traces;
- feature-enabled and sales-disabled prompt exposure/content tests;
- set-equality and orphan-file release tests;
- workflow-to-command synchronization checks; and
- tax-metadata-to-prompt equality tests;
- shared prompt/command wrapper assertions for conversation-language guidance while tool names, JSON keys, IDs, official accounts, and statutory citations remain unchanged; and
- rendered prompt-size budget tests for every prompt and generated command.

Final verification, after all focused suites pass:

```bash
npm test
npm run build
npm run test:integration
npm run validate:release
git diff --check
git status --short --branch
```

No final completion claim is allowed until a separate verifier reviews the accepted specification, implementation diff, full command output, generated mirrors, and absence of unintended live mutations.

## Documentation outcomes

- `README.md` describes receipt handling as preview, create/upload approval, then optional confirmation/link approval.
- `ARCHITECTURE.md` documents registry to workflow to MCP/generated-command rendering.
- `AGENTS.md` accurately identifies canonical workflow text and the shared generator/validation path while retaining all safety invariants.
- Generated `.claude/commands` include the same safety wrapper as MCP prompts.
- Tax guidance records source URLs, effective dates, and verification date without presenting the assistant as a substitute for fact-specific professional advice.

## Completion criteria

The remediation is complete only when:

1. `P01` through `P25` each have a regression test and acceptance evidence.
2. All affected runtime and generated surfaces agree on names, arguments, paths, feature availability, approval scope, and response shape.
3. CAMT, reconciliation, Lightyear, and Wise cannot act outside a current server-issued plan; PDF and receipt paths continue to reject every change covered by their source/manifest contracts; credential persistence rejects source or destination drift.
4. Every bank transaction create call site, including CAMT, Wise main/fee, and direct creation, can emit only `type: "C"`.
5. Every reviewed external-text source is nonce-sandboxed at the model boundary and clean at persistence/write boundaries.
6. Full unit, build, integration, release, diff, and worktree checks pass.
7. Separate specification, code-quality, and final-verification reviews report no unresolved findings.
