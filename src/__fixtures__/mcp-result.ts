/** The first content entry of an MCP tool result as text; throws when it is not a text entry. */
export function firstText(result: { content: ReadonlyArray<{ type: string } & Record<string, unknown>> }): string {
  const first = result.content[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error(`expected a text content entry, got ${first ? first.type : "no content"}`);
  }
  return first.text;
}
