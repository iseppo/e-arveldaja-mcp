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
  it("routes every raw transactions.create through the single boundary", () => {
    const sourceRoot = join(process.cwd(), "src");
    const rawCreateSites = sourceFiles(sourceRoot).flatMap((path) => {
      const matches = readFileSync(path, "utf8").match(/\.transactions\.create\s*\(/g) ?? [];
      return matches.map(() => relative(process.cwd(), path));
    });

    expect(rawCreateSites).toEqual(["src/bank-transaction-create.ts"]);
  });

  it("books an explicit incoming direction as API type D (cash debited at confirm)", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 91 });
    const api = { transactions: { create } };

    await createBankTransaction(api, {
      accounts_dimensions_id: 7,
      amount: 12.34,
      cl_currencies_id: "EUR",
      date: "2026-07-19",
    }, "incoming");

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: "D" }));
  });

  it("books an explicit outgoing direction as API type C (cash credited at confirm)", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 92 });
    const api = { transactions: { create } };

    await createBankTransaction(api, {
      accounts_dimensions_id: 7,
      amount: 12.34,
      cl_currencies_id: "EUR",
      date: "2026-07-19",
    }, "outgoing");

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: "C" }));
  });

  it("derives incoming from a signed CAMT CRDT description when no explicit direction is given", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 93 });
    const api = { transactions: { create } };

    await createBankTransaction(api, {
      accounts_dimensions_id: 7,
      amount: 300,
      cl_currencies_id: "EUR",
      date: "2026-07-19",
      description: "omanikulaen\n[e-arveldaja-mcp:camt dir=CRDT sig=abc123abc123abcd]",
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: "D" }));
  });

  it("derives incoming from a signed Wise IN description when no explicit direction is given", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 94 });
    const api = { transactions: { create } };

    await createBankTransaction(api, {
      accounts_dimensions_id: 7,
      amount: 300,
      cl_currencies_id: "EUR",
      date: "2026-07-19",
      description: "WISE:123 Customer [source_direction=IN]",
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: "D" }));
  });

  it("falls back to the caller's legacy D/C type when direction is otherwise unknown", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 95 });
    const api = { transactions: { create } };

    await createBankTransaction(api, {
      accounts_dimensions_id: 7,
      type: "D",
      amount: 12.34,
      cl_currencies_id: "EUR",
      date: "2026-07-19",
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: "D" }));
  });

  it("defaults to C when there is no direction signal at all", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 96 });
    const api = { transactions: { create } };

    await createBankTransaction(api, {
      accounts_dimensions_id: 7,
      amount: 12.34,
      cl_currencies_id: "EUR",
      date: "2026-07-19",
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: "C" }));
  });
});
