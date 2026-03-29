import type {
  CredentialStorageScope,
  ImportApiKeyCredentialsResult,
} from "./config.js";

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type StartupCredentialImportOutcome =
  | { status: "skipped"; reason: "configured_env" | "explicit_credential_file" | "no_candidate" | "multiple_candidates" | "cancelled"; candidateFile?: string; candidates?: string[] }
  | { status: "imported"; result: ImportApiKeyCredentialsResult }
  | { status: "failed"; reason: "prompt_error" | "import_error"; candidateFile: string; error: string };

export interface StartupCredentialImportOptions {
  env: EnvLike;
  candidateFiles: string[];
  promptForScope: () => Promise<CredentialStorageScope | null>;
  importCredentials: (options: {
    apiKeyFile: string;
    storageScope: CredentialStorageScope;
  }) => Promise<ImportApiKeyCredentialsResult>;
}

function hasCompleteApiCredentialEnv(env: EnvLike): boolean {
  return Boolean(env.EARVELDAJA_API_KEY_ID && env.EARVELDAJA_API_PUBLIC_VALUE && env.EARVELDAJA_API_PASSWORD);
}

export async function maybeImportCredentialsOnStartup(
  options: StartupCredentialImportOptions,
): Promise<StartupCredentialImportOutcome> {
  if (hasCompleteApiCredentialEnv(options.env)) {
    return { status: "skipped", reason: "configured_env" };
  }

  if (options.env.EARVELDAJA_API_KEY_FILE?.trim()) {
    return { status: "skipped", reason: "explicit_credential_file" };
  }

  if (options.candidateFiles.length === 0) {
    return { status: "skipped", reason: "no_candidate" };
  }

  if (options.candidateFiles.length > 1) {
    return {
      status: "skipped",
      reason: "multiple_candidates",
      candidates: options.candidateFiles,
    };
  }

  const candidateFile = options.candidateFiles[0]!;

  let storageScope: CredentialStorageScope | null;
  try {
    storageScope = await options.promptForScope();
  } catch (error) {
    return {
      status: "failed",
      reason: "prompt_error",
      candidateFile,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!storageScope) {
    return {
      status: "skipped",
      reason: "cancelled",
      candidateFile,
    };
  }

  try {
    const result = await options.importCredentials({
      apiKeyFile: candidateFile,
      storageScope,
    });
    return {
      status: "imported",
      result,
    };
  } catch (error) {
    return {
      status: "failed",
      reason: "import_error",
      candidateFile,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
