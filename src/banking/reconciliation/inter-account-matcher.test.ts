import { describe, it, expect } from "vitest";
import type { Journal, Transaction } from "../../types/api.js";
import { buildCamtDescriptionWithMetadata } from "../../camt/duplicate-identity.js";
import {
  counterpartyIbanOf,
  hasUnverifiableCamtMarker,
  inferOneSidedTransfer,
  journalEurNetCents,
  type InterAccountMatchLookups,
} from "./inter-account-matcher.js";

const WISE_IBAN = "BE08905767222113";

/** A PROJECT row as MCP-CAMT stores it: bank_account_no null, the IBAN only in the signed marker. */
function camtRow(id: number, overrides: { iban?: string; name?: string; amount?: number; date?: string; dim?: number } = {}): Transaction {
  const amount = overrides.amount ?? 600;
  const date = overrides.date ?? "2026-09-26";
  const name = overrides.name ?? "Näide OU";
  const description = buildCamtDescriptionWithMetadata("Näide OU", {
    date, amount, currency: "EUR", direction: "DBIT",
    counterparty_name: name, counterparty_iban: overrides.iban ?? WISE_IBAN, bank_reference: `REF${id}`,
    description: "Näide OU",
  });
  return {
    id, status: "PROJECT", is_deleted: false, type: "C", amount, cl_currencies_id: "EUR", date,
    accounts_dimensions_id: overrides.dim ?? 100, bank_account_name: name, bank_account_no: null,
    bank_ref_number: null, description,
  } as unknown as Transaction;
}

/** Flip one hex character of the marker's sig, keeping it syntactically valid. */
function tamperSig(tx: Transaction): Transaction {
  const description = (tx.description ?? "").replace(/sig=([a-f0-9])/, (_m, c: string) => `sig=${c === "0" ? "1" : "0"}`);
  return { ...tx, description };
}

function lookups(dims: Array<[number, string]>, target?: number): InterAccountMatchLookups {
  const ownIbanToDimension = new Map<string, Set<number>>();
  const dimensionToIban = new Map<number, string>();
  for (const [dim, iban] of dims) {
    dimensionToIban.set(dim, iban);
    const set = ownIbanToDimension.get(iban) ?? new Set<number>();
    set.add(dim);
    ownIbanToDimension.set(iban, set);
  }
  return { ownIbanToDimension, dimensionToIban, companyName: "naide", companyLegalName: "Näide OÜ", targetAccountsDimensionsId: target };
}

const THREE_ACCOUNTS: Array<[number, string]> = [[100, "EE123456789012345678"], [300, WISE_IBAN], [400, "EE999999999999999999"]];

describe("counterpartyIbanOf", () => {
  it("prefers the direct bank_account_no", () => {
    const tx = { ...camtRow(1), bank_account_no: " ee123456789012345678 " } as Transaction;
    expect(counterpartyIbanOf(tx)).toBe("EE123456789012345678");
  });

  it("strips grouping spaces so a printed IBAN matches the own-account key", () => {
    const tx = { ...camtRow(1), bank_account_no: "EE12 3456 7890 1234 5678" } as Transaction;
    expect(counterpartyIbanOf(tx)).toBe("EE123456789012345678");
  });

  it("uses a checksum-verified CAMT marker IBAN when bank_account_no is empty", () => {
    expect(counterpartyIbanOf(camtRow(1))).toBe(WISE_IBAN);
  });

  it("ignores a marker IBAN whose sig fails the checksum", () => {
    expect(counterpartyIbanOf(tamperSig(camtRow(1)))).toBe("");
  });
});

describe("hasUnverifiableCamtMarker", () => {
  it("is false for a verified marker, true for a tampered sig, false for a marker without sig", () => {
    expect(hasUnverifiableCamtMarker(camtRow(1))).toBe(false);
    expect(hasUnverifiableCamtMarker(tamperSig(camtRow(1)))).toBe(true);
    const unsigned = { ...camtRow(1), description: `Näide OU\n[e-arveldaja-mcp:camt br=REF1 iban=${WISE_IBAN} dir=DBIT]` } as Transaction;
    expect(hasUnverifiableCamtMarker(unsigned)).toBe(false);
    expect(hasUnverifiableCamtMarker({ ...camtRow(1), description: "plain" } as Transaction)).toBe(false);
  });
});

describe("inferOneSidedTransfer with a CAMT marker IBAN", () => {
  it("targets the marker IBAN's own account among three accounts", () => {
    const inference = inferOneSidedTransfer(camtRow(1), lookups(THREE_ACCOUNTS), new Map());
    expect(inference.targetDimension).toBe(300);
    expect(inference.reasons).toContain("counterparty_iban_is_own_account");
  });

  it("does not use the IBAN of a tampered marker", () => {
    const inference = inferOneSidedTransfer(tamperSig(camtRow(1)), lookups(THREE_ACCOUNTS), new Map());
    expect(inference.reasons).not.toContain("counterparty_iban_is_own_account");
    expect(inference.targetDimension).toBeUndefined();
  });
});

describe("journalEurNetCents", () => {
  const journal = (postings: unknown[], cur?: string) => ({ id: 1, cl_currencies_id: cur, postings } as unknown as Journal);

  it("sums live postings on one dimension, debit positive, preferring base_amount", () => {
    const j = journal([
      { type: "D", amount: 100, accounts_dimensions_id: 5 },
      { type: "C", amount: 30.1, accounts_dimensions_id: 5 },
      { type: "D", amount: 7, base_amount: 6.5, accounts_dimensions_id: 5 },
      { type: "D", amount: 99, is_deleted: true, accounts_dimensions_id: 5 },
      { type: "C", amount: 100, accounts_dimensions_id: 6 },
    ]);
    expect(journalEurNetCents(j, 5)).toBe(10000 - 3010 + 650);
    expect(journalEurNetCents(j, 6)).toBe(-10000);
    expect(journalEurNetCents(j, 7)).toBe(0);
  });

  it("is undefined when a live foreign posting has no EUR base amount", () => {
    expect(journalEurNetCents(journal([{ type: "D", amount: 10, cl_currencies_id: "USD", accounts_dimensions_id: 5 }]), 5)).toBeUndefined();
    expect(journalEurNetCents(journal([{ type: "D", amount: 10, accounts_dimensions_id: 5 }], "USD"), 5)).toBeUndefined();
    expect(journalEurNetCents(journal([{ type: "D", amount: 10, base_amount: 9, cl_currencies_id: "USD", accounts_dimensions_id: 5 }]), 5)).toBe(900);
  });
});
