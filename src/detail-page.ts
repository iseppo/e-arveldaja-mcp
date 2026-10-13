import { createHmac, timingSafeEqual } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { sandboxExternalText } from "./external-text-renderer.js";
import { toMcpJson } from "./mcp-json.js";
import type { PlanData } from "./plan-store.js";
import { canonicalDetailJson, mcpPayloadBytes, RESPONSE_BUDGETS, ResponseBudgetError } from "./response-budget.js";
import type { RuntimeSafetyContext } from "./runtime-safety-context.js";

// Shared pager for the two public-detail stores (get_operation_result_page and
// get_workflow_page). Each caller supplies its own cursor prefix, HMAC domain
// separator, contract, error codes and messages, so cursors issued by one pager
// never verify at the other and every wire string stays per-store.

export const CURSOR_SECRET_BYTES = 32;

export interface DetailPageSpec<S extends { readonly items: readonly PlanData[] }> {
  /** Cursor prefix, e.g. "r1" — `<prefix>.<offset>.<base64url HMAC>`. Must contain no regex metacharacters. */
  readonly cursorPrefix: string;
  /** HMAC domain separator, including its trailing NUL. */
  readonly macDomain: string;
  readonly contract: string;
  readonly defaultPageSize: number;
  readonly maxPageSize: number;
  readonly secretErrorMessage: string;
  readonly cursorErrorCode: string;
  readonly cursorErrorMessage: string;
  readonly failedCode: string;
  readonly failedMessage: string;
  /** The owning store's error class; its `code`/`message` are forwarded verbatim. */
  readonly isStoreError: (error: unknown) => error is Error & { readonly code: string };
  readonly inspect: (context: RuntimeSafetyContext, handle: string) => S;
  /** Envelope fields between `contract` and `total_items`, in wire order. */
  readonly header: (handle: string, stored: S) => Readonly<Record<string, unknown>>;
}

class DetailPageCursorError extends Error {
  constructor(readonly code: string) { super(); }
}

/**
 * Validate the secret and return a synchronous page function. Every failure
 * inside the page function becomes a structured `isError` result; nothing throws.
 */
export function createDetailPager<S extends { readonly items: readonly PlanData[] }>(
  spec: DetailPageSpec<S>,
  runtimeSafetyContext: RuntimeSafetyContext,
  cursorSecret: Uint8Array,
): (handle: string, cursor: string | undefined, pageSize: number | undefined) => CallToolResult {
  if (!(cursorSecret instanceof Uint8Array) || cursorSecret.byteLength !== CURSOR_SECRET_BYTES) throw new Error(spec.secretErrorMessage);
  const secret = Buffer.from(cursorSecret);
  // The prefix is interpolated into the cursor regex: keep it a plain token.
  if (!/^[a-z][a-z0-9]*$/.test(spec.cursorPrefix)) throw new Error("Detail pager cursor prefix must be a plain lowercase token.");
  const cursorPattern = new RegExp(`^${spec.cursorPrefix}\\.(0|[1-9][0-9]{0,6})\\.([A-Za-z0-9_-]{43})$`);
  const cursorError = () => new DetailPageCursorError(spec.cursorErrorCode);

  const mac = (handle: string, offset: number, pageSize: number): Buffer =>
    createHmac("sha256", secret).update(spec.macDomain).update(handle).update("\0")
      .update(String(offset)).update("\0").update(String(pageSize)).digest();
  const encodeCursor = (handle: string, offset: number, pageSize: number): string =>
    `${spec.cursorPrefix}.${offset}.${mac(handle, offset, pageSize).toString("base64url")}`;
  const decodeCursor = (handle: string, cursor: string | undefined, pageSize: number, total: number): number => {
    if (cursor === undefined) return 0;
    const match = cursorPattern.exec(cursor);
    if (!match) throw cursorError();
    const offset = Number(match[1]);
    if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= total) throw cursorError();
    const received = Buffer.from(match[2]!, "base64url");
    if (received.toString("base64url") !== match[2]) throw cursorError();
    const expected = mac(handle, offset, pageSize);
    if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) throw cursorError();
    return offset;
  };
  const errorResult = (error: unknown): CallToolResult => {
    const safe = spec.isStoreError(error) || error instanceof DetailPageCursorError || error instanceof ResponseBudgetError
      ? { code: error.code, message: error instanceof DetailPageCursorError ? spec.cursorErrorMessage : error.message }
      : { code: spec.failedCode, message: spec.failedMessage };
    return { isError: true, content: [{ type: "text", text: toMcpJson({ error: safe }) }] };
  };

  return (handle, cursor, page_size) => {
    try {
      const pageSize = page_size ?? spec.defaultPageSize;
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > spec.maxPageSize) throw cursorError();
      const stored = spec.inspect(runtimeSafetyContext, handle);
      const offset = decodeCursor(handle, cursor, pageSize, stored.items.length);
      const maximumEnd = Math.min(offset + pageSize, stored.items.length);
      const renderedItems = stored.items.slice(offset, maximumEnd).map(item => Object.freeze({
        review_data: sandboxExternalText(canonicalDetailJson(item)),
      }));
      let end = maximumEnd;
      const profile = runtimeSafetyContext.getActiveScope().profile;
      const reductionLimit = profile === "guided" || profile === "guided-sales"
        ? RESPONSE_BUDGETS.detail.target
        : RESPONSE_BUDGETS.detail.hard;
      const build = () => Object.freeze({
        contract: spec.contract, ...spec.header(handle, stored),
        total_items: stored.items.length,
        range: Object.freeze(stored.items.length === 0 ? { from: 0, to: 0, count: 0 } : { from: offset + 1, to: end, count: end - offset }),
        current_cursor: offset === 0 ? null : encodeCursor(handle, offset, pageSize),
        next_cursor: end < stored.items.length ? encodeCursor(handle, end, pageSize) : null,
        items: Object.freeze(renderedItems.slice(0, end - offset)),
      });
      let payload = build();
      while (mcpPayloadBytes(payload) > reductionLimit && end > offset + 1) { end -= 1; payload = build(); }
      if (mcpPayloadBytes(payload) > RESPONSE_BUDGETS.detail.hard) return errorResult(new ResponseBudgetError());
      return { content: [{ type: "text", text: toMcpJson(payload) }] };
    } catch (error) { return errorResult(error); }
  };
}
