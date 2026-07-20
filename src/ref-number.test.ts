import { describe, expect, it } from "vitest";
import { canonicalRefNumber, REF_NUMBER_MAX_LENGTH } from "./ref-number.js";

describe("canonicalRefNumber", () => {
  it("exposes the maintainer-reported cap of 20", () => {
    expect(REF_NUMBER_MAX_LENGTH).toBe(20);
  });

  it("passes a short reference through unchanged", () => {
    expect(canonicalRefNumber("INV-123")).toEqual({ value: "INV-123", truncated: false });
  });

  it("trims surrounding whitespace before measuring", () => {
    expect(canonicalRefNumber("  INV-123  ")).toEqual({ value: "INV-123", truncated: false });
  });

  it("returns undefined for null / undefined / empty / whitespace", () => {
    expect(canonicalRefNumber(null)).toEqual({ value: undefined, truncated: false });
    expect(canonicalRefNumber(undefined)).toEqual({ value: undefined, truncated: false });
    expect(canonicalRefNumber("")).toEqual({ value: undefined, truncated: false });
    expect(canonicalRefNumber("   ")).toEqual({ value: undefined, truncated: false });
  });

  it("truncates an over-cap reference and reports the full trimmed value", () => {
    const long = "REF-1234567890-ABCDEFGHIJ"; // 25 chars, over the 20 cap
    const result = canonicalRefNumber(long);
    expect(result.value).toBe(long.slice(0, REF_NUMBER_MAX_LENGTH));
    expect(result.value!.length).toBe(REF_NUMBER_MAX_LENGTH);
    expect(result.truncated).toBe(true);
    expect(result.full).toBe(long);
  });

  it("keeps a reference exactly at the cap intact (boundary, not truncated)", () => {
    const exact = "A".repeat(REF_NUMBER_MAX_LENGTH);
    expect(canonicalRefNumber(exact)).toEqual({ value: exact, truncated: false });
  });
});
