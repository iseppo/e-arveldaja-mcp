// PURE grouping of detected CAMT statement files. Byte-identical files (same
// SHA-256) are duplicates of one kept file; statements of the same account and
// currency whose periods intersect are reported as overlapping, information
// only (both stay recommended: rows in the overlap are deduplicated on import).

import { groupByDigest } from "../file-digest-groups.js";

export interface CamtStatementFingerprint {
  /** Position in the inbox camt_files list. */
  readonly index: number;
  readonly path: string;
  readonly modifiedAt: string;
  /** Hex SHA-256 of the file bytes. */
  readonly digest: string;
  /** The import's strict account identity plus statement currency; undefined
   * when the statement could not be analyzed for overlap. Never emitted. */
  readonly accountKey?: string;
  readonly period?: { readonly from: string; readonly to: string };
}

interface CamtStatementDuplicateInfo {
  readonly index: number;
  /** Set on a byte-identical copy of the kept file `duplicate_of`. */
  duplicate_of?: number;
  /** Set on a kept file: the indices of its byte-identical copies. */
  stands_in_for?: number[];
  overlaps_with?: Array<{ index: number; from: string; to: string }>;
}

export function groupCamtStatementFiles(files: readonly CamtStatementFingerprint[]): CamtStatementDuplicateInfo[] {
  const info = new Map<number, Omit<CamtStatementDuplicateInfo, "index">>(
    groupByDigest(files).map(({ index, ...group }) => [index, group]));

  // Overlap among the files that keep their steps; a duplicate shares its kept
  // file's statement.
  const candidates = files.filter(file =>
    info.get(file.index)!.duplicate_of === undefined && file.accountKey !== undefined && file.period !== undefined);
  // Each overlapping pair once; both files list the other (in file order).
  for (const [i, file] of candidates.entries()) {
    for (const other of candidates.slice(i + 1)) {
      if (other.accountKey !== file.accountKey) continue;
      if (file.period!.from <= other.period!.to && other.period!.from <= file.period!.to) {
        (info.get(file.index)!.overlaps_with ??= []).push({ index: other.index, from: other.period!.from, to: other.period!.to });
        (info.get(other.index)!.overlaps_with ??= []).push({ index: file.index, from: file.period!.from, to: file.period!.to });
      }
    }
  }

  return files.map(file => ({ index: file.index, ...info.get(file.index)! }));
}
