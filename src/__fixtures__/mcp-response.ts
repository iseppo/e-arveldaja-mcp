import { parseMcpResponse as parseMcpResponseUnknown } from "../mcp-json.js";

/**
 * Parse a tool payload as the producer's exported payload type, so a misspelled field fails to
 * compile instead of reading `undefined`. T is a claim about which payload the test received; name
 * the type the producing presenter exports, never a test-local copy.
 */
export function parseToolPayload<T>(text: string): T { return parseMcpResponseUnknown(text) as T; }

/**
 * @deprecated Untyped: any field typo still compiles. Use parseToolPayload<T>. Calls are counted by
 * the typecheck:tests ratchet (UNTYPED_PAYLOAD) and may only go down.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseMcpResponse(text: string): any { return parseMcpResponseUnknown(text); }
