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
});
