import dotenv from "dotenv";
import { resolve } from "path";
import { readFileSync, existsSync, statSync, readdirSync, realpathSync, lstatSync } from "fs";
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

function validateCredentialFile(filePath: string): boolean {
  try {
    const fileInfo = lstatSync(filePath);
    if (fileInfo.isSymbolicLink()) {
      process.stderr.write(`WARNING: Ignoring symlinked credential file: ${filePath}\n`);
      return false;
    }

    const stats = statSync(filePath);
    if (!stats.isFile()) {
      process.stderr.write(`WARNING: Ignoring non-file credential path: ${filePath}\n`);
      return false;
    }

    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      process.stderr.write(
        `WARNING: Ignoring credential file not owned by the current user: ${filePath}\n`
      );
      return false;
    }

    if (stats.mode & 0o077) {
      process.stderr.write(
        `WARNING: Ignoring ${filePath} because it is accessible by group/others ` +
        `(mode ${(stats.mode & 0o777).toString(8)}). Run: chmod 600 ${filePath}\n`
      );
      return false;
    }

    return true;
  } catch {
    return false;
  }
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
  packageRoot = PACKAGE_ROOT,
): string[] {
  const dirs = [packageRoot];
  if (scanParent) {
    dirs.push(resolve(packageRoot, ".."));
  }
  return toUniqueDirs(dirs);
}

/** Check .env file security. Returns true if safe to load. */
function isSecureEnvFile(envPath: string): boolean {
  try {
    const info = lstatSync(envPath);
    if (info.isSymbolicLink()) {
      process.stderr.write(`WARNING: .env file is a symlink, skipping: ${envPath}\n`);
      return false;
    }
    if (!info.isFile()) return false;
    if (info.mode & 0o077) {
      process.stderr.write(
        `WARNING: ${envPath} is readable by group/others ` +
        `(mode ${(info.mode & 0o777).toString(8)}). Skipping. Run: chmod 600 ${envPath}\n`
      );
      return false;
    }
    return true;
  } catch { return true; /* file may not exist yet — let dotenv handle it */ }
}

export function loadDotenvFiles(): void {
  const loaded = new Set<string>();
  const scanParent = process.env.EARVELDAJA_SCAN_PARENT === "true";

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

      if (isSecureEnvFile(envPath)) {
        dotenv.config({ path: envPath });
      }
    }
  };

  loadFromDirs(getConfigSearchDirs(false));

  if (scanParent) {
    loadFromDirs(getConfigSearchDirs(true));
  }
}

function parseApiKeyFile(filePath: string): { keyId: string; publicValue: string; password: string } | null {
  if (!existsSync(filePath)) return null;

  if (!validateCredentialFile(filePath)) return null;

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
 * Scans the package root by default.
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
      try { seen.add(realpathSync(process.env.EARVELDAJA_API_KEY_FILE)); } catch { /* realpath failed — file may appear as duplicate */ }
    }
  }

  // 3. Scan the package dir by default. Parent scan remains opt-in.
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
      "environment variables, or place apikey*.txt files in the package directory."
    );
  }

  return configs;
}

/** Load single config (first available). Backwards-compatible entry point. */
export function loadConfig(): Config {
  return loadAllConfigs()[0]!.config;
}
