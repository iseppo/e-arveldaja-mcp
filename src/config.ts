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
  action: "created" | "appended" | "replaced" | "unchanged";
  sourceFile: string;
  target: "primary" | `connection_${number}`;
}

export interface StoredCredentialSummary {
  target: "primary" | `connection_${number}`;
  name: string;
  server: "live" | "demo";
  apiKeyId: string;
  isDefault: boolean;
}

export interface StoredCredentialInventory {
  storageScope: CredentialStorageScope;
  envFile: string;
  credentials: StoredCredentialSummary[];
}

export interface RemoveStoredCredentialOptions {
  storageScope: CredentialStorageScope;
  target: "primary" | `connection_${number}`;
  workingDir?: string;
  globalConfigDir?: string;
}

export interface RemoveStoredCredentialResult {
  envFile: string;
  storageScope: CredentialStorageScope;
  removedTarget: "primary" | `connection_${number}`;
  remainingCredentials: number;
}

export const NO_API_CREDENTIALS_FOUND_MESSAGE = "No API credentials found.";

const SERVERS = {
  live: "https://rmp-api.rik.ee/v1",
  demo: "https://demo-rmp-api.rik.ee/v1",
} as const;

const APP_CONFIG_DIR_NAME = "e-arveldaja-mcp";
const GLOBAL_ENV_FILE_NAME = ".env";
const CWD = process.cwd();
const API_CREDENTIAL_ENV_KEYS = [
  "EARVELDAJA_API_KEY_ID",
  "EARVELDAJA_API_PUBLIC_VALUE",
  "EARVELDAJA_API_PASSWORD",
] as const;
const ENV_CONNECTION_KEY_RE = /^EARVELDAJA_CONNECTION_(\d+)_(SERVER|API_KEY_ID|API_PUBLIC_VALUE|API_PASSWORD)$/;

type CredentialServer = keyof typeof SERVERS;

interface StoredCredentialBlock {
  target: "primary" | `connection_${number}`;
  name: string;
  server: CredentialServer;
  apiKeyId: string;
  apiPublicValue: string;
  apiPassword: string;
}

interface CredentialBlockMetadata {
  companyName?: string | null;
  verifiedAt?: string;
  sourceFile?: string;
}

type CredentialMetadataMap = Partial<Record<"primary" | `connection_${number}`, CredentialBlockMetadata>>;

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
  workingDir = CWD,
): string[] {
  return toUniqueDirs([workingDir]);
}

export function getConfigSearchDirs(
  workingDir = CWD,
  globalConfigDir = getGlobalConfigDir(),
): string[] {
  return toUniqueDirs([
    ...getWorkingDirSearchDirs(workingDir),
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
  workingDir = CWD,
): CredentialSetupInfo {
  const resolvedWorkingDir = resolve(workingDir);
  const globalConfigDirectory = getGlobalConfigDir();
  const searchedDirectories = getConfigSearchDirs(workingDir, globalConfigDirectory);
  const globalEnvFile = getGlobalEnvFile(globalConfigDirectory);

  return {
    mode: "setup",
    message: "No API credentials configured. Server is running in setup mode.",
    working_directory: resolvedWorkingDir,
    searched_directories: searchedDirectories,
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
      "Set the EARVELDAJA_API_KEY_ID, EARVELDAJA_API_PUBLIC_VALUE, and EARVELDAJA_API_PASSWORD environment variables, set EARVELDAJA_API_KEY_FILE to an explicit credential file path, or place apikey*.txt in this folder and run import_apikey_credentials.",
      "If credentials are already stored, import_apikey_credentials can append another stored connection by default, and list_stored_credentials / remove_stored_credentials can inspect or delete stored .env connections.",
      "If exactly one secure apikey*.txt is present in this folder and the MCP client supports prompts, the server will offer to verify it and save the resulting .env either only for this folder or so it works when you start the MCP server from any folder.",
      `Shared config directory (used when you want the configuration available from any folder): ${globalConfigDirectory}. Shared env file: ${globalEnvFile}. Override the directory with EARVELDAJA_CONFIG_DIR if needed.`,
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

function parseEnvMetadata(envPath: string): CredentialMetadataMap {
  if (!existsSync(envPath)) return {};
  if (!isSecureEnvFile(envPath)) return {};

  const metadataByTarget: CredentialMetadataMap = {};
  const pendingPrimary: CredentialBlockMetadata = {};
  let currentTarget: "primary" | `connection_${number}` | null = null;

  const ensureTarget = (target: "primary" | `connection_${number}`): CredentialBlockMetadata => {
    const existing = metadataByTarget[target];
    if (existing) return existing;
    const created: CredentialBlockMetadata = {};
    metadataByTarget[target] = created;
    return created;
  };

  const assignMetadata = (field: keyof CredentialBlockMetadata, value: string): void => {
    if (currentTarget) {
      ensureTarget(currentTarget)[field] = value;
    } else {
      pendingPrimary[field] = value;
    }
  };

  const adoptPendingPrimary = (): void => {
    if (!pendingPrimary.companyName && !pendingPrimary.verifiedAt && !pendingPrimary.sourceFile) return;
    metadataByTarget.primary = {
      ...(metadataByTarget.primary ?? {}),
      ...pendingPrimary,
    };
    delete pendingPrimary.companyName;
    delete pendingPrimary.verifiedAt;
    delete pendingPrimary.sourceFile;
  };

  const lines = readFileSync(envPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const defaultMatch = line.match(/^# Default connection\s*$/);
    if (defaultMatch) {
      currentTarget = "primary";
      ensureTarget(currentTarget);
      continue;
    }

    const additionalMatch = line.match(/^# Additional connection (\d+)\s*$/);
    if (additionalMatch) {
      currentTarget = getEnvConnectionTarget(Number(additionalMatch[1]));
      ensureTarget(currentTarget);
      continue;
    }

    const companyMatch = line.match(/^# Company:\s*(.*)$/);
    if (companyMatch) {
      assignMetadata("companyName", companyMatch[1]);
      continue;
    }

    const verifiedAtMatch = line.match(/^# Verified at:\s*(.*)$/);
    if (verifiedAtMatch) {
      assignMetadata("verifiedAt", verifiedAtMatch[1]);
      continue;
    }

    const sourceFileMatch = line.match(/^# Imported from:\s*(.*)$/);
    if (sourceFileMatch) {
      assignMetadata("sourceFile", sourceFileMatch[1]);
      continue;
    }

    if (/^(EARVELDAJA_SERVER|EARVELDAJA_API_KEY_ID|EARVELDAJA_API_PUBLIC_VALUE|EARVELDAJA_API_PASSWORD)=/.test(line)) {
      currentTarget = "primary";
      adoptPendingPrimary();
      continue;
    }

    const extraKeyMatch = line.match(/^EARVELDAJA_CONNECTION_(\d+)_/);
    if (extraKeyMatch) {
      currentTarget = getEnvConnectionTarget(Number(extraKeyMatch[1]));
      ensureTarget(currentTarget);
    }
  }

  return metadataByTarget;
}

function hasAnyApiCredentialEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  return API_CREDENTIAL_ENV_KEYS.some((key) => Boolean(env[key]));
}

function hasCompleteApiCredentialEnv(env: NodeJS.ProcessEnv | Record<string, string>): boolean {
  return API_CREDENTIAL_ENV_KEYS.every((key) => Boolean(env[key]));
}

function getEnvConnectionKey(slot: number, field: "SERVER" | "API_KEY_ID" | "API_PUBLIC_VALUE" | "API_PASSWORD"): string {
  return `EARVELDAJA_CONNECTION_${slot}_${field}`;
}

function getEnvConnectionTarget(slot: number): `connection_${number}` {
  return `connection_${slot}`;
}

function getStoredCredentialSlot(target: "primary" | `connection_${number}`): number | null {
  if (target === "primary") return null;
  return Number(target.replace("connection_", ""));
}

function parseStoredCredentialTarget(value: string): "primary" | `connection_${number}` {
  if (value === "primary") return value;
  const match = value.match(/^connection_(\d+)$/);
  if (!match) {
    throw new Error(`Invalid stored credential target "${value}". Use "primary" or "connection_N".`);
  }
  return value as `connection_${number}`;
}

function getTargetEnvFile(
  storageScope: CredentialStorageScope,
  options: { workingDir?: string; globalConfigDir?: string } = {},
): string {
  return storageScope === "local"
    ? resolve(options.workingDir ?? CWD, ".env")
    : getGlobalEnvFile(options.globalConfigDir);
}

function normalizeCredentialServer(server: string | undefined): CredentialServer | null {
  if (server === undefined || server === "") return "live";
  return server === "live" || server === "demo" ? server : null;
}

function readStoredCredentialBlocks(
  env: Record<string, string>,
  options: { includePrimary?: boolean; extraNamePrefix?: string; primaryName?: string } = {},
): StoredCredentialBlock[] {
  const blocks: StoredCredentialBlock[] = [];

  if (options.includePrimary !== false && hasCompleteApiCredentialEnv(env)) {
    const server = normalizeCredentialServer(env.EARVELDAJA_SERVER);
    if (server) {
      blocks.push({
        target: "primary",
        name: options.primaryName ?? "env",
        server,
        apiKeyId: env.EARVELDAJA_API_KEY_ID!,
        apiPublicValue: env.EARVELDAJA_API_PUBLIC_VALUE!,
        apiPassword: env.EARVELDAJA_API_PASSWORD!,
      });
    }
  }

  const grouped = new Map<number, Partial<Record<"SERVER" | "API_KEY_ID" | "API_PUBLIC_VALUE" | "API_PASSWORD", string>>>();
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(ENV_CONNECTION_KEY_RE);
    if (!match) continue;

    const slot = Number(match[1]);
    if (!Number.isInteger(slot) || slot <= 0) continue;

    const field = match[2] as "SERVER" | "API_KEY_ID" | "API_PUBLIC_VALUE" | "API_PASSWORD";
    const group = grouped.get(slot) ?? {};
    group[field] = value;
    grouped.set(slot, group);
  }

  const extraNamePrefix = options.extraNamePrefix ?? "env";
  const slots = [...grouped.keys()].sort((a, b) => a - b);
  for (const slot of slots) {
    const group = grouped.get(slot)!;
    if (!group.API_KEY_ID || !group.API_PUBLIC_VALUE || !group.API_PASSWORD) continue;

    const server = normalizeCredentialServer(group.SERVER);
    if (!server) continue;

    blocks.push({
      target: getEnvConnectionTarget(slot),
      name: `${extraNamePrefix}-${slot}`,
      server,
      apiKeyId: group.API_KEY_ID,
      apiPublicValue: group.API_PUBLIC_VALUE,
      apiPassword: group.API_PASSWORD,
    });
  }

  return blocks;
}

function findMatchingStoredCredentialTarget(
  blocks: StoredCredentialBlock[],
  candidate: { server: CredentialServer; apiKeyId: string; apiPublicValue: string; apiPassword: string },
): "primary" | `connection_${number}` | null {
  const match = blocks.find((block) =>
    block.server === candidate.server &&
    block.apiKeyId === candidate.apiKeyId &&
    block.apiPublicValue === candidate.apiPublicValue &&
    block.apiPassword === candidate.apiPassword
  );
  return match?.target ?? null;
}

function findNextConnectionSlot(env: Record<string, string>): number {
  const used = new Set<number>();
  for (const key of Object.keys(env)) {
    const match = key.match(ENV_CONNECTION_KEY_RE);
    if (!match) continue;
    const slot = Number(match[1]);
    if (Number.isInteger(slot) && slot > 0) used.add(slot);
  }

  let slot = 1;
  while (used.has(slot)) slot += 1;
  return slot;
}

function setStoredCredentialBlock(
  env: Record<string, string>,
  target: "primary" | `connection_${number}`,
  values: { server: CredentialServer; apiKeyId: string; apiPublicValue: string; apiPassword: string },
): Record<string, string> {
  const next = { ...env };

  if (target === "primary") {
    next.EARVELDAJA_SERVER = values.server;
    next.EARVELDAJA_API_KEY_ID = values.apiKeyId;
    next.EARVELDAJA_API_PUBLIC_VALUE = values.apiPublicValue;
    next.EARVELDAJA_API_PASSWORD = values.apiPassword;
    return next;
  }

  const slot = getStoredCredentialSlot(target)!;
  next[getEnvConnectionKey(slot, "SERVER")] = values.server;
  next[getEnvConnectionKey(slot, "API_KEY_ID")] = values.apiKeyId;
  next[getEnvConnectionKey(slot, "API_PUBLIC_VALUE")] = values.apiPublicValue;
  next[getEnvConnectionKey(slot, "API_PASSWORD")] = values.apiPassword;
  return next;
}

function removeStoredCredentialBlock(
  env: Record<string, string>,
  target: "primary" | `connection_${number}`,
): Record<string, string> {
  const next = { ...env };

  if (target === "primary") {
    delete next.EARVELDAJA_SERVER;
    delete next.EARVELDAJA_API_KEY_ID;
    delete next.EARVELDAJA_API_PUBLIC_VALUE;
    delete next.EARVELDAJA_API_PASSWORD;
    return next;
  }

  const slot = getStoredCredentialSlot(target)!;
  delete next[getEnvConnectionKey(slot, "SERVER")];
  delete next[getEnvConnectionKey(slot, "API_KEY_ID")];
  delete next[getEnvConnectionKey(slot, "API_PUBLIC_VALUE")];
  delete next[getEnvConnectionKey(slot, "API_PASSWORD")];
  return next;
}

function writePrivateEnvFile(filePath: string, content: string): void {
  try {
    const info = lstatSync(filePath);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to write .env through symlink: ${filePath}`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      // File may not exist yet.
    } else if (error instanceof Error) {
      throw error;
    } else {
      throw new Error(`Could not prepare env file for writing: ${filePath}`);
    }
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
  metadataByTarget: CredentialMetadataMap = {},
): string {
  const serializeEnvValue = (v: string): string => {
    const needsQuoting = v === "" || /^[\s]|[\s]$/.test(v) || /[#\n\r]/.test(v);
    if (!needsQuoting) return v;

    const hasNewline = /[\n\r]/.test(v);
    if (hasNewline) {
      if (v.includes(`"`)) {
        throw new Error("Cannot serialize env value containing both newlines and double quotes safely.");
      }
      return `"${v.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
    }

    if (v.includes("#")) {
      if (!v.includes(`'`)) {
        return `'${v}'`;
      }
      if (!v.includes(`"`)) {
        return `"${v}"`;
      }

      throw new Error("Cannot serialize env value containing both quote characters when quoting is required.");
    }

    if (!v.includes(`'`)) {
      return `'${v}'`;
    }
    return `"${v}"`;
  };

  const buildMetadataLines = (metadata?: CredentialBlockMetadata): string[] => {
    const lines: string[] = [];
    if (metadata?.companyName) lines.push(`# Company: ${metadata.companyName}`);
    if (metadata?.verifiedAt) lines.push(`# Verified at: ${metadata.verifiedAt}`);
    if (metadata?.sourceFile) lines.push(`# Imported from: ${metadata.sourceFile}`);
    return lines;
  };

  const sections: string[] = [];
  const primary = readStoredCredentialBlocks(env, { includePrimary: true, extraNamePrefix: "env" })
    .find((block) => block.target === "primary");
  const extras = readStoredCredentialBlocks(env, { includePrimary: false, extraNamePrefix: "env" });

  if (primary || extras.length > 0) {
    sections.push("# e-arveldaja credentials");
  }

  if (primary) {
    sections.push([
      "# Default connection",
      ...buildMetadataLines(metadataByTarget.primary),
      `EARVELDAJA_SERVER=${serializeEnvValue(primary.server)}`,
      `EARVELDAJA_API_KEY_ID=${serializeEnvValue(primary.apiKeyId)}`,
      `EARVELDAJA_API_PUBLIC_VALUE=${serializeEnvValue(primary.apiPublicValue)}`,
      `EARVELDAJA_API_PASSWORD=${serializeEnvValue(primary.apiPassword)}`,
    ].join("\n"));
  }

  for (const block of extras) {
    const slot = getStoredCredentialSlot(block.target)!;
    sections.push([
      `# Additional connection ${slot}`,
      ...buildMetadataLines(metadataByTarget[block.target]),
      `${getEnvConnectionKey(slot, "SERVER")}=${serializeEnvValue(block.server)}`,
      `${getEnvConnectionKey(slot, "API_KEY_ID")}=${serializeEnvValue(block.apiKeyId)}`,
      `${getEnvConnectionKey(slot, "API_PUBLIC_VALUE")}=${serializeEnvValue(block.apiPublicValue)}`,
      `${getEnvConnectionKey(slot, "API_PASSWORD")}=${serializeEnvValue(block.apiPassword)}`,
    ].join("\n"));
  }

  const managedKeys = new Set<string>([
    "EARVELDAJA_SERVER",
    "EARVELDAJA_API_KEY_ID",
    "EARVELDAJA_API_PUBLIC_VALUE",
    "EARVELDAJA_API_PASSWORD",
  ]);
  for (const key of Object.keys(env)) {
    if (ENV_CONNECTION_KEY_RE.test(key)) managedKeys.add(key);
  }

  const otherKeys = Object.keys(env)
    .filter((key) => env[key] && !managedKeys.has(key))
    .sort();

  if (otherKeys.length > 0) {
    sections.push(otherKeys.map((key) => `${key}=${serializeEnvValue(env[key]!)}`).join("\n"));
  }

  if (sections.length === 0) return "";
  return `${sections.join("\n\n")}\n`;
}

export function loadDotenvFiles(): void {
  const loaded = new Set<string>();
  const explicitServerProvided = process.env.EARVELDAJA_SERVER !== undefined;
  const explicitCredentialFileProvided = Boolean(process.env.EARVELDAJA_API_KEY_FILE?.trim());
  let credentialKeysAlreadyProvided =
    hasCompleteApiCredentialEnv(process.env) || explicitCredentialFileProvided;
  let serverLoadedFromStandaloneFile = false;

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

      const parsed = parseEnvFile(envPath);
      if (Object.keys(parsed).length === 0) continue;

      const hasAnyCredentialKeys = hasAnyApiCredentialEnv(parsed);
      const hasCompleteCredentialSet = hasCompleteApiCredentialEnv(parsed);
      if (hasAnyCredentialKeys && !hasCompleteCredentialSet) {
        process.stderr.write(
          `WARNING: Ignoring incomplete e-arveldaja credential keys in ${envPath}. ` +
          "Provide all EARVELDAJA_API_KEY_* values in the same file.\n"
        );
      }

      for (const [key, value] of Object.entries(parsed)) {
        if (API_CREDENTIAL_ENV_KEYS.includes(key as typeof API_CREDENTIAL_ENV_KEYS[number])) continue;
        if (ENV_CONNECTION_KEY_RE.test(key)) continue;
        if (key === "EARVELDAJA_SERVER") {
          if (explicitServerProvided) continue;
          if (credentialKeysAlreadyProvided) continue;
          if (hasAnyCredentialKeys) continue;
          if (process.env.EARVELDAJA_SERVER === undefined) {
            process.env.EARVELDAJA_SERVER = value;
            serverLoadedFromStandaloneFile = true;
          }
          continue;
        }
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }

      if (hasCompleteCredentialSet && !credentialKeysAlreadyProvided) {
        for (const key of API_CREDENTIAL_ENV_KEYS) {
          process.env[key] = parsed[key]!;
        }
        if (!explicitServerProvided) {
          if (parsed.EARVELDAJA_SERVER !== undefined) {
            process.env.EARVELDAJA_SERVER = parsed.EARVELDAJA_SERVER;
            serverLoadedFromStandaloneFile = false;
          } else if (serverLoadedFromStandaloneFile) {
            delete process.env.EARVELDAJA_SERVER;
            serverLoadedFromStandaloneFile = false;
          }
        }
        credentialKeysAlreadyProvided = true;
      }
    }
  };

  loadFiles([
    ...getWorkingDirSearchDirs().map((dir) => resolve(dir, ".env")),
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

  const targetEnvFile = getTargetEnvFile(options.storageScope, options);

  const existingEnv = parseEnvFile(targetEnvFile);
  const existingMetadata = parseEnvMetadata(targetEnvFile);
  const existingHasPrimaryCredentials = hasCompleteApiCredentialEnv(existingEnv);
  const existingBlocks = readStoredCredentialBlocks(existingEnv, { includePrimary: true, extraNamePrefix: "env" });
  const matchingTarget = findMatchingStoredCredentialTarget(existingBlocks, {
    server,
    apiKeyId: parsed.keyId,
    apiPublicValue: parsed.publicValue,
    apiPassword: parsed.password,
  });

  if (matchingTarget && !(options.overwrite === true && matchingTarget !== "primary")) {
    return {
      envFile: targetEnvFile,
      storageScope: options.storageScope,
      companyName: verification.companyName,
      verifiedAt,
      created: false,
      action: "unchanged",
      sourceFile: options.apiKeyFile,
      target: matchingTarget,
    };
  }

  let mergedEnv = { ...existingEnv };
  const mergedMetadata: CredentialMetadataMap = { ...existingMetadata };
  let action: "created" | "appended" | "replaced" | "unchanged";
  let target: "primary" | `connection_${number}`;

  if (options.overwrite === true || !existingHasPrimaryCredentials) {
    target = "primary";
    action = existingHasPrimaryCredentials ? "replaced" : "created";
    mergedEnv = setStoredCredentialBlock(mergedEnv, target, {
      server,
      apiKeyId: parsed.keyId,
      apiPublicValue: parsed.publicValue,
      apiPassword: parsed.password,
    });
    if (matchingTarget) {
      mergedEnv = removeStoredCredentialBlock(mergedEnv, matchingTarget);
      delete mergedMetadata[matchingTarget];
    }
  } else {
    const slot = findNextConnectionSlot(mergedEnv);
    target = getEnvConnectionTarget(slot);
    action = "appended";
    mergedEnv = setStoredCredentialBlock(mergedEnv, target, {
      server,
      apiKeyId: parsed.keyId,
      apiPublicValue: parsed.publicValue,
      apiPassword: parsed.password,
    });
  }

  mergedMetadata[target] = {
    companyName: verification.companyName,
    verifiedAt,
    sourceFile: options.apiKeyFile,
  };

  writePrivateEnvFile(targetEnvFile, serializeEnvFile(mergedEnv, mergedMetadata));

  return {
    envFile: targetEnvFile,
    storageScope: options.storageScope,
    companyName: verification.companyName,
    verifiedAt,
    created: action === "created",
    action,
    sourceFile: options.apiKeyFile,
    target,
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
  const explicitApiKeyFile = process.env.EARVELDAJA_API_KEY_FILE?.trim();
  const explicitApiKeyConfig = explicitApiKeyFile
    ? parseApiKeyFile(explicitApiKeyFile)
    : null;

  if (explicitApiKeyFile && !explicitApiKeyConfig) {
    throw new Error(
      `EARVELDAJA_API_KEY_FILE points to an unreadable or invalid credential file: ${explicitApiKeyFile}`
    );
  }

  const addConfig = (entry: NamedConfig): void => {
    const connectionKey = `${entry.config.baseUrl}\n${entry.config.apiKeyId}\n${entry.config.apiPublicValue}\n${entry.config.apiPassword}`;
    if (seenConnections.has(connectionKey)) return;
    seenConnections.add(connectionKey);
    configs.push(entry);
  };

  // 1. Check specific file from env var first so the explicitly selected
  // credential source becomes the active connection when multiple sources exist.
  if (explicitApiKeyFile && explicitApiKeyConfig) {
    addConfig({
      name: "env-file",
      filePath: explicitApiKeyFile,
      config: {
        apiKeyId: explicitApiKeyConfig.keyId,
        apiPublicValue: explicitApiKeyConfig.publicValue,
        apiPassword: explicitApiKeyConfig.password,
        baseUrl,
      },
    });
    try { seen.add(realpathSync(explicitApiKeyFile)); } catch { /* realpath failed — file may appear as duplicate */ }
  }

  // 2. Check env vars
  const envKeyId = process.env.EARVELDAJA_API_KEY_ID;
  const envPublicValue = process.env.EARVELDAJA_API_PUBLIC_VALUE;
  const envPassword = process.env.EARVELDAJA_API_PASSWORD;
  if (envKeyId && envPublicValue && envPassword) {
    addConfig({
      name: "env",
      config: { apiKeyId: envKeyId, apiPublicValue: envPublicValue, apiPassword: envPassword, baseUrl },
    });
  }

  const envFiles = [
    ...getWorkingDirSearchDirs().map((dir) => ({
      envFile: resolve(dir, ".env"),
      extraNamePrefix: "env-local",
    })),
    {
      envFile: getGlobalEnvFile(),
      extraNamePrefix: "env-global",
    },
  ];
  const seenEnvFiles = new Set<string>();

  for (const candidate of envFiles) {
    let dedupeKey = candidate.envFile;
    try {
      dedupeKey = realpathSync(candidate.envFile);
    } catch {
      // Keep the resolved path if the file does not exist.
    }
    if (seenEnvFiles.has(dedupeKey)) continue;
    seenEnvFiles.add(dedupeKey);

    const parsedEnv = parseEnvFile(candidate.envFile);
    if (Object.keys(parsedEnv).length === 0) continue;

    const storedConnections = readStoredCredentialBlocks(parsedEnv, {
      includePrimary: !explicitApiKeyFile,
      extraNamePrefix: candidate.extraNamePrefix,
      primaryName: candidate.extraNamePrefix,
    });

    for (const stored of storedConnections) {
      addConfig({
        name: stored.name,
        filePath: candidate.envFile,
        config: {
          apiKeyId: stored.apiKeyId,
          apiPublicValue: stored.apiPublicValue,
          apiPassword: stored.apiPassword,
          baseUrl: getBaseUrlForServer(stored.server),
        },
      });
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

export function listStoredCredentials(
  options: { workingDir?: string; globalConfigDir?: string } = {},
): StoredCredentialInventory[] {
  const candidates: Array<{ storageScope: CredentialStorageScope; envFile: string; extraNamePrefix: string }> = [
    {
      storageScope: "local",
      envFile: getTargetEnvFile("local", options),
      extraNamePrefix: "env-local",
    },
    {
      storageScope: "global",
      envFile: getTargetEnvFile("global", options),
      extraNamePrefix: "env-global",
    },
  ];

  return candidates
    .map((candidate) => {
      const env = parseEnvFile(candidate.envFile);
      const credentials = readStoredCredentialBlocks(env, {
        includePrimary: true,
        extraNamePrefix: candidate.extraNamePrefix,
      }).map((block, index) => ({
        target: block.target,
        name: block.name,
        server: block.server,
        apiKeyId: block.apiKeyId,
        isDefault: index === 0,
      }));

      return {
        storageScope: candidate.storageScope,
        envFile: candidate.envFile,
        credentials,
      };
    })
    .filter((inventory) => inventory.credentials.length > 0);
}

export function removeStoredCredential(
  options: RemoveStoredCredentialOptions,
): RemoveStoredCredentialResult {
  const target = parseStoredCredentialTarget(options.target);
  const envFile = getTargetEnvFile(options.storageScope, options);
  const existingEnv = parseEnvFile(envFile);
  const existingMetadata = parseEnvMetadata(envFile);
  const existingTargets = new Set(
    readStoredCredentialBlocks(existingEnv, { includePrimary: true, extraNamePrefix: "env" }).map((block) => block.target)
  );

  if (!existingTargets.has(target)) {
    throw new Error(`Stored credential target "${target}" was not found in ${envFile}.`);
  }

  const updatedEnv = removeStoredCredentialBlock(existingEnv, target);
  delete existingMetadata[target];
  writePrivateEnvFile(envFile, serializeEnvFile(updatedEnv, existingMetadata));

  const remainingCredentials = readStoredCredentialBlocks(updatedEnv, {
    includePrimary: true,
    extraNamePrefix: "env",
  }).length;

  return {
    envFile,
    storageScope: options.storageScope,
    removedTarget: target,
    remainingCredentials,
  };
}
