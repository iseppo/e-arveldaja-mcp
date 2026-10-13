import { randomBytes } from "node:crypto";

// Shared handle format for every server-issued opaque handle (execution plans,
// file references, operation results, workflow states): 32 bytes from a
// CSPRNG, rendered as 43 unpadded base64url characters. Each store keeps its
// own error class; these helpers only report success or failure so the caller
// throws its own store-specific error code.

/** Entropy per handle, in bytes (256 bits). */
export const STORE_HANDLE_BYTES = 32;
/** Exactly the unpadded base64url rendering of STORE_HANDLE_BYTES bytes. */
export const STORE_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Allocation attempts before a store gives up with its own collision error. */
export const MAX_STORE_HANDLE_ATTEMPTS = 16;

/** Default handle factory: STORE_HANDLE_BYTES fresh CSPRNG bytes. */
export function randomStoreHandleBytes(): Uint8Array {
  return randomBytes(STORE_HANDLE_BYTES);
}

/**
 * Encode factory output as a handle. Returns undefined unless `bytes` is a
 * Uint8Array of exactly STORE_HANDLE_BYTES bytes whose encoding matches
 * STORE_HANDLE_PATTERN; the caller maps that to its own collision error.
 */
export function encodeStoreHandle(bytes: unknown): string | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== STORE_HANDLE_BYTES) return undefined;
  const handle = Buffer.from(bytes).toString("base64url");
  return STORE_HANDLE_PATTERN.test(handle) ? handle : undefined;
}

/**
 * True only for a string that is the canonical encoding of exactly
 * STORE_HANDLE_BYTES bytes (round-trips byte-for-byte, so non-canonical
 * trailing bits are rejected).
 */
export function isCanonicalStoreHandle(value: unknown): value is string {
  if (typeof value !== "string" || !STORE_HANDLE_PATTERN.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === STORE_HANDLE_BYTES && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}
