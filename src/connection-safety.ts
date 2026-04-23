/**
 * Connection safety helpers: snapshot construction, stale-connection detection,
 * and the "can we switch connection right now?" gate.
 *
 * Kept in its own module so the pure logic can be unit-tested without the full
 * server bootstrap (index.ts has top-level `main().catch(...)` and can't be
 * imported from tests).
 */

export interface ConnectionState {
  activeIndex: number;
  generation: number;
}

export interface ConnectionSnapshot {
  index: number;
  generation: number;
  /** Name of the tool whose invocation captured this snapshot. Undefined for resource handlers and the pre-tool guard. */
  toolName?: string;
  /** False means a mutation. Used to decide whether to track this snapshot as "interruptable in flight". */
  isReadOnly?: boolean;
  /** Wall-clock ms at capture. Used to detect stale in-flight entries if a handler hangs. */
  capturedAtMs?: number;
}

/**
 * Snapshots older than this are treated as stale by buildSwitchBlockedPayload:
 * a tool handler that has been "in flight" for more than this many ms is
 * almost certainly wedged (crashed before finally, never-resolving promise,
 * etc.) and should not indefinitely block switch_connection.
 */
export const STALE_SNAPSHOT_THRESHOLD_MS = 120_000;

/**
 * Raised when a tool's API call sees a snapshot that no longer matches the
 * live connection state — i.e. someone switched connections while the tool
 * was mid-execution. Typed so wrapToolHandler can identify it and write a
 * dedicated audit entry.
 */
export class ConnectionSwitchInterruptedError extends Error {
  readonly toolName?: string;
  readonly wasReadOnly?: boolean;
  readonly originalIndex: number;
  constructor(toolName: string | undefined, wasReadOnly: boolean | undefined, originalIndex: number) {
    const toolHint = toolName ? ` (tool: ${toolName})` : "";
    super(
      `Active connection changed during tool execution${toolHint}. ` +
      `Further API requests were blocked. Inspect any side effects before retrying the tool on the intended connection.`
    );
    this.name = "ConnectionSwitchInterruptedError";
    this.toolName = toolName;
    this.wasReadOnly = wasReadOnly;
    this.originalIndex = originalIndex;
  }
}

export function captureSnapshot(
  state: ConnectionState,
  opts?: { toolName?: string; isReadOnly?: boolean },
): ConnectionSnapshot {
  return {
    index: state.activeIndex,
    generation: state.generation,
    toolName: opts?.toolName,
    isReadOnly: opts?.isReadOnly,
    capturedAtMs: Date.now(),
  };
}

export function assertSnapshotCurrent(state: ConnectionState, snapshot: ConnectionSnapshot): void {
  if (snapshot.generation !== state.generation) {
    throw new ConnectionSwitchInterruptedError(snapshot.toolName, snapshot.isReadOnly, snapshot.index);
  }
}

export interface InFlightMutationInfo {
  tool_name: string;
  source_connection_index: number;
  age_ms?: number;
}

/**
 * Inspect the in-flight mutation set and decide whether a pending switch is
 * allowed. Excludes the current tool's own snapshot (switch_connection is
 * itself a mutation and will be in the set when this is called from its
 * handler).
 *
 * Snapshots older than `STALE_SNAPSHOT_THRESHOLD_MS` are treated as stale and
 * ignored — they represent handlers that crashed before `finally` or awaited
 * a never-resolving promise, and must not block switching forever. Stale
 * snapshots are also removed from `inFlightSnapshots` when it is a mutable
 * `Set<ConnectionSnapshot>`, so a future call doesn't re-evaluate them.
 *
 * Returns null when the switch is allowed, or a structured error payload
 * when in-flight mutations would be interrupted.
 */
export function buildSwitchBlockedPayload(
  inFlightSnapshots: Iterable<ConnectionSnapshot>,
  currentSnapshot: ConnectionSnapshot | undefined,
  options?: { now?: number; staleThresholdMs?: number },
): { error: string; in_flight_tools: InFlightMutationInfo[]; hint: string } | null {
  const now = options?.now ?? Date.now();
  const staleThreshold = options?.staleThresholdMs ?? STALE_SNAPSHOT_THRESHOLD_MS;
  const interruptable: InFlightMutationInfo[] = [];
  const stale: ConnectionSnapshot[] = [];
  for (const snap of inFlightSnapshots) {
    if (snap === currentSnapshot) continue; // the switch_connection call itself
    const age = snap.capturedAtMs ? now - snap.capturedAtMs : 0;
    if (snap.capturedAtMs && age > staleThreshold) {
      stale.push(snap);
      continue;
    }
    interruptable.push({
      tool_name: snap.toolName ?? "unknown",
      source_connection_index: snap.index,
      ...(snap.capturedAtMs ? { age_ms: age } : {}),
    });
  }
  if (stale.length > 0 && typeof (inFlightSnapshots as Set<ConnectionSnapshot>).delete === "function") {
    for (const s of stale) (inFlightSnapshots as Set<ConnectionSnapshot>).delete(s);
  }
  if (interruptable.length === 0) return null;
  return {
    error:
      `Cannot switch connection while ${interruptable.length} non-readonly tool(s) are in flight. ` +
      `Switching now would interrupt the mutation(s) mid-execution against the previous connection, ` +
      `leaving the transaction state partially applied. Wait for them to complete, then retry.`,
    in_flight_tools: interruptable,
    hint: "If an in-flight tool is stuck, cancel the MCP client request instead of forcing the switch.",
  };
}
