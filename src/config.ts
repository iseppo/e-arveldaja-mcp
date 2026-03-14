import dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(import.meta.dirname, "../.env") });

export interface Config {
  apiKeyId: string;
  apiPublicValue: string;
  apiPassword: string;
  baseUrl: string;
}

const SERVERS = {
  live: "https://rmp-api.rik.ee/v1",
  demo: "https://demo-rmp-api.rik.ee/v1",
} as const;

export function loadConfig(): Config {
  const keyId = process.env.EARVELDAJA_API_KEY_ID;
  const publicValue = process.env.EARVELDAJA_API_PUBLIC_VALUE;
  const password = process.env.EARVELDAJA_API_PASSWORD;

  if (!keyId || !publicValue || !password) {
    throw new Error(
      "Missing API credentials. Set EARVELDAJA_API_KEY_ID, EARVELDAJA_API_PUBLIC_VALUE, and EARVELDAJA_API_PASSWORD."
    );
  }

  const server = process.env.EARVELDAJA_SERVER || "live";
  if (!(server in SERVERS)) {
    throw new Error(`Invalid EARVELDAJA_SERVER="${server}". Must be "live" or "demo".`);
  }
  const baseUrl = SERVERS[server as keyof typeof SERVERS];

  return { apiKeyId: keyId, apiPublicValue: publicValue, apiPassword: password, baseUrl };
}
