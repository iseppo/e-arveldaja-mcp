// PURE grouping of files by content digest. Byte-identical files (same digest)
// are copies of ONE kept file: the newest `modifiedAt`, then the lowest path,
// so the choice is total and does not depend on the input order.

export interface DigestedFile {
  /** Caller's position for the file; echoed back in the result. */
  readonly index: number;
  readonly path: string;
  readonly modifiedAt: string;
  /** Hex digest (SHA-256) of the file bytes. */
  readonly digest: string;
}

export interface DigestGroupInfo {
  readonly index: number;
  /** Set on a byte-identical copy of the kept file `duplicate_of`. */
  duplicate_of?: number;
  /** Set on a kept file: the indices of its byte-identical copies, ascending. */
  stands_in_for?: number[];
}

function keptFirst(left: DigestedFile, right: DigestedFile): number {
  // Newest first; a modified_at tie keeps the lowest path, so the choice is total.
  if (left.modifiedAt !== right.modifiedAt) return left.modifiedAt < right.modifiedAt ? 1 : -1;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

/** Per file (input order): which kept file it copies, or which copies it stands in for. */
export function groupByDigest(files: readonly DigestedFile[]): DigestGroupInfo[] {
  const info = new Map<number, Omit<DigestGroupInfo, "index">>(files.map(file => [file.index, {}]));
  const byDigest = new Map<string, DigestedFile[]>();
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
  return files.map(file => ({ index: file.index, ...info.get(file.index)! }));
}
