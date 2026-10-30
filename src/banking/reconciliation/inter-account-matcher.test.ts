import { describe, it, expect } from "vitest";
import type { Journal, Transaction } from "../../types/api.js";
import { buildCamtDescriptionWithMetadata } from "../../camt/duplicate-identity.js";
import {
  counterpartyIbanOf,
  hasMirrorPostingEvidence,
  hasUnverifiableCamtMarker,
  inferOneSidedTransfer,
  journalEurNetCents,
  unverifiedMarkerTransferClaim,
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

function lookups(dims: Array<[number, string]>, target?: number, ownIbansWithoutDimension: string[] = []): InterAccountMatchLookups {
  const ownIbanToDimension = new Map<string, Set<number>>();
  const dimensionToIban = new Map<number, string>();
  for (const [dim, iban] of dims) {
    dimensionToIban.set(dim, iban);
    const set = ownIbanToDimension.get(iban) ?? new Set<number>();
    set.add(dim);
    ownIbanToDimension.set(iban, set);
  }
  return {
    ownIbanToDimension, dimensionToIban, ownIbansWithoutDimension: new Set(ownIbansWithoutDimension),
    companyName: "naide", companyLegalName: "Näide OÜ", targetAccountsDimensionsId: target,
  };
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

describe("inferOneSidedTransfer with an own IBAN that cannot be booked", () => {
  const TWO_ACCOUNTS: Array<[number, string]> = [[100, "EE123456789012345678"], [300, WISE_IBAN]];
  const EXTERNAL = "EE471000001020145685";
  /** A plain (non-CAMT) row paying `iban` under the company's own name. */
  function ownNameRow(iban: string | null): Transaction {
    return {
      id: 7, status: "PROJECT", is_deleted: false, type: "C", amount: 60, cl_currencies_id: "EUR", date: "2026-01-21",
      accounts_dimensions_id: 100, bank_account_name: "Näide OÜ", bank_account_no: iban,
    } as unknown as Transaction;
  }

  it("keeps the company-name fallback for an unregistered IBAN (a provider's pooled top-up IBAN looks like this)", () => {
    const inference = inferOneSidedTransfer(ownNameRow(EXTERNAL), lookups(TWO_ACCOUNTS), new Map());
    expect(inference.targetDimension).toBe(300);
    expect(inference.reasons).toContain("counterparty_iban_not_registered");
    expect(inference.unbookableOwnIban).toBeUndefined();
  });

  it("does not call the row's own source-account IBAN unregistered", () => {
    const inference = inferOneSidedTransfer(ownNameRow("EE123456789012345678"), lookups(TWO_ACCOUNTS), new Map());
    expect(inference.targetDimension).toBe(300);
    expect(inference.reasons).not.toContain("counterparty_iban_not_registered");
  });

  it("an unverifiable-marker claim on an own account without a dimension is still a claim (reported for review)", () => {
    const claim = unverifiedMarkerTransferClaim(ownNameRow(EXTERNAL), lookups(TWO_ACCOUNTS, undefined, [EXTERNAL]));
    expect(claim?.unbookableOwnIban).toBe(EXTERNAL);
  });

  it("still infers by name when the row has no counterparty IBAN", () => {
    const inference = inferOneSidedTransfer(ownNameRow(null), lookups(TWO_ACCOUNTS), new Map());
    expect(inference.targetDimension).toBe(300);
    expect(inference.reasons).toEqual(["counterparty_name_matches_company", "only_one_other_account"]);
    expect(inference.unbookableOwnIban).toBeUndefined();
  });

  it("holds a row paying an own account that has no dimension, whatever the name", () => {
    const row = { ...ownNameRow(EXTERNAL), bank_account_name: "Bank" } as Transaction;
    const inference = inferOneSidedTransfer(row, lookups(TWO_ACCOUNTS, undefined, [EXTERNAL]), new Map());
    expect(inference.targetDimension).toBeUndefined();
    expect(inference.reasons).toEqual(["counterparty_iban_own_account_without_dimension"]);
    expect(inference.unbookableOwnIban).toBe(EXTERNAL);
  });

  it("is a plain non-inference for an external IBAN under a third-party name", () => {
    const row = { ...ownNameRow(EXTERNAL), bank_account_name: "Kaupmees AS" } as Transaction;
    expect(inferOneSidedTransfer(row, lookups(TWO_ACCOUNTS), new Map())).toEqual({ confidence: 0, reasons: [] });
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

describe("hasMirrorPostingEvidence", () => {
  // PROJECT row 5002: EUR 600 out of dimension 100, marker IBAN = the Wise account (300).
  // Confirmed counterpart 5001: EUR 600 in on 300, booked by journal 9001 as D300/C100.
  const row = camtRow(5002);
  const counterpart = (overrides: Partial<Transaction> = {}): Transaction => ({
    id: 5001, status: "CONFIRMED", is_deleted: false, type: "D", amount: 600, cl_currencies_id: "EUR", date: "2026-09-26",
    accounts_dimensions_id: 300, bank_account_name: "Näide OÜ", bank_account_no: null,
    description: "WISE:TRANSFER-1 top-up [source_direction=IN]", ...overrides,
  } as Transaction);
  const journal = (postings: Array<Partial<Journal["postings"][number]>> = [
    { accounts_dimensions_id: 300, type: "D" }, { accounts_dimensions_id: 100, type: "C" },
  ]): Journal => ({
    id: 9001, effective_date: "2026-09-26", is_deleted: false, registered: true, operation_type: "TRANSACTION", operations_id: 5001,
    postings: postings.map(p => ({ accounts_id: 1020, amount: 600, base_amount: 600, is_deleted: false, ...p })),
  } as Journal);
  const own = lookups(THREE_ACCOUNTS);

  it("accepts the booked mirror, with a signed or an unsigned counterpart", () => {
    expect(hasMirrorPostingEvidence(row, counterpart(), 300, journal(), own)).toBe(true);
    expect(hasMirrorPostingEvidence(row, counterpart({ description: "top-up" }), 300, journal(), own)).toBe(true);
  });

  it("refuses non-EUR or FX-based amounts on either side", () => {
    expect(hasMirrorPostingEvidence(row, counterpart({ cl_currencies_id: "USD" }), 300, journal(), own)).toBe(false);
    expect(hasMirrorPostingEvidence({ ...row, base_amount: 599 }, counterpart(), 300, journal(), own)).toBe(false);
  });

  it("refuses a row without own-origin evidence or without a signed direction", () => {
    expect(hasMirrorPostingEvidence(camtRow(5002, { iban: "EE999999999999999999" }), counterpart(), 300, journal(), own)).toBe(false);
    expect(hasMirrorPostingEvidence({ ...row, description: "Näide OU" }, counterpart(), 300, journal(), own)).toBe(false);
  });

  it("refuses postings that do not book the row's side on its own dimension and the other side on the target", () => {
    expect(hasMirrorPostingEvidence(row, counterpart(), 300, journal([{ accounts_dimensions_id: 300, type: "D" }, { accounts_dimensions_id: 400, type: "C" }]), own)).toBe(false);
    expect(hasMirrorPostingEvidence(row, counterpart(), 300, journal([{ accounts_dimensions_id: 300, type: "D" }, { accounts_dimensions_id: 100, type: "D" }]), own)).toBe(false);
    expect(hasMirrorPostingEvidence(row, counterpart(), 300, journal([{ accounts_dimensions_id: 300, type: "C" }, { accounts_dimensions_id: 100, type: "C" }]), own)).toBe(false);
    expect(hasMirrorPostingEvidence(row, counterpart(), 300, journal([{ accounts_dimensions_id: 300, type: "D" }, { accounts_dimensions_id: 100, type: "C", is_deleted: true }]), own)).toBe(false);
  });

  it("refuses a counterpart signed in the row's own direction", () => {
    expect(hasMirrorPostingEvidence(row, counterpart({ description: "WISE:TRANSFER-1 top-up [source_direction=OUT]" }), 300, journal(), own)).toBe(false);
  });
});
