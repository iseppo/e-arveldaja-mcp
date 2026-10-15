// PURE grouping of detected CAMT statement files. Byte-identical files (same
// SHA-256) are duplicates of one kept file; statements of the same account and
// currency whose periods intersect are reported as overlapping, information
// only (both stay recommended: rows in the overlap are deduplicated on import).

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
  readonly duplicate_of?: number;
  /** Set on a kept file: the indices of its byte-identical copies. */
  readonly stands_in_for?: number[];
  readonly overlaps_with?: Array<{ index: number; from: string; to: string }>;
}

function keptFirst(left: CamtStatementFingerprint, right: CamtStatementFingerprint): number {
  // Newest first; a modified_at tie keeps the lowest path, so the choice is total.
  if (left.modifiedAt !== right.modifiedAt) return left.modifiedAt < right.modifiedAt ? 1 : -1;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export function groupCamtStatementFiles(files: readonly CamtStatementFingerprint[]): CamtStatementDuplicateInfo[] {
  const info = new Map<number, { duplicate_of?: number; stands_in_for?: number[]; overlaps_with?: Array<{ index: number; from: string; to: string }> }>(
    files.map(file => [file.index, {}]),
  );

  const byDigest = new Map<string, CamtStatementFingerprint[]>();
  for (const file of files) {
    const group = byDigest.get(file.digest);
    if (group) group.push(file);
    else byDigest.set(file.digest, [file]);
  }
  for (const group of byDigest.values()) {
    if (group.length < 2) continue;
    const [kept, ...copies] = [...group].sort(keptFirst);
    info.get(kept!.index)!.stands_in_for = copies.map(copy => copy.index).sort((left, right) => left - right);
    for (const copy of copies) info.get(copy.index)!.duplicate_of = kept!.index;
  }

  // Overlap among the files that keep their steps; a duplicate shares its kept
  // file's statement.
  const candidates = files.filter(file =>
    info.get(file.index)!.duplicate_of === undefined && file.accountKey !== undefined && file.period !== undefined);
  for (const file of candidates) {
    for (const other of candidates) {
      if (other.index === file.index || other.accountKey !== file.accountKey) continue;
      if (file.period!.from <= other.period!.to && other.period!.from <= file.period!.to) {
        (info.get(file.index)!.overlaps_with ??= []).push({ index: other.index, from: other.period!.from, to: other.period!.to });
      }
    }
  }

  return files.map(file => ({ index: file.index, ...info.get(file.index)! }));
}
