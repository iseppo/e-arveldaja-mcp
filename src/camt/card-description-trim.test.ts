import { describe, expect, it } from "vitest";
import { GOLDEN_CASES } from "../__fixtures__/camt-marker-golden.js";
import {
  buildDuplicateLookup, extractCamtDescriptionMetadata, findDuplicateTransactionIds, findLossyIdentityConflicts,
  isTrustedCamtDescriptionMetadata, renderCamtDescriptionDetailed, renderCamtDescriptionLegacyCut,
  stripCamtDescriptionMetadata, trimCamtDescriptionToBudget, buildBatchDuplicateKey,
} from "./duplicate-identity.js";
import { computeCamtImportProjection } from "./projection.js";
import type { CamtParseResult, ParsedCamtEntry, Transaction } from "./types.js";
import type { BankAccount } from "../types/api.js";

// #9: a card payment on a Coop statement (synthetic merchant, address and card).
const DIM = 77;
const OWN = "EE382200221020145685";
const POS = "POS: 5375 00** **** 0000, 13.09.2026 09:08:54, NAIDIS AJALEHT AS\\Näidise tänav 93\\Tallinn\\10151     DUBEST  #215035";
const HEAD = "POS: 5375 00** **** 0000, 13.09.2026 09:08:54, NAIDIS AJALEHT AS";
const entry = (overrides: Partial<ParsedCamtEntry> = {}): ParsedCamtEntry => ({
  ...GOLDEN_CASES.issue_example!, counterparty_iban: undefined, counterparty_name: "NAIDIS AJALEHT AS", description: POS,
  duplicate: false, duplicate_transaction_ids: [], ...overrides,
});
const stored = (e: ParsedCamtEntry, description: string | undefined, overrides: Partial<Transaction> = {}): Transaction => ({
  id: 1, status: "PROJECT", accounts_dimensions_id: DIM, type: "C", amount: e.amount, date: e.date,
  cl_currencies_id: e.currency, bank_ref_number: e.bank_reference ?? null, bank_account_no: e.counterparty_iban ?? null,
  bank_account_name: e.counterparty_name ?? null, ref_number: e.reference_number ?? null, description, ...overrides,
} as Transaction);
async function project(entries: ParsedCamtEntry[], ledger: Transaction[]) {
  return computeCamtImportProjection({
    loaded: { entries, statement_metadata: { iban: OWN }, summary: {} } as CamtParseResult,
    accountsDimensionsId: DIM, dateFrom: undefined, dateTo: undefined, ledgerTransactions: ledger,
    journalCoverage: { journals: [], accountId: 1020, bankAccounts: [{ iban_code: OWN, account_no: OWN } as BankAccount], accountDimensions: [],
      interAccountResolver: () => ({ resolveInterAccount: () => ({ status: "none" }), hasOtherLabelledInterAccount: () => false }) },
    resolveClient: async () => ({}), reportProgress: async () => {},
  });
}

describe("card-payment descriptions keep the merchant when shortened (#9)", () => {
  it("drops the #seq, country codes and address segments, never the merchant; the marker verifies", () => {
    const e = entry();
    const rendering = renderCamtDescriptionDetailed(e.description, e);
    expect(stripCamtDescriptionMetadata(rendering.description)).toBe(HEAD);
    expect(rendering.truncated).toEqual({ stored_length: HEAD.length, full_length: POS.length });
    expect(isTrustedCamtDescriptionMetadata(stored(e, rendering.description))).toBe(true);
    // Before, the text was cut in the middle of the address.
    expect(stripCamtDescriptionMetadata(renderCamtDescriptionLegacyCut(e.description, e))).toBe(`${HEAD}\\Näidise tän`);
  });

  it("drops address segments one at a time from the end and hard-cuts only what still does not fit", () => {
    expect(trimCamtDescriptionToBudget(POS, 200)).toBe(POS);
    expect(trimCamtDescriptionToBudget(POS, 100)).toBe(`${HEAD}\\Näidise tänav 93\\Tallinn\\10151`);
    expect(trimCamtDescriptionToBudget(POS, 82)).toBe(`${HEAD}\\Näidise tänav 93`);
    expect(trimCamtDescriptionToBudget(POS, 50)).toBe(HEAD.slice(0, 50).trimEnd());
    expect(trimCamtDescriptionToBudget("Arve 1 | Arve 2 | Arve 3", 16)).toBe("Arve 1 | Arve 2");
  });

  it("a long non-card description is stored exactly as before", () => {
    const e = entry({ description: `Arve ${"pikk selgitus ".repeat(10)}` });
    expect(renderCamtDescriptionDetailed(e.description, e).description).toBe(renderCamtDescriptionLegacyCut(e.description, e));
  });

  it("a row stored with the old cut is still the same movement on re-import, with no possible-duplicate review", async () => {
    const e = entry();
    const old = stored(e, renderCamtDescriptionLegacyCut(e.description, e), { id: 501 });
    expect(findDuplicateTransactionIds(e, buildDuplicateLookup([old], DIM), new Set(), DIM)).toEqual([501]);
    // By the exact key alone (a repeated bank reference turns the reference lookup off).
    expect(findDuplicateTransactionIds(e, buildDuplicateLookup([old], DIM), new Set([e.bank_reference!]), DIM)).toEqual([501]);
    const projection = await project([e], [old]);
    expect(projection.descriptors).toHaveLength(0);
    expect(projection.skipped).toEqual([expect.objectContaining({ duplicate_transaction_ids: [501] })]);
    expect(projection.skipped[0]!.review_code).toBeUndefined();
  });

  it("an old marker-only row (no bank reference, IBAN or name read back) still matches, and counts as lossy", () => {
    const e = entry();
    const description = renderCamtDescriptionLegacyCut(e.description, e);
    expect(extractCamtDescriptionMetadata(description).entry_sig).toBeDefined();
    const old = stored(e, description, { id: 502, bank_ref_number: null, bank_account_no: null, bank_account_name: null });
    expect(findDuplicateTransactionIds(e, buildDuplicateLookup([old], DIM), new Set(), DIM)).toEqual([502]);
    // Two different payments whose old cut is identical cannot be told apart by such a row.
    const other = entry({ description: `${HEAD}\\Näidise tänav 95\\Tallinn\\10151     DUBEST  #215036` });
    const full = stored(e, description, { id: 503 });
    const conflicts = findLossyIdentityConflicts([e, other], buildDuplicateLookup([full], DIM), DIM);
    expect([...conflicts].sort()).toEqual([buildBatchDuplicateKey(e), buildBatchDuplicateKey(other)].sort());
  });
});
