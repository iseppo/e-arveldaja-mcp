import { describe, it, expect } from "vitest";
import { bankReferenceLookupKey, journalDocumentReferenceKeys } from "./duplicate-identity.js";

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
