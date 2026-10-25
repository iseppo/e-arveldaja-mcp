/**
 * Pure bank-dimension resolver. Decides WHICH bank-account dimension
 * (`accounts_dimensions_id`, used as `related_sub_id` at booking) a statement /
 * default should use, returning the shared three-way `Resolution<number>`.
 *
 * House style mirrors `src/camt/operations.ts`: NO MCP / HTTP / fs types — only
 * plain typed data (`BankAccount` / `AccountDimension` from `types/api`, and the
 * injected `SavedBankDefaultPort`). The candidate builders + exact-unique
 * pickers were moved here verbatim from `accounting-inbox.ts` so the inbox and
 * the resolver share one implementation.
 *
 * ORDERED FALLBACK (Step 2):
 *   1. explicit override
 *   2. exact statement IBAN, unique
 *   3. injected saved default — usable ONLY after re-verifying active +
 *      current-connection + expected-ledger + currency/IBAN (async, port)
 *   4. terminal unique-local-bank-by-count (today's inbox rung, UNVALIDATED)
 *   else → ambiguous (candidates present) / not_found (none)
 *
 * GRACEFUL DEGRADATION (critical for byte-identity): when no `savedDefaultPort`
 * is injected rung 3 is skipped and the resolver behaves EXACTLY as the inbox
 * does today: override → IBAN-unique → unique-local-bank → ambiguous/not_found.
 *
 * The inbox calls the SYNC core (`resolveBankAccountSync`, rungs 1/2/4 — all
 * sync). The async wrapper (`resolveBankAccount`) additionally awaits the
 * saved-default port for rung 3; with no port it produces the same result as
 * the sync core.
 */
import type { AccountDimension, BankAccount } from "../types/api.js";
import { ambiguous, notFound, resolved, type Resolution, type ResolutionEvidence } from "./types.js";

export interface BankDimensionCandidate {
  accounts_dimensions_id: number;
  label: string;
  iban?: string;
  match_reason: string;
}

/** Injected, connection-scoped read of a previously-saved default dimension.
 * PR 9 / Task 15 supplies the real persistent adapter; Task 11 defines the
 * interface + the every-invocation re-verification the resolver performs, and
 * consumes an INJECTED port only (tests use an in-memory stub; the inbox passes
 * none). NO persistence is implemented here. */
export interface SavedBankDefaultPort {
  readSavedBankDefault(input: {
    connectionId: string;
    expectedLedgerAccountId: number;
  }): Promise<SavedBankDefaultPointer | undefined>;
}

export interface SavedBankDefaultPointer {
  accounts_dimensions_id: number;
  connectionId: string;
  ledgerAccountId: number;
  currency?: string;
  iban?: string;
}

export interface BankResolutionInput {
  /** The candidate set to resolve over (the inbox passes its local-bank set). */
  readonly candidates: readonly BankDimensionCandidate[];
  /** Rung 1 — explicit operator override. Always wins when present. */
  readonly override?: number;
  /** Rung 2 — the statement IBAN to match uniquely. */
  readonly statementIban?: string;
  /** Rung 3 — statement currency constraint. */
  readonly statementCurrency?: string;
  /** Rung 3 — the bank ledger account a saved default must belong to. */
  readonly expectedLedgerAccountId?: number;
  /** Rung 3 — current connection identity the saved default must match. */
  readonly currentConnectionId?: string;
  /** Rung 3 — active-dimension re-verification set (current chart fetch). */
  readonly accountDimensions?: readonly AccountDimension[];
  /** Rung 3 — INJECTED saved-default port (absent for the inbox). */
  readonly savedDefaultPort?: SavedBankDefaultPort;
}

// ---------------------------------------------------------------------------
// Moved pure helpers (verbatim from accounting-inbox.ts)
// ---------------------------------------------------------------------------

export function normalizeIban(value: string | undefined | null): string | undefined {
  const normalized = (value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return normalized || undefined;
}

export function buildBankDimensionCandidates(
  bankAccounts: BankAccount[],
  accountDimensions: AccountDimension[],
): BankDimensionCandidate[] {
  const dimensionById = new Map<number, AccountDimension>();
  for (const dimension of accountDimensions) {
    if (dimension.id !== undefined && !dimension.is_deleted) {
      dimensionById.set(dimension.id, dimension);
    }
  }

  return bankAccounts
    .filter(account => account.accounts_dimensions_id !== undefined)
    .map((account) => {
      const dimension = account.accounts_dimensions_id !== undefined
        ? dimensionById.get(account.accounts_dimensions_id)
        : undefined;
      return {
        accounts_dimensions_id: account.accounts_dimensions_id!,
        label: account.account_name_est || account.bank_name || dimension?.title_est || `Dimension ${account.accounts_dimensions_id}`,
        // First non-blank identifier: an empty iban_code must not hide account_no.
        iban: account.iban_code?.trim() || account.account_no,
        match_reason: dimension?.title_est
          ? `Linked bank account + dimension title "${dimension.title_est}"`
          : "Linked bank account dimension",
      };
    })
    .filter((candidate, index, all) =>
      all.findIndex(other => other.accounts_dimensions_id === candidate.accounts_dimensions_id) === index
    );
}

export function pickSingleCandidateByPattern(
  candidates: readonly BankDimensionCandidate[],
  pattern: RegExp,
): BankDimensionCandidate | undefined {
  const matches = candidates.filter(candidate => pattern.test(candidate.label) || pattern.test(candidate.iban ?? ""));
  return matches.length === 1 ? matches[0] : undefined;
}

export function pickSingleCandidateByIban(
  candidates: readonly BankDimensionCandidate[],
  iban: string | undefined,
): BankDimensionCandidate | undefined {
  const normalizedIban = normalizeIban(iban);
  if (!normalizedIban) return undefined;
  const matches = candidates.filter(candidate => normalizeIban(candidate.iban) === normalizedIban);
  return matches.length === 1 ? matches[0] : undefined;
}

// ---------------------------------------------------------------------------
// Ordered rungs — each returns a `resolved` Resolution or undefined (continue).
// ---------------------------------------------------------------------------

function ev(tag: string, note: string): readonly ResolutionEvidence[] {
  return [{ tag, note }];
}

function rungOverride(input: BankResolutionInput): Resolution<number> | undefined {
  if (input.override === undefined) return undefined;
  return resolved(input.override, ev("override", `Explicit bank dimension override ${input.override}.`));
}

function rungStatementIban(input: BankResolutionInput): Resolution<number> | undefined {
  const match = pickSingleCandidateByIban(input.candidates, input.statementIban);
  if (!match) return undefined;
  return resolved(
    match.accounts_dimensions_id,
    ev("statement_iban", `Statement IBAN ${input.statementIban} uniquely matched ${match.label}.`),
  );
}

function rungUniqueLocalCount(input: BankResolutionInput): Resolution<number> | undefined {
  if (input.candidates.length !== 1) return undefined;
  const only = input.candidates[0]!;
  return resolved(
    only.accounts_dimensions_id,
    ev("unique_local_bank", `Single local bank candidate ${only.label} (${only.accounts_dimensions_id}).`),
  );
}

function terminal(input: BankResolutionInput): Resolution<number> {
  if (input.candidates.length === 0) {
    return notFound(
      "No bank account dimension is available. Use list_bank_accounts or list_account_dimensions to choose one.",
    );
  }
  return ambiguous(
    input.candidates.slice(0, 3).map(c => ({ id: String(c.accounts_dimensions_id), label: c.label })),
    "Which bank account dimension should be used?",
  );
}

/** Re-verify a saved-default pointer against the CURRENT invocation. Never
 * trusts a pointer from storage alone (plan Step 2): it must be active in the
 * current chart, belong to the current connection + expected ledger account,
 * and match the statement currency/IBAN when the statement carries one. */
function verifySavedDefault(pointer: SavedBankDefaultPointer, input: BankResolutionInput): boolean {
  // active — present + not deleted in the current dimensions fetch
  const dims = input.accountDimensions ?? [];
  const dim = dims.find(d => d.id === pointer.accounts_dimensions_id && !d.is_deleted);
  if (!dim) return false;
  // current connection
  if (input.currentConnectionId !== undefined && pointer.connectionId !== input.currentConnectionId) return false;
  // expected bank ledger account
  if (input.expectedLedgerAccountId !== undefined) {
    if (pointer.ledgerAccountId !== input.expectedLedgerAccountId) return false;
    if (dim.accounts_id !== input.expectedLedgerAccountId) return false;
  }
  // currency constraint — FAIL-CLOSED (F-SAVED-DEFAULT-CURRENCY-FAILCLOSED):
  // a statement that carries a currency requires the pointer to carry a MATCHING
  // one. An undefined pointer.currency no longer passes a currency-bearing
  // statement (that was fail-OPEN → same-connection wrong-currency book).
  if (input.statementCurrency !== undefined && pointer.currency !== input.statementCurrency) {
    return false;
  }
  // IBAN constraint
  if (input.statementIban !== undefined && pointer.iban !== undefined &&
    normalizeIban(pointer.iban) !== normalizeIban(input.statementIban)) {
    return false;
  }
  // the pointed-to dimension must be a real candidate in the resolution set
  return input.candidates.some(c => c.accounts_dimensions_id === pointer.accounts_dimensions_id);
}

/**
 * Synchronous resolver core — rungs 1/2/4. Complete and correct for every
 * caller that does NOT inject a saved-default port (which is how the inbox
 * calls it). Rung 3 (the async saved-default port) is skipped.
 */
export function resolveBankAccountSync(input: BankResolutionInput): Resolution<number> {
  return (
    rungOverride(input) ??
    rungStatementIban(input) ??
    rungUniqueLocalCount(input) ??
    terminal(input)
  );
}

/**
 * Async resolver — the full ordered fallback including the injected
 * saved-default rung (3). With no `savedDefaultPort` it returns exactly what
 * `resolveBankAccountSync` returns.
 */
export async function resolveBankAccount(input: BankResolutionInput): Promise<Resolution<number>> {
  const overrideRung = rungOverride(input);
  if (overrideRung) return overrideRung;
  const ibanRung = rungStatementIban(input);
  if (ibanRung) return ibanRung;

  if (input.savedDefaultPort && input.currentConnectionId !== undefined && input.expectedLedgerAccountId !== undefined) {
    const pointer = await input.savedDefaultPort.readSavedBankDefault({
      connectionId: input.currentConnectionId,
      expectedLedgerAccountId: input.expectedLedgerAccountId,
    });
    if (pointer && verifySavedDefault(pointer, input)) {
      return resolved(
        pointer.accounts_dimensions_id,
        ev("saved_default", `Re-verified saved default dimension ${pointer.accounts_dimensions_id}.`),
      );
    }
  }

  return rungUniqueLocalCount(input) ?? terminal(input);
}

/** Adapter projecting the three-way result back to today's `number | undefined`
 * (`resolved → value`, `ambiguous | not_found → undefined`). The inbox feeds
 * the projection into the UNCHANGED buildBankDefaults/buildRecommendedSteps
 * shape so its output stays byte-identical. */
export function projectBankResolution(resolution: Resolution<number>): number | undefined {
  return resolution.status === "resolved" ? resolution.value : undefined;
}
