import { describe, expect, it } from "vitest";
import { resolveWiseCardClientFromHistory } from "./preflight.js";
import type { Transaction } from "../types/api.js";
import type { WiseRow } from "./types.js";

// Live shape (2026-10): Wise card rows store the merchant in bank_account_name;
// earlier Anthropic card payments on the Wise dimension all carry client 2010417.
const WISE_DIMENSION = 5;
const ANTHROPIC = 2010417;
const MERCHANT = "Anthropic Claude Subscription";

function cardRow(overrides: Partial<WiseRow> = {}): WiseRow {
  return {
    rowIndex: 1, id: "CARD_TRANSACTION-3001", status: "COMPLETED", direction: "OUT",
    createdOn: "2026-09-17 10:00:00", finishedOn: "2026-09-17 10:00:00",
    sourceFeeAmount: 0, sourceFeeCurrency: "EUR", targetFeeAmount: 0, targetFeeCurrency: "EUR",
    sourceName: "Seppo AI OÜ", sourceAmount: 90, sourceCurrency: "EUR",
    targetName: MERCHANT, targetAmount: 90, targetCurrency: "EUR",
    exchangeRate: 1, reference: "", category: "General", note: "",
    ...overrides,
  };
}

function history(id: number, date: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id, status: "CONFIRMED", is_deleted: false, type: "C", amount: 90, cl_currencies_id: "EUR", date,
    accounts_dimensions_id: WISE_DIMENSION, clients_id: ANTHROPIC, bank_account_name: MERCHANT,
    description: `WISE:CARD_TRANSACTION-${id} ${MERCHANT} [source_direction=OUT]`,
    ...overrides,
  } as Transaction;
}

const threeMonths = [history(13787867, "2026-06-17"), history(13895154, "2026-07-17"), history(14044556, "2026-08-17")];

describe("resolveWiseCardClientFromHistory", () => {
  it("takes the client every earlier confirmed card payment to the same merchant carries", () => {
    expect(resolveWiseCardClientFromHistory(cardRow(), threeMonths, WISE_DIMENSION)).toBe(2010417);
  });

  it("needs only one qualifying earlier payment", () => {
    expect(resolveWiseCardClientFromHistory(cardRow(), [history(14044556, "2026-08-17")], WISE_DIMENSION)).toBe(2010417);
  });

  it("matches the complete merchant across case and whitespace, never a part of it", () => {
    expect(resolveWiseCardClientFromHistory(cardRow({ targetName: "  anthropic   CLAUDE subscription " }), threeMonths, WISE_DIMENSION)).toBe(2010417);
    expect(resolveWiseCardClientFromHistory(cardRow({ targetName: "Anthropic" }), threeMonths, WISE_DIMENSION)).toBeUndefined();
  });

  it.each([
    ["mixed clients", [...threeMonths, history(14044560, "2026-08-20", { clients_id: 2010999 })]],
    ["a null client beside a valid one", [...threeMonths, history(14044560, "2026-08-20", { clients_id: null })]],
    ["an invalid client id", [history(14044556, "2026-08-17", { clients_id: -4 })]],
  ])("assigns nothing with %s", (_label, rows) => {
    expect(resolveWiseCardClientFromHistory(cardRow(), rows as Transaction[], WISE_DIMENSION)).toBeUndefined();
  });

  it.each([
    ["deleted", { is_deleted: true }],
    ["unconfirmed", { status: "PROJECT" }],
    ["void", { status: "VOID" }],
    ["incoming", { description: `WISE:CARD_TRANSACTION-1 ${MERCHANT} [source_direction=IN]` }],
    ["unmarked (direction unproven)", { description: `WISE:CARD_TRANSACTION-1 ${MERCHANT}` }],
    ["a fee row", { description: `WISE:FEE:CARD_TRANSACTION-1 Wise teenustasu [source_direction=OUT]` }],
    ["a transfer row", { description: `WISE:TRANSFER-1 ${MERCHANT} [source_direction=OUT]` }],
    ["on another dimension", { accounts_dimensions_id: 6 }],
    ["with an invalid date", { date: "2026-02-30" }],
    ["on the same day", { date: "2026-09-17" }],
    ["later", { date: "2026-09-18" }],
  ])("ignores an earlier row that is %s", (_label, overrides) => {
    const rows = [history(14044556, "2026-08-17", overrides as Partial<Transaction>)];
    expect(resolveWiseCardClientFromHistory(cardRow(), rows, WISE_DIMENSION)).toBeUndefined();
  });

  it("lets an ineligible row neither supply nor veto history", () => {
    const rows = [...threeMonths, history(14044560, "2026-08-20", { clients_id: 2010999, status: "PROJECT" })];
    expect(resolveWiseCardClientFromHistory(cardRow(), rows, WISE_DIMENSION)).toBe(2010417);
  });

  it.each([
    ["a missing merchant", cardRow({ targetName: "" })],
    ["a merchant that may be truncated", cardRow({ targetName: "M".repeat(100) })],
    ["an incoming card row", cardRow({ direction: "IN", sourceName: MERCHANT, targetName: "Seppo AI OÜ" })],
    ["a transfer row", cardRow({ id: "TRANSFER-3001" })],
  ])("resolves nothing for %s", (_label, row) => {
    const longName = history(14044556, "2026-08-17", { bank_account_name: "M".repeat(100), description: `WISE:CARD_TRANSACTION-1 x [source_direction=OUT]` });
    expect(resolveWiseCardClientFromHistory(row, [...threeMonths, longName], WISE_DIMENSION)).toBeUndefined();
  });

  // Sol review MINOR 3: a short current merchant against a historical name
  // at the 100-character cap that normalizes to the same merchant.
  it("resolves nothing when a matching historical name reaches the 100-character cap", () => {
    const capped = `${MERCHANT}${" ".repeat(100 - MERCHANT.length)}`;
    expect(capped).toHaveLength(100);
    const rows = [...threeMonths, history(14044560, "2026-08-20", { bank_account_name: capped })];
    expect(resolveWiseCardClientFromHistory(cardRow(), rows, WISE_DIMENSION)).toBeUndefined();
  });

  it("depends on the row's own date: a payment before the first history resolves nothing", () => {
    expect(resolveWiseCardClientFromHistory(cardRow({ createdOn: "2026-06-10 09:00:00", finishedOn: "2026-06-10 09:00:00" }), threeMonths, WISE_DIMENSION)).toBeUndefined();
    expect(resolveWiseCardClientFromHistory(cardRow({ createdOn: "2026-06-20 09:00:00", finishedOn: "2026-06-20 09:00:00" }), threeMonths, WISE_DIMENSION)).toBe(2010417);
  });
});
