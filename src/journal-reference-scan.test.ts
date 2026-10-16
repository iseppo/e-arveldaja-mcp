import { describe, it, expect, vi } from "vitest";
import type { Journal } from "./types/api.js";
import {
  checkJournalReferences,
  findJournalsReferencingDocument,
  journalReferenceStrength,
} from "./journal-reference-scan.js";

function journal(overrides: Partial<Journal>): Journal {
  return {
    id: 1,
    effective_date: "2026-09-23",
    registered: true,
    is_deleted: false,
    postings: [],
    ...overrides,
  };
}

const ids = (journals: Journal[], references: string[]) =>
  findJournalsReferencingDocument(journals, references).map(hit => hit.journal_id);

describe("findJournalsReferencingDocument", () => {
  it("hits the live Messenger case on the document_number and on the title", () => {
    const journals = [
      journal({ id: 29551083, document_number: "ETR1:EMSS70002960", title: "Madrats ettemakse" }),
      journal({ id: 29551084, document_number: "ETR1:EE1966453", title: "Madrats ETR1 EE1966453, ettemakse tasaarveldus" }),
      journal({ id: 29551085, document_number: null, title: "Madrats arve EE1966453, ettemakse" }),
    ];
    const hits = findJournalsReferencingDocument(journals, ["EE1966453"]);
    expect(hits.map(hit => [hit.journal_id, hit.matched_field])).toEqual([
      [29551084, "document_number"],
      [29551085, "title"],
    ]);
    expect(hits[0]).toMatchObject({ reference: "EE1966453", document_number: "ETR1:EE1966453" });
  });

  it("matches through normalization (case, dashes, spaces)", () => {
    expect(ids([journal({ id: 2, title: "Arve ee-1966453" })], ["EE1966453"])).toEqual([2]);
    expect(ids([journal({ id: 3, title: "Arve EE 1966453" })], ["EE1966453"])).toEqual([3]);
  });

  it.each([
    "ETR1-EE1966453",
    "ETR1/EE1966453",
    "ETR1_EE1966453",
    "ETR1.EE1966453",
  ])("matches a delimiter-joined document_number %s with the number absent from the title", (documentNumber) => {
    expect(ids([journal({ id: 4, document_number: documentNumber, title: "Madrats ettemakse" })], ["EE1966453"])).toEqual([4]);
    expect(ids([journal({ id: 5, document_number: null, title: `Madrats ${documentNumber}` })], ["EE1966453"])).toEqual([5]);
  });

  it("never matches a substring", () => {
    const journals = [
      journal({ id: 6, document_number: "EE19664531", title: "Arve EE19664531" }),
      journal({ id: 7, document_number: "XEE1966453", title: "Arve XEE1966453" }),
    ];
    expect(ids(journals, ["EE1966453"])).toEqual([]);
  });

  it("joins runs of adjacent tokens", () => {
    expect(ids([journal({ id: 8, title: "Arve INV 2024 001" })], ["INV-2024-001"])).toEqual([8]);
    expect(ids([journal({ id: 9, document_number: "2024/001" })], ["2024-001"])).toEqual([9]);
  });

  it("joins sub-tokens across outer tokens (ETR1-INV 2024/001 holds INV-2024-001)", () => {
    expect(ids([journal({ id: 22, document_number: "ETR1-INV 2024/001", title: "Ettemakse" })], ["INV-2024-001"])).toEqual([22]);
    expect(ids([journal({ id: 23, document_number: null, title: "Tasaarveldus ETR1-INV 2024/001" })], ["INV-2024-001"])).toEqual([23]);
    expect(ids([journal({ id: 24, title: "Arve ETR1-INV 2024/0011" })], ["INV-2024-001"])).toEqual([]);
  });

  it("never matches a reference shorter than 4 characters or without a digit", () => {
    const journals = [journal({ id: 10, document_number: "110", title: "Arve 110 kontor" })];
    expect(ids(journals, ["110"])).toEqual([]);
    expect(ids([journal({ id: 11, document_number: "ABCDEFG", title: "ABCDEFG" })], ["ABCDEFG"])).toEqual([]);
  });

  it("a 5-character reference matches only an exact document_number (or its remainder after PREFIX:)", () => {
    expect(ids([journal({ id: 12, document_number: "A1234" })], ["A1234"])).toEqual([12]);
    expect(ids([journal({ id: 13, document_number: "LY:A1234" })], ["A1234"])).toEqual([13]);
    expect(ids([journal({ id: 14, title: "Arve A1234" })], ["A1234"])).toEqual([]);
    // A weak reference is never matched as a sub-token or a join.
    expect(ids([journal({ id: 15, document_number: "ETR1-A1234" })], ["A1234"])).toEqual([]);
    expect(ids([journal({ id: 16, document_number: "X A1234" })], ["A1234"])).toEqual([]);
  });

  it("a date-shaped reference is weak", () => {
    expect(journalReferenceStrength("202609")).toBe("weak");
    expect(journalReferenceStrength("20260923")).toBe("weak");
    expect(journalReferenceStrength("23092026")).toBe("weak");
    expect(journalReferenceStrength("ee1966453")).toBe("strong");
    expect(ids([journal({ id: 17, title: "Palk 202609" })], ["202609"])).toEqual([]);
    expect(ids([journal({ id: 18, document_number: "202609" })], ["202609"])).toEqual([18]);
  });

  it("ignores deleted journals, but includes drafts of any operation type", () => {
    const journals = [
      journal({ id: 19, document_number: "ETR1:EE1966453", is_deleted: true }),
      journal({ id: 20, title: "EE1966453", registered: false, operation_type: "PURCHASE_INVOICE" }),
    ];
    expect(ids(journals, ["EE1966453"])).toEqual([20]);
  });
});

describe("checkJournalReferences", () => {
  it("degrades to scan_available:false with a note and no hits when the list read throws", async () => {
    const api = { journals: { listAll: vi.fn().mockRejectedValue(new Error("page cap reached")) } };
    const result = await checkJournalReferences(api, ["EE1966453"]);
    expect(result.scan_available).toBe(false);
    expect(result.hits).toEqual([]);
    expect(result.scan_note).toContain("Journal reference scan unavailable");
  });

  it("skips the read when no reference passes the strength gate", async () => {
    const api = { journals: { listAll: vi.fn() } };
    const result = await checkJournalReferences(api, ["110", undefined]);
    expect(result).toEqual({ scan_available: true, hits: [] });
    expect(api.journals.listAll).not.toHaveBeenCalled();
  });

  it("returns hits from the journal list", async () => {
    const api = { journals: { listAll: vi.fn().mockResolvedValue([journal({ id: 21, document_number: "ETR1:EE1966453" })]) } };
    const result = await checkJournalReferences(api, ["EE1966453"]);
    expect(result.scan_available).toBe(true);
    expect(result.hits.map(hit => hit.journal_id)).toEqual([21]);
  });
});
