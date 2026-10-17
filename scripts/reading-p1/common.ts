// Shared paths and IO helpers of the offline P1 replay harness.
// Plan: .omc/plans/p1-reading-checker.md §5.1. Private data lives only under DATA_DIR (gitignored).

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPTS_DIR, "..", "..");
export const DATA_DIR = process.env.READING_P1_DATA_DIR ?? join(REPO_ROOT, ".omc", "research", "reading-p1-2026-10");
export const LEGACY_DIR = join(REPO_ROOT, ".omc", "research", "llm-reading-2026-10-16");

export type SetName = "corpus" | "heldout";

export function dataPath(...parts: string[]): string {
  return join(DATA_DIR, ...parts);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Private data files are written mode 0600 into directories created 0700. */
export function writePrivate(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function writeJson(path: string, value: unknown): void {
  writePrivate(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readLines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.trim() !== "");
}

export function sentinel(): string {
  const path = dataPath("SENTINEL.txt");
  if (!existsSync(path)) throw new Error("SENTINEL.txt missing: run init-data.ts first");
  const value = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{32}$/.test(value)) throw new Error("SENTINEL.txt is not a 32-hex token");
  return value;
}

export interface ManifestEntry { id: string; path: string; sha256: string }

/** files.txt + sha256.txt of a set, in manifest order. Ids are "01".. for the corpus, "h01".. held out. */
export function manifest(set: SetName): ManifestEntry[] {
  const files = readLines(dataPath(set, "files.txt"));
  const hashes = new Map(readLines(dataPath(set, "sha256.txt")).map((line) => {
    const [hash, ...rest] = line.split("  ");
    return [rest.join("  "), hash!] as const;
  }));
  return files.map((path, index) => {
    const hash = hashes.get(path);
    if (!hash) throw new Error(`no sha256 recorded for manifest entry ${index + 1}`);
    return { id: manifestId(set, index), path, sha256: hash };
  });
}

/** Throughput round B8: the only report/replay scope this round. Paths derive from the scope's manifest ids. */
export type Scope = "corpus";
export const SCOPES: readonly Scope[] = ["corpus"];

/** The document ids a scope may touch, from its own manifest only. */
export function scopeIds(scope: Scope): Set<string> {
  if (scope !== "corpus") throw new Error(`unknown scope ${String(scope)}`);
  return new Set(manifest("corpus").map((entry) => entry.id));
}

export function manifestId(set: SetName, index: number): string {
  const n = String(index + 1).padStart(2, "0");
  return set === "corpus" ? n : `h${n}`;
}

export function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const value = new Date(Date.UTC(y, m - 1, d + days));
  return value.toISOString().slice(0, 10);
}

export function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
