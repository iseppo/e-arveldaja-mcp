import { describe, expect, it } from "vitest";
import { toolError } from "./tool-error.js";

describe("toolError", () => {
  it("returns MCP isError results for strings", () => {
    expect(toolError("Invalid input")).toEqual({
      isError: true,
      content: [{ type: "text", text: "Invalid input" }],
    });
  });

  it("serializes structured payloads for tool self-correction", () => {
    expect(toolError({ error: "Account validation failed", details: ["4000 missing"] })).toEqual({
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({ error: "Account validation failed", details: ["4000 missing"] }, null, 2),
      }],
    });
  });

  it("falls back to a stable message for undefined throws", () => {
    expect(toolError(undefined)).toEqual({
      isError: true,
      content: [{ type: "text", text: "Unknown error" }],
    });
  });

  it("handles circular objects without throwing from the error wrapper", () => {
    const circular: Record<string, unknown> = { error: "boom" };
    circular.self = circular;

    const result = toolError(circular);

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect((result.content[0] as { type: string; text: string }).text).toBe("Internal error");
  });
});
