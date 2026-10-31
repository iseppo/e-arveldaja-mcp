import { describe, expect, it } from "vitest";
import type { PurchaseInvoice, SaleInvoice, Transaction } from "../types/api.js";
import { withSignedCamtMarker } from "../__fixtures__/camt-marker.js";
import { snapshotBankTransaction, compareBankTransactionMaterial, snapshotLinkedInvoice, changedLinkedInvoiceFields } from "./transaction-material-snapshot.js";

const tx = (): Transaction => withSignedCamtMarker({ id: 42, status: "PROJECT", type: "C", amount: 108,
  base_amount: 100, currency_rate: 1.08, cl_currencies_id: "USD", date: "2026-10-18", clients_id: 7,
  accounts_id: 1020, accounts_dimensions_id: 9, bank_accounts_id: 90, bank_account_name: "Supplier",
  bank_account_no: "BE08905767222113", ref_number: "12345", bank_ref_number: "SOURCE42" }, "DBIT", "SOURCE42");

describe("reviewed bank material", () => {
  it.each([
    ["date", "2026-10-19"], ["accounts_id", 1021], ["accounts_dimensions_id", 10], ["bank_accounts_id", 91],
    ["amount", 109], ["base_amount", 101], ["currency_rate", 1.09], ["cl_currencies_id", "GBP"],
    ["clients_id", 99], ["bank_account_name", "External"], ["bank_account_no", "GB123"],
    ["ref_number", "54321"], ["bank_ref_number", "OTHER"], ["description", "changed"],
    ["status", "CONFIRMED"], ["is_deleted", true], ["operation_type", "NEW"],
    ["bank_code", "CHANGED"], ["bank_subtype", "CHANGED"],
    ["items", [{ accounts_id: 2110, relation_table: "purchase_invoices", relation_id: 51, amount: 108 }]],
  ])("detects %s independently of match score", (field, value) => {
    const approved = tx();
    expect(compareBankTransactionMaterial(snapshotBankTransaction(approved), { ...approved, [field]: value }).ok).toBe(false);
  });
  it("binds genuinely re-signed date/direction, not only signature validity", () => {
    const approved = tx();
    const fresh = withSignedCamtMarker({ ...approved, date: "2026-10-19" }, "CRDT", "SOURCE42");
    expect(snapshotBankTransaction(fresh).trusted_direction).toBe("incoming");
    expect(compareBankTransactionMaterial(snapshotBankTransaction(approved), fresh).ok).toBe(false);
  });
  it("never trusts a marker after a signed field changes", () => {
    expect(snapshotBankTransaction({ ...tx(), amount: 999 }).trusted_direction).toBe("unknown");
    expect(snapshotBankTransaction({ ...tx(), description: tx().description!.replace("DBIT", "CRDT") }).direction_proof.verified).toBe(false);
  });
  it("ignores GET type, output nonce, cache and item display ids", () => {
    const approved = tx();
    const fresh = { ...approved, type: "D", cache_time: 999,
      description: `<<UNTRUSTED_OCR_START:abc>>${approved.description}<<UNTRUSTED_OCR_END:abc>>` };
    expect(compareBankTransactionMaterial(snapshotBankTransaction(approved), fresh).ok).toBe(true);
  });
  it("allows only the exact approved client transition and preserves other checks", () => {
    const approved = snapshotBankTransaction(tx());
    expect(compareBankTransactionMaterial(approved, { ...tx(), clients_id: 42 }, { client: { from: 7, to: 42 } }).ok).toBe(true);
    expect(compareBankTransactionMaterial(approved, { ...tx(), clients_id: 99 }, { client: { from: 7, to: 42 } }).ok).toBe(false);
    expect(compareBankTransactionMaterial(approved, { ...tx(), clients_id: 42, base_amount: 99 }, { client: { from: 7, to: 42 } }).ok).toBe(false);
  });
  it.each([0, NaN, Infinity, -Infinity])("refuses invalid evidence even when repeated: %s", amount => {
    const invalid = { ...tx(), amount };
    expect(compareBankTransactionMaterial(snapshotBankTransaction(invalid), invalid).ok).toBe(false);
  });
  it("preserves zero separately from absence and allows unchanged native missing currency", () => {
    const native = { ...tx(), description: null, cl_currencies_id: undefined } as unknown as Transaction;
    expect(snapshotBankTransaction(native).invalid).toEqual([]);
    expect(compareBankTransactionMaterial(snapshotBankTransaction(native), native).ok).toBe(true);
    expect(snapshotBankTransaction({ ...native, base_amount: 0 }).base_amount).toBe(0);
    expect(compareBankTransactionMaterial(snapshotBankTransaction(native), { ...native, base_amount: 0 }).ok).toBe(false);
  });
  it("canonicalizes item ordering while retaining duplicate rows and relation identity", () => {
    const a = { accounts_id: 2110, relation_table: "purchase_invoices", relation_id: 51, amount: 100 };
    const b = { accounts_id: 3000, amount: 8 };
    const approved = { ...tx(), items: [a, b] };
    expect(compareBankTransactionMaterial(snapshotBankTransaction(approved), { ...approved, items: [b, { ...a, id: 777, client_name: "display" }] }).ok).toBe(true);
    expect(compareBankTransactionMaterial(snapshotBankTransaction(approved), { ...approved, items: [a, a, b] }).ok).toBe(false);
  });
  it("normalizes absent null and undefined material equally",()=>{
    const native:Transaction={...tx(),description:null,ref_number:null,clients_id:null};
    expect(compareBankTransactionMaterial(snapshotBankTransaction(native),{...native,description:undefined,ref_number:undefined,clients_id:undefined}).ok).toBe(true);
  });
  it("refuses poisoned or invalid markers even when the same invalid text repeats",()=>{
    const invalid={...tx(),description:tx().description!.replace("DBIT","CRDT")};
    expect(compareBankTransactionMaterial(snapshotBankTransaction(invalid),invalid).ok).toBe(false);
  });
  it("binds linked invoice material independently of the invoice client", () => {
    const invoice: any = { id: 51, clients_id: 7, gross_price: 100, cl_currencies_id: "EUR", bank_ref_number: "REF" };
    const approved = snapshotLinkedInvoice("purchase_invoices", invoice);
    expect(changedLinkedInvoiceFields(approved, { ...invoice, bank_ref_number: "OTHER" })).toContain("bank_ref_number");
    expect(changedLinkedInvoiceFields(approved, { ...invoice, gross_price: 101 })).toContain("gross_price");
  });
  it("binds a purchase invoice's canonical order references, not its other notes", () => {
    const invoice = (notes: string | null) => ({
      id: 5577728, clients_id: 4100, gross_price: 25.2, cl_currencies_id: "EUR", notes,
    }) as unknown as PurchaseInvoice;
    const one = "Bussipilet\nOstukorvi/tellimuse nr: 261018825247";
    const approved = snapshotLinkedInvoice("purchase_invoices", invoice(one));
    expect(approved.order_references).toEqual(["261018825247"]);
    expect(snapshotLinkedInvoice("purchase_invoices", invoice(null)).order_references).toEqual([]);
    // Added, changed and removed references are material.
    expect(changedLinkedInvoiceFields(snapshotLinkedInvoice("purchase_invoices", invoice("Bussipilet")), invoice(one))).toEqual(["order_references"]);
    expect(changedLinkedInvoiceFields(approved, invoice("Ostukorvi/tellimuse nr: 261018825312"))).toEqual(["order_references"]);
    expect(changedLinkedInvoiceFields(approved, invoice("Bussipilet"))).toEqual(["order_references"]);
    // Duplicate or reordered lines and unrelated prose are not.
    const two = snapshotLinkedInvoice("purchase_invoices", invoice("Ostukorvi/tellimuse nr: 2\nOstukorvi/tellimuse nr: 1"));
    expect(two.order_references).toEqual(["1", "2"]);
    expect(changedLinkedInvoiceFields(two, invoice("Ostukorvi/tellimuse nr: 1\nOstukorvi/tellimuse nr: 2\nOstukorvi/tellimuse nr: 1"))).toEqual([]);
    expect(changedLinkedInvoiceFields(approved, invoice("Tallinn-Tartu\nOstukorvi/tellimuse nr: 261018825247 (e-arveldaja-mcp)"))).toEqual([]);
  });
  it("leaves sale invoice material without order references", () => {
    const sale = { id: 501, clients_id: 7, gross_price: 100, cl_currencies_id: "EUR", notes: "Ostukorvi/tellimuse nr: 261018825247" } as unknown as SaleInvoice;
    const approved = snapshotLinkedInvoice("sale_invoices", sale);
    expect(approved.order_references).toBeNull();
    expect(changedLinkedInvoiceFields(approved, { ...sale, notes: "other" } as SaleInvoice)).toEqual([]);
  });
});
