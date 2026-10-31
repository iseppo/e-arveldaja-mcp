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

/**
 * Multiset containment of opaque identities: every identity of `subset` occurs
 * in `superset` at least as many times. A repeated identity counts each time.
 */
export function coveredBy(subset: readonly string[], superset: readonly string[]): boolean {
  if (subset.length > superset.length) return false;
  const remaining = new Map<string, number>();
  for (const identity of superset) remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
  for (const identity of subset) {
    const left = remaining.get(identity) ?? 0;
    if (left === 0) return false;
    remaining.set(identity, left - 1);
  }
  return true;
}

export interface CoverageCandidate extends DigestedFile {
  /** Only files with an equal scope key can cover each other (e.g. account + currency). */
  readonly scopeKey: string;
  /** Inclusive YYYY-MM-DD period; when set on both, the covering period must contain the other. */
  readonly period?: { readonly from: string; readonly to: string };
  /** Opaque movement identities (a multiset). */
  readonly identities: readonly string[];
}

function periodDays(period: CoverageCandidate["period"]): number {
  return period === undefined ? 0 : (Date.parse(period.to) - Date.parse(period.from)) / 86_400_000;
}

/** Strict total order: the file most likely to cover the others comes first. */
function coveringFirst(left: CoverageCandidate, right: CoverageCandidate): number {
  const byLength = periodDays(right.period) - periodDays(left.period);
  if (byLength !== 0) return byLength;
  const bySize = right.identities.length - left.identities.length;
  if (bySize !== 0) return bySize;
  const leftEnd = left.period?.to ?? "";
  const rightEnd = right.period?.to ?? "";
  if (leftEnd !== rightEnd) return leftEnd < rightEnd ? 1 : -1;
  const byKept = keptFirst(left, right);
  if (byKept !== 0) return byKept;
  return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0;
}

/**
 * Which files are fully contained in another one: a file F is superseded by C
 * when C comes earlier in one strict total order, C itself is retained, both
 * share the scope key, C's period contains F's, and F's identity multiset is
 * covered by C's. Supersession edges therefore always point to a retained file
 * (no cycles), and two equal-content files keep exactly one, independent of
 * input order. A file with no identities is never superseded (period
 * containment alone proves nothing). Returns superseded index → covering index.
 */
export function findSupersededFiles(files: readonly CoverageCandidate[]): Map<number, number> {
  const superseded = new Map<number, number>();
  const retained: CoverageCandidate[] = [];
  for (const file of [...files].sort(coveringFirst)) {
    const cover = file.identities.length === 0 ? undefined : retained.find(candidate =>
      candidate.scopeKey === file.scopeKey &&
      (candidate.period === undefined || file.period === undefined ||
        (candidate.period.from <= file.period.from && file.period.to <= candidate.period.to)) &&
      coveredBy(file.identities, candidate.identities));
    if (cover !== undefined) superseded.set(file.index, cover.index);
    else retained.push(file);
  }
  return superseded;
}
