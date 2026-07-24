import { AsyncLocalStorage } from "node:async_hooks";
import type { ApiContext } from "../tools/crud-tools.js";
import {
  type ConnectionState,
  type ConnectionSnapshot,
  assertSnapshotCurrent,
} from "../connection-safety.js";

/**
 * The per-invocation connection snapshot store. Each tool/resource handler runs
 * inside `invocationStorage.run(snapshot, ...)`, so the scoped API context can
 * pin every API call to the connection that was active when the handler began —
 * and refuse to serve a different company's data if a switch lands mid-flight.
 */
export function createInvocationStorage(): AsyncLocalStorage<ConnectionSnapshot> {
  return new AsyncLocalStorage<ConnectionSnapshot>();
}

/**
 * Build an API context whose section getters resolve, on every access, to the
 * connection pinned by the in-flight snapshot (or the live active index when no
 * snapshot is set). A generation mismatch throws via `assertSnapshotCurrent`, so
 * a tool interrupted by `switch_connection` cannot make further API requests.
 */
export function createScopedApiContext(
  state: ConnectionState,
  contexts: ApiContext[],
  invocationStorage: AsyncLocalStorage<ConnectionSnapshot>,
): ApiContext {
  const api = {} as ApiContext;
  const keys: Array<keyof ApiContext> = [
    "clients",
    "products",
    "journals",
    "transactions",
    "saleInvoices",
    "purchaseInvoices",
    "readonly",
  ];

  for (const key of keys) {
    Object.defineProperty(api, key, {
      enumerable: true,
      configurable: false,
      get() {
        const snapshot = invocationStorage.getStore();
        if (snapshot) {
          assertSnapshotCurrent(state, snapshot);
          return contexts[snapshot.index]![key];
        }
        return contexts[state.activeIndex]![key];
      },
    });
  }

  return api;
}
