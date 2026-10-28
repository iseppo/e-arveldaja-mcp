import { describe, expect, it } from "vitest";
import { printedPaymentReference } from "./document-reading-reference.js";
import { isValidEstonianReferenceNumber } from "./ref-number.js";
import { makePacket } from "./__fixtures__/document-reading/make-packet.js";

describe("isValidEstonianReferenceNumber (7-3-1)", () => {
  it("accepts valid references and rejects a wrong check digit, letters and lengths outside 2–20", () => {
    expect(isValidEstonianReferenceNumber("3114100")).toBe(true); // live 2026-10-28, Arvutitark 447292
    expect(isValidEstonianReferenceNumber("1234561")).toBe(true); // textbook: 6·1+5·3+4·7+3·1+2·3+1·7 = 59 → 1
    expect(isValidEstonianReferenceNumber("13")).toBe(true); // the check itself allows 2 digits; the scan requires 4
    expect(isValidEstonianReferenceNumber("3114101")).toBe(false);
    expect(isValidEstonianReferenceNumber("1234567")).toBe(false);
    expect(isValidEstonianReferenceNumber("3")).toBe(false);
    expect(isValidEstonianReferenceNumber("311410a")).toBe(false);
    expect(isValidEstonianReferenceNumber("1".repeat(21))).toBe(false);
  });
});

describe("printedPaymentReference", () => {
  const packet = (lines: string[]) => makePacket(["Näidis OÜ    Arve nr A-17", ...lines]);

  it("binds one distinct valid value printed under Estonian labels, in any case and inflection", () => {
    expect(printedPaymentReference(packet(["Viitenumber: 3114100", "Palume tasuda viitenumber 3114100."]))).toEqual({ value: "3114100" });
    expect(printedPaymentReference(packet(["VIITENR. 3114100"]))).toEqual({ value: "3114100" });
    expect(printedPaymentReference(packet(["Viitenumber    3114100    Summa 124,00"]))).toEqual({ value: "3114100" });
  });

  it("reports two different valid values as ambiguous", () => {
    expect(printedPaymentReference(packet(["Viitenumber: 3114100", "Viitenumber: 1234561"]))).toEqual({ ambiguous: ["1234561", "3114100"] });
  });

  it("binds nothing for an invalid check digit, a label without a number, a number without a label or an English label", () => {
    expect(printedPaymentReference(packet(["Viitenumber: 3114101"]))).toBeUndefined();
    expect(printedPaymentReference(packet(["Viitenumber:"]))).toBeUndefined();
    expect(printedPaymentReference(packet(["3114100"]))).toBeUndefined();
    expect(printedPaymentReference(packet(["Reference: 3114100", "Ref. nr 3114100"]))).toBeUndefined();
    expect(printedPaymentReference(packet(["3114100 viitenumber"]))).toBeUndefined();
  });

  it("binds only the first digit run right after the label: a word in between, a phone fragment or a sentence binds nothing", () => {
    // Review 2026-10-28: a customer code, a phone number and an inflected label are not references.
    expect(printedPaymentReference(packet(["Viitenumber:    Kliendikood 1234561"]))).toBeUndefined();
    expect(printedPaymentReference(packet(["Viitenumber            Tel 5551 123", "3114100"]))).toBeUndefined();
    expect(printedPaymentReference(packet(["Viitenumbrit ei ole vaja märkida, tellimus 1234561"]))).toBeUndefined();
    expect(printedPaymentReference(packet(["Viitenumbriga 1234561 maksmisel"]))).toBeUndefined();
    expect(printedPaymentReference(packet(["Viitenumber    Maksetähtaeg    Summa", "3114100    10.11.2026    120"]))).toBeUndefined();
    // Live shapes: Arvutitark `Viitenumber: 3114100`, Zone Media `Viitenumber: ¦ 2045665`, `Viite nr 3114100`.
    expect(printedPaymentReference(packet(["Viitenumber:    2045665"]))).toEqual({ value: "2045665" });
    expect(printedPaymentReference(packet(["Viite nr 3114100"]))).toEqual({ value: "3114100" });
    expect(printedPaymentReference(packet(["Viitenumber nr. 3114100"]))).toEqual({ value: "3114100" });
    // Fewer than four digits is never a reference, even with a valid check digit.
    expect(printedPaymentReference(packet(["Viitenumber: 123"]))).toBeUndefined();
  });

  it("does not bind a number glued to letters or a longer token, nor a label glued to letters", () => {
    expect(printedPaymentReference(packet(["Viitenumber: A3114100"]))).toBeUndefined();
    expect(printedPaymentReference(packet(["Viitenumber: 3114100-1"]))).toBeUndefined();
    expect(printedPaymentReference(packet(["Tellimusviitenumber 3114100"]))).toBeUndefined();
  });
});
