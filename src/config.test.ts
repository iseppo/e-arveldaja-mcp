import { afterEach, describe, expect, it, vi } from "vitest";
import dotenv from "dotenv";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
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
  it("prioritizes the current working directory before the package root", async () => {
    const { getConfigSearchDirs } = await importFreshConfig();

    expect(getConfigSearchDirs(false, "/tmp/runtime-cwd", "/opt/e-arveldaja-mcp")).toEqual([
      "/tmp/runtime-cwd",
      "/opt/e-arveldaja-mcp",
    ]);
  });
});

describe("loadAllConfigs", () => {
  it("finds apikey files from the current working directory", async () => {
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

    process.chdir(tempDir);

    try {
      const { loadAllConfigs } = await importFreshConfig(tempDir);
      const configs = loadAllConfigs();

      expect(configs).toHaveLength(1);
      expect(configs[0]).toMatchObject({
        name: "apikey",
        filePath: apiKeyFile,
        config: {
          apiKeyId: "key-id",
          apiPublicValue: "public-value",
          apiPassword: "secret-password",
          baseUrl: "https://rmp-api.rik.ee/v1",
        },
      });
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads parent .env values when parent scanning is enabled from the runtime .env", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "earveldaja-parent-env-"));
    const parentDir = join(tempDir, "parent");
    const childDir = join(parentDir, "child");

    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, ".env"), "EARVELDAJA_SCAN_PARENT=true\n");
    writeFileSync(join(parentDir, ".env"), [
      "EARVELDAJA_API_KEY_ID=parent-id",
      "EARVELDAJA_API_PUBLIC_VALUE=parent-public",
      "EARVELDAJA_API_PASSWORD=parent-secret",
      "",
    ].join("\n"));

    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }

    process.chdir(childDir);

    try {
      const { loadAllConfigs } = await importFreshConfig(childDir);
      dotenv.config({ path: join(childDir, ".env"), override: true });
      dotenv.config({ path: join(parentDir, ".env"), override: true });
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
});
