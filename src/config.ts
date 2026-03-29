import dotenv from "dotenv";
import { resolve, win32 } from "path";
import { readFileSync, existsSync, statSync, readdirSync, realpathSync, lstatSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { homedir } from "os";
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

export type CredentialStorageScope = "local" | "global";

export interface CredentialSetupInfo {
  mode: "setup";
  message: string;
  working_directory: string;
  searched_directories: string[];
  scan_parent_enabled: boolean;
  env_vars: string[];
  credential_file_env_var: string;
  credential_file_pattern: string;
  credential_file_directory: string;
  global_config_directory: string;
  global_config_directory_env_var: string;
  global_env_file: string;
  file_format_example: string[];
  next_steps: string[];
}

export interface CredentialVerificationResult {
  companyName: string | null;
  verifiedAt?: string;
}

export interface ImportApiKeyCredentialsOptions {
  apiKeyFile: string;
  storageScope: CredentialStorageScope;
  overwrite?: boolean;
  workingDir?: string;
  globalConfigDir?: string;
  server?: "live" | "demo";
  verify: (config: Config) => Promise<CredentialVerificationResult>;
}

export interface ImportApiKeyCredentialsResult {
  envFile: string;
  storageScope: CredentialStorageScope;
  companyName: string | null;
  verifiedAt: string;
  created: boolean;
  sourceFile: string;
}

export const NO_API_CREDENTIALS_FOUND_MESSAGE = "No API credentials found.";

const SERVERS = {
  live: "https://rmp-api.rik.ee/v1",
  demo: "https://demo-rmp-api.rik.ee/v1",
} as const;

const APP_CONFIG_DIR_NAME = "e-arveldaja-mcp";
const GLOBAL_ENV_FILE_NAME = ".env";
const CWD = process.cwd();

function getBaseUrl(): string {
  const server = process.env.EARVELDAJA_SERVER || "live";
  return getBaseUrlForServer(server);
}

export function getBaseUrlForServer(server = process.env.EARVELDAJA_SERVER || "live"): string {
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

function getWorkingDirSearchDirs(
  scanParent = process.env.EARVELDAJA_SCAN_PARENT === "true",
  workingDir = CWD,
): string[] {
  const dirs = [workingDir];
  if (scanParent) {
    dirs.push(resolve(workingDir, ".."));
  }
  return toUniqueDirs(dirs);
}

export function getConfigSearchDirs(
  scanParent = process.env.EARVELDAJA_SCAN_PARENT === "true",
  workingDir = CWD,
  globalConfigDir = getGlobalConfigDir(),
): string[] {
  return toUniqueDirs([
    ...getWorkingDirSearchDirs(scanParent, workingDir),
    globalConfigDir,
  ]);
}

export function getNativeGlobalConfigDir(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  if (platform === "win32") {
    const baseDir = env.APPDATA || win32.resolve(userHome, "AppData", "Roaming");
    return win32.resolve(baseDir, APP_CONFIG_DIR_NAME);
  }

  if (platform === "darwin") {
    return resolve(userHome, "Library", "Application Support", APP_CONFIG_DIR_NAME);
  }

  return resolve(env.XDG_CONFIG_HOME || resolve(userHome, ".config"), APP_CONFIG_DIR_NAME);
}

export function getGlobalConfigDir(): string {
  const configured = process.env.EARVELDAJA_CONFIG_DIR?.trim();
  return configured ? resolve(configured) : getNativeGlobalConfigDir();
}

export function getGlobalEnvFile(globalConfigDir = getGlobalConfigDir()): string {
  return resolve(globalConfigDir, GLOBAL_ENV_FILE_NAME);
}

export function getCredentialSetupInfo(
  scanParent = process.env.EARVELDAJA_SCAN_PARENT === "true",
  workingDir = CWD,
): CredentialSetupInfo {
  const resolvedWorkingDir = resolve(workingDir);
  const globalConfigDirectory = getGlobalConfigDir();
  const searchedDirectories = getConfigSearchDirs(scanParent, workingDir, globalConfigDirectory);
  const globalEnvFile = getGlobalEnvFile(globalConfigDirectory);

  return {
    mode: "setup",
    message: "No API credentials configured. Server is running in setup mode.",
    working_directory: resolvedWorkingDir,
    searched_directories: searchedDirectories,
    scan_parent_enabled: scanParent,
    env_vars: [
      "EARVELDAJA_API_KEY_ID",
      "EARVELDAJA_API_PUBLIC_VALUE",
      "EARVELDAJA_API_PASSWORD",
    ],
    credential_file_env_var: "EARVELDAJA_API_KEY_FILE",
    credential_file_pattern: "apikey*.txt",
    credential_file_directory: resolvedWorkingDir,
    global_config_directory: globalConfigDirectory,
    global_config_directory_env_var: "EARVELDAJA_CONFIG_DIR",
    global_env_file: globalEnvFile,
    file_format_example: [
      "ApiKey ID: <your key id>",
      "ApiKey public value: <your public value>",
      "Password: <your password>",
    ],
    next_steps: [
      "Set the EARVELDAJA_API_KEY_ID, EARVELDAJA_API_PUBLIC_VALUE, and EARVELDAJA_API_PASSWORD environment variables, set EARVELDAJA_API_KEY_FILE to an explicit credential file path, or place apikey*.txt in the working directory and run import_apikey_credentials.",
      "If exactly one secure apikey*.txt is present in the working directory and the MCP client supports prompts, the server will offer to verify it and save the resulting .env locally or in the native global config directory.",
      scanParent
        ? "Parent directory scanning is enabled via EARVELDAJA_SCAN_PARENT=true for local .env discovery."
        : "Set EARVELDAJA_SCAN_PARENT=true if you also want to scan the parent directory for a local .env file before falling back to the global .env.",
      `Native global config directory: ${globalConfigDirectory}. Global env file: ${globalEnvFile}. Override the directory with EARVELDAJA_CONFIG_DIR if needed.`,
      "Keep secrets in the chosen .env once verified; treat apikey*.txt as an import source, not the long-term store.",
      "After adding credentials, restart the MCP server.",
    ],
  };
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
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return true; // file does not exist yet — let dotenv handle it
    }
    return false; // fail closed on unexpected errors
  }
}

function parseEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {};
  if (!isSecureEnvFile(envPath)) return {};
  return dotenv.parse(readFileSync(envPath, "utf-8"));
}

function hasCompleteApiCredentialEnv(env: NodeJS.ProcessEnv | Record<string, string>): boolean {
  return Boolean(env.EARVELDAJA_API_KEY_ID && env.EARVELDAJA_API_PUBLIC_VALUE && env.EARVELDAJA_API_PASSWORD);
}

function writePrivateEnvFile(filePath: string, content: string): void {
  try {
    const info = lstatSync(filePath);
    if (info.isSymbolicLink()) {
      process.stderr.write(`WARNING: Refusing to write global .env through symlink: ${filePath}\n`);
      return;
    }
  } catch {
    // File may not exist yet.
  }

  mkdirSync(resolve(filePath, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, content, { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort on platforms with limited chmod support.
  }
}

function serializeEnvFile(
  env: Record<string, string>,
  metadata?: { companyName?: string | null; verifiedAt?: string; sourceFile?: string },
): string {
  const header: string[] = ["# e-arveldaja credentials"];
  if (metadata?.companyName) header.push(`# Company: ${metadata.companyName}`);
  if (metadata?.verifiedAt) header.push(`# Verified at: ${metadata.verifiedAt}`);
  if (metadata?.sourceFile) header.push(`# Imported from: ${metadata.sourceFile}`);

  const orderedKeys = [
    "EARVELDAJA_SERVER",
    "EARVELDAJA_API_KEY_ID",
    "EARVELDAJA_API_PUBLIC_VALUE",
    "EARVELDAJA_API_PASSWORD",
  ];
  const keys = [
    ...orderedKeys.filter((key) => env[key]),
    ...Object.keys(env).filter((key) => env[key] && !orderedKeys.includes(key)).sort(),
  ];

  return `${header.join("\n")}\n${keys.map((key) => `${key}=${env[key]}`).join("\n")}\n`;
}

export function loadDotenvFiles(): void {
  const loaded = new Set<string>();
  const scanParent = process.env.EARVELDAJA_SCAN_PARENT === "true";

  const loadFiles = (envPaths: string[]): void => {
    for (const envPath of envPaths) {
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

  loadFiles([
    ...getWorkingDirSearchDirs(scanParent).map((dir) => resolve(dir, ".env")),
    getGlobalEnvFile(),
  ]);
}

export function parseApiKeyFile(filePath: string): { keyId: string; publicValue: string; password: string } | null {
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

export function findImportableApiKeyFiles(workingDir = CWD): string[] {
  let files: string[];
  try {
    files = readdirSync(workingDir).filter((file) => /^apikey.*\.txt$/i.test(file)).sort();
  } catch {
    return [];
  }

  return files
    .map((file) => resolve(workingDir, file))
    .filter((filePath) => parseApiKeyFile(filePath) !== null);
}

export async function importApiKeyCredentials(
  options: ImportApiKeyCredentialsOptions,
): Promise<ImportApiKeyCredentialsResult> {
  const parsed = parseApiKeyFile(options.apiKeyFile);
  if (!parsed) {
    throw new Error(`Could not read a valid apikey file from ${options.apiKeyFile}`);
  }

  const server = options.server ?? (process.env.EARVELDAJA_SERVER === "demo" ? "demo" : "live");
  const config: Config = {
    apiKeyId: parsed.keyId,
    apiPublicValue: parsed.publicValue,
    apiPassword: parsed.password,
    baseUrl: getBaseUrlForServer(server),
  };
  const verification = await options.verify(config);
  const verifiedAt = verification.verifiedAt ?? new Date().toISOString();

  const targetEnvFile = options.storageScope === "local"
    ? resolve(options.workingDir ?? CWD, ".env")
    : getGlobalEnvFile(options.globalConfigDir);
  const targetEnvFileExists = existsSync(targetEnvFile);

  const existingEnv = parseEnvFile(targetEnvFile);
  const existingHasCredentials = hasCompleteApiCredentialEnv(existingEnv);
  const credentialsDiffer = existingHasCredentials && (
    existingEnv.EARVELDAJA_API_KEY_ID !== parsed.keyId ||
    existingEnv.EARVELDAJA_API_PUBLIC_VALUE !== parsed.publicValue ||
    existingEnv.EARVELDAJA_API_PASSWORD !== parsed.password ||
    (existingEnv.EARVELDAJA_SERVER ?? "live") !== server
  );

  if (credentialsDiffer && options.overwrite !== true) {
    throw new Error(
      `Target env file already contains different e-arveldaja credentials: ${targetEnvFile}. ` +
      "Pass overwrite=true to replace them."
    );
  }

  const mergedEnv: Record<string, string> = {
    ...existingEnv,
    EARVELDAJA_SERVER: server,
    EARVELDAJA_API_KEY_ID: parsed.keyId,
    EARVELDAJA_API_PUBLIC_VALUE: parsed.publicValue,
    EARVELDAJA_API_PASSWORD: parsed.password,
  };

  writePrivateEnvFile(targetEnvFile, serializeEnvFile(mergedEnv, {
    companyName: verification.companyName,
    verifiedAt,
    sourceFile: options.apiKeyFile,
  }));

  return {
    envFile: targetEnvFile,
    storageScope: options.storageScope,
    companyName: verification.companyName,
    verifiedAt,
    created: !targetEnvFileExists || !existingHasCredentials,
    sourceFile: options.apiKeyFile,
  };
}

/**
 * Load all available API configurations from env vars and apikey*.txt files.
 * Env vars and .env are the canonical config sources. apikey*.txt remains a
 * local bootstrap/import source for the current working directory.
 */
export function loadAllConfigs(): NamedConfig[] {
  const baseUrl = getBaseUrl();
  const configs: NamedConfig[] = [];
  const seen = new Set<string>();
  const seenConnections = new Set<string>();

  const addConfig = (entry: NamedConfig): void => {
    const connectionKey = `${entry.config.baseUrl}\n${entry.config.apiKeyId}\n${entry.config.apiPublicValue}`;
    if (seenConnections.has(connectionKey)) return;
    seenConnections.add(connectionKey);
    configs.push(entry);
  };

  // 1. Check env vars
  const envKeyId = process.env.EARVELDAJA_API_KEY_ID;
  const envPublicValue = process.env.EARVELDAJA_API_PUBLIC_VALUE;
  const envPassword = process.env.EARVELDAJA_API_PASSWORD;
  if (envKeyId && envPublicValue && envPassword) {
    addConfig({
      name: "env",
      config: { apiKeyId: envKeyId, apiPublicValue: envPublicValue, apiPassword: envPassword, baseUrl },
    });
  }

  // 2. Check specific file from env var
  if (process.env.EARVELDAJA_API_KEY_FILE) {
    const parsed = parseApiKeyFile(process.env.EARVELDAJA_API_KEY_FILE);
    if (parsed) {
      addConfig({
        name: "env-file",
        filePath: process.env.EARVELDAJA_API_KEY_FILE,
        config: { apiKeyId: parsed.keyId, apiPublicValue: parsed.publicValue, apiPassword: parsed.password, baseUrl },
      });
      try { seen.add(realpathSync(process.env.EARVELDAJA_API_KEY_FILE)); } catch { /* realpath failed — file may appear as duplicate */ }
    }
  }

  // 3. Scan local credential files only. The global directory is reserved for the canonical .env.
  const searchDirs = getWorkingDirSearchDirs();

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
        addConfig({
          name,
          filePath,
          config: { apiKeyId: parsed.keyId, apiPublicValue: parsed.publicValue, apiPassword: parsed.password, baseUrl },
        });
      }
    }
  }

  if (configs.length === 0) {
    throw new Error(
      `${NO_API_CREDENTIALS_FOUND_MESSAGE} ` +
      "Set EARVELDAJA_API_KEY_ID/EARVELDAJA_API_PUBLIC_VALUE/EARVELDAJA_API_PASSWORD " +
      "environment variables, set EARVELDAJA_API_KEY_FILE, or place apikey*.txt in the working directory and run import_apikey_credentials."
    );
  }

  return configs;
}
