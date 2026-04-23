import { describe, expect, it } from "vitest";
import { parseMcpResponse } from "./mcp-json.js";
import { toolError } from "./tool-error.js";
import { HttpError } from "./http-client.js";

describe("toolError", () => {
  it("returns MCP isError results for strings", () => {
    const result = toolError("Invalid input");
    expect(result.isError).toBe(true);
    expect(parseMcpResponse((result.content[0] as { type: string; text: string }).text)).toEqual({
      error: "Invalid input",
    });
  });

  it("serializes structured payloads for tool self-correction", () => {
    const result = toolError({
      error: "Account validation failed",
      hint: "Use list_account_dimensions first",
      details: ["4000 missing"],
    });
    expect(result.isError).toBe(true);
    expect(parseMcpResponse((result.content[0] as { type: string; text: string }).text)).toEqual({
      error: "Account validation failed",
      hint: "Use list_account_dimensions first",
      details: ["4000 missing"],
    });
  });

  it("promotes message-based objects into structured MCP errors", () => {
    const result = toolError({
      message: "Retry later",
      hint: "Wait for the upstream API to recover",
      retryable: true,
    });

    expect(result.isError).toBe(true);
    expect(parseMcpResponse((result.content[0] as { type: string; text: string }).text)).toEqual({
      error: "Retry later",
      message: "Retry later",
      hint: "Wait for the upstream API to recover",
      retryable: true,
    });
  });

  it("falls back to a stable message for undefined throws", () => {
    const result = toolError(undefined);
    expect(result.isError).toBe(true);
    expect(parseMcpResponse((result.content[0] as { type: string; text: string }).text)).toEqual({
      error: "Unknown error",
    });
  });

  it("preserves Error causes and custom fields when available", () => {
    const error = new Error("Write failed", {
      cause: { code: "EPIPE", syscall: "write" },
    }) as Error & { details?: string[]; name: string };
    error.name = "TransportError";
    error.details = ["stdout closed"];

    const result = toolError(error);

    expect(result.isError).toBe(true);
    expect(parseMcpResponse((result.content[0] as { type: string; text: string }).text)).toEqual({
      error: "Write failed",
      name: "TransportError",
      cause: { code: "EPIPE", syscall: "write" },
      details: ["stdout closed"],
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

  it("falls back to a stable MCP error when JSON serialization is impossible", () => {
    const result = toolError({ error: "BigInt payload", value: 1n });

    expect(result.isError).toBe(true);
    expect(parseMcpResponse((result.content[0] as { type: string; text: string }).text)).toEqual({
      error: "Internal error",
    });
  });

  it("forwards HttpError.upstream_detail (sandbox-wrapped upstream body) into the MCP payload", () => {
    // Regression guard: a refactor of toErrorPayload that introduces a
    // property allowlist would silently strip upstream_detail, re-opening
    // the raw-upstream-text leak PR closed. This test keeps the link
    // between HttpClient and the LLM-facing response explicit.
    const err = new HttpError(
      "API request failed: POST /x → 400",
      400,
      "POST",
      "/x",
      { upstream_detail: "<<UNTRUSTED_OCR_START:deadbeef>>\ngross_sum mismatch\n<<UNTRUSTED_OCR_END:deadbeef>>" },
    );
    const result = toolError(err);
    const payload = parseMcpResponse((result.content[0] as { type: string; text: string }).text) as {
      error: string;
      name: string;
      upstream_detail: string;
      status: number;
    };
    expect(payload.error).toBe("API request failed: POST /x → 400");
    expect(payload.name).toBe("HttpError");
    expect(payload.upstream_detail).toBe(
      "<<UNTRUSTED_OCR_START:deadbeef>>\ngross_sum mismatch\n<<UNTRUSTED_OCR_END:deadbeef>>",
    );
    expect(payload.status).toBe(400);
  });
});
