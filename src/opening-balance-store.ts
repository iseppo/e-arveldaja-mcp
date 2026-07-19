import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { resolveOpeningBalanceStorePath, withBundleLock } from "./accounting-rules.js";
import type { ParsedOpeningBalances } from "./opening-balance-parse.js";

export interface StoredOpeningBalances extends ParsedOpeningBalances {
  parsedAt: string;
  source: "algbilanss_paste";
}

let cache: { path: string; value: StoredOpeningBalances | null } | undefined;

export function resetOpeningBalanceCache(): void { cache = undefined; }

export function readOpeningBalances(): StoredOpeningBalances | null {
  const path = resolveOpeningBalanceStorePath();
  if (!path) return null;                       // single-file mode: feature unavailable, treat as not captured
  if (cache && cache.path === path) return cache.value;
  if (!existsSync(path)) { cache = { path, value: null }; return null; }
  let value: StoredOpeningBalances | null;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as StoredOpeningBalances;
  } catch (error) {
    throw new Error(`Could not read opening-balances.json (${path}): ${(error as Error).message}`);
  }
  cache = { path, value };
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
  const stored: StoredOpeningBalances = { ...parsed, parsedAt: now, source: "algbilanss_paste" };
  const dir = dirname(path);
  withBundleLock(dir, () => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(stored, null, 2), "utf8");
  });
  cache = { path, value: stored };
  return stored;
}
