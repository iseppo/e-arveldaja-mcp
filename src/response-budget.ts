import type { ToolProfile } from "./tool-profile.js";
import { mcpSerializedByteLength } from "./mcp-json.js";

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
