import dotenv from "dotenv";
import { resolve } from "path";
import { readFileSync, existsSync, statSync } from "fs";

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

/**
 * Parse e-arveldaja apikey.txt credential file.
 * Format:
 *   ApiKey ID: <key_id>
 *   ApiKey public value: <public_value>
 *   Password: <password>
 */
function loadFromApiKeyFile(): { keyId: string; publicValue: string; password: string } | null {
  const candidates = [
    process.env.EARVELDAJA_API_KEY_FILE,
    resolve(import.meta.dirname, "../apikey.txt"),
    resolve(import.meta.dirname, "../../apikey.txt"),
  ].filter(Boolean) as string[];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;

    // Warn if credential file is world-readable
    try {
      const mode = statSync(filePath).mode;
      if (mode & 0o004) {
        process.stderr.write(
          `WARNING: ${filePath} is world-readable (mode ${(mode & 0o777).toString(8)}). ` +
          `Run: chmod 600 ${filePath}\n`
        );
      }
    } catch { /* stat failed, continue anyway */ }

    const content = readFileSync(filePath, "utf-8");
    const keyIdMatch = content.match(/^ApiKey ID:\s*(.+)$/m);
    const publicValueMatch = content.match(/^ApiKey public value:\s*(.+)$/m);
    const passwordMatch = content.match(/^Password:\s*(.+)$/m);

    if (keyIdMatch?.[1] && publicValueMatch?.[1] && passwordMatch?.[1]) {
      return {
        keyId: keyIdMatch[1].trim(),
        publicValue: publicValueMatch[1].trim(),
        password: passwordMatch[1].trim(),
      };
    }
  }

  return null;
}

export function loadConfig(): Config {
  let keyId = process.env.EARVELDAJA_API_KEY_ID;
  let publicValue = process.env.EARVELDAJA_API_PUBLIC_VALUE;
  let password = process.env.EARVELDAJA_API_PASSWORD;

  // Fall back to apikey.txt if env vars are missing
  if (!keyId || !publicValue || !password) {
    const fromFile = loadFromApiKeyFile();
    if (fromFile) {
      keyId = keyId ?? fromFile.keyId;
      publicValue = publicValue ?? fromFile.publicValue;
      password = password ?? fromFile.password;
    }
  }

  if (!keyId || !publicValue || !password) {
    throw new Error(
      "Missing API credentials. Set EARVELDAJA_API_KEY_ID/EARVELDAJA_API_PUBLIC_VALUE/EARVELDAJA_API_PASSWORD " +
      "environment variables, or place apikey.txt next to the project."
    );
  }

  const server = process.env.EARVELDAJA_SERVER || "live";
  if (!(server in SERVERS)) {
    throw new Error(`Invalid EARVELDAJA_SERVER="${server}". Must be "live" or "demo".`);
  }
  const baseUrl = SERVERS[server as keyof typeof SERVERS];

  return { apiKeyId: keyId, apiPublicValue: publicValue, apiPassword: password, baseUrl };
}
