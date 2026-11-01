/**
 * B3b: the movement identities (camtMovementIdentity) of the CAMT statements an
 * inbox scan retained — not a byte copy, not superseded — keyed by statement
 * digest. A journal-review acknowledgement applies only to a movement that
 * occurs once across these statements, so one acknowledgement cannot quiet the
 * same reference-less movement in two retained statements.
 *
 * In-process state only. A scan replaces the entries of every statement it
 * analyzed; statements no later scan sees keep theirs. The counts can only make
 * an acknowledgement stricter (more refusals), never apply one.
 */
const retainedByDigest = new Map<string, ReadonlyMap<string, number>>();

function countIdentities(identities: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const identity of identities) counts.set(identity, (counts.get(identity) ?? 0) + 1);
  return counts;
}

/** Record one scan: `analyzedDigests` lose their old entries, `retained` (digest → identities) are stored. */
export function recordRetainedCamtStatements(
  analyzedDigests: Iterable<string>,
  retained: ReadonlyMap<string, readonly string[]>,
): void {
  for (const digest of analyzedDigests) retainedByDigest.delete(digest);
  for (const [digest, identities] of retained) retainedByDigest.set(digest, countIdentities(identities));
}

/** Occurrences of `identity` in the retained statements, leaving out the statement with digest `exceptDigest`. */
export function retainedCamtMovementOccurrences(identity: string, exceptDigest?: string): number {
  let total = 0;
  for (const [digest, counts] of retainedByDigest) {
    if (digest !== exceptDigest) total += counts.get(identity) ?? 0;
  }
  return total;
}

/** Test seam: forget every recorded scan. */
export function resetRetainedCamtStatements(): void {
  retainedByDigest.clear();
}
