import { describe, expect, it, vi } from "vitest";
import {
  maybeImportCredentialsOnStartup,
  type StartupCredentialImportOptions,
} from "./startup-credential-import.js";

function buildOptions(
  overrides: Partial<StartupCredentialImportOptions> = {},
): StartupCredentialImportOptions {
  return {
    env: {},
    candidateFiles: [],
    promptForScope: vi.fn(async () => "global"),
    importCredentials: vi.fn(async () => ({
      envFile: "/tmp/.env",
      storageScope: "global",
      companyName: "Acme OÜ",
      verifiedAt: "2026-03-29T12:00:00.000Z",
      created: true,
      action: "created" as const,
      sourceFile: "/tmp/apikey.txt",
      target: "primary" as const,
    })),
    ...overrides,
  };
}

describe("maybeImportCredentialsOnStartup", () => {
  it("skips prompting when canonical env credentials already exist", async () => {
    const promptForScope = vi.fn(async () => "global");
    const importCredentials = vi.fn();

    const result = await maybeImportCredentialsOnStartup(buildOptions({
      env: {
        EARVELDAJA_API_KEY_ID: "id",
        EARVELDAJA_API_PUBLIC_VALUE: "public",
        EARVELDAJA_API_PASSWORD: "secret",
      },
      candidateFiles: ["/tmp/apikey.txt"],
      promptForScope,
      importCredentials,
    }));

    expect(result).toEqual({ status: "skipped", reason: "configured_env" });
    expect(promptForScope).not.toHaveBeenCalled();
    expect(importCredentials).not.toHaveBeenCalled();
  });

  it("skips prompting when an explicit credential file env var is configured", async () => {
    const promptForScope = vi.fn(async () => "global");
    const importCredentials = vi.fn();

    const result = await maybeImportCredentialsOnStartup(buildOptions({
      env: {
        EARVELDAJA_API_KEY_FILE: "/tmp/explicit-apikey.txt",
      },
      candidateFiles: ["/tmp/apikey.txt"],
      promptForScope,
      importCredentials,
    }));

    expect(result).toEqual({ status: "skipped", reason: "explicit_credential_file" });
    expect(promptForScope).not.toHaveBeenCalled();
    expect(importCredentials).not.toHaveBeenCalled();
  });

  it("imports the only startup candidate after prompting for storage scope", async () => {
    const promptForScope = vi.fn(async () => "local" as const);
    const importCredentials = vi.fn(async () => ({
      envFile: "/tmp/project/.env",
      storageScope: "local" as const,
      companyName: "Beta AS",
      verifiedAt: "2026-03-29T13:00:00.000Z",
      created: true,
      action: "created" as const,
      sourceFile: "/tmp/project/apikey.txt",
      target: "primary" as const,
    }));

    const result = await maybeImportCredentialsOnStartup(buildOptions({
      candidateFiles: ["/tmp/project/apikey.txt"],
      promptForScope,
      importCredentials,
    }));

    expect(result).toEqual({
      status: "imported",
      result: {
        envFile: "/tmp/project/.env",
        storageScope: "local",
        companyName: "Beta AS",
        verifiedAt: "2026-03-29T13:00:00.000Z",
        created: true,
        action: "created",
        sourceFile: "/tmp/project/apikey.txt",
        target: "primary",
      },
    });
    expect(promptForScope).toHaveBeenCalledTimes(1);
    expect(importCredentials).toHaveBeenCalledWith({
      apiKeyFile: "/tmp/project/apikey.txt",
      storageScope: "local",
    });
  });

  it("skips automatic import when the prompt is cancelled", async () => {
    const promptForScope = vi.fn(async () => null);
    const importCredentials = vi.fn();

    const result = await maybeImportCredentialsOnStartup(buildOptions({
      candidateFiles: ["/tmp/project/apikey.txt"],
      promptForScope,
      importCredentials,
    }));

    expect(result).toEqual({
      status: "skipped",
      reason: "cancelled",
      candidateFile: "/tmp/project/apikey.txt",
    });
    expect(importCredentials).not.toHaveBeenCalled();
  });

  it("skips automatic import when multiple local apikey files are present", async () => {
    const promptForScope = vi.fn(async () => "global");
    const importCredentials = vi.fn();

    const result = await maybeImportCredentialsOnStartup(buildOptions({
      candidateFiles: ["/tmp/apikey-a.txt", "/tmp/apikey-b.txt"],
      promptForScope,
      importCredentials,
    }));

    expect(result).toEqual({
      status: "skipped",
      reason: "multiple_candidates",
      candidates: ["/tmp/apikey-a.txt", "/tmp/apikey-b.txt"],
    });
    expect(promptForScope).not.toHaveBeenCalled();
    expect(importCredentials).not.toHaveBeenCalled();
  });

  it("returns a failed outcome when prompting is unsupported", async () => {
    const promptForScope = vi.fn(async () => {
      throw new Error("Client does not support interactive setup prompting.");
    });
    const importCredentials = vi.fn();

    const result = await maybeImportCredentialsOnStartup(buildOptions({
      candidateFiles: ["/tmp/project/apikey.txt"],
      promptForScope,
      importCredentials,
    }));

    expect(result).toEqual({
      status: "failed",
      reason: "prompt_error",
      candidateFile: "/tmp/project/apikey.txt",
      error: "Client does not support interactive setup prompting.",
    });
    expect(importCredentials).not.toHaveBeenCalled();
  });

  it("returns a failed outcome when verification/import fails", async () => {
    const promptForScope = vi.fn(async () => "global" as const);
    const importCredentials = vi.fn(async () => {
      throw new Error("401 Unauthorized");
    });

    const result = await maybeImportCredentialsOnStartup(buildOptions({
      candidateFiles: ["/tmp/project/apikey.txt"],
      promptForScope,
      importCredentials,
    }));

    expect(result).toEqual({
      status: "failed",
      reason: "import_error",
      candidateFile: "/tmp/project/apikey.txt",
      error: "401 Unauthorized",
    });
  });
});
