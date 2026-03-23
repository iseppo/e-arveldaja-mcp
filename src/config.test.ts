import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CONFIG_ENV_KEYS = [
  "EARVELDAJA_SERVER",
  "EARVELDAJA_API_KEY_ID",
  "EARVELDAJA_API_PUBLIC_VALUE",
  "EARVELDAJA_API_PASSWORD",
  "EARVELDAJA_API_KEY_FILE",
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
  it("only includes the package root by default", async () => {
    const { getConfigSearchDirs } = await importFreshConfig();

    expect(getConfigSearchDirs(false, "/opt/e-arveldaja-mcp")).toEqual([
      "/opt/e-arveldaja-mcp",
    ]);
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
