import { encode, decode } from "@toon-format/toon";

/** Strip null/undefined fields recursively, then encode as TOON for minimal token usage. */
export function toMcpJson(obj: unknown): string {
  let stripped: unknown;
  try {
    stripped = JSON.parse(JSON.stringify(obj, (_key, val) =>
      (val === null || val === undefined) ? undefined : val
    ));
  } catch (e) {
    throw new Error(`Failed to serialize MCP response: ${e instanceof Error ? e.message : String(e)}`);
  }
  return encode(stripped);
}

/** Parse a TOON-encoded MCP response back into an object. For use in tests. */
export function parseMcpResponse(text: string): unknown {
  return decode(text);
}
