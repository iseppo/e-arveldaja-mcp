import { describe, it, expect } from "vitest";
import {
  CriticalFieldError,
  decodeApiResponseCritical,
  decodeInvoiceStatusCritical,
} from "./critical-codecs.js";

// The codecs are TOLERANT: a happy-path no-op that permits unknown extra upstream
// fields and fails CLOSED only on a present-but-malformed safety-critical field.

describe("decodeApiResponseCritical — tolerant passthrough", () => {
  it("returns a finite created_object_id unchanged", () => {
    expect(decodeApiResponseCritical({ code: 200, created_object_id: 512, messages: [] }))
      .toEqual({ created_object_id: 512 });
  });

  it("treats absent / null created_object_id as undefined (recovery-sentinel path)", () => {
    expect(decodeApiResponseCritical({ code: 200, messages: [] })).toEqual({ created_object_id: undefined });
    expect(decodeApiResponseCritical({ created_object_id: null })).toEqual({ created_object_id: undefined });
  });

  it("ignores unknown extra upstream fields (never rejects for new fields)", () => {
    expect(decodeApiResponseCritical({ created_object_id: 1, some_future_field: { a: 1 }, extra: "x" }))
      .toEqual({ created_object_id: 1 });
  });

  it("tolerates a non-object response as an empty critical view", () => {
    expect(decodeApiResponseCritical(undefined)).toEqual({ created_object_id: undefined });
    expect(decodeApiResponseCritical(null)).toEqual({ created_object_id: undefined });
    expect(decodeApiResponseCritical("nope")).toEqual({ created_object_id: undefined });
  });
});

describe("decodeApiResponseCritical — fail closed on malformed", () => {
  it("throws on a NaN created_object_id", () => {
    expect(() => decodeApiResponseCritical({ created_object_id: NaN })).toThrow(CriticalFieldError);
  });

  it("throws on a non-numeric created_object_id", () => {
    expect(() => decodeApiResponseCritical({ created_object_id: "512" })).toThrow(CriticalFieldError);
  });

  it("throws on a non-finite created_object_id", () => {
    expect(() => decodeApiResponseCritical({ created_object_id: Infinity })).toThrow(CriticalFieldError);
  });
});

describe("decodeInvoiceStatusCritical — tolerant passthrough", () => {
  it("returns well-formed status / payment_status / id unchanged", () => {
    expect(decodeInvoiceStatusCritical({ id: 3, status: "CONFIRMED", payment_status: "PAID" }))
      .toEqual({ id: 3, status: "CONFIRMED", payment_status: "PAID" });
  });

  it("treats absent fields as undefined", () => {
    expect(decodeInvoiceStatusCritical({ status: "PROJECT" }))
      .toEqual({ id: undefined, status: "PROJECT", payment_status: undefined });
  });

  it("accepts any string status (does not reject unknown status strings)", () => {
    expect(decodeInvoiceStatusCritical({ status: "SOME_NEW_STATUS" }).status).toBe("SOME_NEW_STATUS");
  });

  it("ignores unknown extra fields", () => {
    expect(decodeInvoiceStatusCritical({ status: "CONFIRMED", net_price: 10, items: [] }).status)
      .toBe("CONFIRMED");
  });
});

describe("decodeInvoiceStatusCritical — fail closed on malformed", () => {
  it("throws when status is a number (status: 42)", () => {
    expect(() => decodeInvoiceStatusCritical({ status: 42 })).toThrow(CriticalFieldError);
  });

  it("throws when id is a non-numeric string (id: 'abc')", () => {
    expect(() => decodeInvoiceStatusCritical({ id: "abc" })).toThrow(CriticalFieldError);
  });

  it("throws when payment_status is a boolean", () => {
    expect(() => decodeInvoiceStatusCritical({ payment_status: true })).toThrow(CriticalFieldError);
  });

  it("carries the offending field name on the error", () => {
    try {
      decodeInvoiceStatusCritical({ status: 42 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CriticalFieldError);
      expect((error as CriticalFieldError).field).toBe("status");
    }
  });
});
