import { getBundleRecordIdentity } from "../accounting-rules.js";

/**
 * B3b: the movement identities (camtMovementIdentity) of the CAMT statements an
 * inbox scan retained — not a byte copy, not superseded — keyed by connection
 * and statement digest. A stored journal-review acknowledgement applies only to
 * a statement a scan in this process retained for the active connection, and
 * only to a movement that occurs once across that connection's retained
 * statements, so one acknowledgement cannot quiet the same reference-less
 * movement in two statements. Another company's statements never count.
 *
 * In-process state only: after a restart (empty registry) no acknowledgement
 * applies until an inbox scan has seen the statement again. A scan replaces the
 * entries of every statement it analyzed; statements no later scan sees keep
 * theirs.
 */
const retainedByKey = new Map<string, ReadonlyMap<string, number>>();

function connectionPrefix(): string {
  return `${getBundleRecordIdentity().stableIdentity}\n`;
}

function countIdentities(identities: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const identity of identities) counts.set(identity, (counts.get(identity) ?? 0) + 1);
  return counts;
}

/** Record one scan for the active connection: `analyzedDigests` lose their old entries, `retained` (digest → identities) are stored. */
export function recordRetainedCamtStatements(
  analyzedDigests: Iterable<string>,
  retained: ReadonlyMap<string, readonly string[]>,
): void {
  const prefix = connectionPrefix();
  for (const digest of analyzedDigests) retainedByKey.delete(prefix + digest);
  for (const [digest, identities] of retained) retainedByKey.set(prefix + digest, countIdentities(identities));
}

/** True when an inbox scan in this process retained the statement with this digest for the active connection. */
export function hasRetainedCamtStatement(digest: string | undefined): boolean {
  return digest !== undefined && retainedByKey.has(connectionPrefix() + digest);
}

/** Occurrences of `identity` in the active connection's retained statements, leaving out the statement with digest `exceptDigest`. */
export function retainedCamtMovementOccurrences(identity: string, exceptDigest?: string): number {
  const prefix = connectionPrefix();
  const except = exceptDigest !== undefined ? prefix + exceptDigest : undefined;
  let total = 0;
  for (const [key, counts] of retainedByKey) {
    if (key.startsWith(prefix) && key !== except) total += counts.get(identity) ?? 0;
  }
  return total;
}

/** Test seam: forget every recorded scan. */
export function resetRetainedCamtStatements(): void {
  retainedByKey.clear();
}
