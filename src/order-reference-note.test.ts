import { describe, expect, it } from "vitest";
import { appendOrderReferenceNote, orderReferenceNoteLine, orderReferencesFromNotes } from "./order-reference-note.js";

describe("order reference notes line (okt 2026 finding 5)", () => {
  it("builds the canonical line for exactly one distinct value", () => {
    expect(orderReferenceNoteLine(["100000000002"])).toBe("Ostukorvi/tellimuse nr: 100000000002");
    expect(orderReferenceNoteLine(["100000000002", "100000000002"])).toBe("Ostukorvi/tellimuse nr: 100000000002");
  });

  it("binds nothing for none or several distinct values", () => {
    expect(orderReferenceNoteLine([])).toBeUndefined();
    expect(orderReferenceNoteLine(["100000000002", "100000000003"])).toBeUndefined();
  });

  it("appends the line after existing notes and keeps them", () => {
    const line = "Ostukorvi/tellimuse nr: 100000000002";
    expect(appendOrderReferenceNote(undefined, line)).toBe(line);
    expect(appendOrderReferenceNote("", line)).toBe(line);
    expect(appendOrderReferenceNote("Sõit koolitusele", line)).toBe(`Sõit koolitusele\n${line}`);
    expect(appendOrderReferenceNote("Sõit koolitusele", undefined)).toBe("Sõit koolitusele");
  });

  it("is idempotent, also over a tagNotes suffix", () => {
    const line = "Ostukorvi/tellimuse nr: 100000000002";
    const once = appendOrderReferenceNote("Sõit", line);
    expect(appendOrderReferenceNote(once, line)).toBe(once);
    expect(appendOrderReferenceNote(`Sõit\n${line} (e-arveldaja-mcp)`, line)).toBe(`Sõit\n${line} (e-arveldaja-mcp)`);
  });

  it("reads the values back from notes, with or without the tagNotes suffix", () => {
    expect(orderReferencesFromNotes("Sõit\nOstukorvi/tellimuse nr: 100000000002 (e-arveldaja-mcp)")).toEqual(["100000000002"]);
    expect(orderReferencesFromNotes("Ostukorvi/tellimuse nr: AB-1234567")).toEqual(["AB-1234567"]);
    expect(orderReferencesFromNotes("Tellimus 100000000002")).toEqual([]);
    expect(orderReferencesFromNotes(null)).toEqual([]);
  });
});
