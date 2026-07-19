# Opening-Balance (Algbilanss) Capture & Folding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator paste their e-arveldaja "Algbilansi kanded" register once, store it per-company, and fold the opening balances into the six computations the RIK API leaves blind — while keeping the whole feature optional (nothing stored ⇒ behaves exactly as today).

**Architecture:** Parse the paste into per-account debit/credit sums; persist as JSON in the accounting-rules bundle (inherits per-company scoping + `withBundleLock`); at compute time, resolve account codes → `accounts_id` via the chart and emit ONE synthetic `Journal` dated at the opening date, prepended to the journal list every consumer already aggregates. Every existing date/registered/deleted filter and per-account keying then works unchanged. The blind API-limitation warning becomes conditional: actionable when nothing is stored, dropped (with a note) when it is.

**Tech Stack:** TypeScript (Node 18 ESM, `.js` import specifiers), Vitest 4, Zod 4, MCP SDK 1.29. Reuses `src/accounting-rules.ts` bundle/lock helpers, `src/mcp-json.ts` sandbox, `src/api/readonly.api.ts` chart.

## Global Constraints

- **Opening balance is OPTIONAL.** With nothing stored, the loader returns `null`, the synthetic journal is not injected, and every computation behaves exactly as today — the only change is the warning becomes actionable. No task may make a stored algbilanss required for any existing tool to work.
- **ESM import specifiers end in `.js`** (e.g. `import { parseOpeningBalances } from "./opening-balance-parse.js"`), even though sources are `.ts`.
- **Amount format is Estonian:** `1 000.00 €` — space thousands separator, dot decimal, trailing `€`; exactly one of Deebet/Kreedit populated per line; empty cell → `0`.
- **Integrity gate:** a valid algbilanss balances — `abs(totalDebit - totalCredit) <= 0.01`. Reject (typed error) otherwise, at BOTH dry-run and persist. Also reject a paste with no parseable data rows.
- **Account code → id:** resolve via `api.readonly.getAccounts()` (`Account.code: number` → `Account.id: number`). A code absent from the chart is collected as `unmappedCodes` and surfaced as a warning — NEVER silently dropped.
- **Synthetic postings must set `type: "D"` or `"C"`** and the synthetic journal must set `registered: true`, `is_deleted: false`, `effective_date: <openingDate>`, `clients_id: null`. Consumers skip postings whose `type` is neither `D` nor `C`.
- **Untrusted-text sandbox:** the echoed paste and parsed account *names* are external pasted content — wrap via `wrapUntrustedOcr` at MCP output. Account **codes** and numeric amounts used for matching/computation stay unwrapped (clean-vs-display boundary).
- **Per-company storage** goes in the accounting-rules bundle dir, written under `withBundleLock`. Never persist to the repo working dir.
- TDD, DRY, YAGNI, frequent commits. Run `npm test` (vitest) for unit tests; `npx tsc --noEmit` for type-check.

## File Structure

| File | Responsibility |
|------|----------------|
| `src/opening-balance-parse.ts` (new) | Pure parser: raw paste → `ParsedOpeningBalances`, with integrity + format rejections. No I/O. |
| `src/opening-balance-store.ts` (new) | Bundle-backed read/write of `opening-balances.json`. |
| `src/accounting-rules.ts` (modify) | Export `resolveOpeningBalanceStorePath(): string \| null` so the store can locate the bundle dir. |
| `src/opening-balance-journal.ts` (new) | `loadOpeningBalanceJournal(api)` → synthetic `Journal` (or `null`) + `unmappedCodes` + `openingDate`, resolving codes → ids. |
| `src/opening-balance-limitations.ts` (modify) | Add conditional/actionable warning helpers (captured vs not-captured). |
| `src/tools/opening-balance-import.ts` (new) | `import_opening_balances` MCP tool (dry-run preview / confirm persist), registered in `src/index.ts`. |
| `src/tools/account-balance.ts` (modify) | Inject synthetic journal; conditional warning. |
| `src/tools/financial-statements.ts` (modify) | Inject synthetic journal; conditional warning. |
| `src/tools/annual-report.ts` (modify) | Inject synthetic journal; conditional warning. |
| `src/tools/estonian-tax.ts` (modify) | Inject into the preloaded `allJournals` used by the §157 checks; conditional warning. |
| `src/tools/crud/journals.ts` (modify) | Conditional/actionable warning only. |
| `CLAUDE.md`, `ARCHITECTURE.md`, `README.md`, `CHANGELOG.md` (modify) | Document the tool, the folding, and bump tool count. |

---

### Task 1: Parser (`src/opening-balance-parse.ts`)

**Files:**
- Create: `src/opening-balance-parse.ts`
- Test: `src/opening-balance-parse.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface OpeningBalanceAccount { code: string; name: string; debit: number; credit: number; }
  export interface ParsedOpeningBalances {
    openingDate: string;                    // "yyyy-mm-dd"
    accounts: OpeningBalanceAccount[];      // aggregated by code
    totals: { debit: number; credit: number };
    rawText: string;
  }
  export class OpeningBalanceParseError extends Error {}
  export function parseOpeningBalances(rawText: string): ParsedOpeningBalances;
  ```

- [ ] **Step 1: Write failing tests**

```ts
// src/opening-balance-parse.test.ts
import { describe, it, expect } from "vitest";
import { parseOpeningBalances, OpeningBalanceParseError } from "./opening-balance-parse.js";

const SAMPLE = [
  "Algbilansi kanded",
  "Nr\tKuupäev\tKonto\tDeebet\tKreedit\tDokNr\tTehingu sisu\tTulemusüksus",
  "10003.\t12.12.2024\t1020 AS LHV Pank EE637700771011212909\t1 000.00 €\t\t\tAlgbilansi seadistamine\t",
  "\t\t2900 Osakapital või aktsiakapital nimiväärtuses\t\t1 000.00 €\t\t\t",
].join("\n");

describe("parseOpeningBalances", () => {
  it("parses paired debit/credit lines into per-account sums", () => {
    const r = parseOpeningBalances(SAMPLE);
    expect(r.openingDate).toBe("2024-12-12");
    expect(r.accounts).toEqual([
      { code: "1020", name: "AS LHV Pank EE637700771011212909", debit: 1000, credit: 0 },
      { code: "2900", name: "Osakapital või aktsiakapital nimiväärtuses", debit: 0, credit: 1000 },
    ]);
    expect(r.totals).toEqual({ debit: 1000, credit: 1000 });
    expect(r.rawText).toBe(SAMPLE);
  });

  it("tolerates space-run separators instead of tabs", () => {
    const spaced = [
      "Algbilansi kanded",
      "Nr    Kuupäev    Konto    Deebet    Kreedit    DokNr    Tehingu sisu    Tulemusüksus",
      "10003.    12.12.2024    1020 AS LHV Pank    1 000.00 €",
      "          2900 Osakapital    1 000.00 €",
    ].join("\n");
    const r = parseOpeningBalances(spaced);
    expect(r.accounts.map(a => a.code)).toEqual(["1020", "2900"]);
    expect(r.accounts[1]).toMatchObject({ debit: 0, credit: 1000 });
  });

  it("aggregates repeated account codes", () => {
    const dup = [
      "Nr\tKuupäev\tKonto\tDeebet\tKreedit",
      "1.\t01.01.2025\t1020 Pank\t500.00 €\t",
      "2.\t01.01.2025\t1020 Pank\t250.00 €\t",
      "\t\t2900 Kapital\t\t750.00 €",
    ].join("\n");
    const r = parseOpeningBalances(dup);
    expect(r.accounts.find(a => a.code === "1020")).toMatchObject({ debit: 750, credit: 0 });
  });

  it("rejects an unbalanced algbilanss", () => {
    const bad = [
      "Nr\tKuupäev\tKonto\tDeebet\tKreedit",
      "1.\t01.01.2025\t1020 Pank\t1 000.00 €\t",
      "\t\t2900 Kapital\t\t900.00 €",
    ].join("\n");
    expect(() => parseOpeningBalances(bad)).toThrow(OpeningBalanceParseError);
    expect(() => parseOpeningBalances(bad)).toThrow(/does not balance/i);
  });

  it("rejects a paste with no data rows", () => {
    expect(() => parseOpeningBalances("just some text\nnothing here")).toThrow(OpeningBalanceParseError);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- src/opening-balance-parse.test.ts`
Expected: FAIL (module not found / `parseOpeningBalances` undefined).

- [ ] **Step 3: Implement the parser**

```ts
// src/opening-balance-parse.ts
export interface OpeningBalanceAccount { code: string; name: string; debit: number; credit: number; }
export interface ParsedOpeningBalances {
  openingDate: string;
  accounts: OpeningBalanceAccount[];
  totals: { debit: number; credit: number };
  rawText: string;
}
export class OpeningBalanceParseError extends Error {
  constructor(message: string) { super(message); this.name = "OpeningBalanceParseError"; }
}

const AMOUNT_RE = /^\d[\d\s]*[.,]?\d*\s*€?$/;
const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})\.?$/;   // dd.mm.yyyy (trailing dot tolerated)
const CODE_RE = /^(\d{3,6})\b\s*(.*)$/;             // leading account code + name remainder

/** "1 000.00 €" → 1000.00 ; "" → 0 */
function parseAmount(cell: string): number {
  const t = cell.trim();
  if (t === "") return 0;
  const cleaned = t.replace(/€/g, "").replace(/\s/g, "").replace(",", ".");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new OpeningBalanceParseError(`Unparseable amount: "${cell}"`);
  return n;
}

/** Split a row on tabs, or on runs of 2+ spaces when no tab is present. */
function splitCells(line: string): string[] {
  if (line.includes("\t")) return line.split("\t").map(c => c.trim());
  return line.split(/ {2,}/).map(c => c.trim());
}

export function parseOpeningBalances(rawText: string): ParsedOpeningBalances {
  const byCode = new Map<string, OpeningBalanceAccount>();
  let openingDate: string | undefined;

  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    const cells = splitCells(line);

    // Locate the Konto cell: the first cell starting with an account code.
    const kontoIdx = cells.findIndex(c => CODE_RE.test(c));
    if (kontoIdx === -1) continue;                     // header / title / noise

    const codeMatch = CODE_RE.exec(cells[kontoIdx]!)!;
    const code = codeMatch[1]!;
    const name = codeMatch[2]!.trim();

    // Amount cells follow the Konto cell; first is Deebet, second is Kreedit.
    const amountCells = cells.slice(kontoIdx + 1).filter(c => c === "" || AMOUNT_RE.test(c));
    // Re-derive positional debit/credit from the two cells immediately after Konto.
    const debit = parseAmount(cells[kontoIdx + 1] ?? "");
    const credit = parseAmount(cells[kontoIdx + 2] ?? "");
    void amountCells;

    // Opening date: first parseable dd.mm.yyyy seen anywhere on a data row.
    if (!openingDate) {
      for (const c of cells) {
        const dm = DATE_RE.exec(c.trim());
        if (dm) { openingDate = `${dm[3]}-${dm[2]}-${dm[1]}`; break; }
      }
    }

    const entry = byCode.get(code) ?? { code, name, debit: 0, credit: 0 };
    entry.debit += debit;
    entry.credit += credit;
    if (!entry.name && name) entry.name = name;
    byCode.set(code, entry);
  }

  const accounts = [...byCode.values()];
  if (accounts.length === 0) {
    throw new OpeningBalanceParseError(
      "No opening-balance rows found. Paste the 'Algbilansi kanded' register (Nr / Kuupäev / Konto / Deebet / Kreedit columns).",
    );
  }

  const totals = accounts.reduce(
    (acc, a) => ({ debit: acc.debit + a.debit, credit: acc.credit + a.credit }),
    { debit: 0, credit: 0 },
  );
  totals.debit = Math.round(totals.debit * 100) / 100;
  totals.credit = Math.round(totals.credit * 100) / 100;

  if (Math.abs(totals.debit - totals.credit) > 0.01) {
    throw new OpeningBalanceParseError(
      `Algbilanss does not balance: Deebet ${totals.debit.toFixed(2)} € vs Kreedit ${totals.credit.toFixed(2)} €. ` +
      "Check the paste — a valid opening balance has equal debit and credit totals.",
    );
  }

  return { openingDate: openingDate ?? "", accounts, totals, rawText };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test -- src/opening-balance-parse.test.ts` → Expected: PASS.
Run: `npx tsc --noEmit` → Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/opening-balance-parse.ts src/opening-balance-parse.test.ts
git commit -m "feat(opening-balance): pure algbilanss paste parser with integrity gate"
```

---

### Task 2: Store (`src/opening-balance-store.ts`)

**Files:**
- Create: `src/opening-balance-store.ts`
- Modify: `src/accounting-rules.ts` (add `resolveOpeningBalanceStorePath`)
- Test: `src/opening-balance-store.test.ts`

**Interfaces:**
- Consumes: `ParsedOpeningBalances` (Task 1).
- Produces:
  ```ts
  export interface StoredOpeningBalances extends ParsedOpeningBalances { parsedAt: string; source: "algbilanss_paste"; }
  export function readOpeningBalances(): StoredOpeningBalances | null;   // null = not captured OR file absent
  export function writeOpeningBalances(parsed: ParsedOpeningBalances, now: string): StoredOpeningBalances;
  export function resetOpeningBalanceCache(): void;   // test hook
  ```
- From `accounting-rules.ts`: `export function resolveOpeningBalanceStorePath(): string | null;` — absolute path to `opening-balances.json` in the active bundle dir, or `null` in single-file (`EARVELDAJA_RULES_FILE`) mode.

- [ ] **Step 1: Export the store path from `accounting-rules.ts`**

Add near `getAccountingRulesPath` (around `src/accounting-rules.ts:818`), reusing the existing private `resolveStorage()`:

```ts
// src/accounting-rules.ts
export function resolveOpeningBalanceStorePath(): string | null {
  const storage = resolveStorage();
  if (storage.mode === "file") return null;           // single-file legacy mode has no bundle dir
  return resolve(storage.dir, "opening-balances.json");
}
```
(`resolve` is already imported in this file.)

- [ ] **Step 2: Write failing tests**

```ts
// src/opening-balance-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readOpeningBalances, writeOpeningBalances, resetOpeningBalanceCache } from "./opening-balance-store.js";
import type { ParsedOpeningBalances } from "./opening-balance-parse.js";

const PARSED: ParsedOpeningBalances = {
  openingDate: "2024-12-12",
  accounts: [{ code: "1020", name: "Pank", debit: 1000, credit: 0 },
             { code: "2900", name: "Kapital", debit: 0, credit: 1000 }],
  totals: { debit: 1000, credit: 1000 },
  rawText: "…",
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ob-store-"));
  process.env.EARVELDAJA_RULES_DIR = dir;
  resetOpeningBalanceCache();
});
afterEach(() => { delete process.env.EARVELDAJA_RULES_DIR; rmSync(dir, { recursive: true, force: true }); });

describe("opening-balance store", () => {
  it("returns null when nothing is captured", () => {
    expect(readOpeningBalances()).toBeNull();
  });
  it("round-trips a write", () => {
    const stored = writeOpeningBalances(PARSED, "2026-07-19T00:00:00.000Z");
    expect(stored.source).toBe("algbilanss_paste");
    resetOpeningBalanceCache();
    expect(readOpeningBalances()).toMatchObject({ openingDate: "2024-12-12", source: "algbilanss_paste" });
  });
  it("replaces on re-import", () => {
    writeOpeningBalances(PARSED, "2026-07-19T00:00:00.000Z");
    writeOpeningBalances({ ...PARSED, openingDate: "2025-01-01" }, "2026-07-19T01:00:00.000Z");
    resetOpeningBalanceCache();
    expect(readOpeningBalances()?.openingDate).toBe("2025-01-01");
  });
  it("reports a corrupt file rather than throwing raw", () => {
    writeFileSync(join(dir, "opening-balances.json"), "{ not json", "utf8");
    resetOpeningBalanceCache();
    expect(() => readOpeningBalances()).toThrow(/opening-balances\.json/i);
  });
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `npm test -- src/opening-balance-store.test.ts` → Expected: FAIL.

- [ ] **Step 4: Implement the store**

```ts
// src/opening-balance-store.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { resolveOpeningBalanceStorePath, withBundleLock } from "./accounting-rules.js";
import type { ParsedOpeningBalances } from "./opening-balance-parse.js";

export interface StoredOpeningBalances extends ParsedOpeningBalances {
  parsedAt: string;
  source: "algbilanss_paste";
}

let cache: { path: string; value: StoredOpeningBalances | null } | undefined;

export function resetOpeningBalanceCache(): void { cache = undefined; }

export function readOpeningBalances(): StoredOpeningBalances | null {
  const path = resolveOpeningBalanceStorePath();
  if (!path) return null;                       // single-file mode: feature unavailable, treat as not captured
  if (cache && cache.path === path) return cache.value;
  if (!existsSync(path)) { cache = { path, value: null }; return null; }
  let value: StoredOpeningBalances | null;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as StoredOpeningBalances;
  } catch (error) {
    throw new Error(`Could not read opening-balances.json (${path}): ${(error as Error).message}`);
  }
  cache = { path, value };
  return value;
}

export function writeOpeningBalances(parsed: ParsedOpeningBalances, now: string): StoredOpeningBalances {
  const path = resolveOpeningBalanceStorePath();
  if (!path) {
    throw new Error(
      "Opening balances require bundle storage; single-file EARVELDAJA_RULES_FILE mode is not supported. " +
      "Use EARVELDAJA_RULES_DIR (the default) instead.",
    );
  }
  const stored: StoredOpeningBalances = { ...parsed, parsedAt: now, source: "algbilanss_paste" };
  const dir = dirname(path);
  withBundleLock(dir, () => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(stored, null, 2), "utf8");
  });
  cache = { path, value: stored };
  return stored;
}
```

- [ ] **Step 5: Run tests + type-check, verify pass**

Run: `npm test -- src/opening-balance-store.test.ts` → PASS.
Run: `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/opening-balance-store.ts src/opening-balance-store.test.ts src/accounting-rules.ts
git commit -m "feat(opening-balance): bundle-backed opening-balances.json store"
```

---

### Task 3: Synthetic-journal loader (`src/opening-balance-journal.ts`)

**Files:**
- Create: `src/opening-balance-journal.ts`
- Test: `src/opening-balance-journal.test.ts`

**Interfaces:**
- Consumes: `readOpeningBalances()` (Task 2); `api.readonly.getAccounts(): Promise<Account[]>` where `Account` has `id: number`, `code: number`; the `Journal`/`Posting` types from `src/types/api.ts`.
- Produces:
  ```ts
  export interface OpeningBalanceJournal {
    journal: Journal;             // one synthetic journal, effective_date = openingDate
    openingDate: string;
    unmappedCodes: string[];      // codes present in the algbilanss but absent from the chart
  }
  // Returns null when no algbilanss is stored (feature inert).
  export function buildOpeningBalanceJournal(accounts: Account[], stored: StoredOpeningBalances | null): OpeningBalanceJournal | null;
  export async function loadOpeningBalanceJournal(api: ApiContext): Promise<OpeningBalanceJournal | null>;
  ```
  Split so the pure `buildOpeningBalanceJournal` is unit-testable without an API mock.

- [ ] **Step 1: Write failing tests**

```ts
// src/opening-balance-journal.test.ts
import { describe, it, expect } from "vitest";
import { buildOpeningBalanceJournal } from "./opening-balance-journal.js";
import type { Account } from "./types/api.js";
import type { StoredOpeningBalances } from "./opening-balance-store.js";

const ACCOUNTS = [
  { id: 1020, code: 1020, name_est: "Pank", balance_type: "D" },
  { id: 2900, code: 2900, name_est: "Kapital", balance_type: "C" },
] as unknown as Account[];

const STORED: StoredOpeningBalances = {
  openingDate: "2024-12-12",
  accounts: [{ code: "1020", name: "Pank", debit: 1000, credit: 0 },
             { code: "2900", name: "Kapital", debit: 0, credit: 1000 }],
  totals: { debit: 1000, credit: 1000 },
  rawText: "…", parsedAt: "2026-07-19T00:00:00Z", source: "algbilanss_paste",
};

describe("buildOpeningBalanceJournal", () => {
  it("returns null when nothing is stored", () => {
    expect(buildOpeningBalanceJournal(ACCOUNTS, null)).toBeNull();
  });
  it("emits a registered synthetic journal with D/C postings at the opening date", () => {
    const r = buildOpeningBalanceJournal(ACCOUNTS, STORED)!;
    expect(r.journal.effective_date).toBe("2024-12-12");
    expect(r.journal.registered).toBe(true);
    expect(r.journal.is_deleted).toBe(false);
    expect(r.journal.postings).toEqual([
      expect.objectContaining({ accounts_id: 1020, type: "D", amount: 1000, base_amount: 1000 }),
      expect.objectContaining({ accounts_id: 2900, type: "C", amount: 1000, base_amount: 1000 }),
    ]);
    expect(r.unmappedCodes).toEqual([]);
  });
  it("collects codes missing from the chart instead of dropping them silently", () => {
    const stored = { ...STORED, accounts: [...STORED.accounts, { code: "9999", name: "Ghost", debit: 0, credit: 5 }] };
    const r = buildOpeningBalanceJournal(ACCOUNTS, stored)!;
    expect(r.unmappedCodes).toEqual(["9999"]);
    expect(r.journal.postings.some(p => p.accounts_id === 9999)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- src/opening-balance-journal.test.ts` → Expected: FAIL.

- [ ] **Step 3: Implement the loader**

```ts
// src/opening-balance-journal.ts
import type { ApiContext } from "./tools/crud-tools.js";
import type { Account, Journal, Posting } from "./types/api.js";
import { readOpeningBalances, type StoredOpeningBalances } from "./opening-balance-store.js";

export interface OpeningBalanceJournal {
  journal: Journal;
  openingDate: string;
  unmappedCodes: string[];
}

export function buildOpeningBalanceJournal(
  accounts: Account[],
  stored: StoredOpeningBalances | null,
): OpeningBalanceJournal | null {
  if (!stored || stored.accounts.length === 0) return null;

  const idByCode = new Map<string, number>();
  for (const a of accounts) idByCode.set(String(a.code), a.id);

  const postings: Posting[] = [];
  const unmappedCodes: string[] = [];
  for (const acc of stored.accounts) {
    const accountsId = idByCode.get(acc.code);
    if (accountsId === undefined) { unmappedCodes.push(acc.code); continue; }
    if (acc.debit !== 0) {
      postings.push({ accounts_id: accountsId, type: "D", amount: acc.debit, base_amount: acc.debit, is_deleted: false });
    }
    if (acc.credit !== 0) {
      postings.push({ accounts_id: accountsId, type: "C", amount: acc.credit, base_amount: acc.credit, is_deleted: false });
    }
  }

  const journal: Journal = {
    id: -1,                              // sentinel: synthetic, never a real ledger id
    clients_id: null,
    title: "Algbilansi kanded (imported)",
    effective_date: stored.openingDate,
    registered: true,
    is_deleted: false,
    postings,
  };

  return { journal, openingDate: stored.openingDate, unmappedCodes };
}

export async function loadOpeningBalanceJournal(api: ApiContext): Promise<OpeningBalanceJournal | null> {
  const stored = readOpeningBalances();
  if (!stored) return null;
  const accounts = await api.readonly.getAccounts();
  return buildOpeningBalanceJournal(accounts, stored);
}
```

- [ ] **Step 4: Run tests + type-check**

Run: `npm test -- src/opening-balance-journal.test.ts` → PASS.
Run: `npx tsc --noEmit` → clean. (If `Account` lacks `code`/`id` in scope, confirm the import path `./types/api.js`.)

- [ ] **Step 5: Commit**

```bash
git add src/opening-balance-journal.ts src/opening-balance-journal.test.ts
git commit -m "feat(opening-balance): synthetic-journal loader with code→id resolution"
```

---

### Task 4: Conditional / actionable warning helpers (`src/opening-balance-limitations.ts`)

**Files:**
- Modify: `src/opening-balance-limitations.ts`
- Test: `src/opening-balance-limitations.test.ts` (create)

**Interfaces:**
- Produces (keep the existing `OPENING_BALANCE_API_LIMITATION_WARNING` and `withOpeningBalanceApiLimitation` exports untouched for back-compat; add):
  ```ts
  export const OPENING_BALANCE_ACTIONABLE_WARNING: string;   // "…paste via import_opening_balances…"
  // captured=false → actionable warning appended; captured=true → the blind + actionable warnings are NOT added,
  // an applied-note is appended instead.
  export function withOpeningBalanceStatus(warnings: string[], opts: { captured: boolean; openingDate?: string; unmappedCodes?: string[] }): string[];
  ```

- [ ] **Step 1: Write failing tests**

```ts
// src/opening-balance-limitations.test.ts
import { describe, it, expect } from "vitest";
import { withOpeningBalanceStatus, OPENING_BALANCE_API_LIMITATION_WARNING } from "./opening-balance-limitations.js";

describe("withOpeningBalanceStatus", () => {
  it("appends an actionable warning when not captured", () => {
    const w = withOpeningBalanceStatus([], { captured: false });
    expect(w.some(x => /import_opening_balances/.test(x))).toBe(true);
    expect(w).not.toContain(OPENING_BALANCE_API_LIMITATION_WARNING); // superseded by the actionable form
  });
  it("appends an applied note and no limitation warning when captured", () => {
    const w = withOpeningBalanceStatus([], { captured: true, openingDate: "2024-12-12" });
    expect(w.some(x => /applied.*2024-12-12/i.test(x))).toBe(true);
    expect(w.some(x => /import_opening_balances/.test(x))).toBe(false);
  });
  it("flags unmapped codes when captured", () => {
    const w = withOpeningBalanceStatus([], { captured: true, openingDate: "2024-12-12", unmappedCodes: ["9999"] });
    expect(w.some(x => /9999/.test(x) && /not in the chart/i.test(x))).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npm test -- src/opening-balance-limitations.test.ts` → FAIL.

- [ ] **Step 3: Implement** (append to `src/opening-balance-limitations.ts`, keep existing exports):

```ts
export const OPENING_BALANCE_ACTIONABLE_WARNING =
  "Opening balances are not captured. The e-arveldaja API omits 'Algbilansi kanded' (opening-balance entries), so balances, trial balances, P&L, and the dividend §157 checks may be incomplete. Paste the register via the import_opening_balances tool to fold them in.";

export function withOpeningBalanceStatus(
  warnings: string[],
  opts: { captured: boolean; openingDate?: string; unmappedCodes?: string[] },
): string[] {
  const out = [...warnings];
  if (!opts.captured) {
    if (!out.includes(OPENING_BALANCE_ACTIONABLE_WARNING)) out.push(OPENING_BALANCE_ACTIONABLE_WARNING);
    return out;
  }
  const date = opts.openingDate ? ` (as of ${opts.openingDate})` : "";
  out.push(`Opening balances applied from the stored algbilanss${date}.`);
  if (opts.unmappedCodes && opts.unmappedCodes.length > 0) {
    out.push(`Opening-balance accounts not in the chart were skipped: ${opts.unmappedCodes.join(", ")}. Re-check these account codes.`);
  }
  return out;
}
```

- [ ] **Step 4: Run + type-check** → PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/opening-balance-limitations.ts src/opening-balance-limitations.test.ts
git commit -m "feat(opening-balance): conditional actionable/applied warning helpers"
```

---

### Task 5: Capture tool `import_opening_balances`

**Files:**
- Create: `src/tools/opening-balance-import.ts`
- Modify: `src/index.ts` (register the tool)
- Test: `src/tools/opening-balance-import.test.ts`

**Interfaces:**
- Consumes: `parseOpeningBalances` (Task 1), `writeOpeningBalances` (Task 2), `registerTool` (`src/mcp-compat.js`), `toMcpJson`/`wrapUntrustedOcr` (`src/mcp-json.js`), an existing write-tool annotation from `src/annotations.ts` (confirm the exact export — e.g. the same one `save_auto_booking_rule` uses; do NOT use `readOnly`).
- Produces: `export function registerOpeningBalanceTools(server: McpServer, api: ApiContext): void;` (add its call alongside the other `register*Tools(server, api)` calls in `src/index.ts`).

- [ ] **Step 1: Write failing tests** (drive the handler through the registered tool; follow the harness other `src/tools/*.test.ts` files use — inspect one, e.g. `src/tools/account-balance.test.ts`, for the server/registration mock pattern):

```ts
// src/tools/opening-balance-import.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetOpeningBalanceCache, readOpeningBalances } from "../opening-balance-store.js";
// import the same in-memory server harness the sibling tool tests use

const SAMPLE = [
  "Nr\tKuupäev\tKonto\tDeebet\tKreedit",
  "1.\t12.12.2024\t1020 Pank\t1 000.00 €\t",
  "\t\t2900 Kapital\t\t1 000.00 €",
].join("\n");

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ob-tool-")); process.env.EARVELDAJA_RULES_DIR = dir; resetOpeningBalanceCache(); });
afterEach(() => { delete process.env.EARVELDAJA_RULES_DIR; rmSync(dir, { recursive: true, force: true }); });

describe("import_opening_balances", () => {
  it("dry_run previews without writing", async () => {
    const res = await callTool("import_opening_balances", { pasted_text: SAMPLE }); // dry_run defaults true
    expect(res).toMatch(/1020/);
    expect(res).toMatch(/balanced/i);
    expect(existsSync(join(dir, "opening-balances.json"))).toBe(false);
    expect(readOpeningBalances()).toBeNull();
  });
  it("persists when dry_run=false", async () => {
    await callTool("import_opening_balances", { pasted_text: SAMPLE, dry_run: false });
    resetOpeningBalanceCache();
    expect(readOpeningBalances()?.openingDate).toBe("2024-12-12");
  });
  it("wraps the echoed paste in the untrusted-text sandbox", async () => {
    const res = await callTool("import_opening_balances", { pasted_text: SAMPLE });
    expect(res).toMatch(/UNTRUSTED_OCR_START/);
  });
  it("returns the balance error without writing on an unbalanced paste", async () => {
    const bad = "Nr\tKuupäev\tKonto\tDeebet\tKreedit\n1.\t12.12.2024\t1020 Pank\t1 000.00 €\t\n\t\t2900 Kapital\t\t900.00 €";
    const res = await callTool("import_opening_balances", { pasted_text: bad });
    expect(res).toMatch(/does not balance/i);
    expect(existsSync(join(dir, "opening-balances.json"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify fail** → FAIL.

- [ ] **Step 3: Implement the tool**

```ts
// src/tools/opening-balance-import.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiContext } from "./crud-tools.js";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { parseOpeningBalances, OpeningBalanceParseError } from "../opening-balance-parse.js";
import { writeOpeningBalances } from "../opening-balance-store.js";
// import the mutating-tool annotation used by other write tools (see src/annotations.ts)

export function registerOpeningBalanceTools(server: McpServer, _api: ApiContext): void {
  registerTool(server, "import_opening_balances",
    "Capture the e-arveldaja 'Algbilansi kanded' (opening-balance) register — which the RIK API omits — so account balances, trial balance, P&L, annual report, and the dividend §157 checks fold it in. Paste the copied register text. dry_run (default true) previews the parsed per-account balances and the debit=credit check without saving; set dry_run=false to persist. Re-import replaces the stored set.",
    {
      pasted_text: z.string().describe("The copied 'Algbilansi kanded' register text (Nr / Kuupäev / Konto / Deebet / Kreedit columns)."),
      dry_run: z.boolean().optional().describe("Preview only, do not persist (default true)."),
    },
    { /* mutating annotation */ title: "Import Opening Balances (Algbilanss)" },
    async ({ pasted_text, dry_run }) => {
      const persist = dry_run === false;
      let parsed;
      try {
        parsed = parseOpeningBalances(pasted_text);
      } catch (error) {
        const msg = error instanceof OpeningBalanceParseError ? error.message : (error as Error).message;
        return { content: [{ type: "text", text: toMcpJson({ ok: false, error: msg }) }] };
      }

      const balanced = Math.abs(parsed.totals.debit - parsed.totals.credit) <= 0.01;
      const preview = {
        ok: true,
        persisted: false as boolean,
        opening_date: parsed.openingDate,
        balanced,
        totals: parsed.totals,
        account_count: parsed.accounts.length,
        accounts: parsed.accounts.map(a => ({
          code: a.code,                                 // code stays clean (matching key)
          name: wrapUntrustedOcr(a.name) ?? a.name,     // name is pasted content → sandbox
          debit: a.debit,
          credit: a.credit,
        })),
        next_step: persist ? undefined
          : "Review the accounts above. To save, call again with dry_run=false.",
      };

      if (!persist) {
        return { content: [{ type: "text", text: toMcpJson(preview) }] };
      }

      // Use a caller-supplied-free timestamp source consistent with the codebase.
      const stored = writeOpeningBalances(parsed, new Date().toISOString());
      return { content: [{ type: "text", text: toMcpJson({ ...preview, persisted: true, parsed_at: stored.parsedAt }) }] };
    },
  );
}
```

Then register it in `src/index.ts` next to the other `register*Tools(server, api)` calls:

```ts
import { registerOpeningBalanceTools } from "./tools/opening-balance-import.js";
// …
registerOpeningBalanceTools(server, api);
```

- [ ] **Step 4: Run tests + type-check** → PASS / clean. Resolve the two `// import …annotation` / harness placeholders against the real `src/annotations.ts` export and the sibling test harness before finishing (they are the only lookups this task leaves to the implementer).

- [ ] **Step 5: Commit**

```bash
git add src/tools/opening-balance-import.ts src/tools/opening-balance-import.test.ts src/index.ts
git commit -m "feat(opening-balance): import_opening_balances capture tool (dry-run/confirm)"
```

---

### Task 6: Fold into `account-balance` + `financial-statements`

**Files:**
- Modify: `src/tools/account-balance.ts`, `src/tools/financial-statements.ts`
- Test: extend `src/tools/account-balance.test.ts`, `src/tools/financial-statements.test.ts`

**Interfaces:**
- Consumes: `loadOpeningBalanceJournal(api)` (Task 3), `withOpeningBalanceStatus` (Task 4).

**Merge rule (applies to every consumer task):** wherever a consumer obtains `allJournals` (via `api.journals.listAllWithPostings()` or a preloaded array), prepend the synthetic journal:

```ts
const opening = await loadOpeningBalanceJournal(api);
const allJournals = [...(opening ? [opening.journal] : []), ...journalsFromApi];
// …compute unchanged…
// then build warnings with:
warnings: withOpeningBalanceStatus(existingWarnings ?? [], {
  captured: opening !== null,
  openingDate: opening?.openingDate,
  unmappedCodes: opening?.unmappedCodes,
}),
```

`computeAccountBalance` already accepts `preloadedJournals` (`src/tools/account-balance.ts:30`) — pass the merged array so the single account query folds opening balances too.

- [ ] **Step 1: Write failing tests** — for each of the two modules, with a stored algbilanss (set `EARVELDAJA_RULES_DIR` to a temp dir + write via `writeOpeningBalances`) assert (a) the computed debit/credit for an opening account increases by the opening amount, (b) `warnings` contains the "applied" note and NOT the blind limitation string; without a stored algbilanss assert the actionable warning appears and figures are unchanged. Use the existing test harness in each file.

```ts
// sketch — src/tools/account-balance.test.ts addition
it("folds a stored opening balance into compute_account_balance", async () => {
  // arrange: temp EARVELDAJA_RULES_DIR + writeOpeningBalances({1020: debit 1000}); mock api.journals + api.readonly.getAccounts
  const res = await computeAccountBalance(api, 1020);
  expect(res.debitTotal).toBe(EXISTING_DEBIT + 1000);
});
```

- [ ] **Step 2: Run, verify fail** → FAIL.

- [ ] **Step 3: Implement** the merge in both modules per the Merge rule. Replace the `warnings: withOpeningBalanceApiLimitation(...)` calls at `account-balance.ts:151` and `:199`, and `financial-statements.ts:187/259/300`, with `withOpeningBalanceStatus(...)`. In `financial-statements.ts` the aggregation loop over `allJournals` (`:54`) needs no change beyond the prepended journal.

- [ ] **Step 4: Run** the two suites + `npx tsc --noEmit` → PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/tools/account-balance.ts src/tools/financial-statements.ts src/tools/account-balance.test.ts src/tools/financial-statements.test.ts
git commit -m "feat(opening-balance): fold synthetic journal into account-balance & financial-statements"
```

---

### Task 7: Fold into `annual-report` + `estonian-tax` (§157); actionable warning in `journals`

**Files:**
- Modify: `src/tools/annual-report.ts`, `src/tools/estonian-tax.ts`, `src/tools/crud/journals.ts`
- Test: extend `src/tools/annual-report.test.ts`, `src/tools/estonian-tax.test.ts`, `src/tools/crud-tools.test.ts`

**Interfaces:** Consumes `loadOpeningBalanceJournal`, `withOpeningBalanceStatus`.

- **`estonian-tax.ts`**: the §157 path preloads `allJournals` once (`src/tools/estonian-tax.ts:225`) and passes it to `computeAccountBalance` for the retained-earnings (`:232`) and net-assets checks. Prepend the synthetic journal to that preloaded array so BOTH checks fold opening equity in. Replace the `warnings.push(OPENING_BALANCE_API_LIMITATION_WARNING)` at `:356` with `withOpeningBalanceStatus`.
- **`annual-report.ts`**: apply the Merge rule where it gathers journals; replace `withOpeningBalanceApiLimitation` at `:1021/1023`.
- **`crud/journals.ts`**: list/get do not aggregate — only swap the warning. Since these calls don't already load journals, gate on `readOpeningBalances() !== null` (cheap, no API call) rather than `loadOpeningBalanceJournal`: `withOpeningBalanceStatus([], { captured: readOpeningBalances() !== null })` at `:69` and `:119`.

- [ ] **Step 1: Write failing tests** — key case for `estonian-tax`: a `prepare_dividend_package` scenario where the stored opening balance raises retained earnings so a dividend that previously FAILED the §157 lg1 ceiling now passes (and the inverse: opening balances that lower net assets below the floor now block a dividend that previously passed). For `annual-report`/`journals`: assert the applied-note vs actionable-warning swap.

- [ ] **Step 2: Run, verify fail** → FAIL.

- [ ] **Step 3: Implement** per the per-file notes above.

- [ ] **Step 4: Run** the three suites + `npx tsc --noEmit` → PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/tools/annual-report.ts src/tools/estonian-tax.ts src/tools/crud/journals.ts src/tools/annual-report.test.ts src/tools/estonian-tax.test.ts src/tools/crud-tools.test.ts
git commit -m "feat(opening-balance): fold into annual-report & §157 dividend checks; actionable journals warning"
```

---

### Task 8: Documentation + release consistency

**Files:**
- Modify: `CLAUDE.md`, `ARCHITECTURE.md`, `README.md`, `CHANGELOG.md`
- Test: `npm run validate:release`, and `src/documentation-contract.test.ts` if any asserted phrase is touched (do not weaken it).

- [ ] **Step 1: Update docs**
  - `README.md`: add `import_opening_balances` to the tool listing/table; bump the tool count (default 121 → 122) everywhere it appears (README, `CLAUDE.md` header line 2, `ARCHITECTURE.md`, and the `computeAccountBalance` tsdoc "121 tools" comment if present). Grep first: `rg -n "121 tools|121 default"`.
  - `CLAUDE.md`: under the opening-balance / API-limitation area, document that the operator can paste the algbilanss via `import_opening_balances`, that it stores `opening-balances.json` in the accounting-rules bundle, and that six computations fold it in as a synthetic journal; note the feature is optional.
  - `ARCHITECTURE.md`: add a short "Opening-balance folding" subsection describing parse → store → synthetic-journal injection.
  - `CHANGELOG.md`: add an `[Unreleased]` bullet.

- [ ] **Step 2: Run release validation**

Run: `npm run validate:release` → Expected: PASS (registry/workflow/command/README set-equality intact; no prompt-pipeline changes were made, so nothing there should drift).
Run: `npm test` (full suite) → Expected: all pass.
Run: `npx tsc --noEmit` → clean.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md ARCHITECTURE.md README.md CHANGELOG.md
git commit -m "docs(opening-balance): document import_opening_balances tool + folding"
```

---

## Self-Review Notes (author)

- **Spec coverage:** parser (T1), store in bundle (T2), synthetic-journal folding model (T3), conditional/actionable warning (T4), dry-run/confirm tool + sandbox (T5), all six consumers (T6 account-balance + financial-statements; T7 annual-report + estonian-tax §157 + journals), scope boundaries honored (account-level only, single set, EUR), docs (T8). The "optional / no opening balance" requirement is the Global Constraint and is exercised by the without-algbilanss assertions in T6/T7.
- **Known implementer lookups (not placeholders in logic, only in local wiring):** the exact mutating-tool annotation export in `src/annotations.ts` and the sibling test-harness `callTool` helper (T5). Both are one-line lookups against existing code; every algorithm, signature, and type is fully specified.
- **Type consistency:** `ParsedOpeningBalances`/`StoredOpeningBalances`/`OpeningBalanceJournal` names and fields are used identically across T1–T7. Posting `type: "D"|"C"` + `amount`/`base_amount` and Journal `effective_date`/`registered`/`is_deleted`/`postings` match `src/types/api.ts`.
