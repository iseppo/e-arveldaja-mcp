import { z } from "zod";

/** Tool description plus its JSON-schema rendering, for asserting on what an MCP client sees. */
export function toolMetadataText(options: { description?: string; inputSchema?: Record<string, unknown> }): string {
  const schema = options.inputSchema ? z.object(options.inputSchema as z.ZodRawShape).toJSONSchema() : {};
  return `${options.description ?? ""}\n${JSON.stringify(schema)}`;
}
