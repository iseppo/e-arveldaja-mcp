import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { resolveStatementBalanceStorePath, withBundleLock } from "./accounting-rules.js";

export interface StatementBalanceRecord {
  dimensionId: number;
  date: string;
  closingBalance: number;
  currency: string;
  source: "camt" | "wise";
  recordedAt: string;
}

// Mirrors opening-balance-store's cache/null/bundle-lock contracts. `null`
// signals the feature is unavailable (single-file EARVELDAJA_RULES_FILE mode);
// in bundle mode an absent log reads as an empty history (`[]`).
let cache: { path: string; value: StatementBalanceRecord[] | null } | undefined;

export function resetStatementBalanceCache(): void { cache = undefined; }

export function readStatementBalances(): StatementBalanceRecord[] | null {
  const path = resolveStatementBalanceStorePath();
  if (!path) return null;                       // single-file mode: persistence unavailable
  if (cache && cache.path === path) return cache.value;
  if (!existsSync(path)) { cache = { path, value: [] }; return []; }
  let value: StatementBalanceRecord[];
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as StatementBalanceRecord[];
  } catch (error) {
    throw new Error(`Could not read statement-balances.json (${path}): ${(error as Error).message}`);
  }
  cache = { path, value };
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
  const dir = dirname(path);
  withBundleLock(dir, () => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const existing: StatementBalanceRecord[] = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8")) as StatementBalanceRecord[]
      : [];
    existing.push(record);
    writeFileSync(path, JSON.stringify(existing, null, 2), "utf8");
  });
  cache = undefined;                            // force a reload on the next read
}
