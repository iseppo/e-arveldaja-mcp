import { describe, expect, it, vi } from "vitest";
import {
  checkReceiptLedger,
  expectedReceiptBankDirection,
  findRegistrationJournal,
  invoiceLinksFromTransaction,
  verifyInvoiceReceiptLedger,
  type LinkedReceiptInvoice,
  type ReceiptLedgerApi,
} from "./receipt-ledger-check.js";
import type { Journal, Transaction } from "../types/api.js";
import { withSignedCamtMarker } from "../__fixtures__/camt-marker.js";
import { buildCamtEntrySignatureForParsedEntry } from "../camt/duplicate-identity.js";

const BANK_ACCOUNT_ID = 1020;
const BANK_DIMENSION_ID = 500;
const RECEIVABLE_ACCOUNT_ID = 1210;

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 4001,
    accounts_id: BANK_ACCOUNT_ID,
    accounts_dimensions_id: BANK_DIMENSION_ID,
    status: "CONFIRMED",
    type: "D",
    clients_id: 2309260,
    amount: 1488,
    cl_currencies_id: "EUR",
    date: "2026-09-10",
    items: [{ accounts_id: BANK_ACCOUNT_ID, relation_table: "sale_invoices", relation_id: 77, amount: 1488 }],
    ...overrides,
  };
}

const SALE_INVOICE: LinkedReceiptInvoice = {
  gross_price: 1488,
  sale_invoice_type: "INVOICE",
  table: "sale_invoices",
  id: 77,
  clients_id: 2327264,
  ledger_accounts_id: RECEIVABLE_ACCOUNT_ID,
  amount: 1488,
};

function makeRegistrationJournal(overrides: Partial<Journal> = {}): Journal {
  return {
    id: 28013080,
    clients_id: 2327264,
    title: "Laekumine nr 4001, LHV",
    effective_date: "2026-09-10",
    registered: true,
    operations_id: 4001,
    operation_type: "TRANSACTION",
    postings: [
      { accounts_id: BANK_ACCOUNT_ID, accounts_dimensions_id: BANK_DIMENSION_ID, type: "D", amount: 1488 },
      { accounts_id: RECEIVABLE_ACCOUNT_ID, accounts_dimensions_id: null, type: "C", amount: 1488 },
    ],
    ...overrides,
  };
}

describe("findRegistrationJournal", () => {
  it("matches only live TRANSACTION journals of that transaction", () => {
    const journals: Journal[] = [
      makeRegistrationJournal(),
      makeRegistrationJournal({ id: 2, operations_id: 4002 }),
      makeRegistrationJournal({ id: 3, operation_type: "SALE_INVOICE" }),
      makeRegistrationJournal({ id: 4, is_deleted: true }),
    ];

    expect(findRegistrationJournal(journals, 4001).map(j => j.id)).toEqual([28013080]);
  });

  it("ignores the superseded journal left behind by an invalidate/re-confirm cycle", () => {
    const journals: Journal[] = [
      makeRegistrationJournal({ id: 28013079, registered: false }),
      makeRegistrationJournal({ id: 28013090, registered: true }),
    ];

    expect(findRegistrationJournal(journals, 4001).map(j => j.id)).toEqual([28013090]);
  });
});

describe("checkReceiptLedger", () => {
  it("B1 refuses foreign journal nominal values without proven EUR base",()=>{
    const tx=withSignedCamtMarker(makeTransaction({amount:1600,base_amount:1488,cl_currencies_id:"USD"}),"CRDT");
    const journal=makeRegistrationJournal({cl_currencies_id:"USD",postings:[
      {accounts_id:BANK_ACCOUNT_ID,accounts_dimensions_id:BANK_DIMENSION_ID,type:"D",amount:1488,cl_currencies_id:"USD"},
      {accounts_id:RECEIVABLE_ACCOUNT_ID,type:"C",amount:1488,cl_currencies_id:"USD"},
    ]});
    expect(checkReceiptLedger({tx,invoices:[SALE_INVOICE],journals:[journal]})).toMatchObject({ok:false,code:"ledger_posting_mismatch",details:{transaction_id:4001,journal_id:28013080}});
  });
  it("B1 refuses negative postings instead of erasing their sign",()=>{
    const journal=makeRegistrationJournal({postings:[
      {accounts_id:BANK_ACCOUNT_ID,accounts_dimensions_id:BANK_DIMENSION_ID,type:"D",amount:-1488},
      {accounts_id:RECEIVABLE_ACCOUNT_ID,type:"C",amount:-1488},
    ]});
    expect(checkReceiptLedger({tx:makeTransaction(),invoices:[SALE_INVOICE],journals:[journal]})).toMatchObject({ok:false,code:"ledger_posting_mismatch",details:{transaction_id:4001,journal_id:28013080}});
  });
  it("B1 preserves explicit USD108/base EUR100/rate1.08 journal proof",()=>{
    const tx=withSignedCamtMarker(makeTransaction({amount:108,base_amount:100,currency_rate:1.08,cl_currencies_id:"USD"}),"CRDT");
    const journal=makeRegistrationJournal({cl_currencies_id:"USD",postings:[
      {accounts_id:BANK_ACCOUNT_ID,accounts_dimensions_id:BANK_DIMENSION_ID,type:"D",amount:108,base_amount:100,currency_rate:1.08},
      {accounts_id:RECEIVABLE_ACCOUNT_ID,type:"C",amount:108,base_amount:100,currency_rate:1.08},
    ]});
    expect(checkReceiptLedger({tx,invoices:[{...SALE_INVOICE,amount:100}],journals:[journal]})).toEqual({ok:true,journal_id:28013080});
  });
  it("derives normal unsigned sale direction independently of native GET type C",()=>{
    expect(checkReceiptLedger({tx:makeTransaction({type:"C"}),invoices:[SALE_INVOICE],journals:[makeRegistrationJournal()]})).toEqual({ok:true,journal_id:28013080});
  });
  it("derives positive ordinary purchase direction without a statement marker",()=>{
    const invoice:LinkedReceiptInvoice={...SALE_INVOICE,table:"purchase_invoices",ledger_accounts_id:2310};
    const journal=makeRegistrationJournal({postings:[{accounts_id:BANK_ACCOUNT_ID,accounts_dimensions_id:BANK_DIMENSION_ID,type:"C",amount:1488},{accounts_id:2310,type:"D",amount:1488}]});
    expect(checkReceiptLedger({tx:makeTransaction({type:"C"}),invoices:[invoice],journals:[journal]})).toEqual({ok:true,journal_id:28013080});
  });
  it("accepts explicit Wise importer provenance while refusing reversed cash direction",()=>{
    const tx=makeTransaction({type:"C",description:"WISE:TRANSFER-4001 payer reference [source_direction=IN]"});
    expect(checkReceiptLedger({tx,invoices:[SALE_INVOICE],journals:[makeRegistrationJournal()]})).toEqual({ok:true,journal_id:28013080});
    const reversed=makeRegistrationJournal({postings:[{accounts_id:BANK_ACCOUNT_ID,accounts_dimensions_id:BANK_DIMENSION_ID,type:"C",amount:1488},{accounts_id:RECEIVABLE_ACCOUNT_ID,type:"D",amount:1488}]});
    expect(checkReceiptLedger({tx,invoices:[SALE_INVOICE],journals:[reversed]})).toMatchObject({ok:false,details:{expected_type:"D",expectation_source:"wise_importer_marker"}});
  });
  it.each(["CRDT","DBIT"] as const)("checks %s direction independently of actual posting sides", direction => {
    const incoming=direction==="CRDT";
    const tx=withSignedCamtMarker(makeTransaction({type:"C"}),direction);
    const invoices: LinkedReceiptInvoice[]=[incoming?SALE_INVOICE:{...SALE_INVOICE,table:"purchase_invoices",ledger_accounts_id:2310}];
    const good=makeRegistrationJournal({postings:[
      {accounts_id:BANK_ACCOUNT_ID,accounts_dimensions_id:BANK_DIMENSION_ID,type:incoming?"D":"C",amount:1488},
      {accounts_id:incoming?RECEIVABLE_ACCOUNT_ID:2310,type:incoming?"C":"D",amount:1488},
    ]});
    expect(checkReceiptLedger({tx,invoices,journals:[good]})).toEqual({ok:true,journal_id:28013080});
    const reversed={...good,postings:good.postings!.map(row=>({...row,type:row.type==="D"?"C" as const:"D" as const}))};
    expect(checkReceiptLedger({tx,invoices,journals:[reversed]})).toMatchObject({ok:false,code:"ledger_posting_mismatch",details:{transaction_id:4001,journal_id:28013080,leg:"bank",expected_type:incoming?"D":"C",expectation_source:"camt_checksum"}});
  });
  it.each([
    {...SALE_INVOICE,sale_invoice_type:"CREDIT_INVOICE"},
    {...SALE_INVOICE,credit_sale_invoices_id:19},
    {...SALE_INVOICE,gross_price:-1488},
    {...SALE_INVOICE,gross_price:undefined},
  ])("leaves incomplete or credit/refund semantics unverified: %j", invoice=>{
    const result=checkReceiptLedger({tx:makeTransaction({type:"C"}),invoices:[invoice],journals:[makeRegistrationJournal()]});
    expect(result).toMatchObject({ok:true,unverified:expect.arrayContaining([expect.stringMatching(/^direction:/)])});
  });
  it("leaves mixed sale and purchase semantics unverified without a signed source",()=>{
    const result=checkReceiptLedger({tx:makeTransaction({type:"C"}),invoices:[{...SALE_INVOICE,amount:744},{...SALE_INVOICE,table:"purchase_invoices",amount:744}],journals:[makeRegistrationJournal()]});
    expect(result).toMatchObject({ok:true,unverified:expect.arrayContaining([expect.stringMatching(/^direction:/)])});
  });
  describe("legacy CAMT marker without dir= (live 2026-10-28, 6b)",()=>{
    /** What a release before the signed direction wrote: signed over the stored type (CRDT → D, DBIT → C), no dir field. */
    const legacyRow=(direction:"CRDT"|"DBIT",text="Arve 77",over:Partial<Transaction>={})=>{
      const base=makeTransaction({type:"C",bank_account_name:"Payer OÜ",bank_account_no:"EE382200221020145685",ref_number:"77",...over});
      const entry={bank_reference:"REF4001",date:base.date,amount:base.amount,currency:"EUR",direction,counterparty_name:base.bank_account_name!,counterparty_iban:base.bank_account_no!,reference_number:base.ref_number!,description:text};
      const signature=buildCamtEntrySignatureForParsedEntry(entry as never,text,true)!;
      return {...base,description:`${text}\n[e-arveldaja-mcp:camt br=REF4001 iban=${base.bank_account_no} sig=${signature}]`};
    };
    const purchase:LinkedReceiptInvoice={...SALE_INVOICE,table:"purchase_invoices",ledger_accounts_id:2310};
    const outgoing=makeRegistrationJournal({postings:[{accounts_id:BANK_ACCOUNT_ID,accounts_dimensions_id:BANK_DIMENSION_ID,type:"C",amount:1488},{accounts_id:2310,type:"D",amount:1488}]});

    it("a legacy CRDT marker on a type-C row verifies as incoming and checks the direction",()=>{
      const tx=legacyRow("CRDT");
      expect(expectedReceiptBankDirection(tx,[SALE_INVOICE])).toEqual({direction:"D",source:"camt_checksum_legacy"});
      expect(checkReceiptLedger({tx,invoices:[SALE_INVOICE],journals:[makeRegistrationJournal()]})).toEqual({ok:true,journal_id:28013080});
      expect(checkReceiptLedger({tx,invoices:[SALE_INVOICE],journals:[outgoing]})).toMatchObject({ok:false,code:"ledger_posting_mismatch",details:{expected_type:"D",expectation_source:"camt_checksum_legacy"}});
    });
    it("a legacy DBIT marker verifies as outgoing",()=>{
      // Signed over "C", the type GET reads back: the ordinary checksum already verifies it.
      const tx=legacyRow("DBIT");
      expect(expectedReceiptBankDirection(tx,[purchase])).toEqual({direction:"C",source:"camt_checksum"});
      expect(checkReceiptLedger({tx,invoices:[purchase],journals:[outgoing]})).toEqual({ok:true,journal_id:28013080});
    });
    it("a legacy marker whose signature matches neither type stays unverified and never falls back to the invoice direction",()=>{
      const signed=legacyRow("CRDT");
      const tx={...signed,description:signed.description!.replace("Arve 77\n","Arve 78\n")};
      expect(expectedReceiptBankDirection(tx,[SALE_INVOICE])).toEqual({source:"unverified_source_marker"});
      expect(checkReceiptLedger({tx,invoices:[SALE_INVOICE],journals:[makeRegistrationJournal()]})).toMatchObject({ok:true,unverified:expect.arrayContaining([expect.stringMatching(/^direction:/)])});
    });
    it("a marker with dir= and a bad signature is never re-verified by type",()=>{
      const signed=withSignedCamtMarker(makeTransaction({type:"C"}),"CRDT");
      const tx={...signed,description:signed.description!.replace("CRDT","DBIT")};
      expect(expectedReceiptBankDirection(tx,[SALE_INVOICE])).toEqual({source:"unverified_source_marker"});
    });
  });
  it("never falls back to ordinary invoice direction after a CAMT checksum fails",()=>{
    const signed=withSignedCamtMarker(makeTransaction(),"CRDT");
    const tx={...signed,description:signed.description!.replace("CRDT","DBIT")};
    const result=checkReceiptLedger({tx,invoices:[SALE_INVOICE],journals:[makeRegistrationJournal()]});
    expect(result).toMatchObject({ok:true,unverified:expect.arrayContaining([expect.stringMatching(/^direction:/)])});
  });
  it("passes a journal booked to the invoice client with both legs posted", () => {
    const result = checkReceiptLedger({
      tx: makeTransaction(),
      invoices: [SALE_INVOICE],
      journals: [makeRegistrationJournal()],
    });

    expect(result).toEqual({ ok: true, journal_id: 28013080 });
  });

  it("flags a journal booked to the payer instead of the invoice client", () => {
    const result = checkReceiptLedger({
      tx: makeTransaction(),
      invoices: [SALE_INVOICE],
      // Live EIS case: the journal client is copied from the payer transaction.
      journals: [makeRegistrationJournal({ clients_id: 2309260 })],
    });

    expect(result).toMatchObject({
      ok: false,
      code: "ledger_client_mismatch",
      details: {
        transaction_id: 4001,
        transaction_clients_id: 2309260,
        invoice_clients_id: 2327264,
        invoice_table: "sale_invoices",
        invoice_id: 77,
        journal_id: 28013080,
        journal_clients_id: 2309260,
      },
    });
  });

  it("reports a missing registration journal", () => {
    const result = checkReceiptLedger({
      tx: makeTransaction(),
      invoices: [SALE_INVOICE],
      journals: [makeRegistrationJournal({ id: 9, operations_id: 4099 })],
    });

    expect(result).toMatchObject({
      ok: false,
      code: "registration_journal_not_found",
      details: { journal_count: 0, journal_ids: [] },
    });
  });

  it("reports an ambiguous pair of registration journals as not found", () => {
    const result = checkReceiptLedger({
      tx: makeTransaction(),
      invoices: [SALE_INVOICE],
      journals: [makeRegistrationJournal(), makeRegistrationJournal({ id: 28013081 })],
    });

    expect(result).toMatchObject({
      ok: false,
      code: "registration_journal_not_found",
      details: { journal_count: 2, journal_ids: [28013080, 28013081] },
    });
  });

  it("accepts a legacy incoming row stored as type C when the journal debits the bank (verified live)", () => {
    // Imported rows may carry type "C" for money in; the journal's own bank
    // posting decides the direction, and the contra leg must oppose it.
    const result = checkReceiptLedger({
      tx: makeTransaction({ type: "C" }),
      invoices: [SALE_INVOICE],
      journals: [makeRegistrationJournal({
        postings: [
          { accounts_id: BANK_ACCOUNT_ID, accounts_dimensions_id: BANK_DIMENSION_ID, type: "D", amount: 1488 },
          { accounts_id: RECEIVABLE_ACCOUNT_ID, accounts_dimensions_id: null, type: "C", amount: 1488 },
        ],
      })],
    });

    expect(result).toMatchObject({ ok: true });
  });

  it("flags a bank leg that is missing or split across both sides", () => {
    const missing = checkReceiptLedger({
      tx: makeTransaction(),
      invoices: [SALE_INVOICE],
      journals: [makeRegistrationJournal({
        postings: [
          { accounts_id: 9999, accounts_dimensions_id: null, type: "D", amount: 1488 },
          { accounts_id: RECEIVABLE_ACCOUNT_ID, type: "C", amount: 1488 },
        ],
      })],
    });
    expect(missing).toMatchObject({
      ok: false,
      code: "ledger_posting_mismatch",
      details: { leg: "bank", expected_amount: 1488, posted_amount: 0, posted_types: [] },
    });

    const split = checkReceiptLedger({
      tx: makeTransaction(),
      invoices: [SALE_INVOICE],
      journals: [makeRegistrationJournal({
        postings: [
          { accounts_id: BANK_ACCOUNT_ID, accounts_dimensions_id: BANK_DIMENSION_ID, type: "D", amount: 1488 },
          { accounts_id: BANK_ACCOUNT_ID, accounts_dimensions_id: BANK_DIMENSION_ID, type: "C", amount: 1488 },
          { accounts_id: RECEIVABLE_ACCOUNT_ID, type: "C", amount: 1488 },
        ],
      })],
    });
    expect(split).toMatchObject({ ok: false, code: "ledger_posting_mismatch", details: { leg: "bank" } });
  });

  it("flags a contra leg on the same side as the bank leg", () => {
    const result = checkReceiptLedger({
      tx: makeTransaction(),
      invoices: [SALE_INVOICE],
      journals: [makeRegistrationJournal({
        postings: [
          { accounts_id: BANK_ACCOUNT_ID, accounts_dimensions_id: BANK_DIMENSION_ID, type: "D", amount: 1488 },
          { accounts_id: RECEIVABLE_ACCOUNT_ID, type: "D", amount: 1488 },
        ],
      })],
    });
    expect(result).toMatchObject({
      ok: false,
      code: "ledger_posting_mismatch",
      details: { leg: "invoice", expected_type: "C", posted_amount: 1488, posted_types:["D"] },
    });
  });

  it("flags a contra leg posted to a different account than the invoice's receivable", () => {
    const result = checkReceiptLedger({
      tx: makeTransaction(),
      invoices: [SALE_INVOICE],
      journals: [makeRegistrationJournal({
        postings: [
          { accounts_id: BANK_ACCOUNT_ID, accounts_dimensions_id: BANK_DIMENSION_ID, type: "D", amount: 1488 },
          { accounts_id: 2310, type: "C", amount: 1488 },
        ],
      })],
    });

    expect(result).toMatchObject({
      ok: false,
      code: "ledger_posting_mismatch",
      details: { leg: "invoice", expected_accounts_ids: [RECEIVABLE_ACCOUNT_ID], posted_amount: 0 },
    });
  });

  it("measures the contra leg against the invoice row, not the transaction total", () => {
    // 1500 paid: 1488 settles the invoice, 12 is booked straight to a GL account.
    const result = checkReceiptLedger({
      tx: makeTransaction({
        amount: 1500,
        items: [
          { accounts_id: BANK_ACCOUNT_ID, relation_table: "sale_invoices", relation_id: 77, amount: 1488 },
          { accounts_id: 5120, relation_table: "accounts", relation_id: 5120, amount: 12 },
        ],
      }),
      invoices: [SALE_INVOICE],
      journals: [makeRegistrationJournal({
        postings: [
          { accounts_id: BANK_ACCOUNT_ID, accounts_dimensions_id: BANK_DIMENSION_ID, type: "D", amount: 1500 },
          { accounts_id: RECEIVABLE_ACCOUNT_ID, type: "C", amount: 1488 },
          { accounts_id: 5120, type: "C", amount: 12 },
        ],
      })],
    });

    expect(result).toEqual({ ok: true, journal_id: 28013080 });
  });

  it("accepts an FX receipt whose exchange difference is booked on its own leg", () => {
    const result = checkReceiptLedger({
      tx: makeTransaction({ amount: 1500 }),
      invoices: [{ ...SALE_INVOICE, amount: 1455 }],
      journals: [makeRegistrationJournal({
        postings: [
          { accounts_id: BANK_ACCOUNT_ID, accounts_dimensions_id: BANK_DIMENSION_ID, type: "D", amount: 1500 },
          { accounts_id: RECEIVABLE_ACCOUNT_ID, type: "C", amount: 1455 },
          { accounts_id: 6070, type: "C", amount: 45 },
        ],
      })],
    });

    expect(result).toEqual({ ok: true, journal_id: 28013080 });
  });

  it("reports an unverifiable contra leg when an invoice distribution amount is unknown", () => {
    const result = checkReceiptLedger({
      tx: makeTransaction(),
      invoices: [{ ...SALE_INVOICE, amount: null }],
      journals: [makeRegistrationJournal({
        postings: [
          { accounts_id: BANK_ACCOUNT_ID, accounts_dimensions_id: BANK_DIMENSION_ID, type: "D", amount: 1488 },
          { accounts_id: RECEIVABLE_ACCOUNT_ID, type: "C", amount: 999 },
        ],
      })],
    });

    expect(result).toEqual({
      ok: true,
      journal_id: 28013080,
      unverified: ["invoice_leg: the transaction carries no distribution amount for every linked invoice"],
    });
  });

  it("compares the EUR equivalent of a foreign-currency receipt", () => {
    const result = checkReceiptLedger({
      tx: makeTransaction({ amount: 1600, base_amount: 1488, cl_currencies_id: "USD" }),
      invoices: [SALE_INVOICE],
      journals: [makeRegistrationJournal({
        postings: [
          { accounts_id: BANK_ACCOUNT_ID, accounts_dimensions_id: BANK_DIMENSION_ID, type: "D", amount: 1600, base_amount: 1488 },
          { accounts_id: RECEIVABLE_ACCOUNT_ID, type: "C", amount: 1600, base_amount: 1488 },
        ],
      })],
    });

    expect(result).toEqual({ ok: true, journal_id: 28013080 });
  });

  it("reports an unverifiable client leg instead of passing it off as checked", () => {
    const result = checkReceiptLedger({
      tx: makeTransaction(),
      invoices: [{ ...SALE_INVOICE, clients_id: null }],
      journals: [makeRegistrationJournal()],
    });

    expect(result).toEqual({
      ok: true,
      journal_id: 28013080,
      unverified: ["client_leg: linked invoices carry no single clients_id"],
    });
  });
});

describe("invoiceLinksFromTransaction", () => {
  it("collects distinct invoice relations and ignores account-only items", () => {
    const tx = makeTransaction({
      items: [
        { accounts_id: 1, relation_table: "sale_invoices", relation_id: 77, amount: 600 },
        { accounts_id: 1, relation_table: "sale_invoices", relation_id: 77, amount: 400 },
        { accounts_id: 1, relation_table: "purchase_invoices", relation_id: 88, amount: 40 },
        { accounts_id: 1, relation_table: "accounts", relation_id: 5120, amount: 12 },
        { accounts_id: 1 },
      ],
    });

    expect(invoiceLinksFromTransaction(tx)).toEqual([
      { table: "sale_invoices", id: 77, amount: 1000 },
      { table: "purchase_invoices", id: 88, amount: 40 },
    ]);
  });

  it("prefers the EUR base amount and reports an unknown amount as null", () => {
    const tx = makeTransaction({
      amount:1600,base_amount:1488,cl_currencies_id:"USD",
      items: [
        { accounts_id: 1, relation_table: "sale_invoices", relation_id: 77, amount: 1600, base_amount: 1488 },
        { accounts_id: 1, relation_table: "purchase_invoices", relation_id: 88 },
        { accounts_id: 1, relation_table: "purchase_invoices", relation_id: 88, amount: 25 },
      ],
    });

    expect(invoiceLinksFromTransaction(tx)).toEqual([
      { table: "sale_invoices", id: 77, amount: 1488 },
      { table: "purchase_invoices", id: 88, amount: null },
    ]);
  });
});

describe("verifyInvoiceReceiptLedger", () => {
  function makeApi(overrides: {
    tx?: Transaction;
    journals?: Journal[];
    saleInvoice?: Record<string, unknown>;
  } = {}) {
    const api = {
      transactions: { get: vi.fn().mockResolvedValue(overrides.tx ?? makeTransaction()) },
      saleInvoices: {
        get: vi.fn().mockResolvedValue(overrides.saleInvoice
          ?? { id: 77, clients_id: 2327264, receivable_accounts_id: RECEIVABLE_ACCOUNT_ID, gross_price: 1488, sale_invoice_type: "INVOICE" }),
      },
      purchaseInvoices: { get: vi.fn().mockResolvedValue({ id: 88, clients_id: 5, liability_accounts_id: 2310 }) },
      journals: {
        listAll: vi.fn().mockResolvedValue(overrides.journals ?? [makeRegistrationJournal()]),
        get: vi.fn().mockResolvedValue(makeRegistrationJournal()),
      },
    };
    return api;
  }

  it("skips a transaction with no invoice item without fetching journals", async () => {
    const api = makeApi({ tx: makeTransaction({ items: [{ accounts_id: 5120, relation_table: "accounts", relation_id: 5120 }] }) });

    const result = await verifyInvoiceReceiptLedger(api as unknown as ReceiptLedgerApi, 4001);

    expect(result).toEqual({ ok: true, skipped: "no_invoice_distribution" });
    expect(api.journals.listAll).not.toHaveBeenCalled();
  });

  it("re-reads the transaction and its invoice, then reports the client mismatch", async () => {
    const api = makeApi({ journals: [makeRegistrationJournal({ clients_id: 2309260 })] });

    const result = await verifyInvoiceReceiptLedger(api as unknown as ReceiptLedgerApi, 4001);

    expect(api.transactions.get).toHaveBeenCalledWith(4001);
    expect(api.saleInvoices.get).toHaveBeenCalledWith(77);
    expect(result).toMatchObject({ ok: false, code: "ledger_client_mismatch" });
  });

  it("passes a correctly booked invoice receipt", async () => {
    const api = makeApi();

    await expect(verifyInvoiceReceiptLedger(api as unknown as ReceiptLedgerApi, 4001))
      .resolves.toEqual({ ok: true, journal_id: 28013080 });
    // Postings came with the day's listing — no per-journal fetch needed.
    expect(api.journals.get).not.toHaveBeenCalled();
  });

  it("reads only the transaction's own day and fetches postings for a bare candidate", async () => {
    const api = makeApi({ journals: [makeRegistrationJournal({ postings: [] })] });

    const result = await verifyInvoiceReceiptLedger(api as unknown as ReceiptLedgerApi, 4001);

    expect(api.journals.listAll).toHaveBeenCalledWith({ start_date: "2026-09-10", end_date: "2026-09-10" });
    expect(api.journals.get).toHaveBeenCalledWith(28013080);
    expect(result).toEqual({ ok: true, journal_id: 28013080 });
  });
});
