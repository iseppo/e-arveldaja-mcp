# MCP Tool Surface Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce e-arveldaja MCP tool-selection friction by adding merged guided workflow tools while preserving existing low-level tool compatibility.

**Architecture:** Keep public compatibility aliases in place, but move workflow behavior behind pure service functions that do not depend on MCP registration or JSON text parsing. Add merged wrapper tools only after services are testable, then deprecate old entry points in docs without deleting them.

**Tech Stack:** TypeScript, MCP SDK, Zod schemas, Vitest, existing e-arveldaja API context and audit helpers.

---

## File Structure

- `src/tools/accounting-inbox-autopilot-service.ts`: pure dry-run pipeline service extracted from `accounting-inbox.ts`.
- `src/tools/accounting-inbox-autopilot-service.test.ts`: focused tests for autopilot sequencing and materialization blocking.
- `src/record-utils.ts`: shared record-reading helpers for MCP JSON payload inspection.
- `src/tools/accounting-inbox.ts`: thin tool registration plus workspace scanner and review action tools.
- `src/workflow-response.ts`: workflow envelope builder migrated to shared helpers.
- `src/tools/camt-import.ts`: CAMT service wrapper entry point, preserving `parse_camt053` and `import_camt053`.
- `src/tools/receipt-inbox.ts`: receipt batch service wrapper entry point, preserving current scan/process names.
- `src/tools/bank-reconciliation.ts`: reconciliation service wrapper entry point, preserving current suggest/auto-confirm names.
- `src/tools/workflow-recommendations.ts`: workflow recommendation updates to point users at merged wrappers.
- `README.md`, `CHANGELOG.md`, `workflows/*.md`: compatibility and deprecation notes after code lands.

## Execution Rules

- Keep existing tool names registered until a release explicitly removes them.
- New merged tools must use explicit `mode` fields instead of ambiguous booleans.
- Do not route mutating execution through read-only workflow continuation.
- Preserve validation behavior: invalid user payloads should return existing user-facing tool errors where that is already the contract.
- Run focused tests after every slice; run `npm test`, `npm run build`, and `npm run test:integration` before declaring the branch complete.

## Task 1: Stabilize Current Autopilot Service Extraction

**Files:**
- Modify: `src/tools/accounting-inbox-autopilot-service.ts`
- Modify: `src/tools/accounting-inbox-autopilot-service.test.ts`
- Modify: `src/tools/accounting-inbox.ts`

- [ ] **Step 1: Run the focused test for the extracted pipeline**

Run:

```bash
npm test -- src/tools/accounting-inbox-autopilot-service.test.ts
```

Expected: the new test either passes or fails with a focused pipeline behavior mismatch, not a TypeScript/import error.

- [ ] **Step 2: Add a test for CAMT parse failure blocking downstream import**

Add a Vitest case in `src/tools/accounting-inbox-autopilot-service.test.ts` that prepares two recommended steps for the same `file_path`: `parse_camt053` fails and `import_camt053` is not recommended next.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
npm test -- src/tools/accounting-inbox-autopilot-service.test.ts
```

Expected: fail because the missing behavior is not covered or because the expected summary/recommendation is wrong.

- [ ] **Step 4: Implement only the missing pipeline behavior**

Adjust `pickNextAutopilotRecommendedAction` and materialization blocking in `src/tools/accounting-inbox-autopilot-service.ts` only as needed.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm test -- src/tools/accounting-inbox-autopilot-service.test.ts
```

Expected: pass.

## Task 2: Extract Shared Record Helpers

**Files:**
- Create: `src/record-utils.ts`
- Create: `src/record-utils.test.ts`
- Modify: `src/workflow-response.ts`
- Modify: `src/tools/accounting-inbox.ts`
- Modify: `src/tools/accounting-inbox-autopilot-service.ts`
- Modify: `src/tools/accounting-inbox-autopilot.ts`

- [ ] **Step 1: Write helper tests first**

Create `src/record-utils.test.ts` covering `isRecord`, `numberAt`, `stringAt`, `arrayAt`, `recordAt`, and `stringArrayAt`.

- [ ] **Step 2: Run helper tests and verify RED**

Run:

```bash
npm test -- src/record-utils.test.ts
```

Expected: fail because `src/record-utils.ts` does not exist yet.

- [ ] **Step 3: Add `src/record-utils.ts`**

Export the shared helpers currently duplicated across `workflow-response.ts`, `accounting-inbox.ts`, and `accounting-inbox-autopilot-service.ts`.

- [ ] **Step 4: Migrate callers one file at a time**

Replace duplicated helper definitions in each caller with imports from `../record-utils.js` or `./record-utils.js` depending on relative path.

- [ ] **Step 5: Verify focused tests**

Run:

```bash
npm test -- src/record-utils.test.ts src/workflow-response.test.ts src/tools/accounting-inbox-autopilot-service.test.ts src/tools/accounting-inbox.test.ts
```

Expected: pass.

## Task 3: Verify Merged Accounting Inbox Tool

**Files:**
- Modify: `src/tools/accounting-inbox.ts`
- Modify: `src/tools/accounting-inbox.test.ts`
- Modify: `src/tools/workflow-recommendations.ts`
- Modify: `README.md`

**Current baseline:** `accounting_inbox` is already registered as the merged entry point, and the scan/dry-run mode tests already exist. Treat this task as a regression and documentation verification step, not a RED/GREEN implementation slice.

- [x] **Step 1: Confirm tests for `accounting_inbox` modes exist**

Existing tests prove `accounting_inbox({ mode: "scan" })` returns the same prepared payload as `prepare_accounting_inbox`, and `accounting_inbox({ mode: "dry_run" })` returns the same autopilot payload as `run_accounting_inbox_dry_runs`.

- [x] **Step 2: Confirm `accounting_inbox` is registered**

The tool is registered with `mode: z.enum(["scan", "dry_run"]).optional()` and reuses the existing scanner and autopilot service paths.

- [x] **Step 3: Keep aliases**

Leave `prepare_accounting_inbox` and `run_accounting_inbox_dry_runs` registered as aliases that call the same internal helper functions.

- [ ] **Step 4: Verify regression coverage**

Run:

```bash
npm test -- src/tools/accounting-inbox.test.ts src/tools/workflow-recommendations.test.ts
```

Expected: pass.

## Task 4: Verify Review Continuation State Machine

**Files:**
- Modify: `src/tools/accounting-inbox.ts`
- Modify: `src/tools/accounting-inbox.test.ts`
- Modify: `src/workflow-response.ts`

**Current baseline:** `continue_accounting_workflow` already supports `next`, `resolve_review`, and `prepare_action` action modes, and the tests already exist. Treat this task as a regression verification step.

- [x] **Step 1: Confirm tests for `continue_accounting_workflow` action modes exist**

Existing tests cover `action: "next"`, `action: "resolve_review"`, and `action: "prepare_action"` using existing review-item fixtures.

- [x] **Step 2: Confirm schema and dispatch are extended**

The tool accepts optional `action` and routes to existing `resolveReviewItemPlan` or `prepareReviewAction` paths.

- [x] **Step 3: Keep aliases**

Leave `resolve_accounting_review_item` and `prepare_accounting_review_action` registered as compatibility wrappers.

- [ ] **Step 4: Verify regression coverage**

Run:

```bash
npm test -- src/tools/accounting-inbox.test.ts src/workflow-response.test.ts
```

Expected: pass.

## Task 5: Add Remaining Import Wrappers and Verify Reconciliation Wrapper

**Files:**
- Modify: `src/tools/camt-import.ts`
- Modify: `src/tools/camt-import-tools.test.ts`
- Modify: `src/tools/receipt-inbox.ts`
- Modify: `src/tools/receipt-inbox-tools.test.ts`
- Modify: `src/tools/bank-reconciliation.ts`
- Modify: `src/tools/bank-reconciliation.test.ts`

**Current baseline:** `reconcile_bank_transactions` is already registered and covered by wrapper tests. The remaining merged-wrapper work in this slice is `process_camt053` and `receipt_batch`; keep the existing reconciliation wrapper tests passing while adding those wrappers.

- [ ] **Step 1: Add tests for `process_camt053`**

Modes: `parse`, `dry_run`, `execute`.

- [ ] **Step 2: Add tests for `receipt_batch`**

Modes: `scan`, `dry_run`, `create`, `create_and_confirm`.

- [x] **Step 3: Confirm tests for `reconcile_bank_transactions` exist**

Modes: `suggest`, `dry_run_auto_confirm`, `execute_auto_confirm`, and `inter_account_dry_run`.

- [ ] **Step 4: Verify RED for the remaining wrappers**

Run:

```bash
npm test -- src/tools/camt-import-tools.test.ts src/tools/receipt-inbox-tools.test.ts src/tools/bank-reconciliation.test.ts
```

Expected: fail only for the missing `process_camt053` and `receipt_batch` wrappers. Existing `reconcile_bank_transactions` tests should remain green.

- [ ] **Step 5: Implement remaining wrappers without deleting old tools**

Each wrapper calls the same internal service path as the existing tool. The old tool names remain the stable primitive API.

- [ ] **Step 6: Verify GREEN**

Run the same focused tests again and expect all pass.

## Task 6: Refactor CRUD and Reference Tool Registration Internals

**Files:**
- Modify: `src/tools/crud-tools.ts`
- Create: `src/tools/reference-data-tools.ts`
- Modify: `src/index.ts`
- Modify: `src/tools/crud-tools.test.ts`

- [ ] **Step 1: Snapshot registered tool names**

Add a test that registers the server into a mock and asserts the current tool names still include existing CRUD/reference names.

- [ ] **Step 2: Extract reference data registrations**

Move `list_accounts`, `list_account_dimensions`, `list_currencies`, article/template/project/bank-account list tools into `reference-data-tools.ts`.

- [ ] **Step 3: Verify no tool loss**

Run:

```bash
npm test -- src/tools/crud-tools.test.ts
```

Expected: pass and registered tool set remains compatible.

## Task 7: Documentation and Release Validation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `workflows/*.md`
- Modify: `.claude/commands/*.md`

- [ ] **Step 1: Document merged tools as preferred entry points**

Mention old tool names as compatibility aliases.

- [ ] **Step 2: Update workflow recommendations**

Point new users toward merged workflow wrappers.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run build
npm run test:integration
```

Expected: all pass.

## GitHub Issue Mapping

- Parent issue: tool surface refactor roadmap.
- Subissue 1: service boundaries and shared helpers.
- Subissue 2: accounting inbox merged tool.
- Subissue 3: workflow continuation and review-action merge.
- Subissue 4: import and receipt wrapper tools.
- Subissue 5: reconciliation/classification unification.
- Subissue 6: CRUD/reference registration cleanup and documentation.

## Self-Review

- Spec coverage: covers public tool merge choices, code refactor boundaries, compatibility, and verification.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: new modes use explicit string enums; old booleans stay only in compatibility aliases.
- Scope check: large enough for multiple PRs, but each subissue is independently testable.
