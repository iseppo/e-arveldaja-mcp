import { describe, it, expect } from "vitest";
import { isProjectTransaction, isNonVoidTransaction } from "./transaction-status.js";

describe("isProjectTransaction", () => {
  it("returns true for status PROJECT and not deleted", () => {
    expect(isProjectTransaction({ status: "PROJECT", is_deleted: false })).toBe(true);
  });

  it("returns true for status PROJECT when is_deleted is undefined", () => {
    expect(isProjectTransaction({ status: "PROJECT", is_deleted: undefined })).toBe(true);
  });

  it("returns false for status CONFIRMED", () => {
    expect(isProjectTransaction({ status: "CONFIRMED", is_deleted: false })).toBe(false);
  });

  it("returns false for status VOID", () => {
    expect(isProjectTransaction({ status: "VOID", is_deleted: false })).toBe(false);
  });

  it("returns false when status is PROJECT but is_deleted is true", () => {
    expect(isProjectTransaction({ status: "PROJECT", is_deleted: true })).toBe(false);
  });

  it("returns false when status is undefined", () => {
    expect(isProjectTransaction({ status: undefined as any, is_deleted: false })).toBe(false);
  });
});

describe("isNonVoidTransaction", () => {
  it("returns true for status PROJECT and not deleted", () => {
    expect(isNonVoidTransaction({ status: "PROJECT", is_deleted: false })).toBe(true);
  });

  it("returns true for status CONFIRMED and not deleted", () => {
    expect(isNonVoidTransaction({ status: "CONFIRMED", is_deleted: false })).toBe(true);
  });

  it("returns false for status VOID", () => {
    expect(isNonVoidTransaction({ status: "VOID", is_deleted: false })).toBe(false);
  });

  it("returns false when status is VOID and is_deleted is true", () => {
    expect(isNonVoidTransaction({ status: "VOID", is_deleted: true })).toBe(false);
  });

  it("returns false when status is PROJECT but is_deleted is true", () => {
    expect(isNonVoidTransaction({ status: "PROJECT", is_deleted: true })).toBe(false);
  });

  it("returns false when status is CONFIRMED but is_deleted is true", () => {
    expect(isNonVoidTransaction({ status: "CONFIRMED", is_deleted: true })).toBe(false);
  });

  it("returns true when is_deleted is undefined and status is CONFIRMED", () => {
    expect(isNonVoidTransaction({ status: "CONFIRMED", is_deleted: undefined })).toBe(true);
  });

  it("returns true when status is undefined (not VOID) and not deleted", () => {
    expect(isNonVoidTransaction({ status: undefined as any, is_deleted: false })).toBe(true);
  });
});
