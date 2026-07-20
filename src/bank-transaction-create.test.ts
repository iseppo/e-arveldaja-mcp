import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBankTransaction, weaveFullRefIntoDescription } from "./bank-transaction-create.js";
import { bankTransactionDirection } from "./bank-transaction-direction.js";
import { REF_NUMBER_MAX_LENGTH } from "./ref-number.js";
import { extractCamtDescriptionMetadata } from "./tools/camt-import.js";

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

describe("bank transaction create — ref_number canonicalization (Task 9)", () => {
  const overCapRef = "REF-1234567890-ABCDEFGHIJ"; // 25 chars, over the 20 cap

  it("passes a short ref_number through unchanged", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 100 });
    const api = { transactions: { create } };

    await createBankTransaction(api, {
      accounts_dimensions_id: 7,
      amount: 10,
      cl_currencies_id: "EUR",
      date: "2026-07-19",
      ref_number: "INV-123",
    });

    const payload = create.mock.calls[0]![0] as { ref_number?: string; description?: string };
    expect(payload.ref_number).toBe("INV-123");
    // No truncation → description is untouched.
    expect(payload.description).toBeUndefined();
  });

  it("truncates an over-cap ref_number to the cap on the payload", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 101 });
    const api = { transactions: { create } };

    await createBankTransaction(api, {
      accounts_dimensions_id: 7,
      amount: 10,
      cl_currencies_id: "EUR",
      date: "2026-07-19",
      ref_number: overCapRef,
    });

    const payload = create.mock.calls[0]![0] as { ref_number?: string };
    expect(payload.ref_number).toBe(overCapRef.slice(0, REF_NUMBER_MAX_LENGTH));
    expect(payload.ref_number!.length).toBe(REF_NUMBER_MAX_LENGTH);
  });

  it("weaves the full ref into description when truncated and it is not already present", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 102 });
    const api = { transactions: { create } };

    await createBankTransaction(api, {
      accounts_dimensions_id: 7,
      amount: 10,
      cl_currencies_id: "EUR",
      date: "2026-07-19",
      description: "Payment to supplier",
      ref_number: overCapRef,
    });

    const payload = create.mock.calls[0]![0] as { description?: string };
    expect(payload.description).toContain(overCapRef);
    expect(payload.description).toContain("Payment to supplier");
  });

  it("does not duplicate the full ref when it is already present in the description", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 103 });
    const api = { transactions: { create } };

    await createBankTransaction(api, {
      accounts_dimensions_id: 7,
      amount: 10,
      cl_currencies_id: "EUR",
      date: "2026-07-19",
      description: `Payment ${overCapRef} done`,
      ref_number: overCapRef,
    });

    const payload = create.mock.calls[0]![0] as { description?: string };
    const occurrences = payload.description!.split(overCapRef).length - 1;
    expect(occurrences).toBe(1);
  });

  it("inserts the full ref BEFORE a trailing Wise [source_direction=OUT] marker so direction still resolves", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 104 });
    const api = { transactions: { create } };

    await createBankTransaction(api, {
      accounts_dimensions_id: 7,
      amount: 10,
      cl_currencies_id: "EUR",
      date: "2026-07-19",
      description: "WISE:123 Supplier [source_direction=OUT]",
      ref_number: overCapRef,
    });

    const payload = create.mock.calls[0]![0] as { description?: string; type?: string };
    // Full ref woven in...
    expect(payload.description).toContain(overCapRef);
    // ...but the direction marker stays trailing so end-anchored regexes still match.
    expect(payload.description!.trimEnd().endsWith("[source_direction=OUT]")).toBe(true);
    // The boundary booked it outgoing (type C) from the still-matching marker.
    expect(payload.type).toBe("C");
    expect(bankTransactionDirection({ description: payload.description })).toBe("outgoing");
  });

  it("preserves the camt anchor when weaving into a MARKER-ONLY (empty-narrative) description", async () => {
    // Regression: a camt entry with an empty remittance narrative stores a
    // marker-only description. Weaving the full ref directly in front of the
    // marker (no newline) breaks the (?:^|\n) anchor of BOTH read-side regexes
    // (bankTransactionDirection AND extractCamtDescriptionMetadata), making the
    // stored entry_sig / bank_ref / source_direction invisible → the next camt
    // import re-imports the row as a NEW transaction → double booking.
    const create = vi.fn().mockResolvedValue({ created_object_id: 106 });
    const api = { transactions: { create } };

    await createBankTransaction(api, {
      accounts_dimensions_id: 7,
      amount: 10,
      cl_currencies_id: "EUR",
      date: "2026-07-19",
      description: "[e-arveldaja-mcp:camt br=RF12 dir=CRDT sig=abc123abc123abcd]",
      ref_number: overCapRef,
    });

    const payload = create.mock.calls[0]![0] as { description?: string; type?: string };
    expect(payload.description).toContain(overCapRef);
    // Direction still resolves from the still-anchored marker.
    expect(payload.type).toBe("D");
    expect(bankTransactionDirection({ description: payload.description })).toBe("incoming");
    // The camt read-side metadata extractor still sees the marker's fields.
    const metadata = extractCamtDescriptionMetadata(payload.description);
    expect(metadata.source_direction).toBe("CRDT");
    expect(metadata.bank_ref_number).toBe("RF12");
    expect(metadata.entry_sig).toBeDefined();
  });

  it("preserves a marker-only Wise [source_direction=OUT] description when weaving", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 107 });
    const api = { transactions: { create } };

    // A Wise row whose entire description is the WISE tag + trailing marker.
    await createBankTransaction(api, {
      accounts_dimensions_id: 7,
      amount: 10,
      cl_currencies_id: "EUR",
      date: "2026-07-19",
      description: "WISE:123 [source_direction=OUT]",
      ref_number: overCapRef,
    });

    const payload = create.mock.calls[0]![0] as { description?: string; type?: string };
    expect(payload.description).toContain(overCapRef);
    expect(payload.type).toBe("C");
    expect(bankTransactionDirection({ description: payload.description })).toBe("outgoing");
  });

  it("inserts the full ref BEFORE a trailing camt marker so direction still resolves", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 105 });
    const api = { transactions: { create } };

    await createBankTransaction(api, {
      accounts_dimensions_id: 7,
      amount: 10,
      cl_currencies_id: "EUR",
      date: "2026-07-19",
      description: "omanikulaen\n[e-arveldaja-mcp:camt dir=CRDT sig=abc123abc123abcd]",
      ref_number: overCapRef,
    });

    const payload = create.mock.calls[0]![0] as { description?: string; type?: string };
    expect(payload.description).toContain(overCapRef);
    expect(payload.type).toBe("D");
    expect(bankTransactionDirection({ description: payload.description })).toBe("incoming");
  });
});

describe("bank transaction create — weave length budget (FIX B)", () => {
  // A 32-char over-cap ref woven into a near-max description would push the
  // stored description past the backend TRANSACTION_DESCRIPTION_MAX_LENGTH (150),
  // risking an upstream rejection or an evicted/overflowed metadata marker.
  const overCapRef = "RF" + "9".repeat(30); // 32 chars

  it("does not weave when the woven result would exceed the length budget (returns original)", () => {
    const description = "X".repeat(140); // 140 + 1 sep + 32 ref = 173 > 150
    const result = weaveFullRefIntoDescription(description, overCapRef, 150);
    expect(result.length).toBeLessThanOrEqual(150);
    expect(result).toBe(description);
  });

  it("still weaves when the woven result fits within the budget", () => {
    const description = "Short note";
    const result = weaveFullRefIntoDescription(description, overCapRef, 150);
    expect(result).toContain(overCapRef);
    expect(result.length).toBeLessThanOrEqual(150);
  });

  it("defaults the budget to 150 when no maxLength is passed", () => {
    const description = "Y".repeat(140);
    const result = weaveFullRefIntoDescription(description, overCapRef);
    expect(result.length).toBeLessThanOrEqual(150);
    expect(result).toBe(description);
  });

  it("keeps the boundary-stored description within 150 chars for a near-max description + over-cap ref", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 107 });
    const api = { transactions: { create } };

    await createBankTransaction(api, {
      accounts_dimensions_id: 7,
      amount: 10,
      cl_currencies_id: "EUR",
      date: "2026-07-19",
      description: "Z".repeat(140),
      ref_number: overCapRef,
    });

    const payload = create.mock.calls[0]![0] as { description?: string };
    expect(payload.description!.length).toBeLessThanOrEqual(150);
  });
});
