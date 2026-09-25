import { existsSync } from "fs";
import { dirname } from "path";
import {
  checkBundleRecordIdentity,
  getBundleRecordIdentity,
  readBoundedBundleJson,
  resolveOpeningBalanceStorePath,
  withBundleLock,
} from "./accounting-rules.js";
import { writePrivateFile } from "./config.js";
import { MAX_JSON_INPUT_SIZE } from "./tools/crud/shared.js";
import type { ParsedOpeningBalances } from "./opening-balance-parse.js";

export interface StoredOpeningBalances extends ParsedOpeningBalances {
  parsedAt: string;
  source: "algbilanss_paste";
  /**
   * Connection fingerprint of the company the balances were captured for. The
   * bundle can be shared by several connections, so a read refuses a record
   * stamped for another connection. Absent on legacy (pre-identity) records.
   */
  connectionIdentity?: string;
}

const LABEL = "opening balances (opening-balances.json)";

let cache: { key: string; value: StoredOpeningBalances | null; warning: string | null } | undefined;
let lastIdentityWarning: string | null = null;

export function resetOpeningBalanceCache(): void { cache = undefined; lastIdentityWarning = null; }

/**
 * Warning from the most recent `readOpeningBalances()` when a stored record
 * was ignored because it belongs to another connection (or is a legacy record
 * that cannot be attributed on a multi-connection server). Surfaced by
 * `withOpeningBalanceStatus` next to the "not captured" prompt.
 */
export function getOpeningBalanceIdentityWarning(): string | null {
  return lastIdentityWarning;
}

export function readOpeningBalances(): StoredOpeningBalances | null {
  const path = resolveOpeningBalanceStorePath();
  if (!path) { lastIdentityWarning = null; return null; } // single-file mode: feature unavailable
  const key = `${path}\n${getBundleRecordIdentity().stableIdentity}`;
  if (cache && cache.key === key) { lastIdentityWarning = cache.warning; return cache.value; }
  if (!existsSync(path)) { cache = { key, value: null, warning: null }; lastIdentityWarning = null; return null; }
  let value: StoredOpeningBalances | null;
  try {
    value = readBoundedBundleJson(path, "opening-balances.json") as StoredOpeningBalances;
  } catch (error) {
    throw new Error(`Could not read opening-balances.json (${path}): ${(error as Error).message}`);
  }
  let warning: string | null = null;
  const verdict = checkBundleRecordIdentity(value?.connectionIdentity, LABEL);
  if (!verdict.accept) {
    warning = verdict.warning;
    value = null;
  }
  cache = { key, value, warning };
  lastIdentityWarning = warning;
  return value;
}

export function writeOpeningBalances(parsed: ParsedOpeningBalances, now: string): StoredOpeningBalances {
  const path = resolveOpeningBalanceStorePath();
  if (!path) {
    throw new Error(
      "Opening balances require bundle storage; single-file EARVELDAJA_RULES_FILE mode is not supported. " +
      "Use EARVELDAJA_RULES_DIR (the default) instead.",
    );
  }
  const { stableIdentity } = getBundleRecordIdentity();
  const stored: StoredOpeningBalances = {
    ...parsed,
    parsedAt: now,
    source: "algbilanss_paste",
    connectionIdentity: stableIdentity,
  };
  const serialized = JSON.stringify(stored, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_INPUT_SIZE) {
    throw new Error(`opening-balances.json would exceed the maximum size of ${MAX_JSON_INPUT_SIZE} bytes; not written.`);
  }
  withBundleLock(dirname(path), () => {
    // Atomic 0600 temp+rename (0700 parent) — never a torn or world-readable file.
    writePrivateFile(path, serialized);
  });
  cache = { key: `${path}\n${stableIdentity}`, value: stored, warning: null };
  lastIdentityWarning = null;
  return stored;
}
