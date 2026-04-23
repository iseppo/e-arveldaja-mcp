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
 * Age at which an in-flight snapshot is reported as "long-running" to the
 * switch caller for observability. We intentionally do NOT auto-reap these:
 * reaping would let `switch_connection` proceed while a real mutation is
 * still mid-flight — after one successful API write but before the handler
 * finishes its local work — leaving the first side effect committed on
 * the original connection and subsequent calls failing post-switch. That
 * is exactly the partial-state hole the switch gate is supposed to close.
 *
 * A permanently-wedged handler therefore blocks switch forever. The
 * mitigation is to cancel the MCP client request (or restart the server),
 * not to silently let the switch proceed.
 */
export const LONG_RUNNING_SNAPSHOT_MS = 120_000;

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
 * Reports `age_ms` per in-flight snapshot for observability; snapshots are
 * never auto-reaped (see LONG_RUNNING_SNAPSHOT_MS doc comment). Callers can
 * use `age_ms` to surface "this tool has been running N minutes — consider
 * cancelling the MCP client request" guidance to operators.
 *
 * Returns null when the switch is allowed, or a structured error payload
 * when in-flight mutations would be interrupted.
 */
export function buildSwitchBlockedPayload(
  inFlightSnapshots: Iterable<ConnectionSnapshot>,
  currentSnapshot: ConnectionSnapshot | undefined,
  options?: { now?: number },
): { error: string; in_flight_tools: InFlightMutationInfo[]; hint: string } | null {
  const now = options?.now ?? Date.now();
  const interruptable: InFlightMutationInfo[] = [];
  for (const snap of inFlightSnapshots) {
    if (snap === currentSnapshot) continue; // the switch_connection call itself
    // Math.max guards against a backward clock step (NTP) producing a
    // nonsensical negative age in the payload operators read.
    const age = snap.capturedAtMs ? Math.max(0, now - snap.capturedAtMs) : 0;
    interruptable.push({
      tool_name: snap.toolName ?? "unknown",
      source_connection_index: snap.index,
      ...(snap.capturedAtMs ? { age_ms: age } : {}),
    });
  }
  if (interruptable.length === 0) return null;
  const hasLongRunning = interruptable.some(t => (t.age_ms ?? 0) > LONG_RUNNING_SNAPSHOT_MS);
  return {
    error:
      `Cannot switch connection while ${interruptable.length} non-readonly tool(s) are in flight. ` +
      `Switching now would interrupt the mutation(s) mid-execution against the previous connection, ` +
      `leaving the transaction state partially applied. Wait for them to complete, then retry.`,
    in_flight_tools: interruptable,
    hint: hasLongRunning
      ? "One or more tools have been running for over 2 minutes. If wedged, cancel the MCP client request (or restart the server) — the gate will not auto-release, because auto-releasing would re-open the partial-state window the gate is meant to close."
      : "If an in-flight tool is stuck, cancel the MCP client request instead of forcing the switch.",
  };
}
