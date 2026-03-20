import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerPrompt, registerResource, registerTool } from "./mcp-compat.js";

describe("mcp-compat", () => {
  it("maps legacy tool registrations to registerTool with first-class title", () => {
    const server = { registerTool: vi.fn() } as any;
    const callback = vi.fn();

    registerTool(
      server,
      "list_clients",
      "List all clients",
      {},
      {
        title: "List Clients",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      callback,
    );

    expect(server.registerTool).toHaveBeenCalledWith(
      "list_clients",
      {
        title: "List Clients",
        description: "List all clients",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      callback,
    );
  });

  it("derives prompt titles when the legacy signature has none", () => {
    const server = { registerPrompt: vi.fn() } as any;
    const callback = vi.fn();
    const argsSchema = { file_path: z.string() };

    registerPrompt(server, "book-invoice", "Book an invoice", argsSchema, callback);

    expect(server.registerPrompt).toHaveBeenCalledWith(
      "book-invoice",
      {
        title: "Book Invoice",
        description: "Book an invoice",
        argsSchema,
      },
      callback,
    );
  });

  it("derives resource titles while preserving metadata", () => {
    const server = { registerResource: vi.fn() } as any;
    const callback = vi.fn();

    registerResource(
      server,
      "vat_info",
      "earveldaja://vat_info",
      { description: "VAT settings", mimeType: "application/json" },
      callback,
    );

    expect(server.registerResource).toHaveBeenCalledWith(
      "vat_info",
      "earveldaja://vat_info",
      {
        title: "VAT Info",
        description: "VAT settings",
        mimeType: "application/json",
      },
      callback,
    );
  });
});
