import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  importApiKeyCredentials,
  type CredentialStorageScope,
  type ImportApiKeyCredentialsOptions,
} from "../config.js";
import {
  createMockToolServer,
  getRegisteredToolHandler,
  type MockToolServer,
} from "../__fixtures__/accounting-workflow.js";
import { parseMcpResponse } from "../mcp-json.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import {
  registerCredentialTools,
  persistCredentialImportViaPlan,
  type CredentialToolDeps,
} from "./credential-tools.js";

// The reviewed credential surface persists to the GLOBAL .env, whose location is
// resolved dynamically from EARVELDAJA_CONFIG_DIR — so tests can point it at a
// temp dir without touching the working directory or any real credential store.
const APIKEY_CONTENT = [
  "ApiKey ID: key-id-1234567890",
  "ApiKey public value: public-value-abcdef",
  "Password: super-secret-password",
  "",
].join("\n");

const ALT_APIKEY_CONTENT = [
  "ApiKey ID: key-id-1234567890",
  "ApiKey public value: public-value-abcdef",
  "Password: rotated-password-9999",
  "",
].join("\n");

const CONFIG_ENV_KEYS = [
  "EARVELDAJA_SERVER",
  "EARVELDAJA_API_KEY_ID",
  "EARVELDAJA_API_PUBLIC_VALUE",
  "EARVELDAJA_API_PASSWORD",
  "EARVELDAJA_API_KEY_FILE",
  "EARVELDAJA_CONFIG_DIR",
] as const;

const ORIGINAL_ENV = Object.fromEntries(CONFIG_ENV_KEYS.map((key) => [key, process.env[key]]));

let tempDir: string;
let apiKeyFile: string;
let envFile: string;

function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return parseMcpResponse(res.content[0]!.text) as Record<string, unknown>;
}

function buildDeps(overrides: Partial<CredentialToolDeps> = {}): CredentialToolDeps {
  return {
    verify: vi.fn(async () => ({ companyName: "Acme OÜ", verifiedAt: "2026-03-29T12:00:00.000Z" })),
    resolveStorageScope: vi.fn(async () => "global" as CredentialStorageScope),
    ...overrides,
  };
}

function importOptions(): ImportApiKeyCredentialsOptions {
  return {
    apiKeyFile,
    storageScope: "global",
    globalConfigDir: tempDir,
    verify: async () => ({ companyName: "Acme OÜ", verifiedAt: "2026-03-29T12:00:00.000Z" }),
  };
}

beforeEach(() => {
  for (const key of CONFIG_ENV_KEYS) delete process.env[key];
  tempDir = mkdtempSync(join(tmpdir(), "earveldaja-credential-tools-"));
  mkdirSync(tempDir, { recursive: true });
  process.env.EARVELDAJA_CONFIG_DIR = tempDir;
  apiKeyFile = join(tempDir, "apikey.txt");
  envFile = join(tempDir, ".env");
  writeFileSync(apiKeyFile, APIKEY_CONTENT, { mode: 0o600 });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  for (const key of CONFIG_ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

function registerImportServer(deps = buildDeps(), rtsc = createTestRuntimeSafetyContext()) {
  const server = createMockToolServer();
  registerCredentialTools(server, deps, rtsc, true);
  return { server, deps, rtsc };
}

// Common import arg shape: an explicit file_path avoids the working-directory
// scan (whose base dir is fixed at module load), and global scope routes to the
// temp .env.
const IMPORT_ARGS = () => ({ file_path: apiKeyFile, storage_scope: "global" as const });
const REMOVE_ARGS = (target = "primary") => ({ storage_scope: "global" as const, target });

describe("registerCredentialTools gating", () => {
  it("registers no credential tools when exposure is disabled", () => {
    const server = createMockToolServer();
    registerCredentialTools(server, buildDeps(), createTestRuntimeSafetyContext(), false);
    expect((server as MockToolServer).registerTool).not.toHaveBeenCalled();
  });

  it("registers the three credential tools when exposure is enabled", () => {
    const { server } = registerImportServer();
    const names = (server as unknown as MockToolServer).registerTool.mock.calls.map(([name]) => name);
    expect(names).toEqual(expect.arrayContaining([
      "import_apikey_credentials",
      "list_stored_credentials",
      "remove_stored_credentials",
    ]));
  });
});

describe("import_apikey_credentials preview", () => {
  it("writes nothing and returns a one-attempt plan_handle", async () => {
    const { server } = registerImportServer();
    const handler = getRegisteredToolHandler(server, "import_apikey_credentials");

    const res = await handler(IMPORT_ARGS());
    const payload = parse(res);

    expect(payload.execute).toBe(false);
    expect(payload.restart_required).toBe(false);
    expect(typeof payload.plan_handle).toBe("string");
    expect((payload.plan_handle as string).length).toBeGreaterThan(0);
    expect(existsSync(envFile)).toBe(false); // preview persists NOTHING
    const text = res.content[0]!.text;
    expect(text).not.toContain("super-secret-password");
    expect(text).not.toContain("public-value-abcdef");
    expect(payload.masked_api_key_id).toBe("key-…7890");
  });

  it("returns unchanged with no handle when the credential is already stored", async () => {
    await importApiKeyCredentials(importOptions());
    const { server } = registerImportServer();
    const handler = getRegisteredToolHandler(server, "import_apikey_credentials");

    const payload = parse(await handler(IMPORT_ARGS()));
    expect(payload.action).toBe("unchanged");
    expect(payload.already_stored).toBe(true);
    expect(payload.plan_handle).toBeUndefined();
  });
});

describe("import_apikey_credentials execute", () => {
  it("rejects execute without a plan_handle and writes nothing", async () => {
    const { server } = registerImportServer();
    const handler = getRegisteredToolHandler(server, "import_apikey_credentials");

    const res = await handler({ ...IMPORT_ARGS(), execute: true });
    expect(res.isError).toBe(true);
    expect(parse(res).category).toBe("plan_handle_required");
    expect(existsSync(envFile)).toBe(false);
  });

  it("persists only via a valid one-attempt handle", async () => {
    const { server } = registerImportServer();
    const handler = getRegisteredToolHandler(server, "import_apikey_credentials");

    const handle = parse(await handler(IMPORT_ARGS())).plan_handle as string;
    expect(existsSync(envFile)).toBe(false);

    const res = parse(await handler({ ...IMPORT_ARGS(), execute: true, plan_handle: handle }));
    expect(res.restart_required).toBe(true);
    expect(res.action).toBe("created");
    expect(existsSync(envFile)).toBe(true);
    expect(readFileSync(envFile, "utf8")).toContain("EARVELDAJA_API_KEY_ID=key-id-1234567890");
  });

  it("rejects a replayed (consumed) handle", async () => {
    const { server } = registerImportServer();
    const handler = getRegisteredToolHandler(server, "import_apikey_credentials");

    const handle = parse(await handler(IMPORT_ARGS())).plan_handle as string;
    await handler({ ...IMPORT_ARGS(), execute: true, plan_handle: handle });

    const replay = await handler({ ...IMPORT_ARGS(), execute: true, plan_handle: handle });
    expect(replay.isError).toBe(true);
    expect(parse(replay).category).toBe("plan_handle_consumed");
  });

  it("rejects on source drift before writing", async () => {
    const { server } = registerImportServer();
    const handler = getRegisteredToolHandler(server, "import_apikey_credentials");

    const handle = parse(await handler(IMPORT_ARGS())).plan_handle as string;
    writeFileSync(apiKeyFile, ALT_APIKEY_CONTENT, { mode: 0o600 });

    const res = await handler({ ...IMPORT_ARGS(), execute: true, plan_handle: handle });
    expect(res.isError).toBe(true);
    expect(parse(res).category).toBe("plan_drift");
    expect(existsSync(envFile)).toBe(false);
  });

  it("rejects on destination drift before writing", async () => {
    const { server } = registerImportServer();
    const handler = getRegisteredToolHandler(server, "import_apikey_credentials");

    const handle = parse(await handler(IMPORT_ARGS())).plan_handle as string;
    writeFileSync(envFile, "# unrelated change\n", { mode: 0o600 });

    const res = await handler({ ...IMPORT_ARGS(), execute: true, plan_handle: handle });
    expect(res.isError).toBe(true);
    expect(parse(res).category).toBe("plan_drift");
    expect(readFileSync(envFile, "utf8")).toBe("# unrelated change\n");
  });
});

describe("cross-operation and cross-scope handle rejection", () => {
  it("rejects an import handle used for a remove execute (plan_domain_mismatch)", async () => {
    const { server } = registerImportServer();
    const importHandler = getRegisteredToolHandler(server, "import_apikey_credentials");
    const removeHandler = getRegisteredToolHandler(server, "remove_stored_credentials");

    const importHandle = parse(await importHandler(IMPORT_ARGS())).plan_handle as string;

    const res = await removeHandler({ ...REMOVE_ARGS(), execute: true, plan_handle: importHandle });
    expect(res.isError).toBe(true);
    expect(parse(res).category).toBe("plan_domain_mismatch");
  });

  it("rejects a remove handle used for an import execute (plan_domain_mismatch)", async () => {
    await importApiKeyCredentials(importOptions());
    const { server } = registerImportServer();
    const importHandler = getRegisteredToolHandler(server, "import_apikey_credentials");
    const removeHandler = getRegisteredToolHandler(server, "remove_stored_credentials");

    const removeHandle = parse(await removeHandler(REMOVE_ARGS())).plan_handle as string;

    const res = await importHandler({ ...IMPORT_ARGS(), execute: true, plan_handle: removeHandle });
    expect(res.isError).toBe(true);
    expect(parse(res).category).toBe("plan_domain_mismatch");
  });

  it("rejects a handle consumed under a different runtime scope (plan_scope_mismatch)", async () => {
    const rtsc = createTestRuntimeSafetyContext();
    const { server } = registerImportServer(buildDeps(), rtsc);
    const handler = getRegisteredToolHandler(server, "import_apikey_credentials");

    const handle = parse(await handler(IMPORT_ARGS())).plan_handle as string;
    rtsc.setScope({ connectionIndex: 7, connectionGeneration: 3 });

    const res = await handler({ ...IMPORT_ARGS(), execute: true, plan_handle: handle });
    expect(res.isError).toBe(true);
    expect(parse(res).category).toBe("plan_scope_mismatch");
    expect(existsSync(envFile)).toBe(false);
  });
});

describe("remove_stored_credentials preview/execute", () => {
  it("previews without writing then removes only via the handle", async () => {
    await importApiKeyCredentials(importOptions());
    const { server } = registerImportServer();
    const handler = getRegisteredToolHandler(server, "remove_stored_credentials");
    const before = readFileSync(envFile, "utf8");

    const preview = parse(await handler(REMOVE_ARGS()));
    expect(preview.execute).toBe(false);
    expect(typeof preview.plan_handle).toBe("string");
    expect(readFileSync(envFile, "utf8")).toBe(before); // preview wrote nothing

    const res = parse(await handler({ ...REMOVE_ARGS(), execute: true, plan_handle: preview.plan_handle as string }));
    expect(res.restart_required).toBe(true);
    expect(res.removed_target).toBe("primary");
    expect(readFileSync(envFile, "utf8")).not.toContain("EARVELDAJA_API_KEY_ID=key-id-1234567890");
  });

  it("rejects execute without a plan_handle", async () => {
    await importApiKeyCredentials(importOptions());
    const { server } = registerImportServer();
    const handler = getRegisteredToolHandler(server, "remove_stored_credentials");
    const res = await handler({ ...REMOVE_ARGS(), execute: true });
    expect(res.isError).toBe(true);
    expect(parse(res).category).toBe("plan_handle_required");
  });

  it("rejects a removal plan after the destination drifts", async () => {
    await importApiKeyCredentials(importOptions());
    const { server } = registerImportServer();
    const handler = getRegisteredToolHandler(server, "remove_stored_credentials");
    const handle = parse(await handler(REMOVE_ARGS())).plan_handle as string;

    writeFileSync(envFile, "# replaced\n", { mode: 0o600 });
    const res = await handler({ ...REMOVE_ARGS(), execute: true, plan_handle: handle });
    expect(res.isError).toBe(true);
    expect(parse(res).category).toBe("plan_drift");
  });
});

describe("persistCredentialImportViaPlan (startup sole-candidate path)", () => {
  it("persists bound to a fresh one-attempt handle", async () => {
    const rtsc = createTestRuntimeSafetyContext();
    const result = await persistCredentialImportViaPlan(rtsc, importOptions());
    expect(result.action).toBe("created");
    expect(existsSync(envFile)).toBe(true);
    expect(readFileSync(envFile, "utf8")).toContain("EARVELDAJA_API_KEY_ID=key-id-1234567890");
  });

  it("returns unchanged without issuing a plan when already stored", async () => {
    await importApiKeyCredentials(importOptions());
    const rtsc = createTestRuntimeSafetyContext();
    const before = readFileSync(envFile, "utf8");
    const result = await persistCredentialImportViaPlan(rtsc, importOptions());
    expect(result.action).toBe("unchanged");
    expect(readFileSync(envFile, "utf8")).toBe(before);
  });
});
