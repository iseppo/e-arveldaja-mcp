/** Compact JSON without null/undefined fields. Used for all MCP tool responses to minimize token usage. */
export function toMcpJson(obj: unknown): string {
  return JSON.stringify(obj, (_key, val) =>
    (val === null || val === undefined) ? undefined : val
  );
}
