import { createHmac } from "crypto";
import type { Config } from "./config.js";

function formatUtcTime(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
}

export function createAuthHeaders(config: Config, urlPath: string): Record<string, string> {
  const utcTime = formatUtcTime();
  const message = `${config.apiKeyId}:${utcTime}:${urlPath}`;
  const signature = createHmac("sha384", config.apiPassword)
    .update(message)
    .digest("base64");

  return {
    "X-AUTH-KEY": `${config.apiPublicValue}:${signature}`,
    "X-AUTH-QUERYTIME": utcTime,
  };
}
