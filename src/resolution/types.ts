/**
 * Shared three-way resolution result for the safe accounting resolvers
 * (company / bank-account dimension / supplier default). A resolver either
 * RESOLVES to a single value with evidence, reports it is AMBIGUOUS (a bounded
 * set of choices plus one focused question), or reports NOT_FOUND (a question).
 *
 * The invariant that binds every resolver in `src/resolution/`: a tied or
 * zero-candidate outcome is NEVER silently collapsed into a picked value. It
 * surfaces as `ambiguous` / `not_found` so the caller must ask, exactly the way
 * the inbox already treats an undefined default as "ask a question". This is a
 * stricter TYPE surface, not a behavior change — the adapter that feeds the
 * inbox projects `ambiguous | not_found → undefined`.
 *
 * House style mirrors `src/camt/operations.ts`: NO MCP / HTTP / fs types appear
 * here; inputs and outputs are plain typed data. `Resolution<T>` is distinct
 * from `OperationOutcome<T>` (`src/operation-outcome.ts`) — that models an I/O
 * op's success/failure; this models a decision's resolved/ambiguous/not_found.
 */

/** A tagged piece of evidence explaining WHY a resolver resolved as it did. */
export interface ResolutionEvidence {
  /** Machine tag of the rung that fired (e.g. "override", "statement_iban"). */
  readonly tag: string;
  /** Human-readable note describing the evidence. */
  readonly note: string;
}

/** One bounded candidate offered when a resolution is ambiguous. */
export interface ResolutionChoice {
  /** Stable candidate identifier (stringified so every domain shares a shape). */
  readonly id: string;
  /** Human-readable label for the candidate. */
  readonly label: string;
}

export type Resolution<T> =
  | { readonly status: "resolved"; readonly value: T; readonly evidence: readonly ResolutionEvidence[] }
  | { readonly status: "ambiguous"; readonly choices: readonly ResolutionChoice[]; readonly question: string }
  | { readonly status: "not_found"; readonly question: string };

/** Build a `resolved` result. */
export function resolved<T>(value: T, evidence: readonly ResolutionEvidence[]): Resolution<T> {
  return { status: "resolved", value, evidence };
}

/** Build an `ambiguous` result. */
export function ambiguous<T>(choices: readonly ResolutionChoice[], question: string): Resolution<T> {
  return { status: "ambiguous", choices, question };
}

/** Build a `not_found` result. */
export function notFound<T>(question: string): Resolution<T> {
  return { status: "not_found", question };
}
