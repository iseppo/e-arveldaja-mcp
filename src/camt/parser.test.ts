import { describe, it, expect } from "vitest";
import { parseCamt053Xml, preflightCamt053Xml } from "./parser.js";

// Focused characterization of the PURE CAMT parser now that it lives in its own
// module. The broader parser coverage stays in tools/camt-import.test.ts (which
// also imports from this module); these cases pin the direction mapping, the
// structural DTD guard, and the accumulating preflight failure shape.

const baseStatement = (entryXml: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>stmt-parser-1</Id>
      <Acct><Id><IBAN>EE637700771011212909</IBAN></Id><Ccy>EUR</Ccy></Acct>
      ${entryXml}
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

const entry = (direction: "CRDT" | "DBIT", amount = "10.00"): string => `
  <Ntry>
    <Amt Ccy="EUR">${amount}</Amt>
    <CdtDbtInd>${direction}</CdtDbtInd>
    <BookgDt><Dt>2026-02-01</Dt></BookgDt>
    <NtryDtls><TxDtls>
      <RltdPties><Cdtr><Nm>Vendor OÜ</Nm></Cdtr></RltdPties>
      <RmtInf><Ustrd>Test payment</Ustrd></RmtInf>
    </TxDtls></NtryDtls>
  </Ntry>`;

describe("camt parser module", () => {
  it("carries CRDT/DBIT direction through to the parsed entry", () => {
    const credit = parseCamt053Xml(baseStatement(entry("CRDT")));
    expect(credit.entries[0]!.direction).toBe("CRDT");
    expect(credit.summary.credit_count).toBe(1);
    expect(credit.summary.credit_total).toBe(10);

    const debit = parseCamt053Xml(baseStatement(entry("DBIT")));
    expect(debit.entries[0]!.direction).toBe("DBIT");
    expect(debit.summary.debit_count).toBe(1);
    expect(debit.summary.debit_total).toBe(10);
  });

  it("rejects DOCTYPE/ENTITY declarations structurally (thrown, not accumulated)", () => {
    const withDtd = `<?xml version="1.0"?><!DOCTYPE Document [<!ENTITY x "y">]>` + baseStatement(entry("CRDT"));
    expect(() => parseCamt053Xml(withDtd)).toThrow(/DOCTYPE or ENTITY/);
    expect(() => preflightCamt053Xml(withDtd)).toThrow(/DOCTYPE or ENTITY/);
  });

  it("accumulates invalid fields with positional row ids in the preflight result", () => {
    const badAmount = entry("CRDT", "abc");
    const result = preflightCamt053Xml(baseStatement(badAmount));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.source).toBe("camt");
      expect(result.rejected_fields.length).toBeGreaterThan(0);
      const first = result.rejected_fields[0]!;
      expect(first.source_row_id).toBe("camt:ntry:1");
      // No file-supplied statement id / counterparty leaks into the identity.
      expect(first.source_row_id).not.toContain("stmt-parser-1");
    }
    // The value-returning parser throws a fixed message on any invalid field.
    expect(() => parseCamt053Xml(baseStatement(badAmount))).toThrow(/invalid field/);
  });
});
