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

export const EXECUTION_PLAN_PAGE_SIZE = 50;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CURSOR_PATTERN = /^p1\.(0|[1-9][0-9]{0,6})\.([A-Za-z0-9_-]{43})$/;
const CURSOR_SECRET_BYTES = 32;

type PlanPageSection = "commands" | "exclusions" | "reviews";
type PlanPageArgs = { plan_handle: string; section?: PlanPageSection; cursor?: string };

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

function errorResult(error: unknown): CallToolResult {
  const safe = error instanceof PlanStoreError || error instanceof PlanCursorError
    ? { code: error.code, message: error.message }
    : { code: "plan_page_failed", message: "The execution-plan page could not be retrieved." };
  return {
    isError: true,
    content: [{ type: "text", text: toMcpJson({ error: safe }) }],
  };
}

export function createExecutionPlanPageHandler(
  runtimeSafetyContext: RuntimeSafetyContext,
  options: { readonly cursorSecret: Uint8Array },
): (args: PlanPageArgs) => Promise<CallToolResult> {
  if (!(options.cursorSecret instanceof Uint8Array) || options.cursorSecret.byteLength !== CURSOR_SECRET_BYTES) {
    throw new Error("Execution-plan page cursor secret must contain exactly 32 bytes.");
  }
  const cursorSecret = Buffer.from(options.cursorSecret);
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

export function registerPlanTools(server: McpServer, runtimeSafetyContext: RuntimeSafetyContext): void {
  const handler = createExecutionPlanPageHandler(runtimeSafetyContext, { cursorSecret: randomBytes(CURSOR_SECRET_BYTES) });
  registerTool(server, "get_execution_plan_page",
    "Retrieve one fixed-size, read-only review page from a server-issued execution plan. This does not consume or extend the plan and does not record or imply user approval.",
    {
      plan_handle: z.string().regex(HANDLE_PATTERN).describe("Canonical opaque server-issued execution plan handle"),
      section: z.enum(["commands", "exclusions", "reviews"]).optional()
        .describe("Review section to page. Default: commands"),
      cursor: z.string().max(128).optional().describe("Optional opaque cursor returned by the preceding page"),
    },
    { ...readOnly, title: "Get Execution Plan Page" },
    handler,
  );
}
