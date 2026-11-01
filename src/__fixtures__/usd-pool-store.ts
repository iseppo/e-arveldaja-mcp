import { usdPoolRecordKey, type UsdPoolRecord, type UsdPoolStore } from "../lightyear/usd-pool.js";

/** In-memory USD pool store for tests (the real one lives in the accounting-rules bundle). */
export function memoryUsdPoolStore(initial: UsdPoolRecord[] = [], options: { unavailable?: boolean } = {}): UsdPoolStore & { records: UsdPoolRecord[] } {
  const state = { records: [...initial] };
  return {
    get records() { return state.records; },
    read: () => (options.unavailable ? null : state.records.map(record => structuredClone(record))),
    upsert(records) {
      if (options.unavailable) throw new Error("single-file mode");
      const keys = new Set(records.map(usdPoolRecordKey));
      state.records = [...state.records.filter(record => !keys.has(usdPoolRecordKey(record))), ...records.map(record => structuredClone(record))];
    },
    remove(keys) {
      const drop = new Set(keys);
      state.records = state.records.filter(record => !drop.has(usdPoolRecordKey(record)));
    },
    reset() {},
  };
}
