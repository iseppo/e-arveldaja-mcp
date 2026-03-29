import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CONFIG_ENV_KEYS = [
  "EARVELDAJA_SERVER",
  "EARVELDAJA_API_KEY_ID",
  "EARVELDAJA_API_PUBLIC_VALUE",
  "EARVELDAJA_API_PASSWORD",
  "EARVELDAJA_API_KEY_FILE",
  "EARVELDAJA_CONFIG_DIR",
] as const;

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = Object.fromEntries(CONFIG_ENV_KEYS.map(key => [key, process.env[key]]));

function restoreConfigEnv(): void {
  for (const key of CONFIG_ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function importFreshConfig(packageRoot?: string) {
  vi.resetModules();
  vi.doUnmock("./paths.js");
  if (packageRoot) {
    vi.doMock("./paths.js", () => ({
      getProjectRoot: () => packageRoot,
    }));
  }
  return import("./config.js");
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  restoreConfigEnv();
  vi.doUnmock("./paths.js");
  vi.resetModules();
});

describe("getConfigSearchDirs", () => {
  it("includes the working directory and global config directory by default", async () => {
    const { getConfigSearchDirs } = await importFreshConfig();

    expect(getConfigSearchDirs("/opt/e-arveldaja-mcp", "/home/test/.config/e-arveldaja-mcp")).toEqual([
      "/opt/e-arveldaja-mcp",
      "/home/test/.config/e-arveldaja-mcp",
    ]);
  });
});

describe("getNativeGlobalConfigDir", () => {
  it("uses XDG config home on linux", async () => {
    const { getNativeGlobalConfigDir } = await importFreshConfig();

    expect(getNativeGlobalConfigDir("linux", { XDG_CONFIG_HOME: "/tmp/xdg" }, "/home/test")).toBe(
      "/tmp/xdg/e-arveldaja-mcp",
    );
  });

  it("uses Application Support on macOS", async () => {
    const { getNativeGlobalConfigDir } = await importFreshConfig();

    expect(getNativeGlobalConfigDir("darwin", {}, "/Users/test")).toBe(
      "/Users/test/Library/Application Support/e-arveldaja-mcp",
    );
  });

  it("uses APPDATA on Windows", async () => {
    const { getNativeGlobalConfigDir } = await importFreshConfig();

    expect(getNativeGlobalConfigDir("win32", { APPDATA: "C:/Users/Test/AppData/Roaming" }, "C:/Users/Test")).toBe(
      "C:\\Users\\Test\\AppData\\Roaming\\e-arveldaja-mcp",
    );
  });
});

describe("loadAllConfigs", () => {
  it("loads apikey files from the current working directory", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-config-"));
    const apiKeyFile = join(tempDir, "apikey.txt");

    process.env.EARVELDAJA_SERVER = "live";
    process.env.EARVELDAJA_API_KEY_ID = "";
    process.env.EARVELDAJA_API_PUBLIC_VALUE = "";
    process.env.EARVELDAJA_API_PASSWORD = "";
    process.env.EARVELDAJA_API_KEY_FILE = "";

    writeFileSync(apiKeyFile, [
      "ApiKey ID: key-id",
      "ApiKey public value: public-value",
      "Password: secret-password",
      "",
    ].join("\n"));
    chmodSync(apiKeyFile, 0o600);

    process.chdir(tempDir);

    try {
      const { loadAllConfigs } = await importFreshConfig();
      const configs = loadAllConfigs();

      expect(configs.length).toBe(1);
      expect(configs[0]!.config.apiKeyId).toBe("key-id");
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("imports a verified apikey file into the native global .env", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-global-bootstrap-"));
    const workDir = join(tempDir, "work");
    const globalDir = join(tempDir, "global");
    const apiKeyFile = join(workDir, "apikey.txt");
    const globalEnvFile = join(globalDir, ".env");

    mkdirSync(workDir, { recursive: true });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.EARVELDAJA_CONFIG_DIR = globalDir;

    writeFileSync(apiKeyFile, [
      "ApiKey ID: key-id",
      "ApiKey public value: public-value",
      "Password: secret-password",
      "",
    ].join("\n"), { mode: 0o600 });

    process.chdir(workDir);

    try {
      const { importApiKeyCredentials, loadDotenvFiles, loadAllConfigs } = await importFreshConfig(workDir);
      await importApiKeyCredentials({
        apiKeyFile,
        storageScope: "global",
        globalConfigDir: globalDir,
        verify: async () => ({ companyName: "Acme OÜ", verifiedAt: "2026-03-29T12:00:00.000Z" }),
      });
      loadDotenvFiles();
      const configs = loadAllConfigs();

      expect(readFileSync(globalEnvFile, "utf8")).toContain("# Company: Acme OÜ");
      expect(readFileSync(globalEnvFile, "utf8")).toContain("# Verified at: 2026-03-29T12:00:00.000Z");
      expect(readFileSync(globalEnvFile, "utf8")).toContain("EARVELDAJA_API_KEY_ID=key-id");
      expect(readFileSync(globalEnvFile, "utf8")).toContain("EARVELDAJA_API_PUBLIC_VALUE=public-value");
      expect(readFileSync(globalEnvFile, "utf8")).toContain("EARVELDAJA_API_PASSWORD=secret-password");
      expect(process.env.EARVELDAJA_API_KEY_ID).toBe("key-id");
      expect(configs).toHaveLength(1);
      expect(configs[0]!.name).toBe("env");
      expect(configs[0]!.config.apiKeyId).toBe("key-id");
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("round-trips quoted credential values with dollars, backslashes, hashes, and quotes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-quoted-creds-"));
    const workDir = join(tempDir, "work");
    const globalDir = join(tempDir, "global");
    const apiKeyFile = join(workDir, "apikey.txt");

    mkdirSync(workDir, { recursive: true });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.EARVELDAJA_CONFIG_DIR = globalDir;

    const keyId = "id'quote#1";
    const publicValue = 'public"value#x';
    const password = String.raw`pa$$\path#1`;

    writeFileSync(apiKeyFile, [
      `ApiKey ID: ${keyId}`,
      `ApiKey public value: ${publicValue}`,
      `Password: ${password}`,
      "",
    ].join("\n"), { mode: 0o600 });

    process.chdir(workDir);

    try {
      const { importApiKeyCredentials, loadDotenvFiles, loadAllConfigs } = await importFreshConfig(workDir);
      await importApiKeyCredentials({
        apiKeyFile,
        storageScope: "global",
        globalConfigDir: globalDir,
        verify: async () => ({ companyName: "Acme OÜ", verifiedAt: "2026-03-29T12:00:00.000Z" }),
      });
      loadDotenvFiles();
      const configs = loadAllConfigs();

      expect(process.env.EARVELDAJA_API_KEY_ID).toBe(keyId);
      expect(process.env.EARVELDAJA_API_PUBLIC_VALUE).toBe(publicValue);
      expect(process.env.EARVELDAJA_API_PASSWORD).toBe(password);
      expect(configs[0]!.config.apiKeyId).toBe(keyId);
      expect(configs[0]!.config.apiPublicValue).toBe(publicValue);
      expect(configs[0]!.config.apiPassword).toBe(password);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not synthesize a credential set from partial local and shared .env files", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-partial-env-"));
    const workDir = join(tempDir, "work");
    const globalDir = join(tempDir, "global");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    mkdirSync(workDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.EARVELDAJA_CONFIG_DIR = globalDir;

    writeFileSync(join(workDir, ".env"), "EARVELDAJA_API_KEY_ID=local-id\n", { mode: 0o600 });
    writeFileSync(join(globalDir, ".env"), [
      "EARVELDAJA_API_PUBLIC_VALUE=global-public",
      "EARVELDAJA_API_PASSWORD=global-secret",
      "",
    ].join("\n"), { mode: 0o600 });

    process.chdir(workDir);

    try {
      const { loadDotenvFiles, loadAllConfigs } = await importFreshConfig(workDir);
      loadDotenvFiles();

      expect(process.env.EARVELDAJA_API_KEY_ID).toBeUndefined();
      expect(process.env.EARVELDAJA_API_PUBLIC_VALUE).toBeUndefined();
      expect(process.env.EARVELDAJA_API_PASSWORD).toBeUndefined();
      expect(() => loadAllConfigs()).toThrowError("No API credentials found");
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Ignoring incomplete e-arveldaja credential keys"));
    } finally {
      stderrSpy.mockRestore();
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not let an incomplete local env override the server of a complete shared credential set", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-server-mix-"));
    const workDir = join(tempDir, "work");
    const globalDir = join(tempDir, "global");

    mkdirSync(workDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.EARVELDAJA_CONFIG_DIR = globalDir;

    writeFileSync(join(workDir, ".env"), [
      "EARVELDAJA_SERVER=demo",
      "EARVELDAJA_API_KEY_ID=local-only",
      "",
    ].join("\n"), { mode: 0o600 });
    writeFileSync(join(globalDir, ".env"), [
      "EARVELDAJA_SERVER=live",
      "EARVELDAJA_API_KEY_ID=global-id",
      "EARVELDAJA_API_PUBLIC_VALUE=global-public",
      "EARVELDAJA_API_PASSWORD=global-secret",
      "",
    ].join("\n"), { mode: 0o600 });

    process.chdir(workDir);

    try {
      const { loadDotenvFiles, loadAllConfigs } = await importFreshConfig(workDir);
      loadDotenvFiles();
      const configs = loadAllConfigs();

      expect(process.env.EARVELDAJA_SERVER).toBe("live");
      expect(configs).toHaveLength(1);
      expect(configs[0]!.config.apiKeyId).toBe("global-id");
      expect(configs[0]!.config.baseUrl).toBe("https://rmp-api.rik.ee/v1");
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not let a partial shell credential block a complete env file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-partial-shell-env-"));
    const workDir = join(tempDir, "work");

    mkdirSync(workDir, { recursive: true });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.EARVELDAJA_API_KEY_ID = "partial-shell-id";

    writeFileSync(join(workDir, ".env"), [
      "EARVELDAJA_SERVER=live",
      "EARVELDAJA_API_KEY_ID=file-id",
      "EARVELDAJA_API_PUBLIC_VALUE=file-public",
      "EARVELDAJA_API_PASSWORD=file-secret",
      "",
    ].join("\n"), { mode: 0o600 });

    process.chdir(workDir);

    try {
      const { loadDotenvFiles, loadAllConfigs } = await importFreshConfig(workDir);
      loadDotenvFiles();
      const configs = loadAllConfigs();

      expect(process.env.EARVELDAJA_API_KEY_ID).toBe("file-id");
      expect(process.env.EARVELDAJA_API_PUBLIC_VALUE).toBe("file-public");
      expect(process.env.EARVELDAJA_API_PASSWORD).toBe("file-secret");
      expect(configs).toHaveLength(1);
      expect(configs[0]!.config.apiKeyId).toBe("file-id");
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not let a local .env override an explicit EARVELDAJA_API_KEY_FILE", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-explicit-file-precedence-"));
    const workDir = join(tempDir, "work");
    const explicitFile = join(tempDir, "explicit-apikey.txt");

    mkdirSync(workDir, { recursive: true });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.EARVELDAJA_API_KEY_FILE = explicitFile;

    writeFileSync(explicitFile, [
      "ApiKey ID: explicit-id",
      "ApiKey public value: explicit-public",
      "Password: explicit-secret",
      "",
    ].join("\n"), { mode: 0o600 });
    writeFileSync(join(workDir, ".env"), [
      "EARVELDAJA_SERVER=demo",
      "EARVELDAJA_API_KEY_ID=env-id",
      "EARVELDAJA_API_PUBLIC_VALUE=env-public",
      "EARVELDAJA_API_PASSWORD=env-secret",
      "",
    ].join("\n"), { mode: 0o600 });

    process.chdir(workDir);

    try {
      const { loadDotenvFiles, loadAllConfigs } = await importFreshConfig(workDir);
      loadDotenvFiles();
      const configs = loadAllConfigs();

      expect(process.env.EARVELDAJA_API_KEY_ID).toBeUndefined();
      expect(process.env.EARVELDAJA_API_PUBLIC_VALUE).toBeUndefined();
      expect(process.env.EARVELDAJA_API_PASSWORD).toBeUndefined();
      expect(process.env.EARVELDAJA_SERVER).toBeUndefined();
      expect(configs).toHaveLength(1);
      expect(configs[0]!.name).toBe("env-file");
      expect(configs[0]!.config.apiKeyId).toBe("explicit-id");
      expect(configs[0]!.config.baseUrl).toBe("https://rmp-api.rik.ee/v1");
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails with a targeted error when EARVELDAJA_API_KEY_FILE is invalid even if a local .env exists", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-invalid-explicit-file-"));
    const workDir = join(tempDir, "work");
    const missingFile = join(tempDir, "missing-apikey.txt");

    mkdirSync(workDir, { recursive: true });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.EARVELDAJA_API_KEY_FILE = missingFile;

    writeFileSync(join(workDir, ".env"), [
      "EARVELDAJA_API_KEY_ID=env-id",
      "EARVELDAJA_API_PUBLIC_VALUE=env-public",
      "EARVELDAJA_API_PASSWORD=env-secret",
      "",
    ].join("\n"), { mode: 0o600 });

    process.chdir(workDir);

    try {
      const { loadDotenvFiles, loadAllConfigs } = await importFreshConfig(workDir);
      loadDotenvFiles();

      expect(() => loadAllConfigs()).toThrowError(
        `EARVELDAJA_API_KEY_FILE points to an unreadable or invalid credential file: ${missingFile}`
      );
      expect(process.env.EARVELDAJA_API_KEY_ID).toBeUndefined();
      expect(process.env.EARVELDAJA_API_PUBLIC_VALUE).toBeUndefined();
      expect(process.env.EARVELDAJA_API_PASSWORD).toBeUndefined();
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not let a standalone .env server override shell-provided credentials", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-shell-server-mix-"));
    const workDir = join(tempDir, "work");

    mkdirSync(workDir, { recursive: true });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.EARVELDAJA_API_KEY_ID = "shell-id";
    process.env.EARVELDAJA_API_PUBLIC_VALUE = "shell-public";
    process.env.EARVELDAJA_API_PASSWORD = "shell-secret";

    writeFileSync(join(workDir, ".env"), [
      "EARVELDAJA_SERVER=demo",
      "",
    ].join("\n"), { mode: 0o600 });

    process.chdir(workDir);

    try {
      const { loadDotenvFiles, loadAllConfigs } = await importFreshConfig(workDir);
      loadDotenvFiles();
      const configs = loadAllConfigs();

      expect(process.env.EARVELDAJA_SERVER).toBeUndefined();
      expect(configs).toHaveLength(1);
      expect(configs[0]!.name).toBe("env");
      expect(configs[0]!.config.apiKeyId).toBe("shell-id");
      expect(configs[0]!.config.baseUrl).toBe("https://rmp-api.rik.ee/v1");
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("prioritizes an explicit EARVELDAJA_API_KEY_FILE over shell env credentials", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-explicit-file-vs-shell-"));
    const workDir = join(tempDir, "work");
    const explicitFile = join(tempDir, "explicit-apikey.txt");

    mkdirSync(workDir, { recursive: true });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.EARVELDAJA_API_KEY_ID = "shell-id";
    process.env.EARVELDAJA_API_PUBLIC_VALUE = "shell-public";
    process.env.EARVELDAJA_API_PASSWORD = "shell-secret";
    process.env.EARVELDAJA_API_KEY_FILE = explicitFile;

    writeFileSync(explicitFile, [
      "ApiKey ID: explicit-id",
      "ApiKey public value: explicit-public",
      "Password: explicit-secret",
      "",
    ].join("\n"), { mode: 0o600 });

    process.chdir(workDir);

    try {
      const { loadDotenvFiles, loadAllConfigs } = await importFreshConfig(workDir);
      loadDotenvFiles();
      const configs = loadAllConfigs();

      expect(configs).toHaveLength(2);
      expect(configs[0]!.name).toBe("env-file");
      expect(configs[0]!.config.apiKeyId).toBe("explicit-id");
      expect(configs[1]!.name).toBe("env");
      expect(configs[1]!.config.apiKeyId).toBe("shell-id");
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("imports a verified apikey file into the local working-directory .env", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-local-bootstrap-"));
    const workDir = join(tempDir, "work");
    const apiKeyFile = join(workDir, "apikey.txt");
    const localEnvFile = join(workDir, ".env");

    mkdirSync(workDir, { recursive: true });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }

    writeFileSync(apiKeyFile, [
      "ApiKey ID: key-id",
      "ApiKey public value: public-value",
      "Password: secret-password",
      "",
    ].join("\n"), { mode: 0o600 });

    process.chdir(workDir);

    try {
      const { importApiKeyCredentials } = await importFreshConfig(workDir);
      const result = await importApiKeyCredentials({
        apiKeyFile,
        storageScope: "local",
        workingDir: workDir,
        verify: async () => ({ companyName: "Beta AS", verifiedAt: "2026-03-29T13:00:00.000Z" }),
      });

      expect(result.envFile).toBe(localEnvFile);
      expect(readFileSync(localEnvFile, "utf8")).toContain("# Company: Beta AS");
      expect(readFileSync(localEnvFile, "utf8")).toContain("EARVELDAJA_SERVER=live");
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("appends additional credentials into indexed .env connection blocks", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-append-bootstrap-"));
    const workDir = join(tempDir, "work");
    const globalDir = join(tempDir, "global");
    const firstApiKeyFile = join(workDir, "apikey-primary.txt");
    const secondApiKeyFile = join(workDir, "apikey-second.txt");
    const globalEnvFile = join(globalDir, ".env");

    mkdirSync(workDir, { recursive: true });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.EARVELDAJA_CONFIG_DIR = globalDir;

    writeFileSync(firstApiKeyFile, [
      "ApiKey ID: first-id",
      "ApiKey public value: first-public",
      "Password: first-secret",
      "",
    ].join("\n"), { mode: 0o600 });
    writeFileSync(secondApiKeyFile, [
      "ApiKey ID: second-id",
      "ApiKey public value: second-public",
      "Password: second-secret",
      "",
    ].join("\n"), { mode: 0o600 });

    process.chdir(workDir);

    try {
      const { importApiKeyCredentials, loadDotenvFiles, loadAllConfigs } = await importFreshConfig(workDir);
      const first = await importApiKeyCredentials({
        apiKeyFile: firstApiKeyFile,
        storageScope: "global",
        globalConfigDir: globalDir,
        verify: async () => ({ companyName: "Primary OÜ", verifiedAt: "2026-03-29T15:00:00.000Z" }),
      });
      const second = await importApiKeyCredentials({
        apiKeyFile: secondApiKeyFile,
        storageScope: "global",
        globalConfigDir: globalDir,
        verify: async () => ({ companyName: "Second OÜ", verifiedAt: "2026-03-29T15:05:00.000Z" }),
      });

      loadDotenvFiles();
      const configs = loadAllConfigs();
      const envText = readFileSync(globalEnvFile, "utf8");

      expect(first.action).toBe("created");
      expect(first.target).toBe("primary");
      expect(second.action).toBe("appended");
      expect(second.target).toBe("connection_1");
      expect(envText).toContain("EARVELDAJA_API_KEY_ID=first-id");
      expect(envText).toContain("EARVELDAJA_CONNECTION_1_API_KEY_ID=second-id");
      expect(configs).toHaveLength(2);
      expect(configs[0]!.name).toBe("env");
      expect(configs[0]!.config.apiKeyId).toBe("first-id");
      expect(configs[1]!.name).toBe("env-global-1");
      expect(configs[1]!.config.apiKeyId).toBe("second-id");
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("lists and removes stored credential blocks, leaving appended connections loadable", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-remove-bootstrap-"));
    const workDir = join(tempDir, "work");
    const globalDir = join(tempDir, "global");
    const firstApiKeyFile = join(workDir, "apikey-primary.txt");
    const secondApiKeyFile = join(workDir, "apikey-second.txt");
    const globalEnvFile = join(globalDir, ".env");

    mkdirSync(workDir, { recursive: true });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.EARVELDAJA_CONFIG_DIR = globalDir;

    writeFileSync(firstApiKeyFile, [
      "ApiKey ID: first-id",
      "ApiKey public value: first-public",
      "Password: first-secret",
      "",
    ].join("\n"), { mode: 0o600 });
    writeFileSync(secondApiKeyFile, [
      "ApiKey ID: second-id",
      "ApiKey public value: second-public",
      "Password: second-secret",
      "",
    ].join("\n"), { mode: 0o600 });

    process.chdir(workDir);

    try {
      const {
        importApiKeyCredentials,
        listStoredCredentials,
        removeStoredCredential,
        loadDotenvFiles,
        loadAllConfigs,
      } = await importFreshConfig(workDir);

      await importApiKeyCredentials({
        apiKeyFile: firstApiKeyFile,
        storageScope: "global",
        globalConfigDir: globalDir,
        verify: async () => ({ companyName: "Primary OÜ", verifiedAt: "2026-03-29T16:00:00.000Z" }),
      });
      await importApiKeyCredentials({
        apiKeyFile: secondApiKeyFile,
        storageScope: "global",
        globalConfigDir: globalDir,
        verify: async () => ({ companyName: "Second OÜ", verifiedAt: "2026-03-29T16:05:00.000Z" }),
      });

      const before = listStoredCredentials();
      expect(before).toHaveLength(1);
      expect(before[0]!.credentials.map((entry) => entry.target)).toEqual(["primary", "connection_1"]);

      const removedExtra = removeStoredCredential({
        storageScope: "global",
        target: "connection_1",
        globalConfigDir: globalDir,
      });
      expect(removedExtra.remainingCredentials).toBe(1);
      expect(readFileSync(globalEnvFile, "utf8")).not.toContain("EARVELDAJA_CONNECTION_1_API_KEY_ID");

      await importApiKeyCredentials({
        apiKeyFile: secondApiKeyFile,
        storageScope: "global",
        globalConfigDir: globalDir,
        verify: async () => ({ companyName: "Second OÜ", verifiedAt: "2026-03-29T16:10:00.000Z" }),
      });
      const removedPrimary = removeStoredCredential({
        storageScope: "global",
        target: "primary",
        globalConfigDir: globalDir,
      });

      expect(removedPrimary.remainingCredentials).toBe(1);
      expect(readFileSync(globalEnvFile, "utf8")).not.toContain("EARVELDAJA_API_KEY_ID=first-id");

      rmSync(firstApiKeyFile, { force: true });
      rmSync(secondApiKeyFile, { force: true });

      for (const key of CONFIG_ENV_KEYS) {
        delete process.env[key];
      }
      process.env.EARVELDAJA_CONFIG_DIR = globalDir;
      loadDotenvFiles();
      const configs = loadAllConfigs();

      expect(configs).toHaveLength(1);
      expect(configs[0]!.name).toBe("env-global-1");
      expect(configs[0]!.config.apiKeyId).toBe("second-id");
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not write a .env file when credential verification fails", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-import-verify-fail-"));
    const workDir = join(tempDir, "work");
    const globalDir = join(tempDir, "global");
    const apiKeyFile = join(workDir, "apikey.txt");
    const globalEnvFile = join(globalDir, ".env");

    mkdirSync(workDir, { recursive: true });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.EARVELDAJA_CONFIG_DIR = globalDir;

    writeFileSync(apiKeyFile, [
      "ApiKey ID: key-id",
      "ApiKey public value: public-value",
      "Password: secret-password",
      "",
    ].join("\n"), { mode: 0o600 });

    process.chdir(workDir);

    try {
      const { importApiKeyCredentials } = await importFreshConfig(workDir);

      await expect(importApiKeyCredentials({
        apiKeyFile,
        storageScope: "global",
        globalConfigDir: globalDir,
        verify: async () => {
          throw new Error("401 Unauthorized");
        },
      })).rejects.toThrow("401 Unauthorized");

      expect(() => readFileSync(globalEnvFile, "utf8")).toThrow();
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails instead of reporting success when the target .env is a symlink", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-import-symlink-env-"));
    const workDir = join(tempDir, "work");
    const apiKeyFile = join(workDir, "apikey.txt");
    const actualEnvFile = join(workDir, "actual.env");
    const localEnvFile = join(workDir, ".env");

    mkdirSync(workDir, { recursive: true });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }

    writeFileSync(apiKeyFile, [
      "ApiKey ID: key-id",
      "ApiKey public value: public-value",
      "Password: secret-password",
      "",
    ].join("\n"), { mode: 0o600 });
    writeFileSync(actualEnvFile, "# original\n", { mode: 0o600 });
    symlinkSync(actualEnvFile, localEnvFile);

    process.chdir(workDir);

    try {
      const { importApiKeyCredentials } = await importFreshConfig(workDir);

      await expect(importApiKeyCredentials({
        apiKeyFile,
        storageScope: "local",
        workingDir: workDir,
        verify: async () => ({ companyName: "Gamma OÜ", verifiedAt: "2026-03-29T14:00:00.000Z" }),
      })).rejects.toThrow(`Refusing to write .env through symlink: ${localEnvFile}`);

      expect(readFileSync(actualEnvFile, "utf8")).toBe("# original\n");
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not treat the global config directory as another apikey scan directory", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-global-no-scan-"));
    const workDir = join(tempDir, "work");
    const globalDir = join(tempDir, "global");
    const globalApiKeyFile = join(globalDir, "apikey.txt");

    mkdirSync(workDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.EARVELDAJA_CONFIG_DIR = globalDir;

    writeFileSync(globalApiKeyFile, [
      "ApiKey ID: key-id",
      "ApiKey public value: public-value",
      "Password: secret-password",
      "",
    ].join("\n"), { mode: 0o600 });

    process.chdir(workDir);

    try {
      const { loadDotenvFiles, loadAllConfigs } = await importFreshConfig(workDir);
      loadDotenvFiles();

      expect(() => loadAllConfigs()).toThrowError("No API credentials found");
      expect(process.env.EARVELDAJA_API_KEY_ID).toBeUndefined();
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports setup guidance for the working directory by default", async () => {
    const { getCredentialSetupInfo } = await importFreshConfig();

    process.env.EARVELDAJA_CONFIG_DIR = "/tmp/global-config";
    const info = getCredentialSetupInfo("/tmp/project");

    expect(info.working_directory).toBe("/tmp/project");
    expect(info.credential_file_directory).toBe("/tmp/project");
    expect(info.credential_file_env_var).toBe("EARVELDAJA_API_KEY_FILE");
    expect(info.global_config_directory).toBe("/tmp/global-config");
    expect(info.global_env_file).toBe("/tmp/global-config/.env");
    expect(info.searched_directories).toEqual(["/tmp/project", "/tmp/global-config"]);
    expect(info.next_steps[0]).toContain("this folder");
    expect(info.next_steps[0]).toContain("import_apikey_credentials");
    expect(info.next_steps[1]).toContain("append another stored connection");
    expect(info.next_steps[1]).toContain("remove_stored_credentials");
    expect(info.next_steps[2]).toContain("secure apikey*.txt");
    expect(info.next_steps[2]).toContain("any folder");
    expect(info.next_steps[3]).toContain("Shared config directory");
  });

  it("rejects API key files that are group-readable", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-config-perms-"));
    const apiKeyFile = join(tempDir, "apikey.txt");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    process.env.EARVELDAJA_SERVER = "live";
    process.env.EARVELDAJA_API_KEY_ID = "";
    process.env.EARVELDAJA_API_PUBLIC_VALUE = "";
    process.env.EARVELDAJA_API_PASSWORD = "";
    process.env.EARVELDAJA_API_KEY_FILE = "";

    writeFileSync(apiKeyFile, [
      "ApiKey ID: key-id",
      "ApiKey public value: public-value",
      "Password: secret-password",
      "",
    ].join("\n"));
    chmodSync(apiKeyFile, 0o640);

    process.chdir(tempDir);

    try {
      const { loadAllConfigs } = await importFreshConfig();
      expect(() => loadAllConfigs()).toThrowError("No API credentials found");

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("accessible by group/others"));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("chmod 600"));
    } finally {
      stderrSpy.mockRestore();
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not warn when the API key file is owner-only", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-config-private-"));
    const apiKeyFile = join(tempDir, "apikey.txt");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    process.env.EARVELDAJA_SERVER = "live";
    process.env.EARVELDAJA_API_KEY_ID = "";
    process.env.EARVELDAJA_API_PUBLIC_VALUE = "";
    process.env.EARVELDAJA_API_PASSWORD = "";
    process.env.EARVELDAJA_API_KEY_FILE = "";

    writeFileSync(apiKeyFile, [
      "ApiKey ID: key-id",
      "ApiKey public value: public-value",
      "Password: secret-password",
      "",
    ].join("\n"));
    chmodSync(apiKeyFile, 0o600);

    process.chdir(tempDir);

    try {
      const { loadAllConfigs } = await importFreshConfig();
      loadAllConfigs();

      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects symlinked API key files from EARVELDAJA_API_KEY_FILE", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-config-symlink-"));
    const actualFile = join(tempDir, "actual-apikey.txt");
    const symlinkFile = join(tempDir, "apikey.txt");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    process.env.EARVELDAJA_SERVER = "live";
    process.env.EARVELDAJA_API_KEY_ID = "";
    process.env.EARVELDAJA_API_PUBLIC_VALUE = "";
    process.env.EARVELDAJA_API_PASSWORD = "";
    process.env.EARVELDAJA_API_KEY_FILE = symlinkFile;

    writeFileSync(actualFile, [
      "ApiKey ID: key-id",
      "ApiKey public value: public-value",
      "Password: secret-password",
      "",
    ].join("\n"));
    chmodSync(actualFile, 0o600);
    symlinkSync(actualFile, symlinkFile);
    process.chdir(tempDir);

    try {
      const { loadAllConfigs } = await importFreshConfig(tempDir);
      expect(() => loadAllConfigs()).toThrowError(
        `EARVELDAJA_API_KEY_FILE points to an unreadable or invalid credential file: ${symlinkFile}`
      );

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Ignoring symlinked credential file"));
    } finally {
      stderrSpy.mockRestore();
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
