import { describe, expect, it, vi } from "vitest";
import { journalBankDirection, loadProvenBankDirection, provenBankDirection } from "./bank-transaction-journal-direction.js";
import type { Journal, Transaction } from "./types/api.js";

// Live-shaped: the API reads every row back as type "C"; a legacy LHV-import
// row has a plain description and no signed marker, but its CONFIRMED status
// comes with one registration journal (operation_type TRANSACTION).
const BANK_ACCOUNT = 1020;
const BANK_DIMENSION = 7;
const legacyRow = (patch: Partial<Transaction> = {}): Transaction => ({
  id: 501, status: "CONFIRMED", is_deleted: false, type: "C", amount: 120, cl_currencies_id: "EUR",
  date: "2026-03-04", accounts_dimensions_id: BANK_DIMENSION, description: "Arve 17 tasumine",
  ...patch,
} as Transaction);
const registration = (bankSide: "D" | "C", patch: Partial<Journal> = {}): Journal => ({
  id: 9001, operation_type: "TRANSACTION", operations_id: 501, registered: true, is_deleted: false,
  effective_date: "2026-03-04", cl_currencies_id: "EUR",
  postings: [
    { accounts_id: BANK_ACCOUNT, accounts_dimensions_id: BANK_DIMENSION, type: bankSide, amount: 120, base_amount: 120 },
    { accounts_id: 2310, accounts_dimensions_id: null, type: bankSide === "D" ? "C" : "D", amount: 120, base_amount: 120 },
  ],
  ...patch,
});
const OUT_MARKER = "WISE:TRF-1 Payment [source_direction=OUT]";
const IN_MARKER = "WISE:TRF-1 Refund [source_direction=IN]";

describe("provenBankDirection", () => {
  it("proves a plain CONFIRMED row incoming from a journal debiting its bank dimension", () => {
    expect(provenBankDirection(legacyRow(), [registration("D")], BANK_ACCOUNT)).toBe("incoming");
  });

  it("proves a plain CONFIRMED row outgoing from a journal crediting its bank dimension", () => {
    expect(provenBankDirection(legacyRow(), [registration("C")], BANK_ACCOUNT)).toBe("outgoing");
  });

  it("treats a marker that contradicts the journal as unproven", () => {
    expect(provenBankDirection(legacyRow({ description: OUT_MARKER }), [registration("D")], BANK_ACCOUNT)).toBeUndefined();
    expect(provenBankDirection(legacyRow({ description: IN_MARKER }), [registration("D")], BANK_ACCOUNT)).toBe("incoming");
  });

  it("leaves a row without a registration journal unproven (and marker-only when marked)", () => {
    expect(provenBankDirection(legacyRow(), [], BANK_ACCOUNT)).toBeUndefined();
    expect(provenBankDirection(legacyRow(), [registration("D", { operations_id: 502 })], BANK_ACCOUNT)).toBeUndefined();
    expect(provenBankDirection(legacyRow(), [registration("D", { operation_type: "ENTRY" })], BANK_ACCOUNT)).toBeUndefined();
    expect(provenBankDirection(legacyRow(), [registration("D", { registered: false })], BANK_ACCOUNT)).toBeUndefined();
    expect(provenBankDirection(legacyRow(), [registration("D", { is_deleted: true })], BANK_ACCOUNT)).toBeUndefined();
    expect(provenBankDirection(legacyRow({ description: OUT_MARKER }), [], BANK_ACCOUNT)).toBe("outgoing");
  });

  it("keeps a PROJECT row marker-only even when a journal names it", () => {
    expect(provenBankDirection(legacyRow({ status: "PROJECT" }), [registration("D")], BANK_ACCOUNT)).toBeUndefined();
    expect(provenBankDirection(legacyRow({ status: "PROJECT", description: OUT_MARKER }), [registration("D")], BANK_ACCOUNT)).toBe("outgoing");
  });

  it("requires the bank posting on the row's own GL account and dimension", () => {
    expect(provenBankDirection(legacyRow(), [registration("D")], undefined)).toBeUndefined();
    expect(provenBankDirection(legacyRow(), [registration("D")], 1030)).toBeUndefined();
    expect(provenBankDirection(legacyRow({ accounts_dimensions_id: 8 }), [registration("D")], BANK_ACCOUNT)).toBeUndefined();
  });

  it("fails closed on a foreign bank posting without a finite EUR base, and on a zero net", () => {
    const foreign = registration("D");
    foreign.postings[0] = { ...foreign.postings[0]!, cl_currencies_id: "USD", base_amount: undefined };
    expect(journalBankDirection(legacyRow(), [foreign], BANK_ACCOUNT)).toBeUndefined();
    const nan = registration("D");
    nan.postings[0] = { ...nan.postings[0]!, base_amount: Number.NaN, amount: Number.NaN };
    expect(journalBankDirection(legacyRow(), [nan], BANK_ACCOUNT)).toBeUndefined();
    const reversed = registration("D");
    reversed.postings.push({ accounts_id: BANK_ACCOUNT, accounts_dimensions_id: BANK_DIMENSION, type: "C", amount: 120, base_amount: 120 });
    expect(journalBankDirection(legacyRow(), [reversed], BANK_ACCOUNT)).toBeUndefined();
  });
});

describe("loadProvenBankDirection", () => {
  const api = (journals: Journal[]) => ({
    readonly: { getAccountDimensions: vi.fn().mockResolvedValue([{ id: BANK_DIMENSION, accounts_id: BANK_ACCOUNT, title_est: "Pank" }]) },
    journals: {
      listAll: vi.fn().mockResolvedValue(journals.map(journal => ({ ...journal, postings: [] }))),
      get: vi.fn().mockImplementation(async (id: number) => journals.find(journal => journal.id === id)),
    },
  }) as any;

  it("resolves the bank GL account from the dimension and fetches postings the list omits", async () => {
    const deps = api([registration("D")]);
    await expect(loadProvenBankDirection(deps, legacyRow())).resolves.toBe("incoming");
    expect(deps.journals.get).toHaveBeenCalledWith(9001);
  });

  it("loads nothing for a PROJECT row", async () => {
    const deps = api([registration("D")]);
    await expect(loadProvenBankDirection(deps, legacyRow({ status: "PROJECT" }))).resolves.toBeUndefined();
    expect(deps.journals.listAll).not.toHaveBeenCalled();
  });
});
