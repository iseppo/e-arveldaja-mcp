import { describe, expect, it } from "vitest";
import {
  encodeStoreHandle,
  isCanonicalStoreHandle,
  MAX_STORE_HANDLE_ATTEMPTS,
  randomStoreHandleBytes,
  STORE_HANDLE_BYTES,
  STORE_HANDLE_PATTERN,
} from "./handle-store-core.js";

describe("handle store core", () => {
  it("pins the handle format: 32 CSPRNG bytes as 43 unpadded base64url chars, 16 attempts", () => {
    expect(STORE_HANDLE_BYTES).toBe(32);
    expect(STORE_HANDLE_PATTERN.source).toBe("^[A-Za-z0-9_-]{43}$");
    expect(STORE_HANDLE_PATTERN.flags).toBe("");
    expect(MAX_STORE_HANDLE_ATTEMPTS).toBe(16);
    const first = randomStoreHandleBytes();
    const second = randomStoreHandleBytes();
    expect(first).toBeInstanceOf(Uint8Array);
    expect(first.byteLength).toBe(32);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
  });

  it("encodes exactly 32-byte Uint8Arrays and refuses anything else", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index * 7);
    const handle = encodeStoreHandle(bytes);
    expect(handle).toBe(Buffer.from(bytes).toString("base64url"));
    expect(handle).toMatch(STORE_HANDLE_PATTERN);
    expect(encodeStoreHandle(Buffer.alloc(32, 1))).toBe(Buffer.alloc(32, 1).toString("base64url"));
    for (const bad of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(0), Array.from({ length: 32 }, () => 0), "x".repeat(32), null, undefined]) {
      expect(encodeStoreHandle(bad)).toBeUndefined();
    }
  });

  it("accepts only canonical encodings of 32 bytes", () => {
    const handle = encodeStoreHandle(Buffer.alloc(32, 0xab))!;
    expect(isCanonicalStoreHandle(handle)).toBe(true);
    // Last char carries 2 unused bits: "B" decodes to the same bytes as "A" but is not canonical.
    expect(isCanonicalStoreHandle(`${"A".repeat(42)}A`)).toBe(true);
    expect(isCanonicalStoreHandle(`${"A".repeat(42)}B`)).toBe(false);
    for (const bad of ["", "x", `${handle}A`, handle.slice(1), `${handle.slice(0, 42)}=`, `${handle.slice(0, 42)}+`, 42, null, undefined, {}]) {
      expect(isCanonicalStoreHandle(bad)).toBe(false);
    }
  });
});
