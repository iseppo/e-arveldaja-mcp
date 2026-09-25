import { existsSync } from "fs";
import { dirname } from "path";
import {
  checkBundleRecordIdentity,
  getBundleRecordIdentity,
  readBoundedBundleJson,
  resolveStatementBalanceStorePath,
  withBundleLock,
} from "./accounting-rules.js";
import { writePrivateFile } from "./config.js";
import { MAX_JSON_INPUT_SIZE } from "./tools/crud/shared.js";

export interface StatementBalanceRecord {
  dimensionId: number;
  date: string;
  closingBalance: number;
  currency: string;
  source: "camt" | "wise";
  recordedAt: string;
}

/**
 * On-disk shape: every record is stamped with the connection fingerprint it
 * was captured for, because the bundle (and so this file) can be shared by
 * several connections. Legacy records carry no identity.
 */
type PersistedStatementBalanceRecord = StatementBalanceRecord & { connectionIdentity?: string };

const LABEL = "statement closing balances (statement-balances.json)";

// Mirrors opening-balance-store's cache/null/bundle-lock contracts. `null`
// signals the feature is unavailable (single-file EARVELDAJA_RULES_FILE mode);
// in bundle mode an absent log reads as an empty history (`[]`).
let cache: { key: string; value: StatementBalanceRecord[] | null; warning: string | null } | undefined;
let lastIdentityWarning: string | null = null;

export function resetStatementBalanceCache(): void { cache = undefined; lastIdentityWarning = null; }

/**
 * Warning from the most recent `readStatementBalances()` when records were
 * dropped because they belong to another connection (or are legacy records
 * that cannot be attributed on a multi-connection server).
 */
export function getStatementBalanceIdentityWarning(): string | null {
  return lastIdentityWarning;
}

function readPersisted(path: string): PersistedStatementBalanceRecord[] {
  const parsed = readBoundedBundleJson(path, "statement-balances.json");
  if (!Array.isArray(parsed)) throw new Error("statement-balances.json is not a JSON array.");
  return parsed as PersistedStatementBalanceRecord[];
}

export function readStatementBalances(): StatementBalanceRecord[] | null {
  const path = resolveStatementBalanceStorePath();
  if (!path) { lastIdentityWarning = null; return null; } // single-file mode: persistence unavailable
  const key = `${path}\n${getBundleRecordIdentity().stableIdentity}`;
  if (cache && cache.key === key) { lastIdentityWarning = cache.warning; return cache.value; }
  if (!existsSync(path)) { cache = { key, value: [], warning: null }; lastIdentityWarning = null; return []; }
  let persisted: PersistedStatementBalanceRecord[];
  try {
    persisted = readPersisted(path);
  } catch (error) {
    throw new Error(`Could not read statement-balances.json (${path}): ${(error as Error).message}`);
  }
  let warning: string | null = null;
  const value: StatementBalanceRecord[] = [];
  for (const { connectionIdentity, ...record } of persisted) {
    const verdict = checkBundleRecordIdentity(connectionIdentity, LABEL);
    if (verdict.accept) value.push(record);
    else warning ??= verdict.warning;
  }
  cache = { key, value, warning };
  lastIdentityWarning = warning;
  return value;
}

export function appendStatementBalance(record: StatementBalanceRecord): void {
  const path = resolveStatementBalanceStorePath();
  if (!path) {
    throw new Error(
      "Statement balances require bundle storage; single-file EARVELDAJA_RULES_FILE mode is not supported. " +
      "Use EARVELDAJA_RULES_DIR (the default) instead.",
    );
  }
  const stamped: PersistedStatementBalanceRecord = {
    ...record,
    connectionIdentity: getBundleRecordIdentity().stableIdentity,
  };
  withBundleLock(dirname(path), () => {
    const existing = existsSync(path) ? readPersisted(path) : [];
    existing.push(stamped);
    const serialized = JSON.stringify(existing, null, 2);
    if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_INPUT_SIZE) {
      throw new Error(`statement-balances.json would exceed the maximum size of ${MAX_JSON_INPUT_SIZE} bytes; not written.`);
    }
    // Atomic 0600 temp+rename (0700 parent) — never a torn or world-readable file.
    writePrivateFile(path, serialized);
  });
  cache = undefined;                            // force a reload on the next read
}
