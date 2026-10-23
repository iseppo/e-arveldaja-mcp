import { parseMcpResponse as parseMcpResponseUnknown } from "../mcp-json.js";
/** Test-only: payload fields are asserted at runtime, so the parsed value is untyped on purpose. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseMcpResponse(text: string): any { return parseMcpResponseUnknown(text); }
