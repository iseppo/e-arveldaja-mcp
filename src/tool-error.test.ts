import { describe, expect, it } from "vitest";
import { parseMcpResponse } from "./mcp-json.js";
import { toolError } from "./tool-error.js";

describe("toolError", () => {
  it("returns MCP isError results for strings", () => {
    const result = toolError("Invalid input");
    expect(result.isError).toBe(true);
    expect(parseMcpResponse((result.content[0] as { type: string; text: string }).text)).toEqual({
      error: "Invalid input",
    });
  });

  it("serializes structured payloads for tool self-correction", () => {
    const result = toolError({ error: "Account validation failed", details: ["4000 missing"] });
    expect(result.isError).toBe(true);
    expect(parseMcpResponse((result.content[0] as { type: string; text: string }).text)).toEqual({
      error: "Account validation failed",
      details: ["4000 missing"],
    });
  });

  it("falls back to a stable message for undefined throws", () => {
    const result = toolError(undefined);
    expect(result.isError).toBe(true);
    expect(parseMcpResponse((result.content[0] as { type: string; text: string }).text)).toEqual({
      error: "Unknown error",
    });
  });

  it("handles circular objects without throwing from the error wrapper", () => {
    const circular: Record<string, unknown> = { error: "boom" };
    circular.self = circular;

    const result = toolError(circular);

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(parseMcpResponse((result.content[0] as { type: string; text: string }).text)).toEqual({
      error: "Internal error",
    });
  });
});
