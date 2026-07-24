import {
  type ConnectionState,
  type ConnectionSnapshot,
  captureSnapshot,
} from "../connection-safety.js";
import { clearConnectionCaches } from "../cache-control.js";

/**
 * The mutable active-connection bookkeeping shared across the runtime. `generation`
 * is bumped on every switch so any in-flight snapshot captured against the old
 * connection is detectably stale.
 */
export function createConnectionState(): ConnectionState {
  return { activeIndex: 0, generation: 0 };
}

/**
 * Perform the connection switch atomically: bump the generation, repoint the
 * active index, and clear BOTH the previous and target connection caches so one
 * company's data is never served to another. Returns the fresh snapshot for the
 * now-active connection.
 *
 * The generation bump + cache clears are grouped here (moved verbatim from the
 * `switch_connection` handler) so the security-relevant ordering lives in one
 * place; the handler still owns the guard checks and response shaping.
 */
export function switchActiveConnection(
  state: ConnectionState,
  previousIndex: number,
  targetIndex: number,
): ConnectionSnapshot {
  state.generation += 1;
  state.activeIndex = targetIndex;
  clearConnectionCaches(previousIndex);
  clearConnectionCaches(targetIndex);
  return captureSnapshot(state);
}
