import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBankTransaction } from "./bank-transaction-create.js";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return entry.endsWith(".ts") && !entry.endsWith(".test.ts") ? [path] : [];
    });
}

describe("bank transaction create boundary", () => {
  it("creates CAMT CRDT Wise IN fee and direct bank rows only as C", () => {
    const sourceRoot = join(process.cwd(), "src");
    const rawCreateSites = sourceFiles(sourceRoot).flatMap((path) => {
      const matches = readFileSync(path, "utf8").match(/\.transactions\.create\s*\(/g) ?? [];
      return matches.map(() => relative(process.cwd(), path));
    });

    expect(rawCreateSites).toEqual(["src/bank-transaction-create.ts"]);
  });

  it("overwrites caller supplied transaction types at runtime", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 91 });
    const api = { transactions: { create } };

    await createBankTransaction(api, {
      accounts_dimensions_id: 7,
      type: "D",
      amount: 12.34,
      cl_currencies_id: "EUR",
      date: "2026-07-19",
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: "C" }));
    expect(create.mock.calls[0]![0]).not.toEqual(expect.objectContaining({ type: "D" }));
  });
});
