import dotenv from "dotenv";
import { resolve } from "path";
import { readFileSync, existsSync, statSync, readdirSync, realpathSync } from "fs";
import { getProjectRoot } from "./paths.js";

export interface Config {
  apiKeyId: string;
  apiPublicValue: string;
  apiPassword: string;
  baseUrl: string;
}

export interface NamedConfig {
  name: string;
  filePath?: string;
  config: Config;
}

const SERVERS = {
  live: "https://rmp-api.rik.ee/v1",
  demo: "https://demo-rmp-api.rik.ee/v1",
} as const;

const PACKAGE_ROOT = getProjectRoot();

function getBaseUrl(): string {
  const server = process.env.EARVELDAJA_SERVER || "live";
  if (!(server in SERVERS)) {
    throw new Error(`Invalid EARVELDAJA_SERVER="${server}". Must be "live" or "demo".`);
  }
  return SERVERS[server as keyof typeof SERVERS];
}

function warnIfWorldReadable(filePath: string): void {
  try {
    const mode = statSync(filePath).mode;
    if (mode & 0o044) {
      process.stderr.write(
        `WARNING: ${filePath} is group/world-readable (mode ${(mode & 0o777).toString(8)}). ` +
        `Run: chmod 600 ${filePath}\n`
      );
    }
  } catch { /* stat failed, continue anyway */ }
}

function toUniqueDirs(dirs: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    const resolvedDir = resolve(dir);
    let dedupeKey = resolvedDir;
    try {
      dedupeKey = realpathSync(resolvedDir);
    } catch {
      // Keep the resolved path if the directory does not exist yet.
    }
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    unique.push(resolvedDir);
  }

  return unique;
}

export function getConfigSearchDirs(
  scanParent = process.env.EARVELDAJA_SCAN_PARENT === "true",
  cwd = process.cwd(),
  packageRoot = PACKAGE_ROOT,
): string[] {
  const dirs = [cwd, packageRoot];
  if (scanParent) {
    dirs.push(resolve(cwd, ".."), resolve(packageRoot, ".."));
  }
  return toUniqueDirs(dirs);
}

export function loadDotenvFiles(): void {
  const loaded = new Set<string>();

  const loadFromDirs = (dirs: string[]): void => {
    for (const dir of dirs) {
      const envPath = resolve(dir, ".env");
      let dedupeKey = envPath;
      try {
        dedupeKey = realpathSync(envPath);
      } catch {
        // Keep the resolved path if the file does not exist.
      }
      if (loaded.has(dedupeKey)) continue;
      loaded.add(dedupeKey);

      warnIfWorldReadable(envPath);
      dotenv.config({ path: envPath });
    }
  };

  loadFromDirs(getConfigSearchDirs(false));

  if (process.env.EARVELDAJA_SCAN_PARENT === "true") {
    loadFromDirs(getConfigSearchDirs(true));
  }
}

function parseApiKeyFile(filePath: string): { keyId: string; publicValue: string; password: string } | null {
  if (!existsSync(filePath)) return null;

  warnIfWorldReadable(filePath);

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
  return null;
}

/**
 * Load all available API configurations from env vars and apikey*.txt files.
 * Scans the runtime working directory first, then the package root.
 * Set EARVELDAJA_SCAN_PARENT=true to also scan parent directories.
 */
export function loadAllConfigs(): NamedConfig[] {
  const baseUrl = getBaseUrl();
  const configs: NamedConfig[] = [];
  const seen = new Set<string>();

  // 1. Check env vars
  const envKeyId = process.env.EARVELDAJA_API_KEY_ID;
  const envPublicValue = process.env.EARVELDAJA_API_PUBLIC_VALUE;
  const envPassword = process.env.EARVELDAJA_API_PASSWORD;
  if (envKeyId && envPublicValue && envPassword) {
    configs.push({
      name: "env",
      config: { apiKeyId: envKeyId, apiPublicValue: envPublicValue, apiPassword: envPassword, baseUrl },
    });
  }

  // 2. Check specific file from env var
  if (process.env.EARVELDAJA_API_KEY_FILE) {
    const parsed = parseApiKeyFile(process.env.EARVELDAJA_API_KEY_FILE);
    if (parsed) {
      configs.push({
        name: "env-file",
        filePath: process.env.EARVELDAJA_API_KEY_FILE,
        config: { apiKeyId: parsed.keyId, apiPublicValue: parsed.publicValue, apiPassword: parsed.password, baseUrl },
      });
      try { seen.add(realpathSync(process.env.EARVELDAJA_API_KEY_FILE)); } catch {}
    }
  }

  // 3. Scan the runtime working directory first, then the package dir.
  // Parent scan remains opt-in.
  const searchDirs = getConfigSearchDirs();

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter(f => /^apikey.*\.txt$/i.test(f)).sort();
    } catch { continue; }

    for (const file of files) {
      const filePath = resolve(dir, file);
      let realPath: string;
      try { realPath = realpathSync(filePath); } catch { continue; }
      if (seen.has(realPath)) continue;
      seen.add(realPath);

      const parsed = parseApiKeyFile(filePath);
      if (parsed) {
        const name = file.replace(/\.txt$/i, "").trim();
        configs.push({
          name,
          filePath,
          config: { apiKeyId: parsed.keyId, apiPublicValue: parsed.publicValue, apiPassword: parsed.password, baseUrl },
        });
      }
    }
  }

  if (configs.length === 0) {
    throw new Error(
      "No API credentials found. Set EARVELDAJA_API_KEY_ID/EARVELDAJA_API_PUBLIC_VALUE/EARVELDAJA_API_PASSWORD " +
      "environment variables, or place apikey*.txt files in the working directory."
    );
  }

  return configs;
}

/** Load single config (first available). Backwards-compatible entry point. */
export function loadConfig(): Config {
  return loadAllConfigs()[0]!.config;
}
