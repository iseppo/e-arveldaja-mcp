# Opening-Balance (Algbilanss) Capture & Folding — Design

**Date:** 2026-07-19
**Status:** Approved (design), pending implementation plan
**Branch:** `feature/opening-balance-algbilanss`

## Problem

The e-arveldaja / RIK e-Financials API does **not** expose the separate
"Algbilansi kanded" (opening-balance entries) section. As a result every
cumulative computation the MCP performs — account balances, trial balance,
balance sheet, P&L, annual report, and the dividend §157 legality checks —
can silently miss the opening balances a company entered at onboarding.

Today the server only *warns* about this. Six sites append
`OPENING_BALANCE_API_LIMITATION_WARNING`
(`src/opening-balance-limitations.ts`):

- `src/tools/account-balance.ts`
- `src/tools/financial-statements.ts` (trial balance, balance sheet, P&L)
- `src/tools/annual-report.ts`
- `src/tools/estonian-tax.ts` (dividend §157 checks)
- `src/tools/crud/journals.ts` (journal list/get)

The warning tells the operator to go verify balances in the UI — it does not
make the numbers correct.

## Goal

Let the operator paste their algbilanss **once**, store it per-company in a
predetermined place, and **fold** the opening balances into the six
computations so the numbers become correct — not merely annotated.

## Non-goals (v1 scope boundaries)

- **Dimension/sub-account splitting** (`Tulemusüksus` column): fold at
  account-code level only. Per-dimension opening balances are out of scope.
- **Historical versioning / multi-year**: one opening-balance set per company
  (single opening date). Re-import replaces the stored set (behind a confirm).
- **Non-EUR base amounts**: amounts are treated as EUR base (the register
  prints `€`).
- **Trial-balance-table paste format**: v1 targets the "Algbilansi kanded"
  journal-register layout (see Input Format). A paste that doesn't match is
  rejected with a helpful message rather than silently mis-parsed.

## Input Format

The operator copies the "Algbilansi kanded" register out of the e-arveldaja
UI. Representative sample (numbers may be blurred by the operator; whitespace
varies by how they copy):

```
Algbilansi kanded
Nr    Kuupäev    Konto    Deebet    Kreedit    DokNr    Tehingu sisu    Tulemusüksus
10003.  12.12.2024  1020 AS LHV Pank EE637700771011212909  1 000.00 €      Algbilansi seadistamine
        2900 Osakapital või aktsiakapital nimiväärtuses      1 000.00 €
```

Structure:

- Columns: `Nr | Kuupäev | Konto | Deebet | Kreedit | DokNr | Tehingu sisu | Tulemusüksus`.
- A journal spans **paired lines**; the continuation line has blank
  `Nr`/`Kuupäev` but belongs to the journal above. For opening-balance folding
  the journal grouping is irrelevant — only per-account debit/credit sums matter.
- `Konto` = leading integer account **code** + account **name** (the name may
  include an IBAN or Estonian text).
- `Deebet` / `Kreedit` = Estonian amount format `1 000.00 €` (space thousands
  separator, dot decimal, trailing `€`); exactly one of the two is populated
  per line.
- `DokNr`, `Tehingu sisu`, `Tulemusüksus` are ignored by the parser.

**Integrity invariant:** a valid algbilanss balances — total Deebet equals
total Kreedit. This is the parser's primary correctness gate.

## Architecture

The parsed algbilanss is modeled as **synthetic journal postings dated at the
opening date**, injected into the same per-account aggregation each consumer
already performs (the ledger already sums `base_amount` D/C per account). This
gives one merge point and makes date-filtering automatic: any computation
as-of/through a date ≥ the opening date includes the opening postings; a period
entirely before it does not. (Rejected alternative: compute-then-patch each
consumer's final per-account balance — more surgery in every consumer, and
period/P&L math becomes awkward.)

### 1. Parser — `src/opening-balance-parse.ts` (new, pure, no I/O)

- **Input:** raw pasted text.
- Skips the title line (`Algbilansi kanded`), the column-header row, and blank
  lines.
- Per data line: extract account code (leading integer token of the `Konto`
  field), account name (remainder up to the first amount), Deebet, Kreedit.
  Continuation lines (blank leading columns) parse the same way.
- **Amount parser:** `1 000.00 €` → `1000.00` (strip `€` and spaces, dot
  decimal); empty cell → `0`.
- **Whitespace tolerance:** split on tab **or** runs of 2+ spaces, so both
  tab-separated and space-padded copies parse.
- **Output:**
  ```ts
  interface ParsedOpeningBalances {
    openingDate: string;               // ISO from the first Kuupäev (dd.mm.yyyy → yyyy-mm-dd)
    accounts: Array<{ code: string; name: string; debit: number; credit: number }>;
    totals: { debit: number; credit: number };
    rawText: string;                   // verbatim paste, for provenance
  }
  ```
  Accounts are aggregated by `code` (a code appearing on multiple lines is
  summed).
- **Rejections (throw / typed error, no silent partial):**
  - `totals.debit !== totals.credit` beyond €0.01 → "algbilanss does not
    balance" with both totals shown.
  - No parseable data rows / expected columns absent → "does not look like an
    Algbilansi kanded paste" with a short format reminder.

### 2. Store — `opening-balances.json` in the accounting-rules bundle

- Location: inside the per-company OKF bundle directory (the same directory
  `EARVELDAJA_RULES_DIR` / `chooseDefaultBundleStorage()` resolve). Inherits
  per-company scoping, the `withBundleLock()` O_EXCL lock, and the env override
  for free.
- Persisted shape: the `ParsedOpeningBalances` object plus `parsedAt` and a
  `source: "algbilanss_paste"` marker.
- Re-import **replaces** the stored set (behind the tool's confirm step).
- Read/write helpers live in a small module (e.g.
  `src/opening-balance-store.ts`) alongside the parser, reusing the bundle
  path-resolution + lock helpers from `src/accounting-rules.ts`.

### 3. Capture tool — `import_opening_balances`

- Args: `pasted_text: string`, `dry_run: boolean = true` (string-typed per the
  prompt/tool conventions where applicable).
- `dry_run: true` (default): parse, then return a preview — per-account opening
  D/C, the balance check (`debit == credit`), the detected opening date, and a
  count — **without** persisting. If parsing fails, return the typed rejection.
- `dry_run: false`: parse again, persist to the bundle under the lock, return a
  confirmation summary.
- **Untrusted-text sandbox:** the echoed paste / account names are external
  pasted content, so wrap them via the established `wrapUntrustedOcr` /
  MCP-output sandbox policy. Parsed numeric fields and account codes used for
  matching stay unwrapped (clean-vs-display boundary, consistent with existing
  policy).
- Tool exposure: registered by default. (Consider grouping under an existing
  opt-out flag during planning; not required for v1.)

### 4. Consumption — shared helper `loadOpeningBalancePostings(connection)`

- Returns the stored opening postings for the active connection, or `null` if
  none captured.
- Merged into the per-account aggregation of: `account-balance`,
  `financial-statements` (trial balance / balance sheet / P&L),
  `annual-report`, and `estonian-tax` (§157 equity checks — highest-stakes;
  opening equity now feeds the retained-earnings ceiling and net-assets floor
  correctly).
- **Warning becomes conditional at all six sites** (incl. `crud/journals.ts`):
  - algbilanss **stored** → drop the blind
    `OPENING_BALANCE_API_LIMITATION_WARNING` (optionally replace with a short
    "opening balances applied from stored algbilanss (as of <date>)" note).
  - algbilanss **not stored** → keep the warning but make it **actionable**:
    "paste your algbilanss via `import_opening_balances` to fix this."

## Data Flow

```
operator copies "Algbilansi kanded"  ──► import_opening_balances (dry_run=true)
                                              │  parse + integrity check
                                              ▼
                                        preview (per-account D/C, balanced?, date)
                                              │  operator confirms
                                              ▼
                                    import_opening_balances (dry_run=false)
                                              │  withBundleLock → write
                                              ▼
                                   opening-balances.json (in OKF bundle)
                                              │
             ┌────────────────────────────────┴───────────────────────────────┐
             ▼                                                                  ▼
   loadOpeningBalancePostings(connection)  ──► synthetic postings @ openingDate
             │
             ▼  merged into existing per-account aggregation
   account-balance · financial-statements · annual-report · estonian-tax · journals
```

## Error Handling

- Parse failures surface as typed rejections in the tool result (never a
  silent partial parse); the preview path shows them without persisting.
- Unbalanced algbilanss is a hard reject at both dry-run and persist.
- Store read of a missing/corrupt file returns `null` (treated as "not
  captured") — consumers fall back to the actionable warning; a corrupt file is
  reported, not silently ignored.
- Bundle lock contention is handled by the existing `withBundleLock()` path.

## Testing

- **Parser unit tests** (`src/opening-balance-parse.test.ts`): the sample
  paste; tab-separated vs space-padded variants; continuation lines; multi-line
  same-account aggregation; `1 000.00 €` and empty-cell amounts; unbalanced
  paste rejection; non-matching paste rejection; date normalization.
- **Store unit tests**: round-trip write/read in a temp bundle dir; re-import
  replace; missing-file → `null`; corrupt-file report.
- **Tool tests** (`import_opening_balances`): dry-run preview does not write;
  confirm writes; untrusted-text wrapping present on echoed content; rejection
  passthrough.
- **Consumer tests**: for each of the six sites — with a stored algbilanss the
  opening D/C is folded into the computed figure and the blind warning is
  dropped; without one the actionable warning appears. Include one §157 case
  where opening equity changes the dividend legality outcome.

## Consumers touched (summary)

| File | Change |
|------|--------|
| `src/opening-balance-parse.ts` | new — pure parser |
| `src/opening-balance-store.ts` | new — bundle-backed read/write |
| `src/tools/opening-balance-import.ts` (or nearest existing tools module) | new — `import_opening_balances` tool |
| `src/opening-balance-limitations.ts` | warning made conditional/actionable |
| `src/tools/account-balance.ts` | fold + conditional warning |
| `src/tools/financial-statements.ts` | fold + conditional warning |
| `src/tools/annual-report.ts` | fold + conditional warning |
| `src/tools/estonian-tax.ts` | fold into §157 + conditional warning |
| `src/tools/crud/journals.ts` | conditional/actionable warning |
| docs: `CLAUDE.md`, `ARCHITECTURE.md`, `README.md`, `CHANGELOG.md` | document the tool + folding |
