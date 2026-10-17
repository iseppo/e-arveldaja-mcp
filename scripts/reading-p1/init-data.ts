// Creates the private data directory (step 4): the sentinel, the corpus manifest with sha256,
// and own.json from the legacy verify.py COMPANY table. Never overwrites an existing sentinel.
// Usage: npx tsx scripts/reading-p1/init-data.ts

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, LEGACY_DIR, dataPath, readLines, sha256Hex, writeJson, writePrivate } from "./common.js";

export interface OwnIds { reg: string | null; vat: string | null; name?: string }

function pyDict(literal: string, comment?: string): OwnIds {
  const ids = JSON.parse(literal.replace(/\bNone\b/g, "null")) as OwnIds;
  const name = comment?.trim();
  return name ? { ...ids, name } : ids;
}

/** Parses the COMPANY table of the legacy verify.py (default, `for i in (...)` blocks, single entries). */
export function parseLegacyCompanyTable(source: string): Map<number, OwnIds> {
  const constants = new Map<string, OwnIds>();
  for (const match of source.matchAll(/^([A-Z_]+) = (\{"[^}\n]*\})/gm)) constants.set(match[1]!, pyDict(match[2]!));
  const table = new Map<number, OwnIds>();
  const base = /^COMPANY = \{i: ([A-Z_]+) for i in range\(1, (\d+)\)\}/m.exec(source);
  if (!base) throw new Error("verify.py: no default COMPANY table");
  const fallback = constants.get(base[1]!);
  if (!fallback) throw new Error("verify.py: default company constant missing");
  for (let i = 1; i < Number(base[2]); i++) table.set(i, fallback);
  for (const match of source.matchAll(/^for i in \(([\d, ]+)\):\s*\n\s+COMPANY\[i\] = (\{[^}\n]*\})[ \t]*(?:#(.*))?$/gm)) {
    for (const i of match[1]!.split(",").map((part) => Number(part.trim()))) table.set(i, pyDict(match[2]!, match[3]));
  }
  for (const match of source.matchAll(/^COMPANY\[(\d+)\] = (\{[^}\n]*\})[ \t]*(?:#(.*))?$/gm)) table.set(Number(match[1]), pyDict(match[2]!, match[3]));
  return table;
}

function main(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  for (const sub of ["corpus", "heldout", "packets", "snapshots", "readings", "mutations", "results", "reports", "leakage", "staging"]) {
    mkdirSync(join(DATA_DIR, sub), { recursive: true, mode: 0o700 });
  }
  const sentinelPath = dataPath("SENTINEL.txt");
  if (!existsSync(sentinelPath)) writePrivate(sentinelPath, `${randomBytes(16).toString("hex")}\n`);

  const files = readLines(join(LEGACY_DIR, "files.txt"));
  writePrivate(dataPath("corpus", "files.txt"), `${files.join("\n")}\n`);
  writePrivate(dataPath("corpus", "sha256.txt"), files.map((path) => `${sha256Hex(readFileSync(path))}  ${path}`).join("\n") + "\n");

  const table = parseLegacyCompanyTable(readFileSync(join(LEGACY_DIR, "verify.py"), "utf8"));
  const own: Record<string, OwnIds> = {};
  files.forEach((_, index) => {
    const entry = table.get(index + 1);
    if (!entry) throw new Error(`verify.py COMPANY has no entry for document ${index + 1}`);
    own[String(index + 1).padStart(2, "0")] = entry;
  });
  writeJson(dataPath("corpus", "own.json"), own);
  process.stdout.write(`corpus: ${files.length} files, own.json ${Object.keys(own).length} entries, ${new Set(Object.values(own).map((o) => o.reg ?? o.vat)).size} companies\n`);
}

main();
