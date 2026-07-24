import { describe, expect, it } from "vitest";
import type { AccountDimension, BankAccount } from "../types/api.js";
import {
  buildBankDimensionCandidates,
  pickSingleCandidateByIban,
  pickSingleCandidateByPattern,
  resolveBankAccount,
  resolveBankAccountSync,
  type BankDimensionCandidate,
  type SavedBankDefaultPointer,
  type SavedBankDefaultPort,
} from "./bank-account-resolution.js";

function candidate(overrides: Partial<BankDimensionCandidate> & { accounts_dimensions_id: number }): BankDimensionCandidate {
  return {
    label: overrides.label ?? `Dimension ${overrides.accounts_dimensions_id}`,
    match_reason: overrides.match_reason ?? "Linked bank account dimension",
    ...overrides,
  };
}

describe("buildBankDimensionCandidates (moved pure fn)", () => {
  it("maps linked bank accounts to candidates, preferring account name then dimension title", () => {
    const bankAccounts: BankAccount[] = [
      { account_name_est: "LHV põhikonto", account_no: "EE00", iban_code: "EE001", accounts_dimensions_id: 101 },
      { account_name_est: "", account_no: "EE02", bank_name: "SEB", accounts_dimensions_id: 102 },
    ];
    const dims: AccountDimension[] = [
      { id: 101, accounts_id: 1020, title_est: "LHV" },
      { id: 102, accounts_id: 1020, title_est: "SEB dim" },
    ];
    const candidates = buildBankDimensionCandidates(bankAccounts, dims);
    expect(candidates).toEqual([
      { accounts_dimensions_id: 101, label: "LHV põhikonto", iban: "EE001", match_reason: 'Linked bank account + dimension title "LHV"' },
      { accounts_dimensions_id: 102, label: "SEB", iban: "EE02", match_reason: 'Linked bank account + dimension title "SEB dim"' },
    ]);
  });

  it("skips deleted dimensions and de-dupes by accounts_dimensions_id keeping first", () => {
    const bankAccounts: BankAccount[] = [
      { account_name_est: "First", account_no: "EE10", accounts_dimensions_id: 200 },
      { account_name_est: "Dup", account_no: "EE11", accounts_dimensions_id: 200 },
      { account_name_est: "NoDim", account_no: "EE12" } as BankAccount,
    ];
    const dims: AccountDimension[] = [{ id: 200, accounts_id: 1020, title_est: "x", is_deleted: true }];
    const candidates = buildBankDimensionCandidates(bankAccounts, dims);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.accounts_dimensions_id).toBe(200);
    expect(candidates[0]!.label).toBe("First");
    // deleted dimension not indexed → falls back to generic match reason
    expect(candidates[0]!.match_reason).toBe("Linked bank account dimension");
  });
});

describe("pickSingleCandidateByPattern / pickSingleCandidateByIban (moved pure fns)", () => {
  const candidates = [
    candidate({ accounts_dimensions_id: 101, label: "LHV", iban: "EE637700771011212909" }),
    candidate({ accounts_dimensions_id: 202, label: "Wise konto", iban: "BE62510007547061" }),
  ];

  it("pattern picks only when exactly one matches", () => {
    expect(pickSingleCandidateByPattern(candidates, /\bwise\b/i)?.accounts_dimensions_id).toBe(202);
    expect(pickSingleCandidateByPattern(candidates, /konto|LHV/i)).toBeUndefined(); // two match → undefined
    expect(pickSingleCandidateByPattern(candidates, /nomatch/i)).toBeUndefined();
  });

  it("iban picks only when exactly one normalized iban matches", () => {
    expect(pickSingleCandidateByIban(candidates, "ee63 7700 7710 1121 2909")?.accounts_dimensions_id).toBe(101);
    expect(pickSingleCandidateByIban(candidates, undefined)).toBeUndefined();
    expect(pickSingleCandidateByIban(candidates, "EE000000")).toBeUndefined();
  });
});

describe("resolveBankAccountSync — graceful degradation (inbox path: no new inputs)", () => {
  const local = [
    candidate({ accounts_dimensions_id: 101, label: "LHV", iban: "EE637700771011212909" }),
    candidate({ accounts_dimensions_id: 102, label: "SEB", iban: "EE381010220123456789" }),
  ];

  it("rung 1: explicit override always wins and is 'resolved' with override evidence", () => {
    const r = resolveBankAccountSync({ candidates: local, override: 999 });
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.value).toBe(999);
      expect(r.evidence.map(e => e.tag)).toContain("override");
    }
  });

  it("rung 2: unique statement IBAN resolves even with multiple candidates", () => {
    const r = resolveBankAccountSync({ candidates: local, statementIban: "EE637700771011212909" });
    expect(r).toMatchObject({ status: "resolved", value: 101 });
  });

  it("rung 6: unique-by-count local bank resolves when exactly one candidate", () => {
    const r = resolveBankAccountSync({ candidates: [local[0]!] });
    expect(r).toMatchObject({ status: "resolved", value: 101 });
    if (r.status === "resolved") expect(r.evidence.map(e => e.tag)).toContain("unique_local_bank");
  });

  it("ambiguous: 2+ candidates, no unique key, no override/iban", () => {
    const r = resolveBankAccountSync({ candidates: local });
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") {
      expect(r.choices).toHaveLength(2);
      expect(typeof r.question).toBe("string");
    }
  });

  it("not_found: zero candidates", () => {
    const r = resolveBankAccountSync({ candidates: [] });
    expect(r.status).toBe("not_found");
  });

  it("stays dark to rung 3/4/5: no port/currency/history means unique-by-count still governs", () => {
    // Two candidates, no override, no iban, no currency/history/port → ambiguous.
    const r = resolveBankAccountSync({ candidates: local });
    expect(r.status).toBe("ambiguous");
  });
});

describe("resolveBankAccountSync — stricter rungs (pure-test only, never fed by inbox)", () => {
  const local = [
    candidate({ accounts_dimensions_id: 101, label: "LHV" }),
    candidate({ accounts_dimensions_id: 102, label: "SEB" }),
  ];

  it("rung 4: unique currency-validated candidate resolves before unique-by-count", () => {
    const r = resolveBankAccountSync({
      candidates: local,
      statementCurrency: "EUR",
      currencyValidatedCandidates: [
        { accounts_dimensions_id: 101, currency: "EUR" },
        { accounts_dimensions_id: 102, currency: "USD" },
      ],
    });
    expect(r).toMatchObject({ status: "resolved", value: 101 });
    if (r.status === "resolved") expect(r.evidence.map(e => e.tag)).toContain("validated_currency_account");
  });

  it("rung 4: currency match tie does NOT silently pick — falls through to ambiguous", () => {
    const r = resolveBankAccountSync({
      candidates: local,
      statementCurrency: "EUR",
      currencyValidatedCandidates: [
        { accounts_dimensions_id: 101, currency: "EUR" },
        { accounts_dimensions_id: 102, currency: "EUR" },
      ],
    });
    expect(r.status).toBe("ambiguous");
  });

  it("rung 5: unique confirmed-history dimension resolves", () => {
    const r = resolveBankAccountSync({
      candidates: local,
      confirmedHistory: [{ accounts_dimensions_id: 102 }, { accounts_dimensions_id: 102 }],
    });
    expect(r).toMatchObject({ status: "resolved", value: 102 });
    if (r.status === "resolved") expect(r.evidence.map(e => e.tag)).toContain("confirmed_history");
  });

  it("rung 5: tied confirmed history does not tie-break", () => {
    const r = resolveBankAccountSync({
      candidates: local,
      confirmedHistory: [{ accounts_dimensions_id: 101 }, { accounts_dimensions_id: 102 }],
    });
    expect(r.status).toBe("ambiguous");
  });
});

describe("resolveBankAccount (async) — injected SavedBankDefaultPort re-verification", () => {
  const local = [
    candidate({ accounts_dimensions_id: 101, label: "LHV" }),
    candidate({ accounts_dimensions_id: 102, label: "SEB" }),
  ];
  const dims: AccountDimension[] = [
    { id: 101, accounts_id: 1020, title_est: "LHV" },
    { id: 102, accounts_id: 1020, title_est: "SEB" },
  ];
  const makePort = (stored: SavedBankDefaultPointer | undefined): SavedBankDefaultPort => ({
    async readSavedBankDefault() {
      return stored;
    },
  });
  const base = {
    candidates: local,
    accountDimensions: dims,
    currentConnectionId: "conn-A",
    expectedLedgerAccountId: 1020,
  };

  it("uses a saved default only after active + connection + ledger + currency re-verification", async () => {
    const port = makePort({ accounts_dimensions_id: 102, connectionId: "conn-A", ledgerAccountId: 1020, currency: "EUR" });
    const r = await resolveBankAccount({ ...base, statementCurrency: "EUR", savedDefaultPort: port });
    expect(r).toMatchObject({ status: "resolved", value: 102 });
    if (r.status === "resolved") expect(r.evidence.map(e => e.tag)).toContain("saved_default");
  });

  it("discards a saved default for the wrong connection", async () => {
    const port = makePort({ accounts_dimensions_id: 102, connectionId: "conn-OTHER", ledgerAccountId: 1020 });
    const r = await resolveBankAccount({ ...base, savedDefaultPort: port });
    // 2 candidates, no other rung → ambiguous, NOT the stale pointer.
    expect(r.status).toBe("ambiguous");
  });

  it("discards a saved default whose dimension is not active in the current chart", async () => {
    const port = makePort({ accounts_dimensions_id: 999, connectionId: "conn-A", ledgerAccountId: 1020 });
    const r = await resolveBankAccount({ ...base, savedDefaultPort: port });
    expect(r.status).toBe("ambiguous");
  });

  it("discards a saved default bound to the wrong ledger account", async () => {
    const port = makePort({ accounts_dimensions_id: 102, connectionId: "conn-A", ledgerAccountId: 5555 });
    const r = await resolveBankAccount({ ...base, savedDefaultPort: port });
    expect(r.status).toBe("ambiguous");
  });

  it("discards a saved default whose currency does not match the statement currency", async () => {
    const port = makePort({ accounts_dimensions_id: 102, connectionId: "conn-A", ledgerAccountId: 1020, currency: "USD" });
    const r = await resolveBankAccount({ ...base, statementCurrency: "EUR", savedDefaultPort: port });
    expect(r.status).toBe("ambiguous");
  });

  it("FAIL-CLOSED: discards a currency-less saved default against a currency-carrying statement", async () => {
    // F-SAVED-DEFAULT-CURRENCY-FAILCLOSED: an undefined pointer.currency must NOT
    // pass a USD statement (previously fail-OPEN → same-connection wrong-currency book).
    const port = makePort({ accounts_dimensions_id: 102, connectionId: "conn-A", ledgerAccountId: 1020 });
    const r = await resolveBankAccount({ ...base, statementCurrency: "USD", savedDefaultPort: port });
    expect(r.status).toBe("ambiguous"); // rung 3 rejected, falls through, NOT resolved
  });

  it("still resolves a currency-less saved default when the statement carries NO currency", async () => {
    const port = makePort({ accounts_dimensions_id: 102, connectionId: "conn-A", ledgerAccountId: 1020 });
    const r = await resolveBankAccount({ ...base, savedDefaultPort: port });
    expect(r).toMatchObject({ status: "resolved", value: 102 });
  });

  it("override and unique IBAN outrank the saved default", async () => {
    const port = makePort({ accounts_dimensions_id: 102, connectionId: "conn-A", ledgerAccountId: 1020 });
    const overrideR = await resolveBankAccount({ ...base, override: 101, savedDefaultPort: port });
    expect(overrideR).toMatchObject({ status: "resolved", value: 101 });
    if (overrideR.status === "resolved") expect(overrideR.evidence.map(e => e.tag)).toContain("override");
  });

  it("async resolver with no port behaves exactly like the sync core", async () => {
    const asyncR = await resolveBankAccount({ candidates: [local[0]!] });
    const syncR = resolveBankAccountSync({ candidates: [local[0]!] });
    expect(asyncR).toEqual(syncR);
  });
});
