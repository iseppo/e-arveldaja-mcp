import { describe, it, expect } from "vitest";
import type { ApiResponse, Transaction } from "../types/api.js";
import { createBankTransaction } from "../bank-transaction-create.js";
import { canonicalRefNumber, REF_NUMBER_MAX_LENGTH } from "../ref-number.js";
import {
  buildCamtDescriptionWithMetadata,
  isTrustedCamtDescriptionMetadata,
  buildExistingDuplicateKeysForEntry,
  buildExistingTransactionDuplicateKey,
  type ParsedCamtEntry,
} from "./camt-import.js";

// FIX A — MAJOR #1: CAMT dedup dead for references longer than the ref_number
// cap. Task 9 added ref_number truncation + full-ref weaving into `description`
// at the single write boundary (`createBankTransaction`), but the CAMT identity
// sites still built/compared with the FULL, pre-weave reference. For a >20-char
// reference, build-time and verify-time identities diverge → dedup silently
// fails → the same statement entry is booked twice.

const SELECTED_DIMENSION_ID = 7;

// A 27-char structured creditor reference (RF-form), well over the 20-char cap.
const LONG_REFERENCE = "RF1853900754703445912345678".slice(0, 27);

function makeEntry(): ParsedCamtEntry {
  return {
    date: "2026-02-01",
    amount: 10,
    currency: "EUR",
    direction: "DBIT",
    counterparty_name: "Vendor OÜ",
    counterparty_iban: "EE471000001020145685",
    description: "Invoice payment",
    reference_number: LONG_REFERENCE,
    bank_reference: "ACCTSVCR-REF-1",
    duplicate: false,
    duplicate_transaction_ids: [],
  };
}

// Produce the transaction shape the write boundary actually persists for `entry`
// (truncated ref_number + woven/marked description), exactly as the CAMT import
// stores it. Nothing is hand-shaped: it comes from the real boundary.
async function storeViaBoundary(entry: ParsedCamtEntry): Promise<
  Pick<Transaction,
    "bank_ref_number" | "date" | "type" | "amount" | "cl_currencies_id" |
    "ref_number" | "bank_account_no" | "bank_account_name" | "description">
> {
  const storedDescription = buildCamtDescriptionWithMetadata(entry.description, entry);
  let captured: Partial<Transaction> = {};
  const api = {
    transactions: {
      create: async (payload: Partial<Transaction>): Promise<ApiResponse> => {
        captured = payload;
        return { data: { id: 1, ...payload } } as unknown as ApiResponse;
      },
    },
  };
  await createBankTransaction(
    api,
    {
      accounts_dimensions_id: SELECTED_DIMENSION_ID,
      amount: entry.amount,
      cl_currencies_id: entry.currency,
      date: entry.date,
      description: storedDescription,
      bank_account_name: entry.counterparty_name,
      bank_account_no: entry.counterparty_iban,
      // The CAMT create payload canonicalizes the reference at source, so this
      // mirrors exactly what `buildProcessableCamtDescriptors` now hands the
      // boundary (ref already ≤ cap → boundary is a no-op).
      ref_number: canonicalRefNumber(entry.reference_number).value,
      bank_ref_number: entry.bank_reference,
    },
    entry.direction === "CRDT" ? "incoming" : "outgoing",
  );
  return {
    bank_ref_number: (captured.bank_ref_number ?? entry.bank_reference) ?? null,
    date: entry.date,
    type: captured.type ?? "C",
    amount: entry.amount,
    cl_currencies_id: entry.currency,
    ref_number: captured.ref_number ?? null,
    bank_account_no: entry.counterparty_iban ?? null,
    bank_account_name: entry.counterparty_name ?? null,
    description: captured.description ?? null,
  };
}

describe("FIX A: CAMT dedup identity for over-cap references", () => {
  it("boundary truncates the ref and (currently) weaves the full ref into the description", async () => {
    // Guard-rail: proves the fixture really exercises the truncation path.
    expect(LONG_REFERENCE.length).toBeGreaterThan(REF_NUMBER_MAX_LENGTH);
    const stored = await storeViaBoundary(makeEntry());
    expect(stored.ref_number).toBe(LONG_REFERENCE.slice(0, REF_NUMBER_MAX_LENGTH));
  });

  it("the stored transaction's CAMT metadata is trusted on re-verify (build/verify symmetric)", async () => {
    const entry = makeEntry();
    const stored = await storeViaBoundary(entry);
    // RED on Task-9 code: build side signs with the FULL ref + pre-weave clean
    // description, verify side recomputes from the TRUNCATED stored ref + the
    // woven stored description → sig mismatch → metadata untrusted.
    expect(isTrustedCamtDescriptionMetadata(stored)).toBe(true);
  });

  it("a re-imported entry's exact-duplicate key matches the stored transaction's key", async () => {
    const entry = makeEntry();
    const stored = await storeViaBoundary(entry);
    const storedKey = buildExistingTransactionDuplicateKey(stored, SELECTED_DIMENSION_ID);
    const entryKeys = buildExistingDuplicateKeysForEntry(entry, SELECTED_DIMENSION_ID);
    expect(storedKey).toBeDefined();
    // RED on Task-9 code: the entry key carries the full ref + the pre-weave
    // marker description, the stored key carries the truncated ref + the woven
    // description → the re-import never recognises the duplicate.
    expect(entryKeys).toContain(storedKey);
  });
});
