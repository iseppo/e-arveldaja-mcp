# Tax data-integrity remediation

Scope: T1–T6 and infrastructure F4–F6, verified against this worktree before changing production code. F4/F5 are the year-end/dividend portions of T6. No live accounting API calls or pushes were used.

## Findings and changes

| Finding | Verification and resulting behavior |
| --- | --- |
| T1 | Early payments were summed across dates, allowing the entire invoice VAT into the first month. Only payments on the earliest date can now establish full prepayment. Otherwise the existing partial-prepayment review appears in every affected payment month and the invoice month. No automatic allocation is claimed. |
| T2 | Liability selection checked existence/activity only. Both explicit and automatic targets now require `Kohustused`, and cannot overlap any included cost target. Execution revalidates the role. |
| T3 | Financial calculations and existing-close comparisons used `base_amount ?? amount`. `Posting.base_amount` is optional and the API journal loader only ensures postings are loaded; repository types/fixtures/docs provide no guarantee that foreign postings always have EUR valuation. A shared resolver reuses `eurGross`, inherits journal currency when needed, and holds missing foreign EUR values. EUR/absent currency keeps the amount fallback. |
| T4 | An active expense or unrelated equity account could receive a reserve allocation. The target now needs an independently established reserve/equity role and cannot overlap the other closing roles. |
| T5 | Current full VAT status discarded its registration date at purchase decision sites. Pre-registration purchases now require historical-status/deduction review before defaults or registration. An explicit reviewed `false` uses existing non-deductible validation; reviewed `true` permits a statutory exception. Automatic document, receipt, classification and owner-expense paths also apply the date guard. |
| T6 / F4 / F5 | Both write paths accepted execution without a reviewed preview. They now require connection-scoped single-use plan handles binding material arguments and proposed journals. Year-end proposals include resolved dimensions and are compared after fresh ledger analysis inside the existing booking lock. Dividend capacity is still rechecked on a fresh ledger. Changed proposals/arguments refuse before writing. |
| F6 | Month-end read statements before booking limited-taxpayer VAT. VAT processing now precedes all statement reads used by the summary. |

No finding was skipped. Deliberately constructed journal sequences, adversarial documents and external-writer races between execute-time read and write remain outside this change's scope.

## Regression and mutation evidence

All fixes began with failing regressions. Public registered handlers are used where practical; calculation/helper tests supplement the handler tests. Legacy write tests explicitly prepare through fixture wrappers; new approval tests call raw handlers.

| Fix | Mutation check: temporarily remove production correction, run regressions, restore |
| --- | --- |
| T1 | Both instalment regressions failed with the original sum across early dates. Restored; same-date full-payment positive controls retained. |
| T2 | Invalid override, automatic target and target-collision regressions failed without role/collision guards; execute-time role regression also failed. Restored. |
| T3 | Four foreign-valuation/report/existing-close regressions failed with the original amount fallback. Restored. |
| T4 | Six invalid explicit/automatic reserve-target regressions failed without role/collision checks. Restored. |
| T5 | Three creation/confirmation/shared-document regressions failed with the historical-date guard disabled. Both supplier-order regressions also failed when their placement corrections were reversed. Restored; all ten historical-VAT regressions pass. |
| T6 / F4 | Nine raw year-end approval regressions failed with execute-time plan binding removed. Restored. |
| T6 / F5 | All six raw dividend approval regressions failed with plan consumption/comparison disabled. Restored. |
| F6 | The rendered month-end ordering test failed with the original workflow order. Restored. |

Positive controls cover EUR postings without base amounts, foreign postings with verified EUR bases, a custom reserve account, registration-day purchases, both reviewed historical deduction choices, and unchanged single-use plan execution.

## Owner-facing decisions

- Allocate VAT manually for instalments held for review; the tool does not automatically split them.
- For each pre-registration purchase, confirm historical treatment and choose no deduction or a statutory exception after review. A deductible draft must be corrected before choosing no deduction.
- Obtain a new approved preview after drift, a consumed/expired plan, or partial execution. Existing year-end drafts are detected by the new preview.

## Final gates

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | PASS, exit 0. |
| `npm run -s typecheck:tests` | PASS, exit 0; total 1698 = baseline 1698, TypeScript errors 0, explicit-any 1520 and untyped payload calls 178 unchanged. Baseline file not changed. |
| `npx vitest run` | PASS, exit 0; 262 files, 9751 tests passed, 1 existing skip; 133.07 seconds. |
| `npm run build` | PASS, exit 0; integration gate also rebuilt the final production sources. |
| `npm run sync:workflow-prompts` | PASS, exit 0; 16 mirrors synchronized; a repeat left their diff byte-identical. |
| `EARVELDAJA_INTEGRATION_TEST=false npm run test:integration` | PASS, exit 0; 3 files, 30 tests passed, 3 live API tests deliberately skipped; 300.40 seconds. |
| `npx tsx scripts/measure-mcp-surface.ts --output testdata/tool-surface` | PASS, exit 0; snapshots regenerated; tool counts unchanged. |

Sandboxed process/IPC tests failed initially; required local process permissions were used for the passing final gates. The old dividend approved-figures protocol test was adapted to request a preview (execution now requires its handle), and it also checks changed-amount refusal through real in-memory MCP transport. No production correction was weakened to satisfy that test.

## Changed files

- Core VAT: `src/company-vat-status.ts`, `src/limited-vat.ts`, `src/limited-vat.test.ts`.
- Tools: `src/tools/limited-vat.ts`, `src/tools/limited-vat.test.ts`, `src/tools/financial-statements.ts`, `src/tools/annual-report.ts`, `src/tools/annual-report.test.ts`, `src/tools/estonian-tax.ts`, `src/tools/estonian-tax.test.ts`, `src/tools/crud/purchase-invoices.ts`, `src/tools/crud-tools.test.ts`, `src/tools/purchase-historical-vat.test.ts`, `src/tools/pdf-workflow.ts`, `src/tools/receipt-inbox-booking.ts`, `src/tools/receipt-inbox-types.ts`.
- Shared callers: `src/documents/operations.ts`, `src/documents/reading-operations.ts`, `src/receipts/batch-operations.ts`, `src/receipts/classification-operations.ts`.
- Registration and protocol/prompt tests: `src/server/register-domain-tools.ts`, `src/server/dividend-approved-figures.protocol.test.ts`, `src/prompts.test.ts`.
- Guidance: `workflows/book-invoice.md`, `workflows/month-end.md`, their generated `.claude/commands/` mirrors, `CLAUDE.md`, `CHANGELOG.md`, and this record.
- Regenerated MCP surfaces: `testdata/tool-surface/{custom,full,setup,standard}.json`; guided surfaces remain byte-identical.

Independent reviewer passes found no remaining actionable defect after the supplier-order correction. They covered T1/T2, T3/T4, T5 and both T6 execution paths separately from their implementation lanes.
