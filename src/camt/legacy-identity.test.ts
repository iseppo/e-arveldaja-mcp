import { createHash } from "node:crypto";
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
    ["mixed currency legs without a countervalue (kept unsplit)", wrap(ntry("190.00", "R2", leg("100.00", "EUR") + leg("100.00", "USD")) + ntry("5.00", "R2b", leg("5.00", "EUR"))),
      [oldStoredRow(1, { amount: 95, name: "Supplier OÜ", ref: "R2" }), oldStoredRow(2, { amount: 95, name: "Supplier OÜ", ref: "R2" }), oldStoredRow(3, { amount: 5, name: "Supplier OÜ", ref: "R2b" })]],
    ["detail-less charge sharing its bank reference with a payment", wrap(
      ntry("100.00", "R4", leg("100.00", "EUR", "", "Payee AS", "Arve 1")) + ntry("1.50", "R4", "", "Teenustasu")),
      [oldStoredRow(1, { amount: 100, name: "Payee AS", description: "Arve 1", ref: "R4" }), oldStoredRow(2, { amount: 1.5, ref: "R4" })]],
    // A leg's current key equal to another leg's legacy alias key must not
    // demand two stored rows on a new-version ledger.
    ["detail-less charges with and without AddtlNtryInf sharing a bank reference", wrap(ntry("1.50", "R8", "", "Teenustasu") + ntry("1.50", "R8", "")),
      [oldStoredRow(1, { amount: 1.5, ref: "R8" }), oldStoredRow(2, { amount: 1.5, ref: "R8" })]],
    ["three same-currency legs whose middle countervalue equals the proportional split", wrap(ntry("277.50", "R9", leg("100.00", "USD", "92.00") + leg("100.00", "USD", "92.50") + leg("100.00", "USD", "93.00"))),
      [1, 2, 3].map(id => oldStoredRow(id, { amount: 92.5, name: "Supplier OÜ", ref: "R9" }))],
  ];

  it.each(cases)("%s: creates nothing", async (_name, xml, oldLedger) => {
    const rerun = await project(xml, oldLedger);
    expect(rerun.descriptors).toHaveLength(0);
    expect(rerun.skipped).toHaveLength(rerun.parsed.entries.length);
  });

  it.each(cases)("%s: fresh import and its rerun are unchanged", async (_name, xml) => {
    const fresh = await project(xml, []);
    expect(fresh.descriptors.length).toBeGreaterThan(0);
    const rerun = await project(xml, toLedger(fresh));
    expect(rerun.descriptors).toHaveLength(0);
  });

  it("books a mixed-currency entry without countervalues as one reviewed row", async () => {
    const xml = wrap(ntry("190.00", "R2", leg("100.00", "EUR") + leg("100.00", "USD")) + ntry("5.00", "R2b", leg("5.00", "EUR")));
    const fresh = await project(xml, []);
    expect(fresh.descriptors.map(d => d.payload.amount)).toEqual([190, 5]);
    expect(fresh.descriptors[0]!.entry.review_note).toMatch(/camt:ntry:1/);
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

  it("does not let one old row satisfy both a charge's current key and another charge's alias key", async () => {
    // Old release stored only one empty-description row for these two charges;
    // the charge whose alias key needs a second row is booked.
    const xml = wrap(ntry("1.50", "R8", "", "Teenustasu") + ntry("1.50", "R8", ""));
    const rerun = await project(xml, [oldStoredRow(1, { amount: 1.5, ref: "R8" })]);
    expect(rerun.descriptors).toHaveLength(1);
    expect(rerun.skipped).toHaveLength(1);
  });

  describe("an entry the previous release imported only in part", () => {
    const partialNote = /previous release imported only in part/;

    it("sends an unsplit mixed-currency entry to review when only some old leg rows exist", async () => {
      const xml = wrap(ntry("190.00", "R2", leg("100.00", "EUR") + leg("100.00", "USD")));
      const rerun = await project(xml, [oldStoredRow(1, { amount: 95, name: "Supplier OÜ", ref: "R2" })]);
      expect(rerun.descriptors).toHaveLength(0);
      expect(rerun.skipped).toHaveLength(1);
      expect(rerun.skipped[0]!.review_note).toMatch(partialNote);
      expect(rerun.skipped[0]!.duplicate_transaction_ids).toEqual([1]);
    });

    it("sends the remaining legs of a re-split entry to review instead of booking the new allocation", async () => {
      const xml = wrap(ntry("185.00", "R1", leg("100.00", "USD", "90.00") + leg("100.00", "USD", "95.00")));
      const rerun = await project(xml, [oldStoredRow(1, { amount: 92.5, name: "Supplier OÜ", ref: "R1" })]);
      expect(rerun.descriptors).toHaveLength(0);
      expect(rerun.skipped.map(row => [row.amount, row.review_note !== undefined])).toEqual([[90, false], [95, true]]);
      expect(rerun.skipped[1]!.review_note).toMatch(partialNote);
    });

    it("leaves other entries of the statement to import normally", async () => {
      const xml = wrap(ntry("185.00", "R1", leg("100.00", "USD", "90.00") + leg("100.00", "USD", "95.00")) + ntry("5.00", "R3", leg("5.00", "EUR")));
      const rerun = await project(xml, [oldStoredRow(1, { amount: 92.5, name: "Supplier OÜ", ref: "R1" })]);
      expect(rerun.descriptors.map(d => d.payload.amount)).toEqual([5]);
    });
  });
});

// Rows exactly as the API reads them back: bank_ref_number and bank_account_no
// null, type "C", CONFIRMED, a reassigned client. The marker's sig was taken over
// the FULL description before the stored text was cut to the 150-char cap, so the
// marker fails its checksum; the surviving fields must corroborate it instead.
describe("CAMT re-import against API-read-back rows whose marker sig fails (F3)", () => {
  const MAX = 150;
  const crdt = (o: { amount: string; date: string; ref: string; name: string; iban: string; ustrd: string; strd?: string; dir?: "CRDT" | "DBIT" }) =>
    `<Ntry><Amt Ccy="EUR">${o.amount}</Amt><CdtDbtInd>${o.dir ?? "CRDT"}</CdtDbtInd><BookgDt><Dt>${o.date}</Dt></BookgDt><AcctSvcrRef>${o.ref}</AcctSvcrRef>` +
    `<NtryDtls><TxDtls><RltdPties>${(o.dir ?? "CRDT") === "CRDT"
      ? `<Dbtr><Nm>${o.name}</Nm></Dbtr><DbtrAcct><Id><IBAN>${o.iban}</IBAN></Id></DbtrAcct>`
      : `<Cdtr><Nm>${o.name}</Nm></Cdtr><CdtrAcct><Id><IBAN>${o.iban}</IBAN></Id></CdtrAcct>`}</RltdPties>` +
    `<RmtInf><Ustrd>${o.ustrd}</Ustrd>${o.strd ? `<Strd><CdtrRefInf><Ref>${o.strd}</Ref></CdtrRefInf></Strd>` : ""}</RmtInf></TxDtls></NtryDtls></Ntry>`;
  const E682 = {
    amount: "682.00", date: "2026-09-24", ref: "TRUNC-REF-0001", name: "Payer Ministry", iban: "EE471000001020145685",
    ustrd: "RKID:20260924000400000001 EXAMPLE FOUNDATION FOR INNOVATION SA 2026 14 09.09.2026", strd: "57700816",
  };
  const parse = (xml: string) => {
    const preflight = preflightCamt053Xml(xml);
    if (!preflight.ok) throw new Error("preflight rejected");
    return preflight.value.entries;
  };
  /** Independent re-statement of the marker signature (not imported from the module). */
  const norm = (value?: string) => value?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
  const sig = (e: ParsedCamtEntry, type: string, withDirection: boolean) => {
    const parts: string[] = [
      "sha256:" + createHash("sha256").update(e.bank_reference!).digest("hex"), e.date, type, e.currency,
      e.amount.toFixed(2), norm(e.reference_number), norm(e.counterparty_iban), norm(e.counterparty_name), norm(e.description),
    ];
    if (withDirection) parts.push(e.direction);
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
  };
  /** What a renderer writes: text cut to the budget the marker leaves, then trimEnd. */
  const render = (text: string, marker: string) => {
    const budget = MAX - marker.length - 1;
    return `${text.length > budget ? text.slice(0, budget).trimEnd() : text}\n${marker}`;
  };
  const apiRow = (id: number, e: ParsedCamtEntry, description: string, over: Partial<Transaction> = {}): Transaction => ({
    id, status: "CONFIRMED", accounts_dimensions_id: DIM, type: "C", amount: e.amount, cl_currencies_id: "EUR", date: e.date,
    description, bank_account_name: e.counterparty_name, bank_account_no: null, ref_number: e.reference_number ?? null,
    bank_ref_number: null, clients_id: 4242, ...over,
  }) as Transaction;
  const currentRow = (id: number, e: ParsedCamtEntry, over: Partial<Transaction> = {}) =>
    apiRow(id, e, buildCamtDescriptionWithMetadata(e.description, e)!, over);
  const legacyMarker = (e: ParsedCamtEntry, signature = sig(e, e.direction === "CRDT" ? "D" : "C", false)) =>
    `[e-arveldaja-mcp:camt br=${e.bank_reference} iban=${e.counterparty_iban} sig=${signature}]`;
  const projectEntries = (xml: string, ledger: Transaction[]) => project(xml, ledger);
  const skippedAsDuplicate = (p: Awaited<ReturnType<typeof project>>) =>
    p.skipped.filter(row => row.reason === "Existing transaction matched by bank reference" && row.review_note === undefined);

  it("skips the truncated 682 row (current marker, sig over the untruncated text)", async () => {
    const xml = wrap(crdt(E682));
    const [entry] = parse(xml);
    const row = currentRow(9001, entry!);
    expect(row.description!.length).toBe(MAX);
    const rerun = await projectEntries(xml, [row]);
    expect(rerun.descriptors).toHaveLength(0);
    expect(skippedAsDuplicate(rerun).map(r => r.duplicate_transaction_ids)).toEqual([[9001]]);
  });

  it("skips a legacy dir-less untruncated row signed with type D", async () => {
    const xml = wrap(crdt({ amount: "15.00", date: "2026-06-12", ref: "LEG-REF-1", name: "Small Payer", iban: "EE382200221020145685", ustrd: "Arve 15" }));
    const [entry] = parse(xml);
    const rerun = await projectEntries(xml, [apiRow(9002, entry!, `${entry!.description}\n${legacyMarker(entry!)}`)]);
    expect(rerun.descriptors).toHaveLength(0);
    expect(skippedAsDuplicate(rerun)).toHaveLength(1);
  });

  it("skips a legacy dir-less row truncated at the cap", async () => {
    const xml = wrap(crdt({ ...E682, ref: "LEG-REF-2", amount: "16.00" }));
    const [entry] = parse(xml);
    const description = render(entry!.description!, legacyMarker(entry!));
    expect(description.length).toBeLessThanOrEqual(MAX);
    const rerun = await projectEntries(xml, [apiRow(9003, entry!, description)]);
    expect(rerun.descriptors).toHaveLength(0);
    expect(skippedAsDuplicate(rerun)).toHaveLength(1);
  });

  it("skips a row whose cut landed on whitespace (trimEnd leaves it under 150)", async () => {
    // This marker leaves a 57-char budget; characters 56-57 are spaces, so the renderer stores 55.
    const xml = wrap(crdt({ ...E682, ref: "TRIM-REF-1", ustrd: `RKID:${"1".repeat(50)}  SA 2026 14 09.09.2026` }));
    const [entry] = parse(xml);
    const row = currentRow(9013, entry!);
    expect(row.description!.length).toBeLessThan(MAX);
    const rerun = await projectEntries(xml, [row]);
    expect(rerun.descriptors).toHaveLength(0);
  });

  it("skips a legacy row whose stored text is longer than today's truncation (IKEA shape)", async () => {
    const xml = wrap(crdt({ amount: "170.90", date: "2026-05-22", ref: "1E569879CB55F111BB420A0159F9DEBB", name: "RUNIKON RETAIL OÜ", iban: "EE582200221083078634", ustrd: "IKEA.COM/EE/EE, st683943, 961358341328", dir: "DBIT" }));
    const [entry] = parse(xml);
    const description = `${entry!.description}\n${legacyMarker(entry!)}`;
    // Today's marker is longer (dir=), so today's renderer would cut the text.
    expect(buildCamtDescriptionWithMetadata(entry!.description, entry!)!.split("\n")[0]!.length).toBeLessThan(entry!.description!.length);
    const rerun = await projectEntries(xml, [apiRow(9004, entry!, description)]);
    expect(rerun.descriptors).toHaveLength(0);
    expect(skippedAsDuplicate(rerun)).toHaveLength(1);
  });

  describe("does not skip without corroboration", () => {
    const xml = wrap(crdt({ ...E682, ref: "NEW-REF-682" }));
    const entry = () => parse(xml)[0]!;
    const expectNotSkipped = async (ledger: Transaction[]) => {
      const rerun = await projectEntries(xml, ledger);
      expect(rerun.descriptors).toHaveLength(1);
      expect(skippedAsDuplicate(rerun)).toHaveLength(0);
      return rerun;
    };

    it("a copied marker on another payer's row", async () => {
      await expectNotSkipped([currentRow(9005, entry(), { bank_account_name: "Other payer OU", ref_number: "12345678" })]);
    });

    it("a different stored payer alone", async () => {
      await expectNotSkipped([currentRow(9011, entry(), { bank_account_name: "Other payer OU" })]);
    });

    it("a different stored reference number alone", async () => {
      await expectNotSkipped([currentRow(9012, entry(), { ref_number: "12345678" })]);
    });

    it("a copied marker with an edited description", async () => {
      const description = currentRow(0, entry()).description!.replace("EXAMPLE", "EXAMPLX");
      const rerun = await expectNotSkipped([apiRow(9006, entry(), description)]);
      expect(rerun.descriptors[0]!.possibleDuplicateMatches.map(m => m.id)).toEqual([9006]);
    });

    it("stored text shorter than the description without being the renderer's cut", async () => {
      const marker = currentRow(0, entry()).description!.split("\n").pop()!;
      await expectNotSkipped([apiRow(9007, entry(), `${entry().description!.slice(0, 20)}\n${marker}`)]);
    });

    it("stored text one character short of the renderer's cut", async () => {
      const [text, marker] = currentRow(0, entry()).description!.split("\n") as [string, string];
      await expectNotSkipped([apiRow(9014, entry(), `${text.slice(0, -1)}\n${marker}`)]);
    });

    it("a direct bank_ref_number contradicting the marker", async () => {
      await expectNotSkipped([currentRow(9008, entry(), { bank_ref_number: "OTHER-REF" })]);
    });

    it("a direct bank_account_no contradicting the entry IBAN", async () => {
      await expectNotSkipped([currentRow(9015, entry(), { bank_account_no: "EE000000000000000000" })]);
    });

    it("a different stored amount", async () => {
      await expectNotSkipped([currentRow(9009, entry(), { amount: 681 })]);
    });

    it("a marker carrying another entry's sig", async () => {
      const other = parse(wrap(crdt({ ...E682, ref: "NEW-REF-682", amount: "683.00" })))[0]!;
      const otherMarker = currentRow(0, other).description!.split("\n").pop()!;
      const [text] = currentRow(0, entry()).description!.split("\n") as [string];
      await expectNotSkipped([apiRow(9010, entry(), `${text}\n${otherMarker}`)]);
    });
  });

  it("does not use the signature path for legs sharing a repeated reference", async () => {
    const xml = wrap(ntry("100.00", "SPLIT-REF", leg("50.00", "EUR", "", "Supplier OÜ", "A".repeat(140)) + leg("50.00", "EUR", "", "Supplier OÜ", "B".repeat(140))));
    const entries = parse(xml);
    const ledger = entries.map((e, i) => currentRow(9020 + i, e, { type: "C" }));
    const rerun = await projectEntries(xml, ledger);
    expect(rerun.descriptors).toHaveLength(0);
    expect(skippedAsDuplicate(rerun)).toHaveLength(0);
  });

  it("routes a whole split entry to partial-legacy review when an untrusted marker row carries its reference", async () => {
    const xml = wrap(ntry("185.00", "R1", leg("100.00", "USD", "90.00") + leg("100.00", "USD", "95.00")));
    const entries = parse(xml);
    const old = { ...entries[0]!, amount: 92.5, description: "Supplier invoice 1 ".repeat(8) };
    const stored = apiRow(9030, old, render(old.description, `[e-arveldaja-mcp:camt br=R1 dir=DBIT sig=${"0".repeat(16)}]`));
    const rerun = await projectEntries(xml, [stored]);
    expect(rerun.descriptors).toHaveLength(0);
    expect(rerun.skipped.map(row => row.amount)).toEqual([90, 95]);
    expect(rerun.skipped.every(row => /previous release imported only in part/.test(row.review_note ?? ""))).toBe(true);
  });
});
