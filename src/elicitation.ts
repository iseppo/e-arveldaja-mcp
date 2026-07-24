/**
 * Capability-aware MCP elicitation wrapper. A thin generalization of the working
 * in-repo precedent (`resolveCredentialStorageScope`, server-bootstrap.ts) that
 * turns a set of BOUNDED, NON-SECRET fields into an `elicitation/create` form
 * when the client supports it, and falls back to the SAME single `needs_input`
 * question the guided façades already emit when it does not.
 *
 * SDK (confirmed, @modelcontextprotocol/sdk 1.29.0):
 *  - `server.server.elicitInput({ mode:"form", message, requestedSchema })`
 *  - `server.server.getClientCapabilities()?.elicitation` — capability probe
 *  - response `{ action:"accept"|"decline"|"cancel", content? }` — only accept
 *    carries usable content
 *  - unsupported client THROWS, matched by `/Client does not support form elicitation/i`
 *
 * SECURITY: the wrapper THROWS at schema build for any field whose key or title
 * matches an api-key / password / secret pattern. Credentials are NEVER elicited
 * through a form — only company / ambiguous bank account / profile / storage
 * scope / bounded non-secret inputs.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** A bounded PRIMITIVE field. No nested objects, no arbitrary types. */
export type ElicitField =
  | { type: "string"; title?: string; description?: string; minLength?: number; maxLength?: number; format?: "date" | "date-time" | "email" | "uri"; default?: string }
  | { type: "enum"; title?: string; description?: string; choices: ReadonlyArray<{ const: string; title?: string }>; default?: string }
  | { type: "boolean"; title?: string; description?: string; default?: boolean }
  | { type: "number" | "integer"; title?: string; description?: string; minimum?: number; maximum?: number; default?: number };

/** The text-fallback payload — the guided façades' existing `needs_input` shape. */
export type NeedsInputPayload = Record<string, unknown>;

export interface ElicitOptions {
  message: string;
  /** NON-SECRET bounded fields only; a secret key/title is refused. */
  fields: Record<string, ElicitField>;
  required?: string[];
  /** Returned verbatim when the client cannot render a form (Step 5 fallback). */
  needsInput: NeedsInputPayload;
}

export type ElicitOutcome =
  | { kind: "answered"; content: Record<string, string | number | boolean | string[]> }
  | { kind: "declined" }
  | { kind: "unsupported"; needsInput: NeedsInputPayload };

export type Elicitor = (opts: ElicitOptions) => Promise<ElicitOutcome>;

// api-key / public-value / password / secret / token / credential / private-key
const SECRET_FIELD_PATTERN = /(api[\s_-]*key|public[\s_-]*value|passw(or)?d|secret|token|credential|hmac|private[\s_-]*key)/i;

/** All candidate strings for one field: key/title/description, plus enum choice consts/titles. */
function candidateStrings(key: string, field: ElicitField): string[] {
  const candidates: string[] = [key];
  if (field.title !== undefined) candidates.push(field.title);
  if (field.description !== undefined) candidates.push(field.description);
  if (field.type === "enum") {
    for (const choice of field.choices) {
      candidates.push(choice.const);
      if (choice.title !== undefined) candidates.push(choice.title);
    }
  }
  return candidates;
}

function assertNoSecretFields(fields: Record<string, ElicitField>): void {
  for (const [key, field] of Object.entries(fields)) {
    if (candidateStrings(key, field).some(candidate => SECRET_FIELD_PATTERN.test(candidate))) {
      throw new Error(
        `Refusing to build an elicitation form: field "${key}" looks like a credential/secret. ` +
        "The elicitation wrapper NEVER elicits api keys, passwords, or secrets.",
      );
    }
  }
}

function toPropertySchema(field: ElicitField): Record<string, unknown> {
  switch (field.type) {
    case "enum": {
      const schema: Record<string, unknown> = {
        type: "string",
        oneOf: field.choices.map(choice => ({
          const: choice.const,
          ...(choice.title !== undefined ? { title: choice.title } : {}),
        })),
      };
      if (field.title !== undefined) schema.title = field.title;
      if (field.description !== undefined) schema.description = field.description;
      if (field.default !== undefined) schema.default = field.default;
      return schema;
    }
    case "boolean": {
      const schema: Record<string, unknown> = { type: "boolean" };
      if (field.title !== undefined) schema.title = field.title;
      if (field.description !== undefined) schema.description = field.description;
      if (field.default !== undefined) schema.default = field.default;
      return schema;
    }
    case "number":
    case "integer": {
      const schema: Record<string, unknown> = { type: field.type };
      if (field.title !== undefined) schema.title = field.title;
      if (field.description !== undefined) schema.description = field.description;
      if (field.minimum !== undefined) schema.minimum = field.minimum;
      if (field.maximum !== undefined) schema.maximum = field.maximum;
      if (field.default !== undefined) schema.default = field.default;
      return schema;
    }
    case "string":
    default: {
      const schema: Record<string, unknown> = { type: "string" };
      if (field.title !== undefined) schema.title = field.title;
      if (field.description !== undefined) schema.description = field.description;
      if (field.minLength !== undefined) schema.minLength = field.minLength;
      if (field.maxLength !== undefined) schema.maxLength = field.maxLength;
      if (field.format !== undefined) schema.format = field.format;
      if (field.default !== undefined) schema.default = field.default;
      return schema;
    }
  }
}

function buildRequestedSchema(opts: ElicitOptions): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(opts.fields)) {
    properties[key] = toPropertySchema(field);
  }
  return {
    type: "object",
    properties,
    ...(opts.required && opts.required.length > 0 ? { required: opts.required } : {}),
  };
}

function isUnsupportedElicitationError(error: unknown): boolean {
  return error instanceof Error && /Client does not support form elicitation/i.test(error.message);
}

/**
 * Build a capability-aware elicitor bound to one server. Returns `answered` on
 * accept, `declined` on decline/cancel, and `unsupported` (carrying the text
 * fallback) when the client cannot render a form.
 */
export function createElicitor(server: McpServer): Elicitor {
  return async (opts: ElicitOptions): Promise<ElicitOutcome> => {
    // Unconditional secret-field guard (a secret request is a programming error
    // regardless of client capability).
    assertNoSecretFields(opts.fields);

    // Capability gate — no elicitInput call when the client cannot elicit.
    const capabilities = server.server.getClientCapabilities();
    if (!capabilities?.elicitation) {
      return { kind: "unsupported", needsInput: opts.needsInput };
    }

    try {
      const result = await server.server.elicitInput({
        mode: "form",
        message: opts.message,
        requestedSchema: buildRequestedSchema(opts) as never,
      });
      if (result.action === "accept" && result.content) {
        return { kind: "answered", content: result.content as Record<string, string | number | boolean | string[]> };
      }
      return { kind: "declined" };
    } catch (error) {
      if (isUnsupportedElicitationError(error)) {
        return { kind: "unsupported", needsInput: opts.needsInput };
      }
      throw error;
    }
  };
}
