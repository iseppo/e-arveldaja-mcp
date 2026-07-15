import { createHash } from "node:crypto";
import type { Config } from "./config.js";

export function buildConnectionFingerprint(
  config: Pick<Config, "baseUrl" | "apiKeyId" | "apiPublicValue">,
): string {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  return createHash("sha256")
    .update(`${baseUrl}\n${config.apiKeyId}\n${config.apiPublicValue}`)
    .digest("hex");
}
