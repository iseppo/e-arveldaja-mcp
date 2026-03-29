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
  "EARVELDAJA_SCAN_PARENT",
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

    expect(getConfigSearchDirs(false, "/opt/e-arveldaja-mcp", "/home/test/.config/e-arveldaja-mcp")).toEqual([
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
    process.env.EARVELDAJA_SCAN_PARENT = "";

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

  it("does not let the runtime .env enable parent scanning", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-parent-env-"));
    const parentDir = join(tempDir, "parent");
    const childDir = join(parentDir, "child");

    mkdirSync(childDir, { recursive: true });
    const childEnv = join(childDir, ".env");
    const parentEnv = join(parentDir, ".env");
    writeFileSync(childEnv, "EARVELDAJA_SCAN_PARENT=true\n", { mode: 0o600 });
    writeFileSync(parentEnv, [
      "EARVELDAJA_API_KEY_ID=parent-id",
      "EARVELDAJA_API_PUBLIC_VALUE=parent-public",
      "EARVELDAJA_API_PASSWORD=parent-secret",
      "",
    ].join("\n"), { mode: 0o600 });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }

    process.chdir(childDir);

    try {
      const { loadDotenvFiles } = await importFreshConfig(childDir);
      loadDotenvFiles();

      expect(process.env.EARVELDAJA_SCAN_PARENT).toBe("true");
      expect(process.env.EARVELDAJA_API_KEY_ID).toBeUndefined();
      expect(process.env.EARVELDAJA_API_PUBLIC_VALUE).toBeUndefined();
      expect(process.env.EARVELDAJA_API_PASSWORD).toBeUndefined();
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads parent .env values when parent scanning is enabled in the process environment", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-parent-env-opt-in-"));
    const parentDir = join(tempDir, "parent");
    const childDir = join(parentDir, "child");

    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(parentDir, ".env"), [
      "EARVELDAJA_API_KEY_ID=parent-id",
      "EARVELDAJA_API_PUBLIC_VALUE=parent-public",
      "EARVELDAJA_API_PASSWORD=parent-secret",
      "",
    ].join("\n"), { mode: 0o600 });

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.EARVELDAJA_SCAN_PARENT = "true";

    process.chdir(childDir);

    try {
      const { loadDotenvFiles, loadAllConfigs } = await importFreshConfig(childDir);
      loadDotenvFiles();
      const configs = loadAllConfigs();

      expect(configs).toEqual(expect.arrayContaining([expect.objectContaining({
        name: "env",
        config: {
          apiKeyId: "parent-id",
          apiPublicValue: "parent-public",
          apiPassword: "parent-secret",
          baseUrl: "https://rmp-api.rik.ee/v1",
        },
      })]));
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
    const info = getCredentialSetupInfo(false, "/tmp/project");

    expect(info.working_directory).toBe("/tmp/project");
    expect(info.credential_file_directory).toBe("/tmp/project");
    expect(info.credential_file_env_var).toBe("EARVELDAJA_API_KEY_FILE");
    expect(info.global_config_directory).toBe("/tmp/global-config");
    expect(info.global_env_file).toBe("/tmp/global-config/.env");
    expect(info.searched_directories).toEqual(["/tmp/project", "/tmp/global-config"]);
    expect(info.next_steps[0]).toContain("working directory");
    expect(info.next_steps[0]).toContain("import_apikey_credentials");
    expect(info.next_steps[1]).toContain("secure apikey*.txt");
    expect(info.next_steps[2]).toContain("EARVELDAJA_SCAN_PARENT=true");
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
    process.env.EARVELDAJA_SCAN_PARENT = "";

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
    process.env.EARVELDAJA_SCAN_PARENT = "";

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
    process.env.EARVELDAJA_SCAN_PARENT = "";

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
      expect(() => loadAllConfigs()).toThrowError("No API credentials found");

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Ignoring symlinked credential file"));
    } finally {
      stderrSpy.mockRestore();
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
