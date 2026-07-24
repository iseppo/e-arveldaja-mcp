# Architecture, Token Budget, and Guided UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `e-arveldaja-mcp` into a modular monolith with typed application operations, compact paged responses, opaque workflow state, and an opt-in guided surface of no more than 20 tools while preserving all accounting safety and full-profile compatibility.

**Architecture:** Keep the MCP server as one process. MCP registrations become thin adapters over typed operations; pure policies remain independent of MCP, HTTP, filesystem, and presentation code. Guided responses use versioned compact contracts and server-side handles, while `standard` and `full` retain compatibility until a documented major-release migration.

**Tech Stack:** TypeScript 7, Node.js 18+, MCP SDK 1.29, Zod 4, Vitest 4, TOON with lossless JSON fallback, existing `ExecutionPlanStore`, `FileReferenceStore`, `RuntimeSafetyContext`, and e-arveldaja API adapters.

---

## 1. Verified starting point

- Repository root: `/home/seppo/Dokumendid/e_arveldaja/e-arveldaja-mcp`
- Source specification: `/home/seppo/Dokumendid/e_arveldaja/e-arveldaja-mcp-coding-agent-plan.md`
- Branch: `master`
- Baseline commit: `d22559ca70263fe996daaffc111aad5b7e5c00e1`
- Package version: `0.24.0`
- Worktree at planning time: clean
- Existing verification gates: `npm test`, `npm run build`, `npm run test:integration`, `npm run validate:release`, `npm run smoke:package`, and `git diff --check`

The source plan and current checkout are aligned, so no rebase or baseline-adaptation PR is required.

## 2. Delivery choice and PR boundaries

Three sequencing options were considered:

1. **Literal 15-PR sequence:** closest to the source document, but PR 6 and PR 8 combine independent areas and are likely to become too large to review safely.
2. **Journey-first vertical slices:** produces visible UX sooner, but duplicates response/store infrastructure and risks building façades over the current serialized MCP-handler delegation.
3. **Dependency-first hybrid (recommended):** preserve the source order and release milestones, but split receipt/classification and guided façades into smaller PRs. This keeps behavior-preserving refactors separate from public UX changes and closes the missing typed-Wise dependency for `process_bank_input`.

Use the third option. The resulting series is:

| Order | PR | Outcome | Depends on |
|---:|---|---|---|
| 1 | PR 0 | Measurement and golden contract baseline | none |
| 2 | PR 1 | Tool catalog metadata and opt-in profiles | PR 0 |
| 3 | PR 2 | Compact response and byte-budget infrastructure | PR 0 |
| 4 | PR 3 | Workflow state store and `workflow_action_v2` | PR 2 |
| 5 | PR 4 | CAMT typed operations | PR 2 |
| 6 | PR 4B | Wise typed operations | PR 2 |
| 7 | PR 5 | Reconciliation typed operations | PR 2 |
| 8 | PR 6A | Receipt batch typed operations | PR 2 |
| 9 | PR 6B | Classification typed operations | PR 2, PR 6A |
| 10 | PR 7 | Accounting Inbox typed orchestration | PR 3-6B |
| 11 | PR 7A | Deterministic company/account/supplier resolution | PR 4B-7 |
| 12 | PR 8A | Guided bank façade | PR 1-5, PR 7A |
| 13 | PR 8B | Typed document operation and guided façade | PR 1-3, PR 6A, PR 7A |
| 14 | PR 8C | Typed report/record/sales operations and guided façades | PR 1-3 |
| 15 | PR 9 | Persisted defaults, elicitation, and interaction style | PR 8A-8C |
| 16 | PR 10 | Trim configured instructions and add release notices | PR 1, PR 8A |
| 17 | PR 11 | Runtime bootstrap decomposition | PR 1-10 |
| 18 | PR 12 | Mutation request types and critical codecs | PR 4-11 |
| 19 | PR 13 | Money cents and direction contracts | PR 4, PR 5, PR 12 |
| 20 | PR 14 | Optional incident correlation and HTTP presentation cleanup | PR 11-13 |

PRs 1 and 2 can be developed independently after PR 0, but merge them in table order so every later branch has the same golden baseline.

### Resolved deviations from the source specification

Deliberate plan-level decisions, recorded so reviewers do not rediscover them by diffing against the spec:

1. **Interim guided inventory (PR 1) is plan-invented scaffolding.** The spec defines only the final guided surface; the 17/19-tool interim inventory exists so guided is testable from PR 1 onward. It temporarily exposes granular names (`process_camt053`, `import_wise_transactions`) to guided users until PR 8A/8C replace them.
2. **Release grouping differs from the spec's A/B/C content grouping.** PR order follows the spec, but workflow handles ship in Release A (spec: B), and receipt/classification/Inbox typed operations merge before the Release B tag (spec: C) because the guided façades depend on them. Section 8's gates are the binding definition.
3. **`get_operation_result_page` and the operation-result store are additions.** Spec plan pages are review-only and die with plan consumption; paging post-execution detail needs a third mechanism. Budget consequence: base guided is 19 of 20 tools and `guided-sales` sits exactly at the 20-tool hard cap — zero headroom for future guided tools without merging existing ones.
4. **`get_workflow_page` is registered unconditionally**, though the spec adds it only if `get_execution_plan_page` cannot represent the details: non-plan workflow state has no plan handle, so plan paging cannot cover it.
5. **Setup choice 3 ("Bookkeeping plus investments") maps to `standard`**, not a guided-tier profile — no `guided-investments` is invented without a single guided investment façade and a proven <=20-tool budget.
6. **The compatibility window is three minor releases** (`v0.25.x`-`v0.27.x`); the spec requires at least one. Legacy `workflow_state_json`/`review_item_json` removal is therefore deferred to the next major.
7. **`ToolMeta.feature` is a 14-value superset** of the spec's 8 values, needed to classify the entire existing surface.
8. **`server-instructions.ts` is created in PR 10** (the spec files it under PR 11) because PR 10 owns the instruction trim; the PR 11 snapshot reviewer should expect it to pre-exist.
9. **`structuredContent`/`outputSchema` (spec 7.5, marked optional) is deferred** beyond this program; no task emits it.

## 3. Non-negotiable invariants for every PR

- Preview/dry-run remains the default before material mutations.
- A file reference, workflow handle, or plan handle never records or implies approval.
- Execution plan handles remain scope-bound, single-use, finite-lived, and drift-checked.
- Connection generation and in-flight mutation protections remain intact.
- OCR, CAMT, CSV, registry, and upstream error text remains sandboxed at the MCP boundary.
- Indeterminate mutation outcomes are never retried automatically.
- Receipt create/upload and receipt confirm/link remain separate approvals.
- Compact responses always include blockers, scope (active company/connection, source identity, affected account, date range), financial totals with currencies, object counts by type, duplicates, errors/unresolved review items, partial/destructive/indeterminate state, and the exact approval action — the full source-spec 2.3 approval-summary list; presenter tests assert every field.
- `standard` and `full` public schemas remain compatible unless the PR explicitly adds a versioned contract or `response_detail` switch.
- Do not combine behavior changes with file moves, broad renames, or bootstrap decomposition.

## 4. Standard execution loop for each PR

Each task below specifies the focused tests and implementation files. Within each PR, perform this loop in order:

- [ ] Add the named failing contract/unit tests before production code.
- [ ] Run the focused Vitest files and confirm the new assertions fail for the intended missing behavior.
- [ ] Implement only the production changes named in that task.
- [ ] Re-run the focused tests until green.
- [ ] Run `npm test`, `npm run build`, and `npm run test:integration`.
- [ ] If the task changes tools, prompts, docs, packaging, or public metadata, also run `npm run validate:release` and `npm run smoke:package`.
- [ ] Run `git diff --check`, inspect `git diff --stat` and `git diff`, then commit only the task files with the specified message.
- [ ] Record before/after bytes for token work and before/after call counts for journey work in the PR description.

Do not start the next task until the current PR passes its complete gate.

**Documentation file scope:** Tasks 2-20 each also modify the relevant sections of `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, `CLAUDE.md`, and `CHANGELOG.md`. Public-surface tasks document profile/schema/migration behavior; internal architecture tasks update module/dependency maps and working conventions. `src/documentation-contract.test.ts` must be updated in the same PR so stale tool names, counts, contracts, or architecture claims fail before merge.

## 5. Step-by-step implementation

### Task 1: PR 0 — Measurement and contract baseline

**Files:**

- Create: `scripts/measure-mcp-surface.ts`
- Create: `scripts/measure-response-fixtures.ts`
- Create: `src/tool-surface-contract.test.ts`
- Create: `src/context-budget.test.ts`
- Create: `src/user-journey-contract.test.ts`
- Create: `src/__fixtures__/tool-surface.ts`
- Create: `testdata/tool-surface/default.json`
- Create: `testdata/tool-surface/setup.json`
- Create: `testdata/tool-surface/full.json`
- Create: `testdata/tool-surface/lean-purchase.json`
- Create: `testdata/context-budgets.json`
- Create: `src/internal-mcp-delegation.contract.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Capture tool registrations without starting stdio transport.** Extract the existing registration setup through a test fixture that supplies a recording `McpServer` and normalizes nonce/timestamp/absolute-path fields before snapshotting.

```ts
export interface MeasuredMcpSurface {
  toolCount: number;
  toolsListBytes: number;
  descriptionsBytes: number;
  inputSchemasBytes: number;
  largestTool: { name: string; bytes: number };
  serverInstructionsBytes: number;
  promptMetadataBytes: number;
  resourceMetadataBytes: number;
}
```

- [ ] **Step 2: Pin every current exposure surface.** Assert exact tool name/schema/annotation snapshots plus instruction, prompt metadata, and resource metadata bytes for setup, current default, full/granular/setup exposure, and the lean purchase-side combination with every disable flag. Make duplicate names and nondeterministic snapshots fail.
- [ ] **Step 3: Add deterministic response fixtures.** Cover CAMT 10/100/1000 rows, receipt 10/100 files, classification 10/100 groups, Accounting Inbox 1/20/100 review items, plan pages, and 30/100-transaction generic batches.
- [ ] **Step 4: Add journey accounting.** Record call count, request bytes, response bytes, technical-ID prompts, ambiguity questions, and approval-before-mutation for setup, purchase invoice, CAMT, Wise, receipt batch, reconciliation, and month-end.
- [ ] **Step 5: Pin serialized internal-delegation debt.** `internal-mcp-delegation.contract.test.ts` allowlists the five current production consumers in `src/tools/camt-import.ts`, `bank-reconciliation.ts`, `receipt-inbox.ts`, `accounting-inbox.ts`, and `accounting-inbox-autopilot-service.ts`; it forbids new consumers of `parseMcpResponse`, captured MCP handlers, or `content[0].text`. Tasks 5-10 remove allowlist entries, and Task 10 makes the allowlist empty while retaining only the serializer parser definition in `src/mcp-json.ts`.
- [ ] **Step 6: Add scripts.** Add `measure:surface` and `measure:responses` package scripts. The scripts write only normalized JSON when an explicit output path is passed; tests compare committed fixtures without rewriting them.
- [ ] **Step 7: Verify no production behavior changed.** Run all standard gates plus release/package gates.
- [ ] **Step 8: Commit.** `test: establish MCP surface and context baselines`

**Exit evidence:** committed baseline byte counts and journey counts reproduce from a clean checkout.

### Task 2: PR 1 — Tool catalog metadata and opt-in profiles

**Files:**

- Create: `src/tool-catalog.ts`
- Create: `src/tool-profile.ts`
- Create: `src/tool-profile.test.ts`
- Create: `src/public-tool-registrar.ts`
- Create: `src/public-tool-registrar.test.ts`
- Create: `testdata/tool-surface/guided.json`
- Create: `testdata/tool-surface/guided-sales.json`
- Create: `testdata/tool-surface/standard.json`
- Create: `testdata/tool-surface/custom.json`
- Modify: `src/mcp-compat.ts:66`
- Modify: `src/config.ts:145`
- Modify: `src/config.test.ts`
- Modify: `src/runtime-safety-context.ts:12`
- Modify: `src/plan-store.ts:203`
- Modify: `src/plan-store.test.ts`
- Modify: `src/file-reference-store.ts`
- Modify: `src/file-reference-store.test.ts`
- Modify: `src/__fixtures__/runtime-safety.ts`
- Modify: `src/tools/credential-tools.ts`
- Modify: `src/tools/credential-tools.test.ts`
- Modify: `src/index.ts:524`
- Modify: `src/tools/tool-exposure.test.ts`
- Modify: `src/tools/workflow-recommendations.ts:414`
- Modify: `src/tool-surface-contract.test.ts`
- Modify: `README.md`, `CLAUDE.md`, `ARCHITECTURE.md`, `CHANGELOG.md`

- [ ] **Step 1: Define catalog types and fail-closed validation.**

```ts
export type ToolProfile = "guided" | "guided-sales" | "standard" | "full" | "custom";
export interface ToolMeta {
  feature:
    | "core" | "workflow" | "banking" | "documents" | "reports" | "audit"
    | "connection" | "sales" | "products" | "tax" | "annual_report"
    | "lightyear" | "reference_admin" | "setup";
  audience: "guided" | "standard" | "advanced" | "admin";
  risk: "read" | "preview" | "mutate" | "destructive" | "send";
  facade_for?: readonly string[];
  granular_of?: { tool: string; mode?: string };
}
```

Require unique tool names, metadata for every registered tool, destructive-risk parity with annotations, and resolvable `facade_for`/`granular_of` references.
- [ ] **Step 2: Extend registration without breaking internal capture.** `registerTool` looks up or accepts `ToolMeta` and forwards it without profile filtering. A new server-scoped `PublicToolRegistrar` uses a `WeakMap<McpServer, CatalogState>` to reject duplicate public names and apply the profile predicate only to the real top-level MCP server. Accounting Inbox’s fake servers continue capturing the full internal handler set until Task 10 removes them.
- [ ] **Step 3: Parse and persist `EARVELDAJA_PROFILE`.** Explicit legacy exposure flags force `custom`; absent profile preserves current `standard` behavior for this release; `guided` and `guided-sales` are opt-in; `full` enables every group and granular/setup tools. Extend the existing credential import/setup configuration write so a validated optional profile is stored in the selected local/global `.env`; never create a second configuration format.
- [ ] **Step 4: Make setup choices unambiguous.** Map “Daily bookkeeping” to `guided`, “Daily bookkeeping plus sales invoices” to `guided-sales`, “Bookkeeping plus investments” to `standard` with Lightyear enabled, and “Full advanced toolset” to `full`. Do not invent `guided-investments` without a single guided investment façade and a proven <=20-tool budget.
- [ ] **Step 5: Bind profile identity into runtime safety.** Add the normalized profile name and a stable catalog fingerprint to `RuntimeSafetyScope`, `ExecutionPlanStore` scope equality, and the file/workflow-store scope tests; boolean feature flags alone do not distinguish guided from standard.
- [ ] **Step 6: Apply the catalog predicate only at the public boundary.** Wrap `scopedServer` in `PublicToolRegistrar` before `register*Tools` calls in `index.ts`; nested/fake registrars do not filter. A hidden tool must never reach public `tools/list`, while internal operations remain available. Every structured action emitted by `recommend_workflow`, Accounting Inbox, and `workflow-response.ts` must pass `projectActionForProfile` before serialization.
- [ ] **Step 7: Define fail-closed guided action projection.** Existing granular-to-merged aliases use the current safe remap table. In guided/guided-sales, proposed `create_owner_expense_reimbursement`, `create_journal`, `delete_transaction`, or any future action absent from the selected catalog is not emitted as a tool call: return `status="needs_review"`, blocker code `advanced_action_unavailable_in_profile`, preserve the non-executable accounting proposal for review, and set the only visible next action to `{ tool: "get_setup_instructions", args: {}, approval_required: false }`. The message explains that standard/full plus a fresh preview is required; it must not treat the prior proposal/handle as approval. Add contract cases for all three current branches and an unknown future tool.
- [ ] **Step 8: Populate the exhaustive central catalog in migration order.** `src/tool-catalog.ts` contains one metadata record for every PR 0 full-surface name, so the PR does not require mechanical edits to 30+ registration modules. Merged/granular first, setup/admin second, sales/products third, tax/year-end/Lightyear fourth, remaining CRUD/reports last. Set equality against the full-surface fixture fails on any missing or extra entry.
- [ ] **Step 9: Pin profile budgets.** `guided <= 20` tools, no direct destructive CRUD, every emitted guided next action visible, and standard/full snapshots unchanged from PR 0.
- [ ] **Step 10: Document one-choice setup UX and compatibility.** Do not make guided the default yet.
- [ ] **Step 11: Verify and commit.** `feat: add explicit MCP tool profiles`

The PR 1 experimental guided inventory is exactly the following 17 existing tools: `recommend_workflow`, `accounting_inbox`, `continue_accounting_workflow`, `receipt_batch`, `process_camt053`, `import_wise_transactions`, `reconcile_bank_transactions`, `reconcile_inter_account_transfers`, `classify_bank_transactions`, `cleanup_camt_possible_duplicate`, `save_auto_booking_rule`, `compute_trial_balance`, `list_connections`, `switch_connection`, `get_setup_instructions`, `get_execution_plan_page`, and `get_session_log`. Every current compact workflow continuation either maps to one of these visible tools or follows the fail-closed advanced-action projection above. Experimental `guided-sales` adds the existing read-only `list_sale_invoices` and `get_sale_invoice` tools but no direct sale mutation, for 19 total. Both are opt-in and not yet documented as the recommended daily surface.

After PR 10, the final guided inventory is exactly 19 tools: `recommend_workflow`, `accounting_inbox`, `continue_accounting_workflow`, `process_accounting_document`, `receipt_batch`, `process_bank_input`, `reconcile_bank_transactions`, `classify_bank_transactions`, `run_accounting_report`, `search_accounting_records`, `inspect_accounting_record`, `list_connections`, `switch_connection`, `get_setup_instructions`, `get_execution_plan_page`, `get_workflow_page`, `get_operation_result_page`, `get_session_log`, and `get_server_status`. `guided-sales` adds only `manage_sale_invoice`, for the hard maximum of 20.

Six interim-guided tools are dropped between the interim and final inventories; each capability has an explicit successor so guided never loses the capability itself. `process_camt053` and `import_wise_transactions` fold into `process_bank_input` (PR 8A). The remaining four:

- **Inter-account transfer reconciliation** (`reconcile_inter_account_transfers`): becomes additive `suggest_inter_account` and `execute_inter_account` values on the existing `mode` enum of `reconcile_bank_transactions`, backed by PR 5's `prepareInterAccount`/`executeInterAccount` typed operations with plan-backed preview plus execute (added in PR 8C; standard/full keep the standalone tool unchanged).
- **Duplicate cleanup** (`cleanup_camt_possible_duplicate`) and **rule saving** (`save_auto_booking_rule`): remain reachable in guided as `continue_accounting_workflow`/`workflow_action_v2` continuation actions executed server-side through typed operations with unchanged preview/approval semantics. Continuation actions run inside the visible continuation tool, so the fail-closed advanced-action projection does not apply to them; guided never emits these two as tool-call next actions.
- **Trial balance** (`compute_trial_balance`): `run_accounting_report` with `report="trial_balance"`.

PR 8C's journey contracts must prove each successor path end-to-end inside guided.

### Task 3: PR 2 — Compact response and response-budget infrastructure

**Files:**

- Create: `src/operation-summary.ts`
- Create: `src/operation-summary.test.ts`
- Create: `src/operation-outcome.ts`
- Create: `src/operation-outcome.test.ts`
- Create: `src/response-budget.ts`
- Create: `src/response-budget.test.ts`
- Create: `src/compact-batch-response.ts`
- Create: `src/compact-batch-response.test.ts`
- Create: `src/page-reference.ts`
- Create: `src/operation-result-store.ts`
- Create: `src/operation-result-store.test.ts`
- Create: `src/operation-result-page.ts`
- Create: `src/operation-result-page.test.ts`
- Modify: `src/mcp-json.ts`
- Modify: `src/plan-tools.ts:8`
- Modify: `src/runtime-safety-context.ts`
- Modify: `src/__fixtures__/runtime-safety.ts`
- Modify: `src/context-budget.test.ts`

- [ ] **Step 1: Define the internal outcome and public summary contracts.** `OperationOutcome<T>` is a typed internal success/failure union with no MCP types or serialized text. `OperationSummaryV1` uses the exact `operation_summary_v1` status, scope, counts, totals, warnings, blockers, samples, next-action, handles, and details fields from the source specification.

```ts
export interface CompactWarning { code: string; message: string; item_id?: string }
export interface CompactReviewItem { item_id: string; code: string; message: string; severity: "warning" | "blocker" }
export type OperationOutcome<T> =
  | { ok: true; value: T; warnings: readonly CompactWarning[]; blockers: readonly CompactReviewItem[] }
  | { ok: false; error: { code: string; message: string; retry: "never" | "safe" | "unknown" }; blockers: readonly CompactReviewItem[] };

export interface OperationSummaryV1 {
  contract: "operation_summary_v1";
  status: "completed" | "ready_for_approval" | "needs_input" | "needs_review" | "partial" | "failed";
  message: string;
  counts?: Record<string, number>;
  totals?: Record<string, number | string>;
  scope?: { connection?: string; company?: string; account?: string; period?: { from?: string; to?: string }; source_documents?: string[] };
  warnings?: CompactWarning[];
  blockers?: CompactReviewItem[];
  samples?: unknown[];
  next_action?: { tool: string; args: Record<string, unknown>; approval_required: boolean };
  workflow_handle?: string;
  plan_handle?: string;
  details?: { available: boolean; total_items: number; returned_items: number; tool: string; args: Record<string, unknown> };
}
```
- [ ] **Step 2: Test whole-response sizing after real serialization.** Measure `Buffer.byteLength(toMcpJson(payload), "utf8")`; never estimate from JavaScript character count.
- [ ] **Step 3: Implement deterministic compaction.** Preserve all blocker counts, return the highest-priority blockers first, cap non-blocking samples at three, and provide a page reference for omitted items. Compact mode omits dry-run audit references and other debug-only echo fields (full detail retains them). Never slice encoded JSON/TOON strings.
- [ ] **Step 4: Implement one-copy batch partitioning.** Each item appears in exactly one canonical collection; summary counts refer to collections without duplicating rows.
- [ ] **Step 5: Preserve plan-page v1 and add profile-gated v2 behavior.** Standard/full keep the current 50-item default, schema, and `execution_plan_page_v1` response byte-for-byte. Guided registers the additive `detail=summary|full`, caller page size default 20/max 50, HMAC binding over page size/detail, and 32 KiB cap. Plan pages are review-only and available only before plan consumption.
- [ ] **Step 6: Add a non-executable operation-result store.** On execution completion/partial/indeterminate stop, clone/freeze only safe public result projections into a runtime-scope-bound, finite-TTL/capacity store. It contains no executable commands, private plan payload, credentials, or approval state. `get_operation_result_page` pages those details after the execution plan has been consumed; it never resumes or mutates.
- [ ] **Step 7: Add `response_detail: compact|full` helpers with explicit compatibility routing.** Guided and new façade schemas default to compact. Existing standard/full tools retain their pinned schema and full output; they do not gain compact fields until a separately versioned contract.
- [ ] **Step 8: Verify budgets.** Normal summary <= 8 KiB target/16 KiB hard; batch <= 16 KiB target/32 KiB hard; detail <= 24 KiB target/32 KiB hard.
- [ ] **Step 9: Commit.** `feat: add compact response budget infrastructure`

### Task 4: PR 3 — Workflow state store and `workflow_action_v2`

**Files:**

- Create: `src/workflow-state-types.ts`
- Create: `src/workflow-state-store.ts`
- Create: `src/workflow-state-store.test.ts`
- Create: `src/workflow-action-v2.ts`
- Create: `src/workflow-action-v2.test.ts`
- Create: `src/workflow-page.ts`
- Create: `src/workflow-page.test.ts`
- Modify: `src/runtime-safety-context.ts`
- Modify: `src/tools/accounting-inbox.ts:1590`
- Modify: `src/workflow-response.ts`
- Modify: `src/workflow-response.test.ts`
- Modify: `src/context-budget.test.ts`

- [ ] **Step 1: Copy the proven store safety shape, not executable plan semantics.** The workflow store uses opaque 32-byte handles, immutable clone/freeze validation, finite TTL/capacity, runtime-scope equality, and safe tombstones/errors. It stores no credentials and grants no mutation authority.
- [ ] **Step 2: Add fail-closed tests.** Cover cross-server, company switch, generation change, feature-profile change, expiration, capacity, proxy/accessor/cycle rejection, oversized state, and handle collision.
- [ ] **Step 3: Define `workflow_action_v2`.** Return one `next_action`, compact alternative counts, blockers, `workflow_handle`, and an optional page reference; omit duplicate `available_actions` and approval arrays.
- [ ] **Step 4: Register continuation input.** Support `workflow_handle`, `action`, stable `item_id`, and bounded `answer`. Retain `workflow_state_json` and `review_item_json` as deprecated compatibility inputs through `v0.27.x`; removal is major-version-only.
- [ ] **Step 5: Add workflow detail paging.** Register `get_workflow_page` for non-plan state with a scope-bound HMAC cursor and non-mutating reads; plan-backed details continue to use `get_execution_plan_page`.
- [ ] **Step 6: Enforce continuation budget.** Normal continuation args serialize below 512 B target and 1 KiB hard.
- [ ] **Step 7: Verify and commit.** `feat: add scope-bound workflow handles`

### Task 5: PR 4 — CAMT typed operations

**Files:**

- Create: `src/camt/types.ts`
- Create: `src/camt/parser.ts`
- Create: `src/camt/parser.test.ts`
- Create: `src/camt/preflight.ts`
- Create: `src/camt/duplicate-identity.ts`
- Create: `src/camt/projection.ts`
- Create: `src/camt/operations.ts`
- Create: `src/camt/operations.test.ts`
- Create: `src/camt/executor.ts`
- Create: `src/camt/presenter.ts`
- Modify: `src/tools/camt-import.ts:2026`
- Modify: `src/tools/camt-import.test.ts`
- Modify: `src/tools/camt-import-tools.test.ts`
- Modify: `src/tools/camt-import-refnumber-dedup.test.ts`
- Modify: `src/tools/accounting-inbox.ts` only for imports that move to public CAMT modules

- [ ] **Step 1: Pin granular/merged semantic parity and all current safety regressions before extraction.** Include CRDT/DBIT direction, reference duplicates, source digest, argument drift, scope drift, ledger drift, balance checks, plan/approval separation, and indeterminate outcomes.
- [ ] **Step 2: Extract pure parser and preflight code without behavior change.** `src/camt/parser.ts` and `preflight.ts` must not import MCP, HTTP, filesystem, audit, or environment modules.
- [ ] **Step 3: Extract duplicate identity and projection.** Keep stable identity/fingerprint algorithms byte-compatible with the baseline fixtures.
- [ ] **Step 4: Implement typed operations.**

```ts
export interface CamtOperations {
  parse(input: ParseCamtInput): Promise<OperationOutcome<CamtParseResult>>;
  prepareImport(input: CamtImportInput): Promise<OperationOutcome<CamtImportPreview>>;
  executeImport(input: CamtExecuteInput): Promise<OperationOutcome<CamtImportExecution>>;
}
```

- [ ] **Step 5: Keep execution safety in `executor.ts`.** Consume the plan once, recheck source/live scope/ledger/arguments, execute the frozen command set, audit outcomes, and stop on indeterminate mutation.
- [ ] **Step 6: Make granular and merged MCP handlers thin adapters.** No production CAMT path may call a captured handler or parse `content[0].text`.
- [ ] **Step 7: Add compatibility-routed presentation.** The typed operation returns one outcome. Existing `process_camt053`/granular tools in standard/full render the PR 0-pinned full envelope; guided/new façade use the compact presenter with statement identity, IBAN/resolved account, period, direction counts/totals, duplicates, errors, closing-balance warning, blockers, three samples, plan handle, and a `get_operation_result_page` details reference. Size from 100 to 1000 clean rows must remain approximately constant.
- [ ] **Step 8: Remove `src/tools/camt-import.ts` from the internal-delegation allowlist, verify and commit.** `refactor: introduce typed CAMT operations`

### Task 6: PR 4B — Wise typed operations

**Files:**

- Create: `src/wise/types.ts`
- Create: `src/wise/preflight.ts`
- Create: `src/wise/projection.ts`
- Create: `src/wise/operations.ts`
- Create: `src/wise/operations.test.ts`
- Create: `src/wise/executor.ts`
- Create: `src/wise/presenter.ts`
- Modify: `src/tools/wise-import.ts`
- Modify: `src/tools/wise-import.test.ts`

- [ ] **Step 1: Pin the current Wise contract and safety behavior.** Cover strict zero-side-effect preflight, immutable preview/execute projection, source digest, approval separation, execution locking, duplicate behavior, IN/OUT direction, partial results, and indeterminate outcomes.
- [ ] **Step 2: Extract parsing/preflight and projection behind typed inputs/results.** Preserve current statement identity and command fingerprints.
- [ ] **Step 3: Implement typed prepare/execute operations.** Use `ApiContext`, `RuntimeSafetyContext`, and the existing execution-plan machinery; do not introduce MCP types in the operation interface.
- [ ] **Step 4: Make `import_wise_transactions` a thin adapter with profile/version routing.** Standard/full retain the pinned schema/output; guided/new façade use the compact presenter and plan/result-backed details.
- [ ] **Step 5: Prove approximately O(1) clean-batch output.** Compare 100 and 1000 clean-row fixtures without hiding blockers.
- [ ] **Step 6: Verify and commit.** `refactor: introduce typed Wise operations`

### Task 7: PR 5 — Bank reconciliation typed operations

**Files:**

- Create: `src/banking/reconciliation/types.ts`
- Create: `src/banking/reconciliation/invoice-index.ts`
- Create: `src/banking/reconciliation/match-score.ts`
- Create: `src/banking/reconciliation/amount-resolution.ts`
- Create: `src/banking/reconciliation/inter-account-matcher.ts`
- Create: `src/banking/reconciliation/duplicate-policy.ts`
- Create: `src/banking/reconciliation/projection.ts`
- Create: `src/banking/reconciliation/operations.ts`
- Create: `src/banking/reconciliation/operations.test.ts`
- Create: `src/banking/reconciliation/executor.ts`
- Create: `src/banking/reconciliation/presenter.ts`
- Modify: `src/tools/bank-reconciliation.ts`
- Modify: `src/tools/bank-reconciliation.test.ts`
- Modify: `src/tools/bank-reconciliation-plan.ts`
- Modify: `src/tools/inter-account-utils.ts`

- [ ] **Step 1: Pin baseline parity.** Freeze match candidates, scores, partial payments, one-sided EUR amounts, reciprocal transfers, ambiguity, cross-currency rejection, duplicates, partial execution, and indeterminate outcomes.
- [ ] **Step 2: Extract pure policies.** Pure modules accept typed arrays/values and return typed decisions; their tests instantiate neither MCP nor HTTP mocks.
- [ ] **Step 3: Implement the five typed prepare/execute operations from the source specification.** Use narrow API/repository ports rather than the whole MCP server.

```ts
export interface BankReconciliationOperations {
  suggestMatches(input: SuggestMatchesInput): Promise<OperationOutcome<ReconciliationSuggestions>>;
  prepareExactConfirm(input: ExactConfirmInput): Promise<OperationOutcome<ExactConfirmPreview>>;
  executeExactConfirm(input: ExactConfirmExecutionInput): Promise<OperationOutcome<ExactConfirmExecution>>;
  prepareInterAccount(input: InterAccountInput): Promise<OperationOutcome<InterAccountPreview>>;
  executeInterAccount(input: InterAccountExecutionInput): Promise<OperationOutcome<InterAccountExecution>>;
}
```
- [ ] **Step 4: Make execution plan-backed.** Preview and execute must use the same frozen command IDs and reject all scope/source/ledger drift before the first write.
- [ ] **Step 5: Replace handler maps and `parseMcpResponse`.** The MCP façade presents typed outcomes directly.
- [ ] **Step 6: Add profile-routed presenter.** Guided returns totals and every ambiguity/blocker, omits clean match rows, and links plan/result details; standard/full retain their pinned full response.
- [ ] **Step 7: Remove `src/tools/bank-reconciliation.ts` from the internal-delegation allowlist, verify and commit.** `refactor: introduce typed reconciliation operations`

### Task 8: PR 6A — Receipt batch typed operations

**Files:**

- Create: `src/receipts/types.ts`
- Create: `src/receipts/batch-operations.ts`
- Create: `src/receipts/batch-operations.test.ts`
- Create: `src/receipts/presenter.ts`
- Modify: `src/tools/receipt-inbox.ts:1578`
- Modify: `src/tools/receipt-inbox-booking.ts`
- Modify: `src/tools/receipt-inbox-files.ts`
- Modify: `src/tools/receipt-inbox-matching.ts`
- Modify: `src/tools/receipt-inbox-output.ts`
- Modify: `src/tools/receipt-inbox-summary.ts`
- Modify: `src/tools/receipt-inbox-tools.test.ts`
- Modify: `src/tools/receipt-batch-failure.test.ts`
- Modify: `src/tools/receipt-inbox-summary.test.ts`

- [ ] **Step 1: Pin staged-safety and partial-mutation tests.** Create/upload draft is approval one; confirm/link is approval two. Ambiguous post-create failures remain explicit and never trigger retry.
- [ ] **Step 2: Build a typed batch operation over existing helpers.** Do not physically move helper files in this PR; import them through narrow exported functions to keep the diff reviewable.
- [ ] **Step 3: Remove receipt façade handler delegation.** `receipt_batch` calls the typed operation and presenter directly.
- [ ] **Step 4: Produce profile-routed batch summaries.** Guided returns reliable gross/net/VAT totals, counts by status, duplicates, OCR failures/low confidence, unresolved decisions, partial mutations, three samples, and workflow/plan/result detail reference; standard/full retain their pinned full response.
- [ ] **Step 5: Keep raw external text out of initial summaries.** Full detail pages sandbox it using one safe outer page boundary where possible.
- [ ] **Step 6: Verify response sizes at 10 and 100 clean files and commit.** `refactor: introduce typed receipt batch operations`

### Task 9: PR 6B — Classification typed operations

**Files:**

- Create: `src/receipts/classification-operations.ts`
- Create: `src/receipts/classification-operations.test.ts`
- Create: `src/receipts/classification-presenter.ts`
- Modify: `src/tools/receipt-inbox.ts:2614`
- Modify: `src/tools/receipt-inbox.test.ts`
- Modify: `src/tools/receipt-inbox-tools.test.ts`

- [ ] **Step 1: Pin classify/dry-run-apply/execute-apply parity.** Include forced categories, saved rules, booking history, duplicate guards, unresolved groups, partial writes, and indeterminate outcomes.
- [ ] **Step 2: Expose typed classification inputs/results.** Keep model-facing classification evidence distinct from executable frozen projections.
- [ ] **Step 3: Replace `parseMcpResponse` in the merged classification path.** Both granular and merged handlers call the same operation.
- [ ] **Step 4: Apply profile-routed compact/page-backed presentation.** Guided size remains approximately constant between 10 and 100 clean groups while blockers stay in the first response; standard/full retain their pinned full response.
- [ ] **Step 5: Remove `src/tools/receipt-inbox.ts` from the internal-delegation allowlist, verify and commit.** `refactor: introduce typed classification operations`

### Task 10: PR 7 — Accounting Inbox typed orchestration

**Files:**

- Create: `src/accounting-operations.ts`
- Create: `src/accounting-operations.test.ts`
- Modify: `src/tools/accounting-inbox-autopilot-service.ts:118`
- Modify: `src/tools/accounting-inbox-autopilot-service.test.ts`
- Modify: `src/tools/accounting-inbox.ts:1075`
- Modify: `src/tools/accounting-inbox.test.ts`
- Modify: `src/workflow-response.ts`
- Modify: `src/workflow-response.test.ts`

- [ ] **Step 1: Define `AccountingOperations`.** Provide typed bank parse/import, receipt prepare, classification, and reconciliation methods backed by PR 4, PR 4B, PR 5, PR 6A, and PR 6B.

```ts
export interface AccountingOperations {
  parseBankInput(input: BankInput): Promise<OperationOutcome<BankParseResult>>;
  prepareBankImport(input: BankImportInput): Promise<OperationOutcome<BankImportPreview>>;
  prepareReceiptBatch(input: ReceiptBatchInput): Promise<OperationOutcome<ReceiptBatchPreview>>;
  classifyTransactions(input: ClassificationInput): Promise<OperationOutcome<ClassificationResult>>;
  suggestReconciliation(input: ReconciliationInput): Promise<OperationOutcome<ReconciliationSuggestions>>;
}
```
- [ ] **Step 2: Rewrite service tests to mock typed operations.** Remove mock `McpServer`, captured registrations, TOON/JSON text parsing, and handler maps from application-service tests.
- [ ] **Step 3: Replace `captureInternalToolHandlers`.** Orchestrate operations directly and preserve prerequisite, materialization-state, and safe-skipping behavior.
- [ ] **Step 4: Store workflow state server-side.** Guided responses return inventory counts, completed/skipped safe steps, decision/review counts, one next action, and `workflow_handle`; they do not inline prepared, autopilot, and workflow payloads together.
- [ ] **Step 5: Retain pinned compatibility output by profile/version.** Standard/full keep their PR 0 schema and full payload without requiring a new argument. Old JSON continuation stays functional through `v0.27.x`; only guided uses v2/compact by default.
- [ ] **Step 6: Remove `src/tools/accounting-inbox.ts` and `src/tools/accounting-inbox-autopilot-service.ts` from the internal-delegation allowlist, assert the allowlist is empty, verify journey/byte fixtures, and commit.** `refactor: orchestrate Accounting Inbox with typed operations`

### Task 11: PR 7A — Deterministic company, account, and supplier resolution

**Files:**

- Create: `src/resolution/types.ts`
- Create: `src/resolution/company-resolution.ts`
- Create: `src/resolution/company-resolution.test.ts`
- Create: `src/resolution/bank-account-resolution.ts`
- Create: `src/resolution/bank-account-resolution.test.ts`
- Create: `src/resolution/supplier-default-resolution.ts`
- Create: `src/resolution/supplier-default-resolution.test.ts`
- Modify: `src/account-resolution.ts`
- Modify: `src/tools/supplier-resolution.ts`
- Modify: `src/tools/accounting-inbox.ts:386`

- [ ] **Step 1: Define a three-way result.** Every resolver returns `resolved` with evidence, `ambiguous` with bounded choices and one focused question, or `not_found`; it never silently selects a tied candidate.

```ts
export type Resolution<T> =
  | { status: "resolved"; value: T; evidence: readonly ResolutionEvidence[] }
  | { status: "ambiguous"; choices: readonly ResolutionChoice[]; question: string }
  | { status: "not_found"; question: string };
```
- [ ] **Step 2: Implement ordered bank resolution.** Exact statement IBAN; injected connection-scoped saved default; unique validated currency/account; unique confirmed history; otherwise ambiguous/not-found. A saved default is usable only after the current invocation re-fetches and verifies that the dimension is active, belongs to the current connection and expected bank ledger account, and matches the statement currency/IBAN constraints. PR 9 supplies the persistent saved-default port.
- [ ] **Step 3: Implement company resolution.** One configured connection selects automatically; file/request evidence selects only a unique match; otherwise return one company question.
- [ ] **Step 4: Keep supplier/history defaults behind legal-identity gates.** Weak or tied identity evidence cannot bypass current registry/legal-entity verification.
- [ ] **Step 5: Replace Inbox-local candidate selection with the shared pure resolvers.** Preserve existing output until guided façades consume the typed result.
- [ ] **Step 6: Verify and commit.** `refactor: centralize safe accounting resolution`

### Task 12: PR 8A — Guided bank façade

**Files:**

- Create: `src/banking/input-format.ts`
- Create: `src/banking/input-format.test.ts`
- Create: `src/guided/process-bank-input.ts`
- Create: `src/guided/process-bank-input.test.ts`
- Modify: `src/file-reference-store.ts`
- Modify: `src/file-reference-store.test.ts`
- Modify: `src/file-input-snapshot.ts`
- Modify: `src/file-input-snapshot.test.ts`
- Modify: `src/tools/accounting-inbox.ts`
- Modify: `src/index.ts:893`
- Modify: `src/tool-catalog.ts`
- Modify: `src/user-journey-contract.test.ts`
- Modify: `workflows/import-camt.md`
- Modify: `workflows/import-wise.md`
- Modify: `.claude/commands/import-camt.md` (generated by `npm run sync:workflow-prompts`)
- Modify: `.claude/commands/import-wise.md` (generated by `npm run sync:workflow-prompts`)

- [ ] **Step 1: Add an operation-bound unified bank reference.** Add `FILE_REFERENCE_OPERATIONS.bank = "bank_input"`. Accounting Inbox issues `bank_input` only when recommending `process_bank_input`; existing granular CAMT/Wise actions keep their current operation-specific references. A bank reference cannot resolve through `camt_input`, `wise_input`, receipt, or any other operation.
- [ ] **Step 2: Capture once, then auto-detect.** Resolve/capture the immutable `bank_input` snapshot once with the union of strict CAMT/Wise extension and size limits, prefer validated content signatures and both parser preflights over filename, and pass the same immutable bytes/identity into the selected typed operation. Reject ambiguous/unsupported input without mutation or a second path read.
- [ ] **Step 3: Implement `process_bank_input`.** Accept `file_ref` first and validated `file_path` only as advanced fallback; modes are `prepare`, `execute`, and `show_details`.
- [ ] **Step 4: Route to typed CAMT or Wise operations.** Do not call MCP handlers, parse MCP text, or expose delegated tool names/args.
- [ ] **Step 5: Enforce two-call happy path.** Use PR 7A resolution; prepare returns compact approval plus plan handle, and execute consumes the approved plan. Technical dimension IDs are absent on unique-match paths.
- [ ] **Step 6: Pin guided visibility and budgets.** The façade is visible in guided; granular CAMT/Wise tools and their schemas/outputs remain pinned in standard/full.
- [ ] **Step 7: Migrate canonical bank workflow Markdown to the façade name.** Edit `workflows/import-camt.md` and `workflows/import-wise.md`, run `npm run sync:workflow-prompts`, and validate that generated command mirrors and structured actions reference visible tools.
- [ ] **Step 8: Verify and commit.** `feat: add guided bank input workflow`

### Task 13: PR 8B — Typed accounting-document operation and guided façade

**Files:**

- Create: `src/documents/types.ts`
- Create: `src/documents/operations.ts`
- Create: `src/documents/operations.test.ts`
- Create: `src/guided/process-accounting-document.ts`
- Create: `src/guided/process-accounting-document.test.ts`
- Modify: `src/tools/pdf-workflow.ts`
- Modify: `src/tools/pdf-workflow.test.ts`
- Modify: `src/tools/supplier-resolution.ts`
- Modify: `src/tools/document-audit.ts`
- Modify: `src/index.ts`
- Modify: `src/tool-catalog.ts`
- Modify: `src/user-journey-contract.test.ts`
- Modify: `workflows/book-invoice.md`
- Modify: `.claude/commands/book-invoice.md` (generated by `npm run sync:workflow-prompts`)

- [ ] **Step 1: Define and implement a typed document operation before the façade.** It includes extraction confidence, VAT validation, supplier resolution, duplicate result, proposed booking, blockers, and plan projection without raw OCR in the compact summary. Its tests mock narrow OCR/API ports, not MCP handlers.

```ts
export interface AccountingDocumentOperations {
  prepare(input: PrepareAccountingDocumentInput): Promise<OperationOutcome<AccountingDocumentPreview>>;
  create(input: ExecuteAccountingDocumentInput): Promise<OperationOutcome<AccountingDocumentExecution>>;
}
```
- [ ] **Step 2: Implement prepare/create modes over typed receipt/document operations.** File reference is primary; raw path remains validated advanced fallback.
- [ ] **Step 3: Preserve separate confirmation.** A successful create may produce a second plan for confirm/link, but must not silently perform that stage.
- [ ] **Step 4: Pin two-call create happy path and no-technical-ID behavior.** Genuine ambiguity produces `needs_input`, not a guessed supplier/account/VAT decision.
- [ ] **Step 5: Migrate `workflows/book-invoice.md` to `process_accounting_document`, sync generated mirrors, and preserve every staged-safety statement in prompt invariant tests.**
- [ ] **Step 6: Verify and commit.** `feat: add guided accounting document workflow`

### Task 14: PR 8C — Typed report/record/sales operations and guided façades

**Files:**

- Create: `src/reporting/operations.ts`
- Create: `src/reporting/operations.test.ts`
- Create: `src/records/operations.ts`
- Create: `src/records/operations.test.ts`
- Create: `src/sales/invoice-operations.ts`
- Create: `src/sales/invoice-operations.test.ts`
- Create: `src/guided/run-accounting-report.ts`
- Create: `src/guided/run-accounting-report.test.ts`
- Create: `src/guided/search-accounting-records.ts`
- Create: `src/guided/search-accounting-records.test.ts`
- Create: `src/guided/inspect-accounting-record.ts`
- Create: `src/guided/inspect-accounting-record.test.ts`
- Create: `src/guided/manage-sale-invoice.ts`
- Create: `src/guided/manage-sale-invoice.test.ts`
- Modify: `src/tools/financial-statements.ts`
- Modify: `src/tools/aging-analysis.ts`
- Modify: `src/tools/crud-tools.ts`
- Modify: `src/tools/bank-reconciliation.ts`
- Modify: `src/tools/accounting-inbox.ts`
- Modify: `src/index.ts`
- Modify: `src/tool-catalog.ts`
- Modify: `src/tool-surface-contract.test.ts`
- Modify: `src/user-journey-contract.test.ts`
- Modify: `workflows/company-overview.md`
- Modify: `workflows/month-end.md`
- Modify: `.claude/commands/company-overview.md` (generated by `npm run sync:workflow-prompts`)
- Modify: `.claude/commands/month-end.md` (generated by `npm run sync:workflow-prompts`)

- [ ] **Step 1: Extract typed report operations.** Use an explicit report enum and typed result union; tests call no MCP handlers. Compact is default and `detail=full` uses paging.

```ts
export type AccountingReportType = "trial_balance" | "balance_sheet" | "profit_and_loss" | "aging" | "month_end";
export interface ReportingOperations {
  run(input: { report: AccountingReportType; period: { from?: string; to?: string } }): Promise<OperationOutcome<AccountingReportResult>>;
}
export interface RecordOperations {
  search(input: SearchAccountingRecordsInput): Promise<OperationOutcome<RecordSearchResult>>;
  inspect(input: InspectAccountingRecordInput): Promise<OperationOutcome<AccountingRecord>>;
}
export interface SaleInvoiceOperations {
  run(input: SaleInvoiceReadInput | SaleInvoicePrepareInput | SaleInvoiceExecuteInput): Promise<OperationOutcome<SaleInvoiceOperationResult>>;
}
```
- [ ] **Step 2: Extract constrained record search/inspect operations.** Use an explicit entity enum and bounded filters; do not create a universal API executor.
- [ ] **Step 3: Extract typed sale-invoice operations.** Use explicit read/prepare/execute/send modes; preview/execute applies to mutation, send, and destructive modes.
- [ ] **Step 4: Register thin guided façades over those operations.** Sale modes exist only when sales is enabled; granular access remains in full.
- [ ] **Step 5: Absorb the dropped interim-guided capabilities.** Extend `reconcile_bank_transactions` with additive `suggest_inter_account` and `execute_inter_account` mode values calling PR 5's `prepareInterAccount`/`executeInterAccount` (plan-backed preview plus execute; standard/full keep the standalone `reconcile_inter_account_transfers` tool and its pinned schema unchanged). Keep `cleanup_camt_possible_duplicate` and `save_auto_booking_rule` behavior reachable in guided as `continue_accounting_workflow` continuation actions executed server-side through typed operations; guided never emits either as a tool-call next action.
- [ ] **Step 6: Recount guided surface.** It must contain 15-20 tools, never exceed 20, and every guided workflow action must point to a visible tool. Journey contracts must prove inter-account reconciliation, duplicate cleanup, rule saving, and trial balance are each achievable end-to-end inside guided.
- [ ] **Step 7: Migrate `workflows/company-overview.md` and `workflows/month-end.md` to the report/search/inspect façades, sync mirrors, and run release validation.**
- [ ] **Step 8: Verify and commit.** `feat: complete guided accounting tool surface`

**Milestone gate after Task 14:** guided surface <= 20 tools; core bank/document flows use typed operations; common mutation happy paths are preview plus execute; compact outputs meet budgets; no core application service parses another MCP response.

### Task 15: PR 9 — Persisted defaults, capability-aware elicitation, and interaction style

**Files:**

- Create: `src/connection-defaults-store.ts`
- Create: `src/connection-defaults-store.test.ts`
- Create: `src/elicitation.ts`
- Create: `src/elicitation.test.ts`
- Modify: `src/config.ts`
- Modify: `src/tools/workflow-recommendations.ts:463`
- Modify: `src/tools/workflow-recommendations.test.ts`
- Modify: `src/guided/process-bank-input.ts`
- Modify: `src/guided/process-accounting-document.ts`
- Modify: `src/index.ts`
- Modify: `src/user-journey-contract.test.ts`

- [ ] **Step 1: Add a secure connection-defaults store.** Persist a bounded JSON document under the existing app config directory, keyed by connection fingerprint and environment, written atomically with mode `0600`, rejecting symlinks/proxies/accessors/oversized data. Store only non-secret hints such as a previously validated bank dimension ID and input type. Every read is a hint: the resolver must re-fetch and revalidate active state, connection ownership, bank account, currency, and IBAN compatibility before the value influences a plan; stale defaults are ignored and surfaced for replacement.
- [ ] **Step 2: Require explicit remember consent.** An elicitation answer may include `remember_for_connection: true`; without it, a resolved choice is invocation-local and never persisted.
- [ ] **Step 3: Consult the installed SDK types and current official MCP docs before coding capability checks.** Confirm the supported form-elicitation schema and fallback behavior; do not guess an unstable SDK API.
- [ ] **Step 4: Add capability-aware forms.** Use MCP elicitation only for company, ambiguous bank account, profile, storage scope, and bounded non-secret inputs. Never ask for API credentials or passwords through forms.
- [ ] **Step 5: Add text fallback.** Unsupported clients receive the same one focused `needs_input` question and small continuation args.
- [ ] **Step 6: Replace the misleading interaction option compatibly.** Advertise `interaction_style=concise|guided|detailed`; continue accepting deprecated `risk_tolerance=fast|balanced|careful` for the compatibility window and map it only to explanation/detail depth, never safety behavior.
- [ ] **Step 7: Verify unique/no-question, ambiguous/one-question, persistence-consent, and no-secret-elicitation journeys.** Commit `feat: add persisted defaults and capability-aware elicitation`.

### Task 16: PR 10 — Trim instructions and add point-of-use release notices

**Files:**

- Create: `src/server/server-instructions.ts`
- Create: `src/server/server-instructions.test.ts`
- Create: `src/server/release-notices.ts`
- Create: `src/server/release-notices.test.ts`
- Modify: `src/index.ts`
- Modify: `src/guided/process-bank-input.ts`
- Modify: `src/context-budget.test.ts`
- Modify: `workflows/book-invoice.md`
- Modify: `workflows/import-camt.md`
- Modify: `workflows/import-wise.md`
- Modify: `workflows/company-overview.md`
- Modify: `workflows/month-end.md`
- Modify: `workflows/lightyear-booking.md`
- Modify: `.claude/commands/book-invoice.md` (generated)
- Modify: `.claude/commands/import-camt.md` (generated)
- Modify: `.claude/commands/import-wise.md` (generated)
- Modify: `.claude/commands/company-overview.md` (generated)
- Modify: `.claude/commands/month-end.md` (generated)
- Modify: `.claude/commands/lightyear-booking.md` (generated)
- Modify: `README.md`, `CLAUDE.md`, `CHANGELOG.md`

- [ ] **Step 1: Pin required invariant phrases semantically.** Tests must detect live-data warning, preview/approval, external-text evidence rule, guided entry points, connection isolation, and currency default.
- [ ] **Step 2: Build configured instructions under 1.5 KiB target/2 KiB hard.** Remove detailed VAT, D/C, report, Lightyear, and workflow sequencing from the global text.
- [ ] **Step 3: Move detailed guidance to the owning operation/prompt.** Edit only the six canonical workflow files listed above, then run `npm run sync:workflow-prompts`; never hand-edit `.claude/commands/*.md`.
- [ ] **Step 4: Implement compact server/release status.** Register the read-only `get_server_status` tool from `src/server/release-notices.ts`. Active bank notices appear at the start of affected bank flows, not unrelated sessions; notices carry stable IDs and operational relevance.
- [ ] **Step 5: Verify release metadata and commit.** `perf: reduce fixed MCP instruction context`

### Task 17: PR 11 — Runtime bootstrap decomposition

**Files:**

- Create: `src/runtime/connection-manager.ts`
- Create: `src/runtime/connection-manager.test.ts`
- Create: `src/runtime/invocation-scope.ts`
- Create: `src/runtime/invocation-scope.test.ts`
- Create: `src/runtime/runtime-context.ts`
- Create: `src/runtime/audit-label-resolver.ts`
- Create: `src/server/create-server.ts`
- Create: `src/server/register-system-tools.ts`
- Create: `src/server/register-domain-tools.ts`
- Modify: `src/index.ts`
- Modify: `src/connection-safety.test.ts`
- Modify: `src/__integration__/mcp-connection.integration.test.ts`
- Modify: `src/tool-surface-contract.test.ts`
- Modify: `ARCHITECTURE.md`, `CLAUDE.md`

- [ ] **Step 1: Pin the complete standard/full tool snapshots and connection concurrency tests before moving code.**
- [ ] **Step 2: Extract pure construction/composition in small commits inside the PR.** Preserve handler wrapping order, setup mode, audit labels, cache clearing, request guard, AsyncLocalStorage snapshots, generation checks, and in-flight mutation block exactly.
- [ ] **Step 3: Move system registrations and domain registrations without schema changes.** `index.ts` should retain only startup, stdio transport, top-level composition, and fatal-error handling.
- [ ] **Step 4: Run snapshot diff after every extraction.** Any tool/schema/instruction change is a regression in this behavior-preserving PR.
- [ ] **Step 5: Verify and commit.** `refactor: decompose MCP runtime bootstrap`

### Task 18: PR 12 — Mutation request types and critical response codecs

**Files:**

- Create: `src/types/mutations.ts`
- Create: `src/api/critical-codecs.ts`
- Create: `src/api/critical-codecs.test.ts`
- Modify: `src/types/api.ts`
- Modify: `src/api/transactions.api.ts`
- Modify: `src/api/journals.api.ts`
- Create: `src/api/journals.api.test.ts`
- Modify: `src/api/purchase-invoices.api.ts`
- Modify: `src/api/sale-invoices.api.ts`
- Modify: `src/bank-transaction-create.ts`
- Modify: `src/tools/crud/transactions.ts`
- Modify: `src/tools/crud/journals.ts`
- Modify: `src/tools/crud/purchase-invoices.ts`
- Modify: `src/tools/crud/sale-invoices.ts`
- Modify: `src/camt/executor.ts`
- Modify: `src/wise/executor.ts`
- Modify: `src/banking/reconciliation/executor.ts`
- Modify: `src/receipts/batch-operations.ts`
- Modify: `src/documents/operations.ts`
- Modify: `src/sales/invoice-operations.ts`

- [ ] **Step 1: Inventory each mutation caller and pin current valid payloads.** Add compile-time fixtures for accepted request fields and `@ts-expect-error` cases for server-managed/read-only fields.
- [ ] **Step 2: Add operation-specific create/update/confirm/invalidate request types.** Do not use `Partial<ReadModel>` at the four high-risk API boundaries.

```ts
export interface CreateBankTransactionRequest {
  accounts_dimensions_id: number;
  amount: number;
  cl_currencies_id: CurrencyCode;
  date: IsoDate;
  description?: string;
  clients_id?: number;
  bank_account_name?: string;
  bank_account_no?: string;
  ref_number?: string;
  bank_ref_number?: string;
}
```
- [ ] **Step 3: Keep transaction direction trusted.** `createBankTransaction` derives API `type` from semantic direction; raw caller-provided `type` cannot override it.
- [ ] **Step 4: Add tolerant critical codecs.** Permit unknown extra upstream fields but reject malformed IDs, statuses, monetary fields, dates, distributions, and confirmation fields used by pre-mutation checks.
- [ ] **Step 5: Migrate callers one API resource at a time.** Run resource tests after each migration and do not broaden public tool schemas.
- [ ] **Step 6: Verify and commit.** `refactor: harden mutation request and response types`

### Task 19: PR 13 — Money cents and direction contracts

**Files:**

- Create: `src/money-cents.ts`
- Create: `src/money-cents.test.ts`
- Create: `src/currency-code.ts`
- Create: `src/exchange-rate.ts`
- Create: `src/bank-transaction-direction.contract.test.ts`
- Create: `src/architecture-boundaries.test.ts`
- Modify: `src/money.ts`
- Modify: `src/bank-transaction-direction.ts`
- Modify: `src/camt/duplicate-identity.ts`
- Modify: `src/camt/projection.ts`
- Modify: `src/banking/reconciliation/amount-resolution.ts`
- Modify: `src/banking/reconciliation/duplicate-policy.ts`
- Modify: `src/statement-balance-check.ts`
- Modify: `src/bank-transaction-create.ts`

- [ ] **Step 1: Extend the existing money/direction abstractions.** `money-cents.ts`, `currency-code.ts`, and `exchange-rate.ts` reuse/re-export existing rounding and direction concepts from `money.ts` and `bank-transaction-direction.ts`; they must not become competing definitions. Define branded safe-integer cents with checked conversions, reject non-finite/unsafe/excess-precision values, and keep API wire numbers and exchange rates separate.
- [ ] **Step 2: Migrate only comparison/identity boundaries.** Use cents for duplicate keys, reconciliation comparisons, CAMT fingerprints, closing balance, and one-cent conflicts; do not perform a whole-system bigint migration.
- [ ] **Step 3: Pin direction contracts.** CAMT CRDT and Wise IN map to API `D`; CAMT DBIT and Wise OUT map to API `C`.
- [ ] **Step 4: Add architecture guard.** Scan production source and fail when `api.transactions.create` appears outside the shared `createBankTransaction` boundary/adapter. The same test enforces the source specification's pure-domain import ban: the modules Tasks 5-11 designate as pure (`src/camt/parser|preflight|duplicate-identity|projection`, `src/wise/preflight|projection`, `src/banking/reconciliation/` policy modules, `src/resolution/*`) must not import the MCP SDK, `McpServer`, `CallToolResult`, `toMcpJson`, `HttpClient`, `node:fs`, audit, or environment/config modules; executors and presenters are exempt.
- [ ] **Step 5: Verify no BigInt serialization and commit.** `refactor: use integer cents for financial comparisons`

### Task 20: PR 14 — Optional incident correlation and HTTP presentation cleanup

**Decision gate:** Start only if operational evidence shows incident correlation or transport-layer guidance is still a material maintenance problem after PR 13. Deferring this task still satisfies the primary milestone.

**Files:**

- Create: `src/execution-incident.ts`
- Create: `src/execution-incident.test.ts`
- Create: `src/integration-error.ts`
- Create: `src/integration-error.test.ts`
- Modify: `src/http-client.ts`
- Modify: `src/tool-error.ts`
- Modify: `src/audit-log.ts`

- [ ] **Step 1: Add non-executable incident summaries.** Store run ID, connection fingerprint, plan domain, completed IDs, failed/indeterminate command, known object IDs, stop reason, and `automatic_retry_forbidden: true`; never persist private plan payload or approval state.
- [ ] **Step 2: Keep resume manual.** No incident record can be executed or automatically resumed.
- [ ] **Step 3: Return typed transport errors from `HttpClient`.** Move MCP tool recommendations and next actions into presenters/tool-error mapping.
- [ ] **Step 4: Verify redaction, audit size, and indeterminate behavior.** Commit `refactor: separate integration errors from MCP presentation`.

## 6. Focused red/green commands

For each task, run the listed command immediately after adding the new test and expect a non-zero exit caused by the named missing contract. Run the same command after implementation and expect exit 0 with every named test file passing.

| Task | Command | Initial expected failure |
|---:|---|---|
| 1 | `npm test -- src/tool-surface-contract.test.ts src/context-budget.test.ts src/user-journey-contract.test.ts src/internal-mcp-delegation.contract.test.ts` | measurement fixtures/delegation allowlist absent |
| 2 | `npm test -- src/tool-profile.test.ts src/public-tool-registrar.test.ts src/config.test.ts src/mcp-compat.test.ts src/tools/tool-exposure.test.ts` | profile/catalog/public-boundary metadata absent |
| 3 | `npm test -- src/operation-outcome.test.ts src/operation-summary.test.ts src/response-budget.test.ts src/compact-batch-response.test.ts src/operation-result-store.test.ts src/operation-result-page.test.ts src/plan-tools.test.ts` | compact contracts/budgets/result paging absent |
| 4 | `npm test -- src/workflow-state-store.test.ts src/workflow-action-v2.test.ts src/workflow-page.test.ts src/workflow-response.test.ts` | handle/v2 contracts absent |
| 5 | `npm test -- src/camt/parser.test.ts src/camt/operations.test.ts src/tools/camt-import.test.ts src/tools/camt-import-tools.test.ts src/tools/camt-import-refnumber-dedup.test.ts src/internal-mcp-delegation.contract.test.ts` | typed CAMT modules absent |
| 6 | `npm test -- src/wise/operations.test.ts src/tools/wise-import.test.ts` | typed Wise modules absent |
| 7 | `npm test -- src/banking/reconciliation/operations.test.ts src/tools/bank-reconciliation.test.ts src/plan-execution.test.ts src/internal-mcp-delegation.contract.test.ts` | typed reconciliation modules absent |
| 8 | `npm test -- src/receipts/batch-operations.test.ts src/tools/receipt-inbox-tools.test.ts src/tools/receipt-batch-failure.test.ts src/tools/receipt-inbox-summary.test.ts` | typed receipt batch absent |
| 9 | `npm test -- src/receipts/classification-operations.test.ts src/tools/receipt-inbox.test.ts src/tools/receipt-inbox-tools.test.ts src/internal-mcp-delegation.contract.test.ts` | typed classification absent |
| 10 | `npm test -- src/accounting-operations.test.ts src/tools/accounting-inbox-autopilot-service.test.ts src/tools/accounting-inbox.test.ts src/internal-mcp-delegation.contract.test.ts` | typed Inbox orchestration absent |
| 11 | `npm test -- src/resolution/company-resolution.test.ts src/resolution/bank-account-resolution.test.ts src/resolution/supplier-default-resolution.test.ts` | shared deterministic resolvers absent |
| 12 | `npm test -- src/banking/input-format.test.ts src/guided/process-bank-input.test.ts src/file-reference-store.test.ts src/file-input-snapshot.test.ts src/user-journey-contract.test.ts` | unified bank reference/façade absent |
| 13 | `npm test -- src/documents/operations.test.ts src/guided/process-accounting-document.test.ts src/tools/pdf-workflow.test.ts` | typed document/façade absent |
| 14 | `npm test -- src/reporting/operations.test.ts src/records/operations.test.ts src/sales/invoice-operations.test.ts src/guided/run-accounting-report.test.ts src/guided/search-accounting-records.test.ts src/guided/inspect-accounting-record.test.ts src/guided/manage-sale-invoice.test.ts src/tools/bank-reconciliation.test.ts src/user-journey-contract.test.ts` | typed guided read/sales operations and successor journeys absent |
| 15 | `npm test -- src/connection-defaults-store.test.ts src/elicitation.test.ts src/tools/workflow-recommendations.test.ts src/user-journey-contract.test.ts` | persistence/elicitation/interaction contract absent |
| 16 | `npm test -- src/server/server-instructions.test.ts src/server/release-notices.test.ts src/context-budget.test.ts src/prompt-safety-invariants.test.ts` | compact instruction/notice contracts absent |
| 17 | `npm test -- src/runtime/connection-manager.test.ts src/runtime/invocation-scope.test.ts src/connection-safety.test.ts src/tool-surface-contract.test.ts` | decomposed runtime absent |
| 18 | `npm test -- src/api/critical-codecs.test.ts src/api/transactions.api.test.ts src/api/journals.api.test.ts src/api/purchase-invoices.api.test.ts src/api/sale-invoices.api.test.ts` | narrow mutation/codecs absent |
| 19 | `npm test -- src/money-cents.test.ts src/bank-transaction-direction.contract.test.ts src/architecture-boundaries.test.ts src/bank-transaction-create.test.ts` | cents/architecture contracts absent |
| 20 | `npm test -- src/execution-incident.test.ts src/integration-error.test.ts src/http-client.test.ts src/tool-error.test.ts` | optional incident/error split absent |

## 7. Requirement traceability

| Source requirement | Implemented and proven in |
|---|---|
| Guided tool count and `tools/list` byte budget | Tasks 1, 2, 12-16; final program verification |
| Configured instruction byte budget | Tasks 1 and 16 |
| Summary/batch/detail/continuation byte budgets | Tasks 1, 3, 4 and every presenter task |
| Approximately O(1) clean batches | Tasks 3, 5-9 |
| One-call reads and preview-plus-execute mutations | Tasks 12-15; journey contracts |
| No technical IDs on unique paths | Tasks 11-15 |
| Typed operations instead of MCP handler delegation | Tasks 5-14 |
| Opaque workflow state and paged details | Tasks 3 and 4 |
| Backward-compatible standard/full and legacy continuation | Tasks 1-4 and version gates |
| Preview, approval, scope, drift, audit, sandbox, staged receipt, and indeterminate safeguards | Non-negotiable invariants; Tasks 4-10, 13, 18-20 |
| Thin composition-root `index.ts` | Task 17 |
| Narrow mutation types/codecs | Task 18 |
| Cents/direction and direct-create boundary | Task 19 |
| Setup profile choice and persistence | Tasks 2 and 15 |
| Interaction style cannot weaken safety | Task 15 |
| Documentation/generated-surface consistency | Tasks 2, 12-16 and release validation |

## 8. Release gates

Release *content* grouping intentionally diverges from the source spec's A/B/C grouping (see "Resolved deviations", item 2); the gates below are the binding definition.

### Release A (`v0.25.0`) gate — after PR 3

- Measurement is reproducible in CI.
- Guided profile is opt-in and <= 20 tools.
- Compact contracts and workflow handles exist without changing default behavior.
- Old full responses and JSON continuation remain functional.

### Release B (`v0.26.0`) gate — after PR 8A

- CAMT, Wise, and reconciliation run through typed operations.
- Guided bank import is prepare plus execute on the clean path.
- Plan/source/scope/ledger drift and indeterminate safeguards pass the demo canaries.

### Release C (`v0.27.0`) gate — after PR 10

- Receipts, classification, and Accounting Inbox use typed operations.
- Guided bank/document/report/search/sales journeys meet call and byte budgets.
- Guided is documented as recommended but is not yet forced as default.

### Next-major (`v1.0.0` or later) gate — after compatibility window

- Keep legacy `workflow_state_json`, `review_item_json`, `workflow_action_v1`, and full response fields supported and contract-tested through all `v0.25.x`, `v0.26.x`, and `v0.27.x` releases.
- Only after telemetry, docs, and that full compatibility window: make guided the default in `v1.0.0` or later.
- Remove deprecated full-state continuation inputs and legacy response fields only in a separately reviewed major-version migration.

## 9. Final program verification

- [ ] Run `npm run validate:release`.
- [ ] Run `npm run build`.
- [ ] Run `npm test`.
- [ ] Run `npm run test:integration`.
- [ ] Run `npm run smoke:package`.
- [ ] Run `git diff --check`.
- [ ] Run the full demo canary matrix from the source specification.
- [ ] Confirm guided tool count <= 20 and guided `tools/list` <= 25% target/30% hard of PR 0 default bytes.
- [ ] Confirm configured instructions <= 1.5 KiB target/2 KiB hard.
- [ ] Confirm normal/read mutation/batch/detail/continuation byte budgets.
- [ ] Confirm 100-versus-1000 clean batch sizes are approximately constant.
- [ ] Confirm one-call reads and preview-plus-execute mutations on clean journeys.
- [ ] Confirm no production application service parses another MCP tool response.
- [ ] Confirm full profile retains advanced tools and standard/full compatibility fixtures pass.
- [ ] Confirm docs, workflow registry, Markdown sources, generated command mirrors, README, changelog, package contents, and shipped surface agree.

## 10. Stop conditions

Stop the active PR before any production mutation code is merged if:

- a baseline safety test must be weakened to make the refactor pass;
- preview and execute no longer share a frozen command projection;
- a compact response omits a blocker or material financial/scope fact;
- a workflow handle is being treated as approval;
- an operation needs to parse serialized MCP output to continue;
- standard/full compatibility changes without a versioned contract;
- the focused PR requires unrelated file moves or broad renames.

Resolve the architectural cause inside the active PR or split the PR further; do not carry a known invariant violation into the next phase.
