import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDetailPager, type DetailPageSpec } from "./detail-page.js";
import { parseMcpResponse } from "./mcp-json.js";
import type { PlanData } from "./plan-store.js";
import type { RuntimeSafetyContext } from "./runtime-safety-context.js";

interface Stored { readonly items: readonly PlanData[]; readonly name: string }
class StubStoreError extends Error { readonly code = "stub_handle_invalid"; }

const HANDLE = "A".repeat(43);
const SECRET = Buffer.alloc(32, 5);
const stored: Stored = { name: "demo", items: Array.from({ length: 5 }, (_, i) => ({ i, b: "x", a: "y" })) };
const context = { getActiveScope: () => ({ profile: "standard" }) } as unknown as RuntimeSafetyContext;

function spec(prefix: string, domain: string): DetailPageSpec<Stored> {
  return {
    cursorPrefix: prefix, macDomain: domain, contract: `${prefix}_page`, defaultPageSize: 2, maxPageSize: 3,
    secretErrorMessage: "bad secret", cursorErrorCode: `${prefix}_cursor_invalid`, cursorErrorMessage: `${prefix} cursor invalid`,
    failedCode: `${prefix}_failed`, failedMessage: `${prefix} failed`,
    isStoreError: (error): error is StubStoreError => error instanceof StubStoreError,
    inspect: (_context, handle) => { if (handle !== HANDLE) throw new StubStoreError("stub message"); return stored; },
    header: (handle, value) => ({ h: handle, name: value.name }),
  };
}

const page = (pager: ReturnType<typeof createDetailPager>, cursor?: string, size?: number) => {
  const result = pager(HANDLE, cursor, size);
  return { isError: result.isError === true, body: parseMcpResponse((result.content[0] as { text: string }).text) as Record<string, any> };
};

describe("detail pager", () => {
  it("emits the envelope in wire order with key-sorted review data and an HMAC cursor over handle, offset and page size", () => {
    const pager = createDetailPager(spec("x1", "x-page-v1\0"), context, SECRET);
    const first = page(pager);
    expect(first.isError).toBe(false);
    expect(Object.keys(first.body)).toEqual(["contract", "h", "name", "total_items", "range", "current_cursor", "next_cursor", "items"]);
    expect(first.body.items[0].review_data).toContain('{"a":"y","b":"x","i":0}');
    const mac = createHmac("sha256", SECRET).update("x-page-v1\0").update(HANDLE).update("\0").update("2").update("\0").update("2").digest();
    expect(first.body.next_cursor).toBe(`x1.2.${mac.toString("base64url")}`);
    const second = page(pager, first.body.next_cursor);
    expect(second.body.range).toEqual({ from: 3, to: 4, count: 2 });
    expect(second.body.current_cursor).toBe(first.body.next_cursor);
  });

  it("keeps cursors domain-separated per spec even under one secret", () => {
    const x = createDetailPager(spec("x1", "x-page-v1\0"), context, SECRET);
    const y = createDetailPager(spec("y1", "y-page-v1\0"), context, SECRET);
    const cursor: string = page(x).body.next_cursor;
    const relabelled = cursor.replace(/^x1/, "y1");
    expect(page(y, cursor).body.error).toEqual({ code: "y1_cursor_invalid", message: "y1 cursor invalid" });
    expect(page(y, relabelled).body.error).toEqual({ code: "y1_cursor_invalid", message: "y1 cursor invalid" });
    expect(page(x, cursor, 3).body.error.code).toBe("x1_cursor_invalid");
  });

  it("maps store errors verbatim, anything else to the generic failure, and checks the secret eagerly", () => {
    const pager = createDetailPager(spec("x1", "x-page-v1\0"), context, SECRET);
    const missing = pager("B".repeat(43), undefined, undefined);
    expect(parseMcpResponse((missing.content[0] as { text: string }).text)).toEqual({ error: { code: "stub_handle_invalid", message: "stub message" } });
    const broken = createDetailPager({ ...spec("x1", "x-page-v1\0"), inspect: () => { throw new TypeError("boom"); } }, context, SECRET);
    expect(page(broken).body.error).toEqual({ code: "x1_failed", message: "x1 failed" });
    expect(() => createDetailPager(spec("x1", "x-page-v1\0"), context, Buffer.alloc(31))).toThrow("bad secret");
  });
});
