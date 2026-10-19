# Annual cash-flow correction implementation plan

> Historical implementation and review follow-up. Exact accounting evidence is retained outside the repository. The active repair steps are in [the review-findings repair plan](2026-10-19-review-findings-repair.md).

**Goal:** Produce an auditable indirect cash-flow statement, remove noncash effects and classify actual receipts and payments from their proved purpose.

**Architecture:** Use a pure calculator over registered API journal postings, plus bounded exact transaction-to-invoice evidence. Keep a journal-level indirect operating bridge and an independently classified direct operating total. Never use a cash reconciliation difference as an adjustment.

**Scope:** Existing TypeScript reporting modules, Vitest and read-only API clients. Opening balances come only from API INITIAL journals; no local opening-register import. This document contains public account numbers and synthetic examples, not company ledger evidence.

## Calculation contract

For each journal, derive profit (P), depreciation addback (D) and working-capital (W) components using the shared chart and signed EUR base amounts. The raw bridge contribution is B(j) = P(j) + D(j) + W(j).

- A noncash journal has its exact bridge contribution reversed once.
- A proved investing or financing group has its owned nonoperating bridge components removed once.
- An unresolved group retains known signed cash, gross receipts/payments, provenance and an explicit exclusion from the verified partial operating subtotal. It does not become operating merely because totals reconcile.
- Each component is identified by journal, posting and component kind. Exact slices may divide a component but cannot duplicate or exceed it.
- INITIAL is an opening position, never an external cash flow. Draft/deleted journals and deleted postings do not enter ordinary registered balances.

Opening/closing cash, the independent direct operating total, the adjusted indirect bridge and the cash identity must agree before the cash statement can be complete. Missing or inconsistent evidence keeps review status. A zero residual alone does not establish the economic category.

## Evidence and category boundaries

Selective evidence reads use exact registered transaction IDs. They are read-only, memoized, bounded to 500 details per report and at most five concurrent requests. Read failures and exhausted budgets are disclosed.

Invoice attribution requires an exact transaction item reference to one active registered invoice journal and agreement with actual transaction/posting material. Account, dimension, signed direction, valuation and total coverage are checked. IDs are not guessed from dates, descriptions, clients or similar amounts.

A homogeneous operating invoice proves payment purpose without certifying its historical open balance. Prepayment dates and unrelated customer clearing cannot veto that proved purpose. Exact invoice plus direct operating-account slices can share one payment when all slices are covered once. Realized FX within that operating payment follows the actual payment.

Capital and mixed sources retain signed finite-capacity safeguards. Source/item/payment account and dimension must match. Partial mixed payments and shared VAT without exact attribution remain unresolved. Unsupported multidimensional allocation within one invoice cannot manufacture capacity.

Actual investing/financing receipts and payments are shown separately. Dividend payable and loan-principal roles are distinct from operating tax, interest and ordinary receivables. Explicit account rules retain their documented precedence; unsupported or conflicting bundles require review.

## Principal and result bundles

Recognized result accounts cannot establish investing purpose by themselves. A supported bundle needs a genuine nonzero principal, compatible asset/result family, correct signed direction, fully valued balanced postings and complete coverage.

- Securities acquisitions may include proved expense fee rows, including multiple fee rows. An income credit financing an increasing asset is not proved sale proceeds.
- Securities/fixed-asset disposals use actual cash, not carrying amount. Conventional fixed-asset disposals may reverse chart-proved accumulated depreciation against a genuine decreasing gross asset; fully depreciated assets remain supported.
- Realized FX in a proved investment bundle is removed from the operating bridge once, without adding a duplicate cash-FX effect.
- Unsupported financing-principal/FX combinations remain reviewable rather than being falsely split into financing and operating cash. Ordinary interest and fees do not automatically become financing.
- Rejected principal/result combinations cannot fall through to a generic classifier and reappear as complete.

Synthetic examples: a sale with cash130, investment carrying amount100 and related FX result30 uses the actual130 cash as its investing amount. Cash80 plus an *increasing* investment20 against income100 does not establish a sale. These examples are invented and do not describe a company ledger.

Cash-only internal transfers are eliminated. A transfer plus an external portion needs exact distribution proof; only the external amount is a cash flow. Zero-net unknown groups retain gross exposure.

Pure cash revaluation requires evidence that foreign units did not change; account names alone are insufficient. If a noncash counterpart is malformed but some cash is validly valued, retain the known cash and disclose unvalued cash separately. Never substitute foreign raw units for EUR.

## Public output and verification

Retain the indirect method and existing numeric fields. Expose source-backed adjustments, actual gross I/F cash, separately proved cash FX, unresolved gross/count/net, evidence coverage and complete/requires_review status. Public provenance lists are capped with full counts and truncation flags; independent private evidence may remain uncapped.

Verification uses:

- Failing regression tests before implementation, then focused calculation/evidence/annual-core checks.
- Synthetic sign, result-family, FX, fee, depreciation, dimensional, malformed-value and override counterexamples.
- Saved-data replay through the actual built annual-report core and an independent Decimal validator.
- Preservation of every already-correct journal/category group, earlier corrected allocations, intentional unresolved source questions and all unrelated annual statement data.
- Full unit tests, build, integration tests, metadata/surface validation, diff checks and separate independent review.

Private snapshots, exact journal/invoice/transaction IDs, company financial totals, raw responses, numeric oracles and review logs are retained under the sibling verification directory. No real accounting inputs or ledger examples belong in this public plan or test fixtures.

The original detailed plan was preserved byte-for-byte outside the repository before this privacy cleanup. Its exact backup and checksum, the earlier review history and current validation records are in the private review-repair evidence directory. No original accounting evidence was deleted.

## Accounting basis and follow-up

The pinned accounting basis is [RTJ 2, paragraphs34 and37–44](https://www.fin.ee/sites/default/files/documents/2020-10/RTJ%202%20N%C3%95UDED%20INFORMATSIOONI%20ESITUSVIISILE%20RAAMATUPIDAMISE%20AASTAARUANDES.pdf): purpose-based classification, indirect corrections, gross investing/financing and separate cash FX.

The initial implementation and false-hold refinement passed their recorded scoped checks. A subsequent independent review found additional counterexamples; earlier approval and passing fixtures do not certify those untested cases. The active repair plan specifies their corrections and final gates. Known source-evidence questions remain explicit. None of this work authorizes accounting writes, a commit, push or publication.
