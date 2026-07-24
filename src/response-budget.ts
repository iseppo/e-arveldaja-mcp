import type { ToolProfile } from "./tool-profile.js";
import { mcpSerializedByteLength } from "./mcp-json.js";
import { MAX_EXTERNAL_TEXT_CHARS, sandboxExternalText } from "./external-text-renderer.js";

export type ResponseDetail = "compact" | "full";
export type ResponseCompatibility = "legacy-pinned" | "versioned";
export type ResponseBudgetKind = "normal" | "batch" | "detail";

export const RESPONSE_BUDGETS = Object.freeze({
  normal: Object.freeze({ target: 8 * 1024, hard: 16 * 1024 }),
  batch: Object.freeze({ target: 16 * 1024, hard: 32 * 1024 }),
  detail: Object.freeze({ target: 24 * 1024, hard: 32 * 1024 }),
});

export function mcpPayloadBytes(payload: unknown): number {
  return mcpSerializedByteLength(payload);
}

export function responseDetailForRoute(options: {
  readonly profile: ToolProfile;
  readonly compatibility: ResponseCompatibility;
  readonly requested?: ResponseDetail;
}): ResponseDetail {
  if (options.compatibility === "legacy-pinned") return "full";
  return options.requested ?? (options.profile === "guided" || options.profile === "guided-sales" ? "compact" : "full");
}

export function selectResponseDetail<C, F>(detail: ResponseDetail, projections: Readonly<{ compact: C; full: F }>): C | F {
  return detail === "compact" ? projections.compact : projections.full;
}

export class ResponseBudgetError extends Error {
  readonly code = "response_budget_exceeded" as const;
  constructor() {
    super("response_budget_exceeded");
    this.name = "ResponseBudgetError";
  }
}

export function assertMcpPayloadWithinHardBudget(payload: unknown, kind: ResponseBudgetKind): void {
  if (mcpPayloadBytes(payload) > RESPONSE_BUDGETS[kind].hard) throw new ResponseBudgetError();
}

/**
 * Canonical (key-sorted) JSON for one stored detail item — the exact string the
 * operation-result and workflow-state pagers wrap as `review_data`. Shared so a
 * store's insertion-time per-item budget check measures the identical rendering
 * the pager will later emit.
 */
export function canonicalDetailJson(value: unknown): string {
  const canonicalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonicalize);
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(
        Object.keys(candidate as Record<string, unknown>).sort()
          .map(key => [key, canonicalize((candidate as Record<string, unknown>)[key])]),
      );
    }
    return candidate;
  };
  return JSON.stringify(canonicalize(value));
}

// Headroom reserved for the page envelope (contract, handle, operation/status,
// range, and two signed cursors) so that a page carrying a single admitted
// detail never exceeds the detail hard budget.
const DETAIL_PAGE_ENVELOPE_RESERVE = 2 * 1024;

/**
 * The largest rendered single-item contribution (`{ review_data: … }` in bytes)
 * a stored detail may have and still be retrievable as a one-item page within
 * the detail hard budget.
 */
export const MAX_DETAIL_ITEM_RENDER_BYTES = RESPONSE_BUDGETS.detail.hard - DETAIL_PAGE_ENVELOPE_RESERVE;

/**
 * True iff a stored detail item is retrievable as a single-item page without
 * exceeding the detail hard budget. Two ways an item becomes silently
 * unreachable and are both rejected here:
 *
 *  - its canonical JSON is longer than the sandbox display cap, so
 *    `sandboxExternalText` would replace the whole payload with the
 *    "external_text_too_large" sentinel — dropping the content entirely; or
 *  - even faithfully rendered, a one-item page would blow the hard budget, so
 *    the pager (which reduces to at most one item) can never return it.
 *
 * A store rejects an oversized item at insertion time with a structured
 * `*_item_too_large` error instead of admitting an item no page size can reach.
 */
export function detailItemFitsSinglePage(item: unknown): boolean {
  const json = canonicalDetailJson(item);
  if (json.length > MAX_EXTERNAL_TEXT_CHARS) return false;
  return mcpPayloadBytes({ review_data: sandboxExternalText(json) }) <= MAX_DETAIL_ITEM_RENDER_BYTES;
}
