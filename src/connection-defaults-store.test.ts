import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONNECTION_DEFAULTS_MAX_ENTRIES,
  createConnectionDefaultsStore,
} from "./connection-defaults-store.js";
import { resolveBankAccount, type BankDimensionCandidate } from "./resolution/bank-account-resolution.js";
import type { AccountDimension } from "./types/api.js";

const tempDirs: string[] = [];
function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "conn-defaults-"));
  tempDirs.push(dir);
  return join(dir, "connection-defaults.json");
}
afterEach(() => {
  while (tempDirs.length) {
    try { rmSync(tempDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const scope = { connectionId: "conn-A", environmentKind: "live" as const };
const bankEntry = {
  ...scope,
  accounts_dimensions_id: 102,
  ledgerAccountId: 1020,
  currency: "EUR",
  iban: "EE381010220123456789",
  input_type: "camt",
};

describe("connection-defaults-store — persistence + read", () => {
  it("round-trips a saved bank default keyed by connection + environment + ledger", () => {
    const path = tempStorePath();
    const store = createConnectionDefaultsStore(path);
    store.saveBankDefault(bankEntry);
    const pointer = store.readBankDefault({ ...scope, expectedLedgerAccountId: 1020 });
    expect(pointer).toMatchObject({
      accounts_dimensions_id: 102,
      connectionId: "conn-A",
      ledgerAccountId: 1020,
      currency: "EUR",
      iban: "EE381010220123456789",
    });
  });

  it("returns undefined for a different connection / environment / ledger", () => {
    const path = tempStorePath();
    const store = createConnectionDefaultsStore(path);
    store.saveBankDefault(bankEntry);
    expect(store.readBankDefault({ connectionId: "conn-OTHER", environmentKind: "live", expectedLedgerAccountId: 1020 })).toBeUndefined();
    expect(store.readBankDefault({ connectionId: "conn-A", environmentKind: "demo", expectedLedgerAccountId: 1020 })).toBeUndefined();
    expect(store.readBankDefault({ ...scope, expectedLedgerAccountId: 9999 })).toBeUndefined();
  });

  it("returns undefined when nothing is stored yet (no file)", () => {
    const store = createConnectionDefaultsStore(tempStorePath());
    expect(store.readBankDefault({ ...scope, expectedLedgerAccountId: 1020 })).toBeUndefined();
  });

  it("upserts (replaces) an existing bank default for the same key", () => {
    const path = tempStorePath();
    const store = createConnectionDefaultsStore(path);
    store.saveBankDefault(bankEntry);
    store.saveBankDefault({ ...bankEntry, accounts_dimensions_id: 103 });
    const pointer = store.readBankDefault({ ...scope, expectedLedgerAccountId: 1020 });
    expect(pointer?.accounts_dimensions_id).toBe(103);
  });
});

describe("connection-defaults-store — SECURITY", () => {
  it("writes the store file with 0600 permissions", () => {
    const path = tempStorePath();
    createConnectionDefaultsStore(path).saveBankDefault(bankEntry);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("rejects (ignores) a symlinked store target on read", () => {
    const realPath = tempStorePath();
    const store = createConnectionDefaultsStore(realPath);
    store.saveBankDefault(bankEntry);
    // Point a NEW path at the real file via symlink; the store must refuse to read it.
    const linkPath = `${realPath}.link`;
    symlinkSync(realPath, linkPath);
    const linkedStore = createConnectionDefaultsStore(linkPath);
    expect(linkedStore.readBankDefault({ ...scope, expectedLedgerAccountId: 1020 })).toBeUndefined();
  });

  it("ignores an oversized store file on read (size-bound)", () => {
    const path = tempStorePath();
    // > MAX_JSON_INPUT_SIZE (1 MiB) of valid-looking JSON padding.
    const huge = JSON.stringify({ version: 1, entries: [], pad: "x".repeat(1024 * 1024 + 16) });
    writeFileSync(path, huge, { mode: 0o600 });
    const store = createConnectionDefaultsStore(path);
    expect(store.readBankDefault({ ...scope, expectedLedgerAccountId: 1020 })).toBeUndefined();
  });

  it("REJECTS persisting a currency-less bank default (fail-closed persist side)", () => {
    const store = createConnectionDefaultsStore(tempStorePath());
    expect(() => store.saveBankDefault({ ...bankEntry, currency: "" as unknown as string })).toThrow(/currency/i);
    // @ts-expect-error deliberately omitting currency
    expect(() => store.saveBankDefault({ ...scope, accounts_dimensions_id: 1, ledgerAccountId: 1020 })).toThrow(/currency/i);
  });

  it("NEVER persists a secret field even if one is smuggled into the entry", () => {
    const path = tempStorePath();
    const store = createConnectionDefaultsStore(path);
    store.saveBankDefault({ ...bankEntry, apiKey: "SECRET", password: "hunter2" } as never);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("SECRET");
    expect(raw).not.toContain("hunter2");
  });

  it("caps stored entry count", () => {
    const path = tempStorePath();
    const store = createConnectionDefaultsStore(path);
    for (let i = 0; i < CONNECTION_DEFAULTS_MAX_ENTRIES + 25; i++) {
      store.saveBankDefault({ ...bankEntry, connectionId: `conn-${i}`, accounts_dimensions_id: 100 + i });
    }
    expect(store.entryCount()).toBeLessThanOrEqual(CONNECTION_DEFAULTS_MAX_ENTRIES);
  });
});

describe("connection-defaults-store — SavedBankDefaultPort adapter drives rung 3", () => {
  const candidate = (id: number, label: string): BankDimensionCandidate => ({
    accounts_dimensions_id: id, label, match_reason: "Linked bank account dimension",
  });
  const local = [candidate(101, "LHV"), candidate(102, "SEB")];
  const dims: AccountDimension[] = [
    { id: 101, accounts_id: 1020, title_est: "LHV" },
    { id: 102, accounts_id: 1020, title_est: "SEB" },
  ];

  it("a persisted+consented default resolves a later same-connection scan via rung 3 (saved_default)", async () => {
    const path = tempStorePath();
    const store = createConnectionDefaultsStore(path);
    // First scan: ambiguous, operator chose 102, consented → persisted.
    store.saveBankDefault(bankEntry);
    // Second scan same connection: rung 3 must resolve without a fresh question.
    const port = store.bankDefaultPort(scope);
    const r = await resolveBankAccount({
      candidates: local,
      accountDimensions: dims,
      currentConnectionId: "conn-A",
      expectedLedgerAccountId: 1020,
      statementCurrency: "EUR",
      savedDefaultPort: port,
    });
    expect(r).toMatchObject({ status: "resolved", value: 102 });
    if (r.status === "resolved") expect(r.evidence.map(e => e.tag)).toContain("saved_default");
  });

  it("the port yields a pointer only for the matching environment scope", async () => {
    const path = tempStorePath();
    const store = createConnectionDefaultsStore(path);
    store.saveBankDefault(bankEntry); // live
    const demoPort = store.bankDefaultPort({ connectionId: "conn-A", environmentKind: "demo" });
    const r = await resolveBankAccount({
      candidates: local,
      accountDimensions: dims,
      currentConnectionId: "conn-A",
      expectedLedgerAccountId: 1020,
      statementCurrency: "EUR",
      savedDefaultPort: demoPort,
    });
    expect(r.status).toBe("ambiguous"); // wrong environment → no hint
  });
});
