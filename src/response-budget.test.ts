import { describe, expect, it } from "vitest";
import { RESPONSE_BUDGETS, mcpPayloadBytes, responseDetailForRoute, selectResponseDetail } from "./response-budget.js";
import { toMcpJson } from "./mcp-json.js";

describe("response budgets", () => {
  it("measures the whole real MCP serialization in UTF-8 bytes", () => {
    const payload = { message: "õ🚀".repeat(100), rows: [{ value: "é" }] };
    expect(mcpPayloadBytes(payload)).toBe(Buffer.byteLength(toMcpJson(payload), "utf8"));
    expect(mcpPayloadBytes(payload)).toBeGreaterThan(toMcpJson(payload).length);
  });

  it("pins normal, batch, and detail target/hard byte budgets", () => {
    expect(RESPONSE_BUDGETS).toEqual({
      normal: { target: 8 * 1024, hard: 16 * 1024 },
      batch: { target: 16 * 1024, hard: 32 * 1024 },
      detail: { target: 24 * 1024, hard: 32 * 1024 },
    });
  });

  it("defaults only guided and versioned future routes to compact", () => {
    expect(responseDetailForRoute({ profile: "guided", compatibility: "versioned" })).toBe("compact");
    expect(responseDetailForRoute({ profile: "guided-sales", compatibility: "versioned", requested: "full" })).toBe("full");
    expect(responseDetailForRoute({ profile: "standard", compatibility: "legacy-pinned", requested: "compact" })).toBe("full");
    expect(responseDetailForRoute({ profile: "full", compatibility: "legacy-pinned" })).toBe("full");
  });

  it("routes explicit compact/full projections without leaking audit or debug echoes", () => {
    const compact = { status: "completed" };
    const full = { status: "completed", dry_run_audit_refs: ["audit:1"], debug_echo: { raw: true } };
    expect(selectResponseDetail("compact", { compact, full })).toEqual(compact);
    expect(selectResponseDetail("full", { compact, full })).toEqual(full);
  });
});
