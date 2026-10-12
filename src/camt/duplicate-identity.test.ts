import { describe, it, expect } from "vitest";
import {
  bankReferenceLookupKey,
  buildCamtDescriptionWithMetadata,
  buildDuplicateLookup,
  extractCamtDescriptionMetadata,
  findDuplicateTransactionIds,
  findMarkerSignatureMatches,
  isTrustedCamtDescriptionMetadata,
  journalDocumentReferenceKeys,
} from "./duplicate-identity.js";

describe("journalDocumentReferenceKeys", () => {
  const ref = "2947447407B8F111BB4E0627B324E395";
  const entryKey = bankReferenceLookupKey(ref);

  it("matches the entry key for BANK:-prefixed and bare document numbers", () => {
    expect(entryKey).toBeDefined();
    expect(journalDocumentReferenceKeys(`BANK:${ref}`)).toContain(entryKey);
    expect(journalDocumentReferenceKeys(ref)).toEqual([entryKey]);
    expect(journalDocumentReferenceKeys(`  BANK:${ref}  `)).toContain(entryKey);
  });

  it("returns no keys for empty, bare prefix, or missing document numbers", () => {
    expect(journalDocumentReferenceKeys("")).toEqual([]);
    expect(journalDocumentReferenceKeys("   ")).toEqual([]);
    expect(journalDocumentReferenceKeys("BANK:")).toEqual([]);
    expect(journalDocumentReferenceKeys(null)).toEqual([]);
    expect(journalDocumentReferenceKeys(undefined)).toEqual([]);
  });

  it("does not overlap for a different reference", () => {
    expect(journalDocumentReferenceKeys("BANK:OTHER-REF-1")).not.toContain(entryKey);
  });
});

describe("CAMT marker instruction id (instr=)", () => {
  const base = {
    date: "2026-05-04",
    amount: 500,
    currency: "EUR",
    direction: "DBIT" as const,
    counterparty_name: "Näide OÜ",
    counterparty_iban: "BE00000000000000",
    bank_reference: "AAAA0000BBBB1111CCCC2222DDDD3333",
    description: "Näide OÜ",
    duplicate: false,
    duplicate_transaction_ids: [],
  };
  const asStored = (description: string | undefined, id = 1) => ({
    id, accounts_dimensions_id: 100, status: "PROJECT", is_deleted: false,
    type: "C", amount: base.amount, cl_currencies_id: "EUR", date: base.date,
    bank_account_name: base.counterparty_name, bank_account_no: base.counterparty_iban,
    ref_number: null, bank_ref_number: null, description,
  }) as any;

  it("persists a numeric DBIT InstrId inside the signed marker", () => {
    const description = buildCamtDescriptionWithMetadata(base.description, { ...base, instruction_id: "68" });
    expect(description).toMatch(/\[e-arveldaja-mcp:camt [^\]]*instr=68[^\]]*\]$/);
    expect(extractCamtDescriptionMetadata(description).instruction_id).toBe("68");
    expect(isTrustedCamtDescriptionMetadata(asStored(description))).toBe(true);
  });

  it("a tampered instr fails the marker checksum", () => {
    const description = buildCamtDescriptionWithMetadata(base.description, { ...base, instruction_id: "68" })!;
    expect(isTrustedCamtDescriptionMetadata(asStored(description.replace("instr=68", "instr=69")))).toBe(false);
  });

  it("writes exactly the previous marker when there is no usable instruction id", () => {
    const legacy = buildCamtDescriptionWithMetadata(base.description, base);
    expect(legacy).not.toContain("instr=");
    // Incoming rows and non-numeric ids (e.g. Wise-originated "SI…") are not persisted.
    expect(buildCamtDescriptionWithMetadata(base.description, { ...base, direction: "CRDT", instruction_id: "68" }))
      .toBe(buildCamtDescriptionWithMetadata(base.description, { ...base, direction: "CRDT" }));
    expect(buildCamtDescriptionWithMetadata(base.description, { ...base, instruction_id: "SI2609000001" })).toBe(legacy);
  });

  it("drops instr rather than cutting description text the previous release kept", () => {
    // A text exactly filling the budget the instr-less marker leaves.
    const marker = buildCamtDescriptionWithMetadata("x", { ...base, description: "x" })!.split("\n")[1]!;
    const text = "x".repeat(150 - marker.length - 1);
    const legacy = buildCamtDescriptionWithMetadata(text, { ...base, description: text })!;
    const withInstr = buildCamtDescriptionWithMetadata(text, { ...base, description: text, instruction_id: "68" })!;
    expect(legacy.split("\n")[0]).toBe(text);
    expect(withInstr).toBe(legacy);
    // With room for " instr=68" the id is kept.
    const roomy = "x".repeat(150 - marker.length - 1 - " instr=68".length);
    expect(buildCamtDescriptionWithMetadata(roomy, { ...base, description: roomy, instruction_id: "68" })).toContain("instr=68");
  });

  it("drops instr rather than a marker identity field the sig covers", () => {
    // A bank reference long enough that " instr=…" would push the marker to a
    // form without the IBAN; the read-back row has no bank fields of its own.
    const entry = { ...base, bank_reference: "R".repeat(20) + "/".repeat(12), counterparty_iban: "BE08905767222113", instruction_id: "1234567890" };
    const description = buildCamtDescriptionWithMetadata(base.description, entry)!;
    const { instruction_id: _unused, ...withoutId } = entry;
    expect(description).toBe(buildCamtDescriptionWithMetadata(base.description, withoutId));
    expect(description).not.toContain("instr=");
    expect(extractCamtDescriptionMetadata(description).bank_account_no).toBe("BE08905767222113");
  });

  it("a row stored without instr is still the same entry on re-import", () => {
    const entry = { ...base, instruction_id: "68" };
    const old = asStored(buildCamtDescriptionWithMetadata(base.description, base), 7);
    const lookup = buildDuplicateLookup([old], 100);
    expect(findDuplicateTransactionIds(entry, lookup, new Set(), 100)).toEqual([7]);
    expect(findMarkerSignatureMatches(entry, lookup, 100)).toEqual([7]);
  });
});
