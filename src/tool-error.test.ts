import { describe, it, expect } from "vitest";
import { toolError } from "./tool-error.js";

describe("toolError", () => {
  it("extracts message from Error instances", () => {
    const result = toolError(new Error("something went wrong"));
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "something went wrong" });
  });

  it("stringifies non-Error values", () => {
    const result = toolError("string error");
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "string error" });
  });

  it("handles objects", () => {
    const result = toolError({ code: 404 });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: string; text: string }).text).toBe("[object Object]");
  });

  it("handles null and undefined", () => {
    expect(toolError(null).content[0]).toEqual({ type: "text", text: "null" });
    expect(toolError(undefined).content[0]).toEqual({ type: "text", text: "undefined" });
  });
});
