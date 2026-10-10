import { describe, it, expect } from "vitest";
import { preflightCamt053Xml } from "./parser.js";
import { computeCamtImportProjection } from "./projection.js";
import { buildCamtDescriptionWithMetadata } from "./duplicate-identity.js";
import type { ParsedCamtEntry, Transaction } from "./types.js";

// Rows stored by the release before CntrValAmt-weighted splitting and the
// AddtlNtryInf description fallback (1007fde) must still be recognised as the
// same bank entries, so upgrading and re-importing a statement books nothing twice.

const DIM = 55;
const wrap = (entries: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Id>s</Id>
<Acct><Id><IBAN>EE637700771011212909</IBAN></Id><Ccy>EUR</Ccy></Acct>${entries}</Stmt></BkToCstmrStmt></Document>`;
const leg = (amount: string, currency: string, counterValue = "", name = "Supplier OÜ", ustrd = "") =>
  `<TxDtls><AmtDtls><TxAmt><Amt Ccy="${currency}">${amount}</Amt></TxAmt>${counterValue ? `<CntrValAmt><Amt Ccy="EUR">${counterValue}</Amt></CntrValAmt>` : ""}</AmtDtls>` +
  `<RltdPties><Cdtr><Nm>${name}</Nm></Cdtr></RltdPties>${ustrd ? `<RmtInf><Ustrd>${ustrd}</Ustrd></RmtInf>` : ""}</TxDtls>`;
const ntry = (amount: string, ref: string, inner: string, addtl = "") =>
  `<Ntry><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-02-04</Dt></BookgDt>` +
  `${ref ? `<AcctSvcrRef>${ref}</AcctSvcrRef>` : ""}${inner ? `<NtryDtls>${inner}</NtryDtls>` : ""}${addtl ? `<AddtlNtryInf>${addtl}</AddtlNtryInf>` : ""}</Ntry>`;

async function project(xml: string, ledger: Transaction[]) {
  const preflight = preflightCamt053Xml(xml);
  if (!preflight.ok) throw new Error(`preflight rejected: ${JSON.stringify(preflight.rejected_fields)}`);
  return computeCamtImportProjection({
    loaded: preflight.value,
    accountsDimensionsId: DIM,
    dateFrom: undefined,
    dateTo: undefined,
    ledgerTransactions: ledger,
    resolveClient: async () => ({}) as never,
    reportProgress: async () => {},
  });
}

/** A row exactly as the 1007fde projection would have written it for a leg. */
function oldStoredRow(id: number, leg: { amount: number; name?: string; description?: string; ref: string }): Transaction {
  const entry: ParsedCamtEntry = {
    date: "2026-02-04", amount: leg.amount, currency: "EUR", direction: "DBIT",
    counterparty_name: leg.name, description: leg.description, bank_reference: leg.ref,
    duplicate: false, duplicate_transaction_ids: [],
  };
  return {
    id, status: "PROJECT", accounts_dimensions_id: DIM, type: "C", amount: leg.amount, cl_currencies_id: "EUR",
    date: "2026-02-04", description: buildCamtDescriptionWithMetadata(leg.description, entry),
    bank_account_name: leg.name, bank_account_no: undefined, ref_number: undefined, bank_ref_number: leg.ref,
  } as Transaction;
}

const toLedger = (projection: Awaited<ReturnType<typeof project>>): Transaction[] =>
  projection.descriptors.map((descriptor, index) =>
    ({ id: 2000 + index, status: "PROJECT", ...descriptor.payload }) as Transaction);

describe("CAMT re-import against rows stored by the previous release", () => {
  const cases: Array<[string, string, Transaction[]]> = [
    ["same foreign currency legs converted at different rates", wrap(ntry("185.00", "R1", leg("100.00", "USD", "90.00") + leg("100.00", "USD", "95.00"))),
      [oldStoredRow(1, { amount: 92.5, name: "Supplier OÜ", ref: "R1" }), oldStoredRow(2, { amount: 92.5, name: "Supplier OÜ", ref: "R1" })]],
    ["countervalue rounding differs from the proportional split", wrap(ntry("91.70", "R1b", leg("33.33", "USD", "30.57") + leg("66.67", "USD", "61.13"))),
      [oldStoredRow(1, { amount: 30.56, name: "Supplier OÜ", ref: "R1b" }), oldStoredRow(2, { amount: 61.14, name: "Supplier OÜ", ref: "R1b" })]],
    ["mixed currency legs with a countervalue", wrap(ntry("190.00", "R2c", leg("100.00", "EUR") + leg("100.00", "USD", "90.00"))),
      [oldStoredRow(1, { amount: 95, name: "Supplier OÜ", ref: "R2c" }), oldStoredRow(2, { amount: 95, name: "Supplier OÜ", ref: "R2c" })]],
    ["detail-less charge sharing its bank reference with a payment", wrap(
      ntry("100.00", "R4", leg("100.00", "EUR", "", "Payee AS", "Arve 1")) + ntry("1.50", "R4", "", "Teenustasu")),
      [oldStoredRow(1, { amount: 100, name: "Payee AS", description: "Arve 1", ref: "R4" }), oldStoredRow(2, { amount: 1.5, ref: "R4" })]],
  ];

  it.each(cases)("%s: creates nothing", async (_name, xml, oldLedger) => {
    const rerun = await project(xml, oldLedger);
    expect(rerun.descriptors).toHaveLength(0);
    expect(rerun.skipped).toHaveLength(oldLedger.length);
  });

  it.each(cases)("%s: fresh import and its rerun are unchanged", async (_name, xml) => {
    const fresh = await project(xml, []);
    expect(fresh.descriptors.length).toBeGreaterThan(0);
    const rerun = await project(xml, toLedger(fresh));
    expect(rerun.descriptors).toHaveLength(0);
  });

  it("keeps the new split amounts and books only the leg a partial new-version ledger lacks", async () => {
    const xml = wrap(ntry("185.00", "R1", leg("100.00", "USD", "90.00") + leg("100.00", "USD", "95.00")));
    const fresh = await project(xml, []);
    expect(fresh.descriptors.map(d => d.payload.amount)).toEqual([90, 95]);
    const partial = await project(xml, toLedger(fresh).slice(0, 1));
    expect(partial.descriptors.map(d => d.payload.amount)).toEqual([95]);
  });

  it("books the second detail-less charge the old release dropped as an in-batch duplicate", async () => {
    // 1007fde gave both charges an empty description, so the second collapsed
    // into the first and only one row was stored. Exactly that one is matched.
    const xml = wrap(ntry("1.50", "R5", "", "Teenustasu A") + ntry("1.50", "R5", "", "Teenustasu B"));
    const rerun = await project(xml, [oldStoredRow(1, { amount: 1.5, ref: "R5" })]);
    expect(rerun.descriptors).toHaveLength(1);
    expect(rerun.skipped).toHaveLength(1);
  });
});
