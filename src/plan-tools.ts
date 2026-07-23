import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readOnly } from "./annotations.js";
import { sandboxExternalText } from "./external-text-renderer.js";
import { registerTool } from "./mcp-compat.js";
import { toMcpJson } from "./mcp-json.js";
import { PlanStoreError, type PlanData } from "./plan-store.js";
import type { RuntimeSafetyContext } from "./runtime-safety-context.js";
import type { ToolProfile } from "./tool-profile.js";
import { mcpPayloadBytes, RESPONSE_BUDGETS, ResponseBudgetError } from "./response-budget.js";

export const EXECUTION_PLAN_PAGE_SIZE = 50;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CURSOR_PATTERN = /^p1\.(0|[1-9][0-9]{0,6})\.([A-Za-z0-9_-]{43})$/;
const CURSOR_SECRET_BYTES = 32;

type PlanPageSection = "commands" | "exclusions" | "reviews";
type PlanPageArgs = { plan_handle: string; section?: PlanPageSection; cursor?: string };
type PlanPageDetail = "summary" | "full";
type GuidedPlanPageArgs = PlanPageArgs & { page_size?: number; detail?: PlanPageDetail };
const GUIDED_PLAN_PAGE_SIZE = 20;
const MAX_GUIDED_PLAN_PAGE_SIZE = 50;
const GUIDED_CURSOR_PATTERN = /^p2\.(0|[1-9][0-9]{0,6})\.([A-Za-z0-9_-]{43})$/;

class PlanCursorError extends Error {
  readonly code = "plan_cursor_invalid" as const;

  constructor() {
    super("The execution-plan page cursor is invalid for this plan.");
    this.name = "PlanCursorError";
  }
}

function canonicalJson(value: PlanData | readonly PlanData[]): string {
  const canonicalize = (candidate: PlanData): PlanData => {
    if (Array.isArray(candidate)) return candidate.map(canonicalize);
    if (candidate !== null && typeof candidate === "object") {
      const result: Record<string, PlanData> = {};
      const record = candidate as { readonly [key: string]: PlanData };
      for (const key of Object.keys(record).sort()) result[key] = canonicalize(record[key]!);
      return result;
    }
    return candidate;
  };
  return JSON.stringify(canonicalize(value as PlanData));
}

function cursorMac(secret: Buffer, handle: string, section: PlanPageSection, offset: number): Buffer {
  return createHmac("sha256", secret).update("execution-plan-page-v1\0").update(handle).update("\0")
    .update(section).update("\0").update(String(offset)).digest();
}

function encodeCursor(secret: Buffer, handle: string, section: PlanPageSection, offset: number): string {
  return `p1.${offset}.${cursorMac(secret, handle, section, offset).toString("base64url")}`;
}

function decodeCursor(secret: Buffer, handle: string, section: PlanPageSection, cursor: string | undefined, total: number): number {
  if (cursor === undefined) return 0;
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match) throw new PlanCursorError();
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset % EXECUTION_PLAN_PAGE_SIZE !== 0 || offset >= total) {
    throw new PlanCursorError();
  }
  const received = Buffer.from(match[2]!, "base64url");
  if (received.toString("base64url") !== match[2]) throw new PlanCursorError();
  const expected = cursorMac(secret, handle, section, offset);
  if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) throw new PlanCursorError();
  return offset;
}

function guidedCursorMac(secret: Buffer, handle: string, section: PlanPageSection, offset: number, pageSize: number, detail: PlanPageDetail): Buffer {
  return createHmac("sha256", secret).update("execution-plan-page-v2-guided\0").update(handle).update("\0")
    .update(section).update("\0").update(String(offset)).update("\0").update(String(pageSize)).update("\0").update(detail).digest();
}

function encodeGuidedCursor(secret: Buffer, handle: string, section: PlanPageSection, offset: number, pageSize: number, detail: PlanPageDetail): string {
  return `p2.${offset}.${guidedCursorMac(secret, handle, section, offset, pageSize, detail).toString("base64url")}`;
}

function decodeGuidedCursor(secret: Buffer, handle: string, section: PlanPageSection, cursor: string | undefined, total: number, pageSize: number, detail: PlanPageDetail): number {
  if (cursor === undefined) return 0;
  const match = GUIDED_CURSOR_PATTERN.exec(cursor);
  if (!match) throw new PlanCursorError();
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= total) throw new PlanCursorError();
  const received = Buffer.from(match[2]!, "base64url");
  if (received.toString("base64url") !== match[2]) throw new PlanCursorError();
  const expected = guidedCursorMac(secret, handle, section, offset, pageSize, detail);
  if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) throw new PlanCursorError();
  return offset;
}

function errorResult(error: unknown): CallToolResult {
  const safe = error instanceof PlanStoreError || error instanceof PlanCursorError || error instanceof ResponseBudgetError
    ? { code: error.code, message: error.message }
    : { code: "plan_page_failed", message: "The execution-plan page could not be retrieved." };
  return {
    isError: true,
    content: [{ type: "text", text: toMcpJson({ error: safe }) }],
  };
}

function createGuidedExecutionPlanPageHandler(
  runtimeSafetyContext: RuntimeSafetyContext,
  cursorSecret: Buffer,
): (args: GuidedPlanPageArgs) => Promise<CallToolResult> {
  return async ({ plan_handle, section: requestedSection, cursor, page_size, detail: requestedDetail }) => {
    try {
      const section = requestedSection ?? "commands";
      const pageSize = page_size ?? GUIDED_PLAN_PAGE_SIZE;
      const detail = requestedDetail ?? "summary";
      if ((section !== "commands" && section !== "exclusions" && section !== "reviews") ||
        !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_GUIDED_PLAN_PAGE_SIZE ||
        (detail !== "summary" && detail !== "full")) throw new PlanCursorError();
      const plan = runtimeSafetyContext.planStore.inspect(plan_handle);
      const sectionValues = section === "commands" ? plan.commands : plan[section];
      const sectionTotal = sectionValues.length;
      const offset = decodeGuidedCursor(cursorSecret, plan_handle, section, cursor, sectionTotal, pageSize, detail);
      const maximumEnd = Math.min(offset + pageSize, sectionTotal);
      const fullCommands = section === "commands" && detail === "full"
        ? plan.commands.slice(offset, maximumEnd).map(command => Object.freeze({
          command_id: command.id, category: command.category,
          review_data: sandboxExternalText(canonicalJson(command.reviewProjection ?? null)),
        })) : undefined;
      const summaryCommands = section === "commands" && detail === "summary"
        ? plan.commands.slice(offset, maximumEnd).map(command => Object.freeze({ command_id: command.id, category: command.category }))
        : undefined;
      const fullItems = section !== "commands" && detail === "full"
        ? plan[section].slice(offset, maximumEnd).map(item => Object.freeze({ review_data: sandboxExternalText(canonicalJson(item)) }))
        : undefined;
      const summaryItems = section !== "commands" && detail === "summary"
        ? plan[section].slice(offset, maximumEnd).map((_item, index) => Object.freeze({ item_index: offset + index + 1 }))
        : undefined;
      let end = maximumEnd;
      const build = () => {
        const count = end - offset;
        const commands = (fullCommands ?? summaryCommands)?.slice(0, count);
        const items = (fullItems ?? summaryItems)?.slice(0, count);
        return Object.freeze({
          contract: "execution_plan_page_v1" as const,
          plan_handle, plan_schema: plan.schema, operation: plan.domain,
          total_commands: plan.commands.length, category_counts: plan.counts, monetary_totals: plan.totals,
          section, detail, section_total: sectionTotal,
          range: Object.freeze(sectionTotal === 0 ? { from: 0, to: 0, count: 0 } : { from: offset + 1, to: end, count }),
          current_cursor: offset === 0 ? null : encodeGuidedCursor(cursorSecret, plan_handle, section, offset, pageSize, detail),
          next_cursor: end < sectionTotal ? encodeGuidedCursor(cursorSecret, plan_handle, section, end, pageSize, detail) : null,
          review_sections: Object.freeze({
            exclusions: Object.freeze({ count: plan.exclusions.length, page_reference: Object.freeze({ tool: "get_execution_plan_page", args: Object.freeze({ plan_handle, section: "exclusions" as const, detail }) }) }),
            reviews: Object.freeze({ count: plan.reviews.length, page_reference: Object.freeze({ tool: "get_execution_plan_page", args: Object.freeze({ plan_handle, section: "reviews" as const, detail }) }) }),
          }),
          ...(commands ? { commands: Object.freeze(commands) } : {}),
          ...(items ? { items: Object.freeze(items) } : {}),
        });
      };
      let payload = build();
      while (mcpPayloadBytes(payload) > RESPONSE_BUDGETS.detail.target && end > offset + 1) { end -= 1; payload = build(); }
      if (mcpPayloadBytes(payload) > RESPONSE_BUDGETS.detail.hard) throw new ResponseBudgetError();
      return { content: [{ type: "text", text: toMcpJson(payload) }] };
    } catch (error) { return errorResult(error); }
  };
}

export function createExecutionPlanPageHandler(
  runtimeSafetyContext: RuntimeSafetyContext,
  options: { readonly cursorSecret: Uint8Array; readonly profile?: ToolProfile },
): (args: GuidedPlanPageArgs) => Promise<CallToolResult> {
  if (!(options.cursorSecret instanceof Uint8Array) || options.cursorSecret.byteLength !== CURSOR_SECRET_BYTES) {
    throw new Error("Execution-plan page cursor secret must contain exactly 32 bytes.");
  }
  const cursorSecret = Buffer.from(options.cursorSecret);
  if (options.profile === "guided" || options.profile === "guided-sales") {
    return createGuidedExecutionPlanPageHandler(runtimeSafetyContext, cursorSecret);
  }
  return async ({ plan_handle, section: requestedSection, cursor }) => {
    try {
      const section = requestedSection ?? "commands";
      if (section !== "commands" && section !== "exclusions" && section !== "reviews") throw new PlanCursorError();
      const plan = runtimeSafetyContext.planStore.inspect(plan_handle);
      const sectionValues = section === "commands" ? plan.commands : plan[section];
      const sectionTotal = sectionValues.length;
      const offset = decodeCursor(cursorSecret, plan_handle, section, cursor, sectionTotal);
      const end = Math.min(offset + EXECUTION_PLAN_PAGE_SIZE, sectionTotal);
      const commands = section === "commands"
        ? plan.commands.slice(offset, end).map(command => Object.freeze({
          command_id: command.id,
          category: command.category,
          review_data: sandboxExternalText(canonicalJson(command.reviewProjection ?? null)),
        }))
        : undefined;
      const items = section === "commands"
        ? undefined
        : plan[section].slice(offset, end).map(item => Object.freeze({
          review_data: sandboxExternalText(canonicalJson(item)),
        }));
      const payload = Object.freeze({
        contract: "execution_plan_page_v1" as const,
        plan_handle,
        plan_schema: plan.schema,
        operation: plan.domain,
        total_commands: plan.commands.length,
        category_counts: plan.counts,
        monetary_totals: plan.totals,
        section,
        section_total: sectionTotal,
        range: Object.freeze(sectionTotal === 0 ? { from: 0, to: 0, count: 0 } : { from: offset + 1, to: end, count: end - offset }),
        current_cursor: offset === 0 ? null : encodeCursor(cursorSecret, plan_handle, section, offset),
        next_cursor: end < sectionTotal ? encodeCursor(cursorSecret, plan_handle, section, end) : null,
        review_sections: Object.freeze({
          exclusions: Object.freeze({
            count: plan.exclusions.length,
            page_reference: Object.freeze({
              tool: "get_execution_plan_page",
              args: Object.freeze({ plan_handle, section: "exclusions" as const }),
            }),
          }),
          reviews: Object.freeze({
            count: plan.reviews.length,
            page_reference: Object.freeze({
              tool: "get_execution_plan_page",
              args: Object.freeze({ plan_handle, section: "reviews" as const }),
            }),
          }),
        }),
        ...(commands ? { commands: Object.freeze(commands) } : {}),
        ...(items ? { items: Object.freeze(items) } : {}),
      });
      return { content: [{ type: "text", text: toMcpJson(payload) }] };
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function registerPlanTools(server: McpServer, runtimeSafetyContext: RuntimeSafetyContext, options: { readonly profile?: ToolProfile } = {}): void {
  const profile = options.profile ?? "standard";
  const handler = createExecutionPlanPageHandler(runtimeSafetyContext, { cursorSecret: randomBytes(CURSOR_SECRET_BYTES), profile });
  const guided = profile === "guided" || profile === "guided-sales";
  const description = guided
    ? "Retrieve one bounded, caller-sized, read-only review page from a server-issued execution plan. This does not consume or extend the plan and does not record or imply user approval."
    : "Retrieve one fixed-size, read-only review page from a server-issued execution plan. This does not consume or extend the plan and does not record or imply user approval.";
  const standardSchema = {
      plan_handle: z.string().regex(HANDLE_PATTERN).describe("Canonical opaque server-issued execution plan handle"),
      section: z.enum(["commands", "exclusions", "reviews"]).optional()
        .describe("Review section to page. Default: commands"),
      cursor: z.string().max(128).optional().describe("Optional opaque cursor returned by the preceding page"),
  };
  const annotations = { ...readOnly, title: "Get Execution Plan Page" };
  if (guided) {
    registerTool(server, "get_execution_plan_page", description, {
      ...standardSchema,
        detail: z.enum(["summary", "full"]).optional().describe("Review detail. Default: summary"),
        page_size: z.number().int().min(1).max(MAX_GUIDED_PLAN_PAGE_SIZE).optional().describe("Maximum items. Default: 20; maximum: 50"),
    }, annotations, handler);
  } else {
    registerTool(server, "get_execution_plan_page", description, standardSchema, annotations, handler);
  }
}
