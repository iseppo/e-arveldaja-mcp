// --- M05: strict import validation scaffolding -------------------------------
//
// External statements are attacker-controlled. Every rejected field is
// addressed by a POSITIONAL identity so no file-supplied byte (statement ID,
// counterparty text, the malformed value itself) can reach an identity or a
// reason. Raw values are exposed only through the bounded, sandboxed projection
// in the tool/presenter layer (importPreflightFailure).
//
// This module is PURE: it imports no MCP, HTTP, filesystem, audit, or
// environment module. The failure→MCP-envelope projection stays in the
// tool/presenter layer. The Wise preflight (../wise/preflight.ts) shares this
// scaffolding, so both importers reject fields identically.

export interface ImportRejectedField {
  source_row_id: string;
  field: string;
  value: string;
  reason: string;
}

export class ImportFieldError extends Error {
  constructor(readonly issue: ImportRejectedField) {
    super(issue.reason);
    this.name = "ImportFieldError";
  }
}

export function reject(source_row_id: string, field: string, value: unknown, reason: string): never {
  throw new ImportFieldError({ source_row_id, field, value: String(value ?? ""), reason });
}

/**
 * Run one field parse, recording its issue and continuing. Accumulating rather
 * than throwing on the first bad field is what lets one pass report defects
 * from every entry in a file instead of stopping at the first. Coverage is per
 * capture() call, not exhaustive within one: a node parsed by a single call
 * (parseAmountNode validates amount before currency) reports only the first
 * defect it hits, and the rest of that node's fields go unexamined until the
 * reported one is fixed.
 */
export function capture<T>(sink: ImportRejectedField[], parse: () => T): T | undefined {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ImportFieldError) {
      sink.push(error.issue);
      return undefined;
    }
    throw error;
  }
}

/** Reject dates the calendar does not have (2026-02-30, 2026-13-01). */
export function assertRealDate(date: string, row: string, field: string, original: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return reject(row, field, original, "Expected YYYY-MM-DD");
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = new Date(Date.UTC(year, month - 1, day));
  const roundTrips = utc.getUTCFullYear() === year
    && utc.getUTCMonth() === month - 1
    && utc.getUTCDate() === day;
  return roundTrips ? date : reject(row, field, original, "Impossible calendar date");
}
