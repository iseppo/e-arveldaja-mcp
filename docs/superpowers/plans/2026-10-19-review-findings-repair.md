# Review Findings Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task, with a separate independent reviewer. Steps use checkbox syntax for tracking. The coordinator must obtain the requested xhigh plan review before execution.

**Goal:** Repair the six accepted review findings without regressing previously proved cash classifications, API-only opening balances or dividend approval safeguards.

**Architecture:** Tighten the existing pure cash-flow engine at its valuation, principal/result and invoice-allocation boundaries. Keep the dividend correction inside its existing fresh-ledger legality calculation, and preserve the existing transaction evidence loader. Keep all identifiable accounting evidence outside the repository; this plan contains only synthetic fixtures, public account numbers and private evidence path references.

**Tech Stack:** TypeScript, Vitest, existing MCP tool mocks, saved-data Node replay and independent Python Decimal validator.

**Status:** Implemented and verified on 2026-10-19. The independently approved original plan is retained byte-for-byte outside the repository. Independent xhigh actual-code review: APPROVE after two additional demonstrated defects were fixed and re-reviewed. Final checks: 7995 unit tests, 20 integration tests and 16137 independent saved-data comparisons passed; configured skips are recorded privately. Fresh GET-only verification passed for both authorized companies. All 135 prior targets and 17 intentional unresolved movements remain unchanged. No accounting writes, commit, push or publication. Private closeout and evidence: `../verification/2026-10-19-api/review-repair/tulemus.md`.

## Scope and acceptance contract

The accepted private audit is `../verification/2026-10-19-api/full-code-review/ulevaatus.md`, with `cashflow.md`, `opening.md` and `api-surface.md` in the same directory. Findings are: standard investment FX results misclassified as operating; investing-account presence mistaken for principal evidence; a latent draft-INITIAL dividend-capacity defect; lost known EUR cash when another posting is invalid; conditional capital-invoice dimension mismatch; private evidence in an unignored plan. The dividend scanner defect existed before the current opening migration; the dimension example is a supported-type contract gap, not a confirmed production-company failure.

Acceptance requires all six corrections, retained gross cash and component ownership, the 135 frozen false-hold targets, all 17 intentionally unresolved Lightyear rows, and unchanged category-level gross/net cash for every unaffected previously classified real journal. Numerical reconciliation alone does not prove purpose. Keep indirect reporting, result-only guards, I/F invoice capacity/date safeguards, explicit rules, cash-FX proof, 500-detail/five-concurrent-GET limits and API-only INITIAL semantics. No accounting mutations, commits, pushes, releases or publication are part of this work. Execution tests use only mocked writes; saved-data replay blocks network.

The six saved-real-data oracle sets and exact amounts are private in `../verification/2026-10-19-api/cashflow-refinement/oracles.json`, `cashflow-refinement/validate.py`, `cashflow-refinement/after/` and `cashflow-after/`. The current independently frozen all-row baseline is `../verification/2026-10-19-api/review-repair/verification-baseline.json`. Do not copy their names, IDs, transaction descriptions or totals into public docs, fixtures or commit messages. Preserve the original evidence and validators. A fresh verification output directory is `../verification/2026-10-19-api/review-repair/`.

## File ownership and edit boundaries

| Owner / pass | Files | Permitted change |
| --- | --- | --- |
| Cash-flow executor | `src/reporting/annual-cash-flow.ts` | Shared posting-value predicate; known cash on invalid journal; bounded principal/result proof; capital settlement dimension/sign selection. No unrelated rewrite. |
| Cash-flow tests | `src/reporting/annual-cash-flow.test.ts` | Synthetic numeric matrices and counterexamples using existing accounting fixture helpers. |
| Annual integration tests | `src/tools/annual-report.test.ts` | Real exported report-core assertions for the new cases, including status, bridge, categories and gross exposure. |
| Annual output adapter, only if needed | `src/tools/annual-report.ts` | Additive valuation-coverage disclosure or presentation cap only. Keep statement formulas, unrelated statements and public numeric fields unchanged. |
| Dividend executor | `src/tools/estonian-tax.ts` | Candidate exclusion, per-draft conservative reservations, anomaly disclosure and gate inside existing `checkAndBook`. |
| Dividend tests | `src/tools/estonian-tax.test.ts` | Preview and fresh-read mock-execute regressions, negative component matrix, force and ordinary pending reservation. |
| Documentation executor | `docs/superpowers/plans/2026-10-19-cash-flow-correction.md`, `CLAUDE.md`, `CHANGELOG.md` | Sanitize the old public plan after preserving its exact private original. Describe final conservative behavior in current domain docs and Unreleased changelog. |
| Independent verifier | private `review-repair/` artifacts | Baseline manifest, RED/GREEN logs, plan/code reports, replay runner copies, independent validation and final limitations. |

Do not modify `cash-flow-evidence.ts`, API/CRUD mutation wrappers, opening loader/store removal, chart/rules files, tool catalog, profiles, prompt mirrors or unrelated dirty files unless a newly demonstrated defect makes a small extra change necessary and the coordinator records that reason. Do not add a general policy engine, trade parser or new tool/schema.

## Task 1: Freeze recoverable evidence and preserve the private plan

- [x] From the actual repository root run `git status --short --branch`. Compare the existing dirty file set with the private baseline manifest under `review-repair/`. Record source hashes and a scoped diff outside the repo, including untracked cash-flow sources; do not reset existing changes.
- [x] Before sanitizing the old public plan, preserve an exact byte copy outside the repository, then verify its hash. If the coordinator already created the baseline copy, require byte equality and retain it; never overwrite a conflicting backup. A concrete preservation command is:

```bash
python3 - <<'PY'
from pathlib import Path
import hashlib, os
src = Path('docs/superpowers/plans/2026-10-19-cash-flow-correction.md')
dst = Path('../verification/2026-10-19-api/review-repair/baseline/docs__superpowers__plans__2026-10-19-cash-flow-correction.md')
dst.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(dst.parent, 0o700)
payload = src.read_bytes()
if dst.exists():
    assert dst.read_bytes() == payload, 'Conflicting baseline: retain both and investigate before sanitizing'
else:
    with dst.open('xb') as out:
        out.write(payload)
os.chmod(dst, 0o600)
assert hashlib.sha256(dst.read_bytes()).digest() == hashlib.sha256(payload).digest()
print('Exact private plan backup verified')
PY
```

- [x] Keep the SHA and private backup path in the private manifest. All new private logs/files use mode 0600 and private directories 0700. No original source snapshot, oracle, validator, plan evidence or accounting input is deleted. This is preservation plus public-content sanitization, not evidence deletion.
- [x] Read all four audit documents and the relevant existing code/tests before implementing. Read current `AGENTS.md`/`CLAUDE.md`; use `apply_patch` for manual edits. No external SDK or API changes are needed.

## Task 2: Test and replace the principal/result shortcut

**Files:** `src/reporting/annual-cash-flow.ts`, `src/reporting/annual-cash-flow.test.ts`, `src/tools/annual-report.test.ts`.

### Proof contract

Keep the existing pure base-only cash-FX branch separate. For a journal containing both an investment principal candidate and a recognized result, perform the following bounded proof before homogeneous/slice fallbacks:

1. Cash postings have one nonzero direction after signed D/C normalization. Existing opposed-cash handling remains earlier. There must be at least one **nonzero** genuine debit-nature `Varad` gross/principal posting (`balance_type === "D"`) with an investing role. A zero principal row, contra-asset alone, liability or income/expense account explicitly classified investing cannot prove principal. The narrowly proved fixed-asset/accumulated-depreciation exception in condition4 is permitted; it never makes contra-assets standalone principal.
2. Separate result families: securities `[8330,8335]`; fixed-asset disposals `[3820,7100,7110]`; FX `[3840,7310,8500]`. Results must be chart `Tulud`/`Kulud`; FX uses the same recognized FX predicate as the cash-FX branch. Do not generally change these accounts' roles. A result-account `categoryRule` remains authoritative: any explicit rule in a bundled result retains `investment_result_override_requires_allocation`, including an equal `investing` rule. Standalone explicit operating/investing/financing rules continue to work.
3. Every nonzero gross/principal posting has sign opposite actual cash; only the explicitly paired accumulated-depreciation reversal in condition4 can have the cash direction. All nonzero noncash rows must be proved principal, its paired depreciation reversal or supported result, with no settlement/unrelated operating/equity/liability rows. The whole journal must balance using valued EUR postings. Multiple principal rows of one compatible asset family and multiple result/fee rows are allowed; do not reject an existing fee bundle just because it contains two expense rows. Valued zero result rows do not trigger the bundle or financing-FX guard and do not establish direction.
4. Securities disposal: actual cash receipt, securities principal decreases (`Varad` 1100–1199), securities gain/loss plus optional FX results. Fixed-asset disposal: actual cash receipt, nonzero genuine debit-nature gross fixed assets decrease (existing fixed-asset predicate), fixed-asset gain/loss plus optional FX. **Bounded accumulated-depreciation exception:** allow the same fixed-asset-family chart-proved accumulated-depreciation contra-account (`Varad`, balance type C, standard accumulated-depreciation account or unambiguous chart name such as accumulated depreciation / akumuleeritud kulum) to decrease via positive signed D postings. Its total reversal cannot exceed the gross asset decrease; net book principal is gross decrease minus paired depreciation reversal, must be nonnegative, and when positive has sign opposite cash. Zero net book principal is allowed only when nonzero gross asset disposal and exactly covering paired depreciation reversal are proved. All gross/contra amounts belong to that same fixed-asset family and are fully covered; a generic unrelated C-type asset, wrong-side depreciation row, contra-only row or excess reversal fails. Do not generalize this exception to securities or net an increasing ordinary asset against a decreasing one. Do not use a loan receivable or an account merely overridden to investing as securities-sale proof. A mixed securities/fixed-asset/result family is unresolved.
5. Securities acquisition with fees: actual cash payment, securities principal increases, all non-FX result rows are `8335` chart `Kulud` with positive signed expense, plus optional FX of either sign. This is the existing acquisition-plus-expense structure. It must remain investing even with several fee rows. A credit on `8330` funding an asset purchase can be a dividend/reinvestment; it does not satisfy this fee rule. Wrong-sign/reversal expense rows require separate evidence and stay unresolved here.
6. FX-only principal bundles: actual cash payment with increasing principal or actual cash receipt with decreasing principal; principal is a genuine supported investment asset (including a given-loan principal). FX result may have either sign. Standard 1420/1430 operating receivables retain their default. Mixed loan principal plus securities gain/dividend account is unresolved; pure loan movements without such results continue to classify normally.
7. On proof, allocate the *actual cash* once to investing, adjust the owned P/D/W slices once as nonoperating, and add no FX cash effect. On failure, `unknown("investment_principal_result_unproved")` and `continue`; do not let a rejected bundle fall through into `homogeneous_counterpart` or `exact_counterpart_slice` and reappear as complete. Any nonzero direction mismatch, unsupported family or override must therefore stay unresolved even if its numerical bridge reconciles.

The same newly demonstrated fallback problem exists for financing principal plus realized FX. Apply the smallest safe related guard: if a nonzero financing principal/liability is combined with nonzero recognized FX result rows and this journal has no exact supported allocation proof, make the full cash movement unresolved before homogeneous/slice fallback. A valued zero FX row cannot create a new hold on an ordinary principal-only movement. Do not falsely split F principal and O FX or infer all interest/fees to be financing. Full financing-FX bundle support is outside this repair; an explicit source-backed allocation can be designed separately if needed. Preserve ordinary loan receipts/payments and proved operating invoice FX.

Keep helpers local to this module/function and reuse the existing `signed`, `role`, `components`, `unknown`, `movement`, `adjust` and chart lookups. A compact shape for the replacement is:

```typescript
// Run only after existing cash-FX/opposed-cash branches. All ps are valued here.
const resultIds = new Set([8330,8335,3820,7100,7110,3840,7310,8500]);
const resultRows = counterpart.filter(p => signed(p) !== 0 && resultIds.has(p.accounts_id) &&
  ["Tulud", "Kulud"].includes(chart.get(p.accounts_id)?.account_type_est ?? ""));
const principalRows = counterpart.filter(p => signed(p) !== 0 && !resultRows.includes(p) &&
  chart.get(p.accounts_id)?.account_type_est === "Varad" &&
  chart.get(p.accounts_id)?.balance_type === "D" && role(p.accounts_id) === "investing");
// Candidate detection must see any nonzero role-investing row regardless of
// account nature, and raw supported asset families when a rule changes role.
// Reject invalid nature rather than skipping proof and leaking into fallback.
// A separate proved fixed-asset contra slice may pair with principalRows per #4.
// Derive supported families and the conditions above from these exact rows.
// Only the proved branch calls movement(..., "investing", net, ...) and adjust.
```

The executor must implement the full seven conditions; the snippet identifies the existing insertion boundary, not a replacement for those checks. No document title, company ID or inferred market event can substitute for the proof.

### RED and numeric test matrix

- [x] Before changing source add a parameterized matrix with existing `makeAccount`, `makeJournal`, `makePosting` helpers. Add missing synthetic chart accounts with the proper account types/names. For **each** FX account 3840/7310/8500 assert these independent expectations:

| Shape (all synthetic EUR) | Investing | Profit | Bridge correction | Operating | Cash FX |
| --- | ---: | ---: | ---: | ---: | ---: |
| D cash 120 / C securities 100 + C FX 20 | receipt 120 | +20 | -20 | 0 | 0 |
| D cash 90 + D FX 10 / C securities 100 | receipt 90 | -10 | +10 | 0 | 0 |
| D securities 100 + D FX 10 / C cash 110 | payment 110 | -10 | +10 | 0 | 0 |
| D securities 100 / C cash 90 + C FX 10 | payment 90 | +10 | -10 | 0 | 0 |

Every row must be `complete`, with zero bridge difference/coverage difference and one owned adjustment. Repeat selected rows encoded using negative D/C amounts with equal economic signed effects. Also test a valid foreign cash posting with explicit EUR base and each result account; never equate source-currency amount with EUR.

Concrete fixture pattern using the existing aliases is:

```typescript
it.each([3840, 7310, 8500])("keeps realized FX %s inside sale cash", id => {
  const chart = [...accounts.filter(a => a.id !== id),
    makeAccount(id, "C", "Tulud", "Valuutakursi tulemus")];
  const r = calculate([j(801, [p(1020,"D",120), p(1100,"C",100), p(id,"C",20)])], {accounts:chart});
  expect(r.status).toBe("complete");
  expect(r.investing).toEqual({cash_receipts:120, cash_payments:0, net:120});
  expect(r.operating_bridge).toMatchObject({adjusted_total:0, direct_operating_cash:0,
    non_operating_adjustments:-20, difference:0, coverage_difference:0});
  expect(r.exchange_rate_effect_on_cash).toBe(0);
});
```

- [x] Add positive acquisition-fee cases D securities 100 + D8335 4 / C cash 104 and D securities 100 + D8335 3 + D8335 1 / C cash 104. Assert I payment 104, P=-4, adjustment +4, O=0, complete. Add acquisition fee plus FX gain/loss, disposal gain/loss plus a different FX result, and receipt containing both securities gain8330 and expense fee8335, retaining actual cash and aggregate P correction exactly once. Multiple result rows must remain supported on both receipts and payments.
- [x] Preserve conventional fixed-asset disposals including accumulated depreciation with explicit chart metadata: D cash100+D1890 contra20 / C1820 gross100+C3820 gain20 gives I receipt100, P+20, correction-20, O0, complete; D cash60+D1890 contra20+D7100 loss20 / C1820 gross100 gives I receipt60, P-20, correction+20, O0, complete; fully depreciated D cash80+D1890 contra100 / C1820 gross100+C3820 gain80 gives I receipt80, P+80, correction-80, O0, complete. Add an annual-report positive control for this exception. Negative controls: contra-only, unrelated C-type asset, wrong-signed depreciation, depreciation reversal greater than gross asset, incompatible fixed-asset family and same-signed increasing ordinary asset must require review. Assert no double depreciation/P adjustment.
- [x] Add the direction counterexample D cash 70 + D securities 30 / C8330 100: unresolved receipt 70, no proved I/O/FX, requires review. Add D securities 100 / C cash 70 + C8330 30 (possible dividend-funded acquisition), cash with increasing loan1410 plus8330, decreasing loan1410 plus8330, wrong-side8335 acquisition expense, mixed asset families, a nonasset account explicitly investing, unrelated expense, unvalued FX and two result overrides (operating and investing). Each must require review with known gross; no automatic dividend inference. Keep a valid decreasing-securities8330 sale and pure loan receipt/payment as positive controls.
- [x] Make candidate-boundary tests concrete: D5990 expense100+D7310 FX5/C cash105 with explicit `5990 -> investing` must require review, not escape as I100/O5; D cash100 + a zero1100 posting / C8330 income100 must retain result-only review. Add valued zero FX rows to ordinary investment/financing principal-only movements and assert their original complete buckets remain unchanged.
- [x] Assert standalone 8330/8335/3820/7100/7110 still require evidence/default review; explicit standalone rules still classify as before. Assert a normal pure base-only cash revaluation uses FX alone; an ordinary cash+FX-result journal still requires review.
- [x] Add financing FX counterexamples D borrowing100+D7310 5/C cash105 and D cash130/C borrowing100+C8500 30. Require unresolved known gross105/130 and no falsely complete F/O split. Positive controls keep pure financing cash and independently proved operating FX settlements unchanged. Check the all-row saved baseline before accepting any new hold; unexplained changes in previously correct rows fail verification.
- [x] Add exported `buildAnnualReportData` regressions for standard8500 sale,7310 acquisition, wrong-direction8330 and multiple8335 fees. Use a synthetic registered INITIAL to balance starting positions where needed. Assert final public O/I/F, gross values, FX, bridge and status rather than only calculator status or zero reconciliation.
- [x] Run `npm test -- src/reporting/annual-cash-flow.test.ts src/tools/annual-report.test.ts`, retain RED output privately, and require failures at the new financial assertions, not imports/types. Then implement the bounded proof, rerun the same files and require GREEN. Preserve original acquisition-fee fixtures and all unaffected journal buckets in the later replay.

## Task 3: Preserve independently valued cash on invalid journals

**Files:** `src/reporting/annual-cash-flow.ts`, `src/reporting/annual-cash-flow.test.ts`, conditional additive adapter change in `src/tools/annual-report.ts`.

- [x] Add RED cases: valid EUR receipt95 plus a foreign noncash counterpart missing base; valid EUR payment95 plus malformed noncash counterpart; known opposed EUR cash D150/C55 plus invalid noncash row; known EUR cash plus foreign cash without base; only unvalued foreign cash; invalid posting side; nonfinite base; sign-conflicting base. Assert `requires_review` in every invalid case. Known gross is respectively receipt95; payment95; receipt150/payment55/net95; the known EUR gross only; zero known gross for only unknown cash. Unknown foreign raw amounts never enter EUR totals.
- [x] Extract the current validation expression into one local predicate `postingIsValued(p, j)` and use it both for whole-journal rejection and selecting known cash. It must require D/C, finite chosen amount, compatible amount/base sign and base present for foreign currency. Keep signed-negative ordinary posting support.
- [x] Replace the invalid-journal zero movement with an unresolved movement built from `knownCash = cashPs.filter(p => postingIsValued(p,j))`: sum signed known cash into net and positive/negative sides into gross. Keep all cash posting IDs as provenance, pass `owned: []` to avoid deriving P/D/W from invalid rows, and retain the original issue. Do not classify a partially invalid journal's known cash as operating/investing/financing.
- [x] Add `unvalued_cash_posting_count` to the unresolved movement only when positive, plus the specific unvalued cash posting IDs (and posting indexes where IDs are absent); known cash posting IDs must remain distinguishable. Add the aggregate count under existing `evidence_coverage`. Cap any newly presented ID/index list at500 with its full count/truncation marker; pure evidence remains uncapped. This discloses missing cash valuation separately from known zero cash. Malformed *noncash* counterparts yield zero unvalued cash count but still show the existing journal issue. Keep INITIAL out of cash movements even when invalid; the issue remains visible. Add an invalid-INITIAL regression and a known D95/C95 zero-net gross case with an invalid noncash counterpart.
- [x] Run the focused cash-flow tests RED then GREEN. Add one annual-report integration assertion that known gross survives the public adapter and `status` remains review; do not invent a bridge exclusion or balancing plug to eliminate its valuation/coverage limitation.

## Task 4: Bind capital allocation to account, dimension and direction

**Files:** `src/reporting/annual-cash-flow.ts`, `src/reporting/annual-cash-flow.test.ts`, `src/tools/annual-report.test.ts`.

- [x] Add RED synthetic dimensional capital-invoice tests using `allows_dimensions:true`: source settlement dim11, distribution dim11, registered payment dim22 fails; source dim11/distribution dim22 fails; null/defined mismatch fails; matching11 passes; no dimensions everywhere preserves the ordinary standard-account case. This verifies the supported contract without asserting production availability of dimensional settlement accounts.
- [x] Add two same-account payment components dim11 and dim22 with separate exact invoice links. Swap item dimensions and require review; match them and verify each posting slice consumed once. Repeat for a mixed operating/capital source and gross-VAT capital source, retaining existing partial/mixed/VAT/capacity holds. Add capital credit-note and explicit reversal controls with correct and wrong signed payment leg. Preserve positive-magnitude distribution items on normal credit-note refunds, while an ordinary invoice reversal requires an explicitly negative item as in the operating branch. Add a transaction header with opposite amount/base signs and require review before allocation.
- [x] Choose the conservative source boundary explicitly: a capital/mixed invoice with nonzero settlement rows in more than one distinct `(account_id, dimension ?? null)` key stays unresolved. This repair does not implement per-dimension economic-purpose and shared-capacity accounting for one such invoice. Add a single-invoice/two-settlement-dimensions regression that requires review even when its full bank payment and item magnitudes reconcile. Two **separate**, individually single-key invoice sources may still allocate their matched dimensions correctly.
- [x] In the capital branch carry `accountDimensionId: item.accounts_dimensions_id ?? null` alongside existing `accountId` in each allocation. Select source settlement rows and payment rows by the exact same `(account_id, dimension ?? null)` key. Require the sole nonzero source settlement key to equal the distribution key; any other source key holds before computing obligation or spending capacity. Do not let another dimension inflate the obligation or restore capacity.
- [x] In the final `remaining` consumption loop require exact account/dimension and `Math.sign(signed(p)) === -Math.sign(net)`. Continue to use absolute magnitudes only after proving sign. Since settlement slices carry W only, keep the current one-time proportional W ownership; leave unused/wrong-direction components unresolved. Add `accountDimensionId` to internal allocation type only; no public schema/tool change is needed.
- [x] Apply the same compound key to prior noncash/prior cash capacity checks in this branch: an unrelated journal in another dimension cannot consume or certify this slice. For a prior transaction edge naming the **same invoice**, require its item account/dimension, signed registered settlement posting and actual cash direction to agree with the single source key before using its amount as consumption or restoration; conflicting/unproved evidence holds rather than being silently ignored. Retain the existing invoice-level finite capacity because supported source invoices now have only one nonzero settlement key. Do not relax existing date, prior-detail, duplicate-item, prior-unlinked-settlement or signed reversal guards.
- [x] Require transaction-header amount/base sign consistency in this branch, using the existing operating-purpose validation rule. Require explicit negative ordinary reversal items while preserving the operating branch's positive-magnitude credit-note convention. These are bounded signed-evidence consistency checks at the same allocation boundary, not a new invoice matching policy.
- [x] Run `npm test -- src/reporting/annual-cash-flow.test.ts src/reporting/cash-flow-evidence.test.ts src/tools/annual-report.test.ts` RED then GREEN. Annual integration must reject the mismatch even if balance/cash reconciliation is zero, and accept the exactly matched control.

## Task 5: Exclude INITIAL and make pending dividend reservations conservative

**Files:** `src/tools/estonian-tax.ts`, `src/tools/estonian-tax.test.ts`.

- [x] Add tests under the existing remediation describe block using its `setup`, `base`, `dividendDraft`, `parseResult` and mocked create helpers. Test both `dry_run:true` and `dry_run:false` explicitly: the mock server otherwise defaults to execute. Registered synthetic ledger D cash1000/C share capital1000 has maximum net dividend0. Add an unregistered INITIAL D cash6000/C share capital1000+C retained4000+C dividend payable1000. A requested net dividend100 must still block and create must remain uncalled. INITIAL cannot appear among pending dividend drafts. Verify the draft-opening warning remains accurate.
- [x] Add a normal DIV draft, a manual payable-credit draft and a genuine registered INITIAL as positive controls: ordinary reservations and registered opening equity must still count exactly once. Deleted/registered drafts, date behavior, duplicate detection and concurrency tests retain their existing semantics.
- [x] Add three non-INITIAL anomalous DIV drafts, testing both preview/execute and force false/true. All examples are balanced synthetic entries:

| Draft postings | Raw retained reduction | Raw net-assets reduction | Reserved components |
| --- | ---: | ---: | --- |
| D expense250 / C retained200 + C payable50 | -200 | +50 | 0 and50 |
| D retained50 + D payable100 / C expense150 | +50 | -100 | 50 and0 |
| D payable200 / C retained100 + C expense100 | -100 | -200 | 0 and0 |

Also combine an ordinary positive draft and an anomalous negative draft so a negative component cannot cancel another journal's reservation. With generous registered headroom, each anomalous case still returns a review error with create uncalled even `force:true`. Assert each computed headroom never exceeds the same ledger without anomalous drafts.
- [x] Candidate filter becomes `j.operation_type !== "INITIAL"` plus all existing exclusions. Compute raw retained and net-assets reduction for each non-INITIAL candidate and reserve each independently:

```typescript
const rawRetainedReduction = roundMoney(-sumCreditMinusDebit([j], id => lg1Accounts.has(id), () => true));
const rawNetAssetsReduction = roundMoney(-sumCreditMinusDebit([j], id => equityOrPlAccountIds.has(id), () => true));
const reservation = {
  journal_id: j.id!, document_number: j.document_number ?? null, effective_date: j.effective_date,
  retained_earnings_reduction: Math.max(0, rawRetainedReduction),
  net_assets_reduction: Math.max(0, rawNetAssetsReduction),
};
```

Retain raw signed reductions separately in an additive anomaly list for any raw negative component. Clamp *per candidate and per component before summing*, never just the final total. Do not drop an anomaly because both clamped numbers became zero.

- [x] Extend the existing legality response with `pending_dividend_draft_anomalies` including journal ID and both raw reductions, plus a clear warning. Add a hard gate inside `checkAndBook` before preview/create: pending anomaly OR ledger imbalance OR existing unforced statutory violation blocks. `force` keeps its existing ability to bypass only the two known statutory shortfalls; it cannot bypass uncertain draft reservations or ledger imbalance. Use a specific `error_code: "pending_dividend_draft_requires_review"` for this new anomaly case and a hint to correct/review the named existing draft and rerun. Do not add a new approval or confirmation workflow.
- [x] Test force with only the excluded draft INITIAL: it has the same capacity/check results as without that INITIAL; existing explicit force on an ordinary known statutory breach remains available in the mocked environment. The hard anomaly hold must not silently disable force for ordinary valid ledgers.
- [x] Add a fresh-read execute regression: first preview a sufficient ledger, then return an anomalous draft from `listAllWithPostings` on the later execute; require the lock/cache-refresh calculation to block with zero create calls. Preserve the current duplicate same-key retry path, company lock, BookingGuard and `confirm:false` behavior. This task does not add a dividend-specific guard to generic later confirmation.
- [x] Run `npm test -- src/tools/estonian-tax.test.ts src/opening-balance-journal.test.ts src/opening-balance-limitations.test.ts` RED then GREEN, retaining logs. Verify source-reached assertions, not just an upstream mock error. Existing tax-rate/legal policy is unchanged; no new legal interpretation is being implemented.

## Task 6: Sanitize public documentation without losing evidence

- [x] Only after Task1 byte/hash verification, replace private names, real IDs, descriptions, company/year totals and identifiable financial examples in `2026-10-19-cash-flow-correction.md` with synthetic examples or general acceptance statements. Preserve the technical method, history that a prior implementation/review occurred, known remaining source-evidence limits and links to private evidence directories. Remove claims that exact private financial comparisons belong in a public plan. Do not copy those values into a new appendix, public changelog or this plan.
- [x] Review `2026-10-19-rik-api-opening-balances.md` and all changed public documentation for the same issue; sanitize any actual identifiable evidence only after preserving its exact original privately. Keep the API-only opening design intact.
- [x] Update canonical `CLAUDE.md` to describe proved direction/family-bound principal/result bundles, preserved securities-acquisition expense fees, known gross despite partial valuation, capital account/dimension consistency, and exclusion/anomaly handling for pending dividends. Update only current/Unreleased changelog text with user-facing consequences first. No version bump or publish metadata change.
- [x] Independent privacy review scans the full changed documentation text, public fixtures and diff, not only company-name strings. Match exact identifier/value combinations from the private original against public files using a private scanner; inspect remaining matches manually so public account numbers/synthetic amounts are not mistaken for evidence. Require zero identifiable company evidence in the intended public change set and byte-identical original private copies. Historical already-public content is not silently rewritten.

## Task 7: Independent review, six saved-data replays and final checks

- [x] Before execution, coordinator obtains the independent **xhigh** review of this exact plan. Reviewer checks sign/family matrix, acquisition fee preservation, wrong-direction fallback closure, raw-negative reservations and force/create paths, dimensions/sign/capacity and privacy preservation. Resolve material findings in the plan before any source/test implementation. Keep the xhigh report private and do not self-approve in the writer context.
- [x] After focused GREEN, a separate reviewer inspects the actual full scoped diff against the frozen dirty baseline, not only the new lines. Reviewer runs independent synthetic probes through pure calculator and annual-report/dividend callbacks. Require no unresolved HIGH/MAJOR findings; report verified-OK items and limits explicitly. If a defect appears, add a failing regression before correcting it and repeat only relevant checks plus affected full gates.
- [x] Build the final source, record its source/dist hashes, then replay all six frozen saved company/year datasets through the actual compiled `buildAnnualReportData`. Do not overwrite prior `cashflow-refinement/after` evidence: copy/adapt the private harness to write under `review-repair/after`; keep source/input paths explicit and unchanged and keep network/mutation methods blocked. Preserve the original oracle/validator files byte for byte; any runner path adaptations get their own private diff.
- [x] Independent Decimal verification must prove: raw cash opening/closing and known flow identities; P/D/W and one-time bridge slices; all135 target classifications unchanged; all17 Lightyear unresolved IDs/reasons/gross/components unchanged; all previously classified unaffected journal category-level receipts/payments/net unchanged, including acquisition-plus-fee bundles with multiple8335 rows; all pre-existing declaration/offset/capex/sale critical oracles unchanged; unrelated annual statements/notes unchanged after normalizing only random sandbox nonces. No oracle update merely to make this repair pass. New malformed/dimensional synthetic cases must hold even with zero residual.
- [x] Required checks from repository root, with private per-command logs and recorded exit codes:

```bash
npm test -- src/reporting/annual-cash-flow.test.ts src/reporting/cash-flow-evidence.test.ts src/tools/annual-report.test.ts src/tools/estonian-tax.test.ts
npm test
npm run build
npm run test:integration
npm run validate:release
git diff --check
git status --short --branch
```

Before integration, inspect the selected `src/__integration__` tests/environment to confirm they remain mock/read-only and do not construct a live mutation flow. Preserve the no-accounting-writes boundary. Release validation is a metadata/surface compatibility check here, not authorization to release. If sandbox subprocess/IPC restrictions stop an unchanged check, request the appropriate execution permission through the tool and retry that exact check; do not alter code/tests to evade restrictions. Report configured skips and any command not run distinctly from a pass.

- [x] Re-run the private original synthetic audit probes as independent post-repair checks where their harness expects current truth; keep their old failing outputs immutable and write new outputs separately. Their assertions may need a new expectation wrapper for corrected status, never a weakened financial oracle. A fresh live verification is optional only within existing read-only authorization; saved-data replay must never be reported as live verification.
- [x] Finish with zero pending implementation/review tasks, all relevant checks complete, hashes and independent review evidence recorded, exact private evidence preserved, intended public docs sanitized, and no unexpected changed files. Report the six repaired findings, remaining intentional17 holds and validation limits. Leave the user's existing dirty work uncommitted and unpublished.
