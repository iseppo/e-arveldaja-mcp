# Prompt Contract Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: use `superpowers:test-driven-development` for every behavior change, `superpowers:subagent-driven-development` for execution and reviews, and `superpowers:verification-before-completion` before any completion claim. Track work with the checkboxes below.

**Goal:** Implement accepted contracts `P01`–`P25` so all prompts work through real MCP string transport, reviewed mutation scopes are stable, all bank transactions use type `C`, external text remains inert, and canonical prompt surfaces cannot drift.

**Architecture:** Five sequential waves establish strict prompt parsing and one registry; shared server plans, immutable inputs, partial-execution tracking, and opaque file references; importer/reconciliation integrations; workflow/tool repairs; then behavioral and release verification. Consumers reuse runtime services injected once from `main()`. Existing PDF, receipt, Wise-digest, audit, credential-permission, symlink, and connection-switch safeguards remain intact.

**Tech stack:** TypeScript 7, Node.js >=18 ESM, Vitest 4, MCP SDK 1.29, Zod 4, `tsx`, and Node standard-library crypto/filesystem APIs.

## Global execution contract

- Work in an isolated worktree created with `superpowers:using-git-worktrees`; never implement directly on `master`.
- Before Task 1, record repository/branch, Node/npm versions, `npm test`, `npm run build`, `npm run test:integration`, and `npm run validate:release` in ignored `.omc/prompt-remediation-ledger.md`.
- Every task follows red-green-review-commit: add the named regression, observe and record its intended failure, implement only that contract, run focused green tests plus `git diff --check`, obtain separate specification and quality approval, commit, record evidence, and require clean status.
- Edit canonical `workflows/*.md` before generated commands. After every workflow edit run `npm run sync:workflow-prompts`; commit source and mirrors together.
- No test performs a live accounting mutation. Use mocks, fixtures, temporary directories, linked in-memory MCP transports, and existing integration safety controls.
- A plan handle binds continuity and scope but does not prove human consent. Trace tests include matching `USER_APPROVAL` before mutation.
- The upstream API has no ETag/conditional-write contract. Reuse locks and refresh exact preconditions immediately before each command; document the residual cross-process check/write race and fail closed whenever drift is observable.
- `captureInternalToolHandlers` and every public/captured CAMT, Wise, receipt, reconciliation, Lightyear, credential, and Inbox registrar receive the same mandatory `RuntimeSafetyContext`. No production or test path may create an implicit fallback store.
- Resolve a failed task before the next one. Never weaken an assertion or approval gate to make a suite pass.

## Mandatory named red evidence

Each task must create these named cases before production edits and record the stated failure. Additional cases remain required by the task body.

| Task | Required red case | Expected red evidence |
|---|---|---|
| 1 | `parses exact false and rejects truthy aliases` | prompt-argument module is absent; after creation the first run must fail on current permissive/unfinished parser behavior. |
| 2 | `keeps a hostile identifier wholly inside one fresh data boundary` | current renderer interpolates the identifier into prose and lacks an authenticated argument boundary. |
| 3 | `retrieves every prompt through Client.getPrompt using strings` | numeric/boolean prompt arguments return SDK `-32602` before callback. |
| 4 | `rejects orphan commands workflows registry rows and README count drift` | current one-way validator returns no error for at least the orphan-command fixture and generated commands lack the shared wrapper. |
| 5 | `renders purchase-only MCP prompts when sales are disabled` | current prompt still names `compute_receivables_aging`/sale actions. |
| 6 | `renders identical dated VAT facts from one metadata object` | current prompt/workflow facts are independent literals and metadata lacks accepted URLs/date structure. |
| 7 | `consumes a cross-connection execute attempt exactly once` | plan store/context symbols do not exist. |
| 8 | `reports completed command 1 and not-attempted command 3 after command 2 drifts` | shared execution tracker/partial contract does not exist. |
| 9 | `routes a hostile Inbox filename through a clean opaque file_ref` | current public recommendation exposes/reuses raw path text and no ref store exists. |
| 10 | `creates CAMT CRDT Wise IN fee and direct bank rows only as C` | current CRDT/IN/direct paths can forward `D`. |
| 11 | `rejects changed CAMT bytes with plan_drift and zero creates` | execute currently rereads/replans from path with no handle. |
| 12 | `stops reconciliation after one confirmed match when the second precondition changes` | current execute recomputes/continues without stored command preconditions. |
| 13 | `rejects a trade handle for distributions and wraps hostile ticker freshly` | Lightyear execute has no scoped handle and raw output fields remain. |
| 14 | `requires a new Wise plan after exact ownership IDs are approved` | current workflow/runtime can reuse the original digest cycle and has no server handle. |
| 15 | `previews a sole credential candidate locally without writing` | startup currently imports after scope elicitation and credential tool writes in one call. |
| 16 | `blocks a legal entity without an API-valid registration identity before create` | current legal create path can reach API with missing code. |
| 17 | `branches new invoice suppliers without calling suggest_booking` | current workflow unconditionally requires a nonexistent supplier ID. |
| 18 | `uses result.execution paths and one historical as_of_date` | current receipt paths are top-level and aging calls omit the chosen date. |
| 19 | `rejects mutation traces lacking matching USER_APPROVAL scope` | trace model/assertion does not exist and phrase tests cannot reject the trace. |
| 20 | `documents the canonical prompt pipeline and staged receipt approvals` | current architecture/contributor/README text contradicts the accepted pipeline. |

For every row, the green run must prove the named case passes for the intended reason; deleting or weakening the case is forbidden.

## Wave 1 — Prompt transport and canonical surfaces

### Task 1: P01/P02 — Strict MCP string argument helpers

**Files:** create `src/prompt-arguments.ts`, `src/prompt-arguments.test.ts`.

- [ ] Red-test helpers for positive integers, finite numbers, exact booleans, real ISO dates, months, absolute paths, identifiers, and JSON objects. Require `"false" → false`; reject empty/noncanonical numbers, impossible dates, relative/control-character paths, root arrays, dangerous keys, and excessive size/depth/nodes/keys.
- [ ] Implement limits: identifier 512 chars, path 4096 chars, JSON 20,000 bytes, depth 8, nodes 512, keys/object 128. Use non-echoing errors; never use truthiness or generic coercion.
- [ ] Verify: `npx vitest run src/prompt-arguments.test.ts && git diff --check`.
- [ ] Review and commit: `feat(prompts): add strict MCP string argument parsers`.

### Task 2: P02/P20/P23 — Authenticated shared prompt wrapper

**Files:** create `src/prompt-surface.ts`, `src/prompt-surface.test.ts`; modify `src/workflow-prompt-source.ts`, `src/prompts.test.ts`.

- [ ] Red-test hostile newlines, fake nonce markers, Markdown fences, and approval-bypass prose. Two renders need different fresh outer nonces, no value outside the data envelope, and length ≤64,000 chars.
- [ ] Require the wrapper to classify file/OCR/CSV/XML/registry/API/filesystem text as evidence; say a plan handle is not human approval; preserve stop gates; follow conversation language while keeping exact technical tokens.
- [ ] Move month dates, requested transaction ID, and supplier-search hints into canonical sorted `derived` JSON. Remove raw identifier prose and Markdown-fenced arguments. Apply the same bounded wrapper to setup mode.
- [ ] Verify: `npx vitest run src/prompt-surface.test.ts src/prompts.test.ts && git diff --check`.
- [ ] Review and commit: `feat(prompts): confine run data behind shared safety wrapper`.

### Task 3: P01/P21 — Canonical registry and real protocol tests

**Files:** create `src/prompt-registry.ts`, `src/prompt-registry.test.ts`, `src/prompt-protocol.test.ts`; modify `src/prompts.ts`, `src/workflow-prompt-source.ts`, `src/mcp-compat.ts`, `src/prompts.test.ts`, `src/tools/tool-exposure.test.ts`.

- [ ] Add linked `McpServer`/`Client` tests with `InMemoryTransport.createLinkedPair()` and `Client.getPrompt()` for all 16 prompts using string arguments. Prove current numeric strings fail red with SDK `InvalidParams (-32602)`.
- [ ] Test valid/invalid booleans, numbers, IDs, dates, paths, and JSON. Assert safe bounded error paths/requirements without pinning the SDK's complete message or echoing malicious input.
- [ ] Create `PROMPT_REGISTRY` definitions owning name, slug, description, transformed schema, setup options, feature predicate, and variants. Export names/slugs/enabled definitions; make `registerPrompts` iterate it and remove duplicate maps/call lists.
- [ ] Verify: `npx vitest run src/prompt-arguments.test.ts src/prompt-registry.test.ts src/prompt-protocol.test.ts src/prompts.test.ts src/tools/tool-exposure.test.ts && npm run build`.
- [ ] Review and commit: `refactor(prompts): register workflows from canonical registry`.

### Task 4: P20/P21/P23 — TypeScript command generation and set equality

**Files:** create `scripts/prompt-surface-files.ts`; replace both prompt `.mjs` scripts with `.ts`; modify `package.json`, `src/release-metadata.test.ts`, `src/release-smoke.test.ts`, `scripts/release-smoke-helpers.mjs`; regenerate all commands.

- [ ] Red-test that generated commands lack the shared wrapper and validation misses orphan workflow/command/registry/README entries, duplicates, and wrong count.
- [ ] Run sync/validation through existing `tsx` and import the TypeScript registry directly. Generate commands from registry definitions and shared wrapper.
- [ ] Enforce registry slugs ↔ workflows ↔ command filenames and registry names/count ↔ README workflow table/count, plus exact generated content. Make packed smoke import `dist/prompt-registry.js`.
- [ ] Enumerate every enabled/disabled MCP prompt with maximum valid arguments and every generated command; assert each complete rendered surface stays within the 64 KiB budget.
- [ ] Verify: `npm run sync:workflow-prompts && npx vitest run src/prompt-surface.test.ts src/release-metadata.test.ts src/release-smoke.test.ts && npm run build && npm run validate:release`.
- [ ] Review and commit: `build(prompts): generate and validate canonical prompt surfaces`.

### Task 5: P16 — Runtime sales variants and static capability branches

**Files:** modify prompt registry/rendering, `workflows/company-overview.md`, `workflows/month-end.md`, prompt/protocol/exposure tests; regenerate two commands.

- [ ] Red-test sales-disabled MCP prompts omit receivables/sale-invoice calls and claims but retain purchases/payables/reports; enabled mode stays complete.
- [ ] Red-test static commands place sales calls inside an advertised-tool capability condition and never probe by calling a missing tool.
- [ ] Implement explicit feature sections: runtime removes/retains from `enableSales`; static rendering converts them to safe capability branches.
- [ ] Verify sync plus `npx vitest run src/prompt-protocol.test.ts src/prompts.test.ts src/tools/tool-exposure.test.ts && npm run validate:release`.
- [ ] Review and commit: `fix(prompts): render sales-aware workflow variants`.

### Task 6: P24 — Versioned VAT prompt metadata

**Files:** modify `src/estonian-tax-rules.ts`, its tests, prompt registry, `src/tools/estonian-tax.ts`, VAT workflow, protocol tests; regenerate VAT command.

- [ ] Red-test one canonical object: threshold 40,000 EUR; scope effective 2025-01-01; rates 24/13/9/0; standard rate effective 2025-07-01; verified 2026-07-19; three accepted EMTA URLs.
- [ ] Add version/date/source/rule metadata; retain old public constants as projections. Render descriptions/workflow tokens from it and reject unresolved tokens.
- [ ] Verify sync plus `npx vitest run src/estonian-tax-rules.test.ts src/prompt-protocol.test.ts src/prompts.test.ts src/tools/estonian-tax.test.ts && npm run validate:release`.
- [ ] Review and commit: `fix(tax): render prompt facts from canonical metadata`.

## Wave 2 — Shared runtime safety primitives

### Task 7: P03/P04/P05/P12/P18/P19 — Runtime context and plan store

**Files:** create `src/runtime-safety-context.ts`, `src/plan-store.ts`, `src/plan-store.test.ts`, `src/__fixtures__/runtime-safety.ts`; modify `src/index.ts`. Do not change consumer registrar signatures in this commit.

- [ ] Red-test 32-byte base64url handles, immutable cloned data, ten-minute TTL, max 128 active plans, no active eviction, server-instance locality, cross-domain/connection rejection, one-attempt consumption, replay tombstones, restart invalidation.
- [ ] Construct one `RuntimeSafetyContext` in `main()`. `getActiveScope()` returns connection index/generation/name/fingerprint, live/demo URL, feature config, and server identity from the invocation snapshot. Add a deterministic explicit `createTestRuntimeSafetyContext()` fixture for later registrar tests; it is never a production fallback.
- [ ] Store `execution_plan_v1`: normalized args, clean source identities/digests, live snapshot, ordered stable command IDs, counts/totals, exclusions/reviews, scope/domain/times, and private payload. Consume atomically before execute validation; expose no constructible token data.
- [ ] Verify: `npx vitest run src/plan-store.test.ts && npm run build && git diff --check`.
- [ ] Review and commit: `feat(runtime): add bounded server-issued execution plans`.

### Task 8: P19/P22 — Plan pages and partial execution

**Files:** create `src/plan-execution.ts`, tests, `src/plan-tools.ts`, tests; modify batch/workflow response modules/tests and `src/index.ts`.

- [ ] Red-test exact command partitions, known IDs, audit reference, `mutation_may_have_occurred`, retry prohibition, and `plan_drift` only before attempted mutation.
- [ ] Red-test read-only `get_execution_plan_page`: 50-command pages, deterministic totals/ranges, handle-bound cursor, fresh nonce, no TTL extension/consumption.
- [ ] Implement shared tracker, additive `batch_execution_v1` fields, stop-on-first drift/failure/indeterminate, and one registered page tool. Preserve handles/counts/exclusions through hidden/merged workflow mapping.
- [ ] Verify: `npx vitest run src/plan-execution.test.ts src/plan-tools.test.ts src/workflow-response.test.ts && git diff --check`.
- [ ] Review and commit: `feat(runtime): add paged plan scope and partial execution`.

### Task 9: P07 — Immutable snapshots and opaque file references

**Files:** create `src/file-input-snapshot.ts`, tests, `src/file-reference-store.ts`, tests; modify Accounting Inbox/autopilot, receipt, CAMT, Wise, reconciliation, Lightyear, their registrar signatures and all call sites, `src/index.ts`, `src/__fixtures__/runtime-safety.ts`, `src/tools/accounting-inbox.test.ts`, `src/tools/receipt-inbox-tools.test.ts`, `src/tools/receipt-inbox-path.test.ts`, `src/tools/camt-import-tools.test.ts`, `src/tools/wise-import.test.ts`, `src/tools/bank-reconciliation.test.ts`, `src/tools/lightyear-investments.test.ts`, and `src/tools/tool-exposure.test.ts`.

- [ ] Red-test one-read immutable bytes for local/base64 inputs. Inline plans retain digest/identity only and require matching resubmitted bytes, not 10 MB stored arguments.
- [ ] Red-test opaque expiring server-local file/directory refs, exact canonical resolution, wrong-kind/forged/expired rejection, and exactly one of direct path/ref.
- [ ] Red-test hostile Inbox names/paths/reasons: public sandboxed display plus clean `file_ref`; routed CAMT/Wise/receipt calls resolve the exact clean path.
- [ ] Atomically make `RuntimeSafetyContext` mandatory for every affected public registrar and `captureInternalToolHandlers`; update every production registration and existing test call site to pass either the server context or explicit deterministic test fixture. Compile errors or missing context must fail; no default/fallback store is allowed.
- [ ] Inject the same stores through public and Inbox-captured registrars. Keep direct absolute paths supported; execution uses the verified snapshot without reopening.
- [ ] Add cross-surface tests: a ref issued by Accounting Inbox resolves through the corresponding public/merged CAMT, Wise, or receipt handler on the same context; it fails on another server instance, wrong kind, and wrong operation.
- [ ] Before refactoring, record passing characterization for receipt allowed-root/symlink/digest/manifest behavior with `src/tools/receipt-inbox-path.test.ts` and `src/tools/receipt-batch-failure.test.ts`; rerun both green before commit.
- [ ] Verify every changed registrar remains green in the same commit: `npx vitest run src/file-input-snapshot.test.ts src/file-reference-store.test.ts src/tools/accounting-inbox.test.ts src/tools/receipt-inbox-tools.test.ts src/tools/receipt-inbox-path.test.ts src/tools/camt-import-tools.test.ts src/tools/wise-import.test.ts src/tools/bank-reconciliation.test.ts src/tools/lightyear-investments.test.ts src/tools/tool-exposure.test.ts && npm run build && git diff --check`.
- [ ] Review and commit: `feat(runtime): bind inbox paths to opaque file references`.

### Task 10: P06 — Bank transaction type `C` everywhere

**Files:** create `src/bank-transaction-create.ts`, tests; modify direct transaction CRUD, CAMT, Wise, their tests, and `src/index.ts`.

- [ ] Red-test direct create, CAMT CRDT/DBIT, Wise IN/OUT, fees, and inter-account payloads all call `api.transactions.create` with `type:"C"` while retaining direction in metadata/distributions.
- [ ] Add static call-site coverage. Remove caller control of direct type or overwrite it after validation; decouple Wise direction logic before constant API type.
- [ ] Replace server instructions that preserve imported type with the absolute invariant.
- [ ] Verify: `npx vitest run src/bank-transaction-create.test.ts src/tools/crud-tools.test.ts src/tools/camt-import-tools.test.ts src/tools/wise-import.test.ts && git diff --check`.
- [ ] Review and commit: `fix(transactions): enforce type C on every bank transaction create`.

## Wave 3 — Plan-bound mutation workflows

### Task 11: P03/P14 — CAMT plans and merged paths

**Files:** modify CAMT tool/tests, workflow response/Inbox and its capture tests, `workflows/import-camt.md`, prompt tests; regenerate command.

- [ ] Red-test dry run handle/scope, mandatory execute handle, source/arg/dimension/connection/client/duplicate drift, replay, immutable single read, per-command recheck, partial command 2, and indeterminate stop.
- [ ] Extract pure CAMT planner/projector/executor with stable IDs and shared tracker. Granular and merged execute both require/forward handle.
- [ ] Prove a CAMT handle produced through the Inbox-captured dry run is consumable by the public merged executor sharing that context and rejected by Wise/reconciliation or a second context.
- [ ] Correct workflow paths to `result.statement_metadata`, `result.summary.*`, `result.execution.*`, errors/audit; add handle/page approval guidance.
- [ ] Verify sync plus `npx vitest run src/tools/camt-import-tools.test.ts src/prompts.test.ts src/workflow-response.test.ts && npm run validate:release`.
- [ ] Review and commit: `feat(camt): bind execution to immutable reviewed plans`.

### Task 12: P04/P19 — Reconciliation plans

**Files:** modify reconciliation tool/tests, transaction API/tests, workflow response, Accounting Inbox capture/tests, reconciliation workflow/prompt tests; regenerate command.

- [ ] Red-test exact/inter-account execute handles, no match substitution, bound statuses/clients/amounts/currency/open balance/distributions, explicit client-update command, immediate rechecks, and partial confirm/delete failures.
- [ ] Use stable IDs and existing locks. One approval may cover one enumerated batch; any subset/account/category change creates a new plan.
- [ ] Prove Inbox-captured and public reconciliation handlers share the same plan store and reject CAMT/Wise/second-context handles.
- [ ] Verify sync plus `npx vitest run src/tools/bank-reconciliation.test.ts src/api/transactions.api.test.ts src/prompts.test.ts src/workflow-response.test.ts && npm run validate:release`.
- [ ] Review and commit: `feat(reconciliation): execute only reviewed match plans`.

### Task 13: P05/P07/P15 — Lightyear plans and sandboxing

**Files:** modify Lightyear tool/tests, workflow response, Accounting Inbox recommendation/capture tests where Lightyear is routed, Lightyear workflow/prompt tests; regenerate command.

- [ ] Red-test distinct trade/distribution handles binding both source files, args/defaults, journals, full commands; cross-domain rejection; source/live drift; immutable reads; later partial execution.
- [ ] Fresh-sandbox references, tickers, names, conversion/FX provenance, duplicates, warnings/results on normal/page output while internal matching/audit/API stays clean.
- [ ] Prove public/page/Inbox-projected output uses the same stored clean plan and cross-domain/second-context handles are rejected.
- [ ] Document exact required args: summary path; trades path/investment/broker/mapped gains file; distributions path/broker/income; execute reuses reviewed optional args and handle.
- [ ] Verify sync plus `npx vitest run src/tools/lightyear-investments.test.ts src/prompts.test.ts src/workflow-response.test.ts && npm run validate:release`.
- [ ] Review and commit: `feat(lightyear): bind booking to immutable reviewed plans`.

### Task 14: P12/P19 — Wise handles and ownership re-preview

**Files:** modify Wise tool/tests, workflow response, Accounting Inbox capture/tests, Wise workflow/prompt tests; regenerate command.

- [ ] First characterize the existing digest as passing. Then red-test: digest without handle cannot execute; every attempt consumes; source/arg/live/command drift stops; later failure returns partial sets.
- [ ] Red-test ownership sequence: preview exact unverified IDs, approve IDs only, new preview with exact confirmations, reject old handle/digest, approve/execute new plan. Extra/missing/reordered decisions invalidate it.
- [ ] Compare clean projected fields rather than deterministic wrapper bytes. Present grouped totals/exceptions plus paged detail rather than a whole-plan dump.
- [ ] Prove a Wise handle from the Inbox-captured dry run executes only in the public Wise handler sharing that context and is rejected cross-domain/second-context.
- [ ] Verify sync plus `npx vitest run src/tools/wise-import.test.ts src/prompts.test.ts src/workflow-response.test.ts && npm run validate:release`.
- [ ] Review and commit: `feat(wise): require server plans and fresh ownership approval`.

### Task 15: P18 — Credential preview plans and safe startup

**Files:** create `src/credential-plans.ts`, tests, `src/tools/credential-tools.ts`, tests; modify config/startup/index/tests, both setup workflows, prompt/exposure tests; regenerate commands.

- [ ] Split credential read/verify/target projection from commit. Privately bind secret snapshot, company/server, source/destination, slot, scope, operation, overwrite, permissions, destination state; expose no secrets/reusable hashes.
- [ ] Red-test preview writes nothing; execute requires one-attempt handle; all source/destination/scope/operation drift rejects before write; commit rechecks under existing owned lock and retains atomic private writes.
- [ ] Make import/remove preview-first with `execute`/`plan_handle`; local default. Reroute sole-candidate startup through preview and persist only after accepted elicitation bound to exact handle.
- [ ] Make setup workflows capability-aware; hidden tools require `EARVELDAJA_EXPOSE_SETUP_TOOLS=1` and restart guidance.
- [ ] Preserve private `0600` writes, regular-file checks, symlink refusal, non-truncating permission repair, and connection-switch safety. Record their passing characterization before edits.
- [ ] Verify sync plus `npx vitest run src/credential-plans.test.ts src/tools/credential-tools.test.ts src/startup-credential-import.test.ts src/config.test.ts src/connection-safety.test.ts src/prompts.test.ts src/tools/tool-exposure.test.ts && npm run validate:release`.
- [ ] Review and commit: `feat(credentials): require preview approval for persistence`.

## Wave 4 — Coupled workflow/tool contracts

### Task 16: P17 — Legal-entity identity gate

**Files:** create `src/legal-entity-identity.ts`, tests; modify client CRUD, supplier resolution, receipts, identifier helper, tests, new-supplier/book-invoice workflows; regenerate commands.

- [ ] Red table: valid Estonian checksum passes; missing/invalid/VAT-only fails; foreign registration needs non-forwarded accountant attestation; explicit natural person passes.
- [ ] Validate before API/audit. Supplier/receipt auto-create returns `legal_entity_identity_required` and creates neither supplier nor invoice. Reuse duplicate search; never forward attestation.
- [ ] Preserve receipt `approved_manifest`, source digest, partial-failure recovery, and allowed-path checks while adding the identity gate.
- [ ] Verify sync plus `npx vitest run src/legal-entity-identity.test.ts src/tools/crud-tools.test.ts src/tools/supplier-resolution.test.ts src/tools/receipt-inbox-tools.test.ts src/tools/receipt-batch-failure.test.ts src/tools/receipt-inbox-path.test.ts src/prompts.test.ts`.
- [ ] Review and commit: `fix(clients): require verified legal entity identity`.

### Task 17: P08/P09/P10 — Invoice supplier branch and validation evidence

**Files:** modify PDF workflow/tests, `workflows/book-invoice.md`, prompt tests; regenerate command.

- [ ] Red-test only existing suppliers call `suggest_booking`; new suppliers use supplier-independent articles/accounts/dimensions and are created only after approval.
- [ ] Pass `reg_code`/`vat_no`; approval includes truncation/length, OCR failures/confidence, provenance, notes/fallback, warnings, and resolution/acknowledgement of material warnings.
- [ ] Return historical `vat_accounts_dimensions_id`; missing/ambiguous dimension requires explicit lookup/selection.
- [ ] Verify sync plus `npx vitest run src/tools/pdf-workflow.test.ts src/prompts.test.ts && npm run validate:release`.
- [ ] Review and commit: `fix(invoice-workflow): branch suppliers and preserve validation evidence`.

### Task 18: P07/P11/P13/P25 — Remaining output/workflow alignment

**Files:** modify external renderer, PDF/supplier/receipt output and tests, receipt/company workflows, prompt tests, README; regenerate commands.

- [ ] Red-test supplier/registry/receipt display text gets fresh outer boundaries while IDs/dates/amounts stay typed and matching/audit/rules/API use clean values.
- [ ] Add a per-surface adversarial matrix for Lightyear, supplier/registry, and Inbox public/page/merged fields: newline directives, forged matching-looking wrappers, repeated render, fake closing delimiter, oversized/truncation metadata or `external_text_too_large`, and clean persistence/match/audit/API values.
- [ ] Correct receipt paths to `result.*`; use digest-bound PDF/JPG/JPEG/PNG recovery; plain create only for structured/no-file input; keep separate create/upload and confirm/link approvals.
- [ ] Pass one selected `as_of_date` to both aging calls and statements. Update README to remove the contradictory “all in one pass” receipt claim.
- [ ] Verify sync plus `npx vitest run src/external-text-renderer.test.ts src/tools/lightyear-investments.test.ts src/tools/pdf-workflow.test.ts src/tools/supplier-resolution.test.ts src/tools/receipt-inbox-tools.test.ts src/tools/receipt-batch-failure.test.ts src/tools/receipt-inbox-path.test.ts src/prompts.test.ts && npm run validate:release`.
- [ ] Review and commit: `fix(workflows): align paths dates and external text`.

## Wave 5 — Behavioral proof and release gate

### Task 19: P22 — Workflow trace harness

**Files:** create `src/workflow-trace.ts`, `src/workflow-trace.test.ts`, `src/prompt-safety-invariants.test.ts`; add only needed trace adapters.

- [ ] Define `PROMPT`, `TOOL_RESULT`, `USER_APPROVAL(scope)`, `TOOL_CALL`, `MUTATION` with stable workflow/tool/plan/manifest/source IDs.
- [ ] Red-test every mutating prompt: no mutation before matching approval; no unavailable tool; every mutation lies inside approved scope; subset/category/account changes require new preview; early execute/stale handles fail.
- [ ] Cover CAMT, reconciliation, Lightyear, Wise ownership, credentials, supplier creation, receipt create/upload then confirmation/linking, and prepared review actions.
- [ ] Re-run exhaustive max-argument surface budgets for every enabled/disabled MCP prompt and all generated commands; include the shared wrapper exactly once.
- [ ] Verify: `npx vitest run src/workflow-trace.test.ts src/prompt-safety-invariants.test.ts src/prompt-protocol.test.ts src/prompts.test.ts && git diff --check`.
- [ ] Review and commit: `test(prompts): prove workflow approval invariants`.

### Task 20: P25 — Documentation and final verification

**Files:** create `src/documentation-contract.test.ts`; modify `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md`.

- [ ] Red-test docs describe registry → workflow → shared renderer → MCP/command pipeline; string arguments; plan handle versus approval; sales variants; file refs; staged receipts; dated tax metadata; sync/validation.
- [ ] Correct the claim that prompt text lives in `src/prompts.ts`; update Unreleased changelog for P01–P25; keep README table/count validator-compatible.
- [ ] Run focused documentation/release tests and commit all documentation/generated output first: `docs(prompts): document completed safe prompt pipeline`.
- [ ] On the committed tree, run final gates: `npm test`, `npm run build`, `npm run test:integration`, `npm run validate:release`, `git diff --check`, `git status --porcelain`.
- [ ] Dispatch a fresh final verifier with accepted spec, plan, complete committed diff/ledger/outputs. Require checks for no live mutation; PDF digest and receipt manifest preservation; credential permissions/symlink refusal; connection-switch interruption; one-attempt handles; shared Inbox context; immutable sources; stop-on-first-failure; Wise digest compatibility; adversarial sandbox coverage; and no credential secrets.
- [ ] Resolve every finding in a new reviewed commit, rerun the complete post-commit gates and verifier, and require empty `git status --porcelain` with zero pending tasks.

## Completion evidence

The branch is ready only when all 20 tasks are committed; P01–P25 have ledger evidence; unit/build/integration/release/diff checks pass from a clean isolated worktree; every command matches canonical output; and a non-authoring verifier approves the branch. Do not push, merge, or delete the worktree without separate user instruction.
