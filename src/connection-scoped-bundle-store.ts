import { statSync } from "fs";
import { dirname } from "path";
import {
  checkBundleRecordIdentity,
  getBundleRecordIdentity,
  readBoundedBundleJson,
  resolveBundleStorePath,
  withBundleLock,
} from "./accounting-rules.js";
import { writePrivateFile } from "./config.js";
import { MAX_JSON_INPUT_SIZE } from "./tools/crud/shared.js";

/**
 * A small JSON record store in the accounting-rules bundle dir, built on the
 * statement-balance store pattern: every record is stamped with the connection
 * identity it was written for (the bundle can be shared by several
 * connections), reads keep only this connection's records, and writes run
 * under the bundle lock with an atomic private write. In single-file rules mode
 * (EARVELDAJA_RULES_FILE) there is no bundle dir: `read()` returns null (feature
 * off) and writes throw.
 */
export interface ConnectionScopedBundleStore<T> {
  /** This connection's records, or null when the store is unavailable (single-file mode). */
  read(): T[] | null;
  /** Insert or replace records by key; the oldest are dropped beyond `maxEntries`. */
  upsert(records: readonly T[]): void;
  /** Remove this connection's records with these keys. */
  remove(keys: readonly string[]): void;
  /** Drop the in-memory cache (tests, connection switch). */
  reset(): void;
}

/** The file-backed store, which can also write conditionally under the bundle lock. */
export interface ConditionalConnectionScopedBundleStore<T> extends ConnectionScopedBundleStore<T> {
  /**
   * `upsert`, but only when `precondition` holds for this connection's
   * records as read under the bundle lock; returns whether it wrote.
   */
  upsertIf(records: readonly T[], precondition: (own: readonly T[]) => boolean): boolean;
}

type Persisted<T> = T & { connectionIdentity?: string };

/**
 * True when the store file exists; false only for genuine absence (ENOENT,
 * also a missing parent dir). Any other error (EACCES, ENOTDIR, …) throws:
 * an inaccessible store is not an empty one (`existsSync` would say false).
 */
function storeFileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function createConnectionScopedBundleStore<T extends object>(options: {
  fileName: string;
  label: string;
  maxEntries: number;
  keyOf: (record: T) => string;
}): ConditionalConnectionScopedBundleStore<T> {
  let cache: { key: string; value: T[] } | undefined;

  function readPersisted(path: string): Array<Persisted<T>> {
    const parsed = readBoundedBundleJson(path, options.fileName);
    if (!Array.isArray(parsed)) throw new Error(`${options.fileName} is not a JSON array.`);
    return parsed as Array<Persisted<T>>;
  }

  function ownRecord(record: Persisted<T>): boolean {
    return checkBundleRecordIdentity(record.connectionIdentity, options.label).accept;
  }

  function write(mutate: (existing: Array<Persisted<T>>) => Array<Persisted<T>> | null): boolean {
    const path = resolveBundleStorePath(options.fileName);
    if (!path) {
      throw new Error(`${options.label} require bundle storage; single-file EARVELDAJA_RULES_FILE mode is not supported.`);
    }
    const written = withBundleLock(dirname(path), () => {
      const next = mutate(storeFileExists(path) ? readPersisted(path) : []);
      if (next === null) return false;
      const serialized = JSON.stringify(next, null, 2);
      if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_INPUT_SIZE) {
        throw new Error(`${options.fileName} would exceed the maximum size of ${MAX_JSON_INPUT_SIZE} bytes; not written.`);
      }
      writePrivateFile(path, serialized);
      return true;
    });
    cache = undefined;
    return written;
  }

  function merge(existing: Array<Persisted<T>>, records: readonly T[]): Array<Persisted<T>> {
    const identity = getBundleRecordIdentity().stableIdentity;
    const incoming = new Map(records.map(record => [options.keyOf(record), record]));
    const kept = existing.filter(record => !(ownRecord(record) && incoming.has(options.keyOf(record))));
    const merged = [...kept, ...[...incoming.values()].map(record => ({ ...record, connectionIdentity: identity }))];
    return merged.slice(Math.max(0, merged.length - options.maxEntries));
  }

  function strip(existing: Array<Persisted<T>>): T[] {
    return existing.filter(ownRecord).map(({ connectionIdentity: _identity, ...record }) => record as T);
  }

  return {
    read() {
      const path = resolveBundleStorePath(options.fileName);
      if (!path) return null;
      const key = `${path}\n${getBundleRecordIdentity().stableIdentity}`;
      if (cache && cache.key === key) return cache.value;
      const value = storeFileExists(path) ? strip(readPersisted(path)) : [];
      cache = { key, value };
      return value;
    },
    upsert(records) {
      write(existing => merge(existing, records));
    },
    upsertIf(records, precondition) {
      return write(existing => (precondition(strip(existing)) ? merge(existing, records) : null));
    },
    remove(keys) {
      const drop = new Set(keys);
      write(existing => existing.filter(record => !(ownRecord(record) && drop.has(options.keyOf(record)))));
    },
    reset() {
      cache = undefined;
    },
  };
}
