import { describe, it, expect } from "vitest";
import { parseCamt053Xml, preflightCamt053Xml } from "./camt-import.js";

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
  it("H08 preserves whitespace and lowercase in the statement IBAN for later binding normalization", () => {
    const parsed = parseCamt053Xml(sampleXml.replace(
      "EE637700771011212909",
      "ee63 7700 7710 1121 2909",
    ));

    expect(parsed.statement_metadata.iban).toBe("ee63 7700 7710 1121 2909");
  });

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

// --- M05: strict CAMT row validation -----------------------------------------
//
// The statement <Id> is attacker-controlled (any counterparty can send a
// statement), so it must never appear in a source_row_id. These fixtures use a
// sentinel <Id> that the identity assertions prove absent.
const SENTINEL_STATEMENT_ID = "SENTINEL-STMT-ID-DO-NOT-LEAK";

// Positional, non-attacker-controlled identities only.
const M05_CAMT_ROW_ID_RE = /^camt:(statement:1|balance:\d+|ntry:\d+(:tx:\d+)?)$/;

function m05CamtXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>${SENTINEL_STATEMENT_ID}</Id>
      <Acct>
        <Id><IBAN>EE637700771011212909</IBAN></Id>
        <Ccy>EUR</Ccy>
      </Acct>
${body}
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
}

function m05Balance(code: string, amount: string, date: string, indicator = "CRDT"): string {
  return `      <Bal>
        <Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">${amount}</Amt>
        <CdtDbtInd>${indicator}</CdtDbtInd>
        <Dt><Dt>${date}</Dt></Dt>
      </Bal>`;
}

function m05Entry(options: {
  amount?: string;
  currency?: string;
  indicator?: string;
  date?: string;
  dateTag?: "Dt" | "DtTm";
  originalAmount?: string;
  originalCurrency?: string;
}): string {
  const {
    amount = "10.00", currency = "EUR", indicator = "DBIT",
    date = "2026-02-01", dateTag = "Dt",
    originalAmount, originalCurrency = "USD",
  } = options;
  const details = originalAmount === undefined
    ? ""
    : `
        <NtryDtls><TxDtls>
          <AmtDtls><TxAmt><Amt Ccy="${originalCurrency}">${originalAmount}</Amt></TxAmt></AmtDtls>
        </TxDtls></NtryDtls>`;
  return `      <Ntry>
        <Amt Ccy="${currency}">${amount}</Amt>
        <CdtDbtInd>${indicator}</CdtDbtInd>
        <BookgDt><${dateTag}>${date}</${dateTag}></BookgDt>${details}
      </Ntry>`;
}

describe("M05 strict CAMT validation", () => {
  // Case 1 (FAIL): accumulate every malformed monetary lexeme across balances,
  // entries, and transaction details, each addressed by a positional row ID.
  it("M05 accumulates malformed monetary lexemes with positional, non-attacker-controlled row IDs", () => {
    const xml = m05CamtXml([
      m05Balance("OPBD", "10oops", "2026-02-01"),
      m05Balance("CLBD", "Infinity", "2026-02-28"),
      m05Entry({ amount: "1,2,3", originalAmount: "1e2" }),
    ].join("\n"));

    const result = preflightCamt053Xml(xml);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable: preflight must reject");

    // Every issue is accumulated — not just the first throw.
    expect(result.rejected_fields).toEqual([
      expect.objectContaining({ source_row_id: "camt:balance:1", field: "amount", value: "10oops" }),
      expect.objectContaining({ source_row_id: "camt:balance:2", field: "amount", value: "Infinity" }),
      expect.objectContaining({ source_row_id: "camt:ntry:1", field: "amount", value: "1,2,3" }),
      expect.objectContaining({ source_row_id: "camt:ntry:1:tx:1", field: "original_amount", value: "1e2" }),
    ]);

    // Identity is positional, and the attacker-controlled statement <Id> leaks
    // into no identity, field name, or reason.
    for (const issue of result.rejected_fields) {
      expect(issue.source_row_id).toMatch(M05_CAMT_ROW_ID_RE);
      expect(issue.source_row_id).not.toContain(SENTINEL_STATEMENT_ID);
      expect(issue.field).not.toContain(SENTINEL_STATEMENT_ID);
      expect(issue.reason).not.toContain(SENTINEL_STATEMENT_ID);
    }
    expect(JSON.stringify(result.rejected_fields)).not.toContain(SENTINEL_STATEMENT_ID);

    // Item 3's positivity rule is a SEPARATE property from the money grammar:
    // "-5" and "0" are well-formed decimals, so only a positivity check
    // rejects them. Booked and original entry amounts must be positive
    // because the sign is carried by CdtDbtInd — a negative <Amt> under CRDT
    // is the silent sign-inversion the rule exists to stop.
    const negative = preflightCamt053Xml(m05CamtXml(
      m05Entry({ amount: "-5", originalAmount: "-1.50" }),
    ));
    expect(negative.ok).toBe(false);
    if (!negative.ok) {
      expect(negative.rejected_fields).toEqual([
        expect.objectContaining({ source_row_id: "camt:ntry:1", field: "amount", value: "-5" }),
        expect.objectContaining({ source_row_id: "camt:ntry:1:tx:1", field: "original_amount", value: "-1.50" }),
      ]);
    }
    const zeroEntry = preflightCamt053Xml(m05CamtXml(m05Entry({ amount: "0.00" })));
    expect(zeroEntry.ok).toBe(false);
    if (!zeroEntry.ok) {
      expect(zeroEntry.rejected_fields).toEqual([
        expect.objectContaining({ source_row_id: "camt:ntry:1", field: "amount", value: "0.00" }),
      ]);
    }

    // Regex-legal digits that Number() overflows to Infinity. Only the
    // finiteness check rejects this: Infinity passes the positivity test
    // above, so without it a non-finite amount reaches the ledger.
    const overflowing = preflightCamt053Xml(m05CamtXml(m05Entry({ amount: "9".repeat(400) })));
    expect(overflowing.ok).toBe(false);
    if (!overflowing.ok) {
      expect(overflowing.rejected_fields).toEqual([
        expect.objectContaining({
          source_row_id: "camt:ntry:1", field: "amount", reason: "CAMT amount must be finite",
        }),
      ]);
    }

    // A missing booking date is a REJECTION, not a skip. If it merely returned
    // undefined the entry would be dropped from the import while preflight
    // still reported ok:true — a silent omission from the ledger with no
    // rejection and no flag anywhere.
    const missingDate = preflightCamt053Xml(m05CamtXml(
      `      <Ntry>
        <Amt Ccy="EUR">10.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
      </Ntry>`,
    ));
    expect(missingDate.ok, "a missing booking date must reject, never silently drop the entry").toBe(false);
    if (!missingDate.ok) {
      expect(missingDate.rejected_fields).toEqual([
        expect.objectContaining({
          source_row_id: "camt:ntry:1", field: "booking_date",
          reason: "CAMT entry is missing a booking date",
          // An ABSENT field echoes as "", never the string "undefined": this
          // sink passes an undefined value, and wrapUntrustedOcr("") returns
          // "" unwrapped while "undefined" would mint a spurious sandbox block
          // around a value the file never contained.
          value: "",
        }),
      ]);
    }

    // The contrast item 3 draws: a BALANCE may legitimately be zero, so the
    // same lexeme that rejects on an entry must be accepted here.
    const zeroBalance = preflightCamt053Xml(m05CamtXml([
      m05Balance("OPBD", "0.00", "2026-02-01"),
      m05Entry({}),
    ].join("\n")));
    expect(zeroBalance.ok, "a zero balance is valid and must not be rejected").toBe(true);
  });

  // Case 2 (FAIL): dates, clocks, offsets, currency syntax, and direction.
  it("M05 rejects impossible dates, clocks, offsets, currency syntax, and CdtDbtInd", () => {
    // Genuine RED through the EXISTING parseCamt053Xml binding, routed to each
    // of the two date sinks separately. normalizeDate() is `split("T")[0]`, so
    // both are silently accepted today.
    //
    // Balance-date sink (camt-import.ts:916). `.replace` with a string pattern
    // hits only the FIRST `>2026-02-01<`, which is the OPBD balance date.
    // The message is matched, not just the throw: item 4 mandates a FIXED,
    // non-echoing exception. A bare .toThrow() would equally accept a message
    // built from the rejected lexemes themselves, which is what the base did
    // (f20ccae:476) and is exactly the raw echo this sink exists to close.
    const fixedNonEchoing = /contains \d+ invalid field/;
    expect(() => parseCamt053Xml(sampleXml.replace(">2026-02-01<", ">2026-02-30<")))
      .toThrow(fixedNonEchoing);
    // Entry-booking-date sink (camt-import.ts:931), reached only by targeting
    // the BookgDt node explicitly.
    expect(() => parseCamt053Xml(
      sampleXml.replace("<BookgDt>\n          <Dt>2026-02-01</Dt>", "<BookgDt>\n          <Dt>2026-02-30</Dt>"),
    )).toThrow(fixedNonEchoing);
    // The offending lexeme must never reach the message.
    expect(() => parseCamt053Xml(sampleXml.replace(">2026-02-01<", ">2026-02-30<")))
      .not.toThrow(/2026-02-30/);

    // Impossible calendar dates and partially consumed date-times. The last
    // three pin the grammar's BOUNDS, not just the presence of each clause:
    // a fraction beyond 9 digits, a bare trailing `.`, and an offset whose
    // minutes exceed 59. Without them `{1,9}` could widen to `{1,12}`, admit
    // an empty fraction, or accept +13:60, with nothing failing.
    for (const date of ["2026-02-30", "2026-13-01", "2026-02-01junk", "2026-02-01T24:00:00+02:00",
                        "2026-02-01T12:60:00+02:00", "2026-02-01T12:00:60+02:00",
                        "2026-02-01T12:00:00+15:00", "2026-02-01T12:00:00+14:01",
                        "2026-02-01T12:00:00.1234567890+02:00", "2026-02-01T12:00:00.+02:00",
                        "2026-02-01T12:00:00+13:60"]) {
      const tag = date.includes("T") ? "DtTm" : "Dt";
      const result = preflightCamt053Xml(m05CamtXml(m05Entry({ date, dateTag: tag })));
      expect(result.ok, `expected rejection for booking date ${date}`).toBe(false);
      if (result.ok) continue;
      expect(result.rejected_fields).toEqual([
        expect.objectContaining({ source_row_id: "camt:ntry:1", field: "booking_date", value: date }),
      ]);
    }

    // Statement period values are validated too (item 3 requires period,
    // balance, and entry booking dates), addressed to the statement row rather
    // than to any entry. Nothing else in the suite covers this clause: without
    // these two assertions the period validation could be deleted outright and
    // every other case would still pass.
    for (const [field, from, to] of [
      ["period_from", "2026-02-30T00:00:00+02:00", "2026-02-28T23:59:59+02:00"],
      ["period_to", "2026-02-01T00:00:00+02:00", "2026-02-31T23:59:59+02:00"],
    ] as const) {
      const badPeriod = preflightCamt053Xml(m05CamtXml(
        `      <FrToDt>
        <FrDtTm>${from}</FrDtTm>
        <ToDtTm>${to}</ToDtTm>
      </FrToDt>
${m05Entry({})}`,
      ));
      expect(badPeriod.ok, `expected rejection for ${field}`).toBe(false);
      if (badPeriod.ok) continue;
      expect(badPeriod.rejected_fields).toEqual([
        expect.objectContaining({
          source_row_id: "camt:statement:1",
          field,
          value: field === "period_from" ? from : to,
        }),
      ]);
    }

    // The statement account currency is attacker-controlled like any other
    // element, and it has two sinks the <Amt Ccy=""> attribute does not:
    // statement_metadata.currency (emitted unwrapped — only statement_id and
    // bank_name are sandbox-wrapped) and, for any <Amt> carrying no Ccy
    // attribute, entries[].currency, which becomes cl_currencies_id on the
    // API mutation payload. It must meet the same three-letter rule.
    const badAccountCurrency = preflightCamt053Xml(
      m05CamtXml(m05Entry({})).replace("<Ccy>EUR</Ccy>", "<Ccy>EURO</Ccy>"),
    );
    expect(badAccountCurrency.ok).toBe(false);
    if (!badAccountCurrency.ok) {
      expect(badAccountCurrency.rejected_fields).toEqual([
        expect.objectContaining({
          source_row_id: "camt:statement:1", field: "account_currency", value: "EURO",
        }),
      ]);
    }

    // Invalid currency syntax.
    const badCurrency = preflightCamt053Xml(m05CamtXml(m05Entry({ currency: "EURO" })));
    expect(badCurrency.ok).toBe(false);
    if (!badCurrency.ok) {
      expect(badCurrency.rejected_fields).toEqual([
        expect.objectContaining({ source_row_id: "camt:ntry:1", field: "amount_currency", value: "EURO" }),
      ]);
    }

    // Invalid direction.
    const badIndicator = preflightCamt053Xml(m05CamtXml(m05Entry({ indicator: "SIDEWAYS" })));
    expect(badIndicator.ok).toBe(false);
    if (!badIndicator.ok) {
      expect(badIndicator.rejected_fields).toEqual([
        expect.objectContaining({ source_row_id: "camt:ntry:1", field: "direction", value: "SIDEWAYS" }),
      ]);
    }

    // A BALANCE direction is a separate binding under a separate row identity
    // from the entry direction above, and it decides the balance's sign. The
    // entry assertion does not reach it.
    const badBalanceDirection = preflightCamt053Xml(m05CamtXml([
      m05Balance("OPBD", "10.00", "2026-02-01", "SIDEWAYS"),
      m05Entry({}),
    ].join("\n")));
    expect(badBalanceDirection.ok).toBe(false);
    if (!badBalanceDirection.ok) {
      expect(badBalanceDirection.rejected_fields).toEqual([
        expect.objectContaining({
          source_row_id: "camt:balance:1", field: "balance_direction", value: "SIDEWAYS",
        }),
      ]);
    }

    // The balance date sink is pinned above only by a bare .toThrow() through
    // parseCamt053Xml, which asserts neither the field nor the row identity.
    const badBalanceDate = preflightCamt053Xml(m05CamtXml([
      m05Balance("OPBD", "10.00", "2026-02-30"),
      m05Entry({}),
    ].join("\n")));
    expect(badBalanceDate.ok).toBe(false);
    if (!badBalanceDate.ok) {
      expect(badBalanceDate.rejected_fields).toEqual([
        expect.objectContaining({
          source_row_id: "camt:balance:1", field: "balance_date", value: "2026-02-30",
        }),
      ]);
    }
  });

  // Case 3 (PASS — declared control): valid input stays compatible. Uses only
  // bindings that exist at M05_IMPLEMENTATION_BASE, so it passes before and
  // after implementation.
  it("M05 control: valid decimals, date-times, lexical dates, and H08 identity bytes are preserved", () => {
    const parsed = parseCamt053Xml(sampleXml);

    // Valid decimals survive untouched.
    expect(parsed.entries.map(entry => entry.amount)).toEqual([150, 240, 0.14]);
    expect(parsed.statement_metadata.opening_balance).toMatchObject({ amount: 128.73, currency: "EUR" });
    expect(parsed.statement_metadata.closing_balance).toMatchObject({ amount: 170.03, currency: "EUR" });

    // Period strings are preserved verbatim, not normalized.
    expect(parsed.statement_metadata.period).toEqual({
      from: "2026-02-01T00:00:00+02:00",
      to: "2026-02-28T23:59:59+02:00",
    });

    // A date-time keeps its LEXICAL calendar prefix — no UTC shifting. +14:00
    // would roll back a day if the value were converted through Date.
    const lexical = parseCamt053Xml(m05CamtXml(
      m05Entry({ date: "2026-02-01T23:59:59.123456789+14:00", dateTag: "DtTm" }),
    ));
    expect(lexical.entries[0]!.date).toBe("2026-02-01");

    // `Z` is the other half of item 3's "Z/offsets through +/-14:00", and the
    // commoner form in real exports. Only the +14:00 branch is exercised
    // above, so without this the `Z|` alternation could be dropped and EVERY
    // UTC-stamped statement would be rejected wholesale, silently.
    const utc = parseCamt053Xml(m05CamtXml(
      m05Entry({ date: "2026-02-01T12:00:00Z", dateTag: "DtTm" }),
    ));
    expect(utc.entries[0]!.date).toBe("2026-02-01");

    // "stored uppercase" (item 3) is a normalization, not just a filter: a
    // lowercase code is ACCEPTED and stored uppercase. Every other fixture
    // supplies uppercase already, so nothing else proves the toUpperCase()
    // step rather than the regex.
    const lowercaseCcy = parseCamt053Xml(m05CamtXml(
      m05Entry({}).replace('Ccy="EUR"', 'Ccy="eur"'),
    ));
    expect(lowercaseCcy.entries[0]!.currency).toBe("EUR");

    // H08: interior whitespace and lowercase in the statement IBAN survive for
    // later binding normalization. (The XML parser trims leading/trailing
    // whitespace itself, so interior spacing is what M05 must not disturb.)
    const h08 = parseCamt053Xml(sampleXml.replace(
      "EE637700771011212909",
      "ee63 7700 7710 1121 2909",
    ));
    expect(h08.statement_metadata.iban).toBe("ee63 7700 7710 1121 2909");
  });
});
