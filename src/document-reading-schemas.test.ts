import { describe, expect, it } from "vitest";
import { READING_FIELDS, parseDocumentReading, parseProof } from "./document-reading-schemas.js";
import { makeAnswer, makeProof, makeReading } from "./__fixtures__/document-reading/readings.js";

const readingCode = (input: unknown) => {
  const outcome = parseDocumentReading(input);
  return outcome.ok ? "ok" : outcome.code;
};
const proofCode = (input: unknown) => {
  const outcome = parseProof(input);
  return outcome.ok ? "ok" : outcome.code;
};

describe("document-reading schemas: document_reading", () => {
  it("T-SC-valid: accepts a well-formed reading, as an object or a JSON string", () => {
    expect(READING_FIELDS).toHaveLength(15);
    expect(readingCode(makeReading())).toBe("ok");
    expect(readingCode(JSON.stringify(makeReading()))).toBe("ok");
    expect(readingCode("{not json")).toBe("reading_schema_invalid");
    expect(readingCode("[1]")).toBe("reading_schema_invalid");
  });

  it("T-SC-unknown-key: refuses an unknown key and `notes`", () => {
    expect(readingCode(makeReading({ extra: 1 }))).toBe("reading_schema_invalid");
    expect(readingCode(makeReading({ notes: "computed from lines" }))).toBe("reading_schema_invalid");
  });

  it("T-SC-evidence-extra-key: refuses an extra key inside evidence and inside an evidence entry", () => {
    expect(readingCode(makeReading({ evidence: { doc_type: { line: "p1:001", quote: "x" } } }))).toBe("reading_schema_invalid");
    expect(readingCode(makeReading({ evidence: { gross: { line: "p1:001", quote: "x", note: "y" } } }))).toBe("reading_schema_invalid");
    expect(readingCode(makeReading({ evidence: { gross: { line: "1:001", quote: "x" } } }))).toBe("reading_schema_invalid");
  });

  it("T-SC-quote-cap: refuses a quote over 200 characters and an empty quote", () => {
    expect(readingCode(makeReading({ evidence: { gross: { line: "p1:001", quote: "x".repeat(201) } } }))).toBe("reading_schema_invalid");
    expect(readingCode(makeReading({ evidence: { gross: { line: "p1:001", quote: "" } } }))).toBe("reading_schema_invalid");
  });

  it("T-SC-size: refuses a reading over 16 KiB (measured as serialized JSON)", () => {
    // A control character serializes as \u0001 (6 bytes), so legal 200-character quotes can pass 16 KiB.
    const evidence = (count: number) => Object.fromEntries(
      READING_FIELDS.filter((f) => f !== "doc_type").slice(0, count).map((field) => [field, { line: "p1:001", quote: "\u0001".repeat(200) }]),
    );
    expect(Buffer.byteLength(JSON.stringify(makeReading({ evidence: evidence(12) })))).toBeLessThan(16 * 1024);
    expect(readingCode(makeReading({ evidence: evidence(12) }))).toBe("ok");
    expect(Buffer.byteLength(JSON.stringify(makeReading({ evidence: evidence(14) })))).toBeGreaterThan(16 * 1024);
    expect(readingCode(makeReading({ evidence: evidence(14) }))).toBe("reading_schema_invalid");
    // whitespace in a JSON string does not count: the decoded object is measured
    expect(readingCode(JSON.stringify(makeReading()) + " ".repeat(20000))).toBe("ok");
  });

  it("T-SC-marker: refuses a string that still carries a sandbox marker", () => {
    expect(readingCode(makeReading({ supplier_name: "<<UNTRUSTED_OCR_START:ab>>Näidis OÜ" }))).toBe("reading_schema_invalid");
    expect(readingCode(makeReading({ evidence: { gross: { line: "p1:001", quote: "x<<UNTRUSTED_OCR_END:ab>>" } } }))).toBe("reading_schema_invalid");
  });

  it("T-SC-amounts: gross > 0, net/vat ≥ 0, two decimals with a float tolerance", () => {
    expect(readingCode(makeReading({ gross: 0 }))).toBe("reading_schema_invalid");
    expect(readingCode(makeReading({ vat: -1 }))).toBe("reading_schema_invalid");
    expect(readingCode(makeReading({ net: 0, vat: 0 }))).toBe("ok");
    expect(readingCode(makeReading({ gross: 0.1 + 0.2 }))).toBe("ok");
    expect(readingCode(makeReading({ gross: 1.234 }))).toBe("reading_schema_invalid");
    expect(readingCode(makeReading({ gross: Number.POSITIVE_INFINITY }))).toBe("reading_schema_invalid");
    expect(readingCode(makeReading({ gross: "124.00" }))).toBe("reading_schema_invalid");
  });

  it("T-SC-fields: dates are strict, currency is three uppercase letters, ids are capped", () => {
    expect(readingCode(makeReading({ invoice_date: "2026-02-30" }))).toBe("reading_schema_invalid");
    expect(readingCode(makeReading({ currency: "eur" }))).toBe("reading_schema_invalid");
    expect(readingCode(makeReading({ supplier_reg: "1".repeat(21) }))).toBe("reading_schema_invalid");
    expect(readingCode(makeReading({ doc_type: "proforma" }))).toBe("reading_schema_invalid");
    expect(readingCode(makeReading({ due_date: undefined }))).toBe("reading_schema_invalid");
  });

  it("T-SC-computed: any computed entry (incl. doc_type) is refused upfront as computed_field", () => {
    expect(readingCode(makeReading({ computed: ["doc_type"] }))).toBe("computed_field");
    expect(readingCode(makeReading({ computed: ["net"] }))).toBe("computed_field");
    expect(readingCode(makeReading({ computed: [] }))).toBe("ok");
  });
});

describe("document-reading schemas: proof", () => {
  it("T-SC-proof-valid: accepts a complete proof, as an object or a JSON string", () => {
    expect(proofCode(makeProof())).toBe("ok");
    expect(proofCode(JSON.stringify(makeProof({}, { proof_context: "fresh" })))).toBe("ok");
    expect(proofCode(makeProof({}, { proof_context: "later" }))).toBe("proof_schema_invalid");
  });

  it("T-SC-proof-missing-key: every one of the 15 answers is required", () => {
    const proof = makeProof();
    delete (proof.answers as Record<string, unknown>).due_date;
    expect(proofCode(proof)).toBe("proof_schema_invalid");
    const answer = makeAnswer();
    delete answer.why_this_one;
    expect(proofCode(makeProof({ gross: answer }))).toBe("proof_schema_invalid");
  });

  it("T-SC-proof-strict: refuses unknown keys at every level", () => {
    expect(proofCode(makeProof({}, { notes: "x" }))).toBe("proof_schema_invalid");
    expect(proofCode(makeProof({ gross: makeAnswer({ extra: 1 }) }))).toBe("proof_schema_invalid");
    expect(proofCode(makeProof({ gross: makeAnswer({ competitors: [{ line: "p1:001", quote: "x", why: "y" }] }) }))).toBe("proof_schema_invalid");
    expect(proofCode(makeProof({ gross: makeAnswer({ verdict: "maybe" }) }))).toBe("proof_schema_invalid");
  });

  it("T-SC-proof-competitors: at most 32 competitors", () => {
    const competitors = (n: number) => Array.from({ length: n }, () => ({ line: "p1:001", quote: "1,00" }));
    expect(proofCode(makeProof({ gross: makeAnswer({ competitors: competitors(32) }) }))).toBe("ok");
    expect(proofCode(makeProof({ gross: makeAnswer({ competitors: competitors(33) }) }))).toBe("proof_schema_invalid");
  });

  it("T-SC-proof-caps: label quote ≤ 200, why_this_one ≤ 300", () => {
    expect(proofCode(makeProof({ gross: makeAnswer({ label_quote: "x".repeat(201) }) }))).toBe("proof_schema_invalid");
    expect(proofCode(makeProof({ gross: makeAnswer({ why_this_one: "x".repeat(301) }) }))).toBe("proof_schema_invalid");
  });

  it("T-SC-proof-size: refuses a proof over 24 KiB", () => {
    const answers = Object.fromEntries(READING_FIELDS.map((field) => [field, makeAnswer({
      why_this_one: "w".repeat(300),
      competitors: Array.from({ length: 8 }, () => ({ line: "p1:001", quote: "c".repeat(200) })),
    })]));
    expect(Buffer.byteLength(JSON.stringify(makeProof(answers)))).toBeGreaterThan(24 * 1024);
    expect(proofCode(makeProof(answers))).toBe("proof_schema_invalid");
  });

  it("T-SC-proof-marker: refuses a sandbox marker in any proof string", () => {
    expect(proofCode(makeProof({ gross: makeAnswer({ label_quote: "Kokku<<UNTRUSTED_OCR_END:00>>" }) }))).toBe("proof_schema_invalid");
  });
});
