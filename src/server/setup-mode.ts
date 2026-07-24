import type { getCredentialSetupInfo } from "../config.js";
import type { ApiContext } from "../tools/crud-tools.js";
import { SETUP_PROFILE_CHOICES } from "../tool-profile.js";

/**
 * Setup-mode payloads, errors, and the credential-blocked API proxy.
 *
 * When no connections are configured the server runs in "setup mode": every
 * API-backed call surfaces the same friendly credential-setup guidance instead
 * of hitting the network. These helpers are shared by the handler-wrapping
 * machinery (create-server) and the system-tool registrations (register-system-
 * tools), so they live in one focused module rather than being duplicated.
 */

export function buildSetupModePayload(
  setupInfo: ReturnType<typeof getCredentialSetupInfo>,
  options?: {
    hint?: string;
    blockedTool?: string;
    blockedResource?: string;
    blockedApiMethod?: string;
  },
): Record<string, unknown> {
  return {
    mode: "setup",
    error: `${setupInfo.message} Call get_setup_instructions for guidance.`,
    hint: options?.hint ??
      "Call get_setup_instructions to see how to configure EARVELDAJA_API_*, use import_apikey_credentials to verify an apikey*.txt and save the configuration either only for this folder or for any folder you start the MCP server from, or set EARVELDAJA_API_KEY_FILE to an explicit credential file path.",
    credential_file_env_var: setupInfo.credential_file_env_var,
    credential_file_pattern: setupInfo.credential_file_pattern,
    working_directory: setupInfo.working_directory,
    searched_directories: setupInfo.searched_directories,
    global_config_directory: setupInfo.global_config_directory,
    global_env_file: setupInfo.global_env_file,
    import_tool: "import_apikey_credentials",
    ...(options?.blockedTool ? { blocked_tool: options.blockedTool } : {}),
    ...(options?.blockedResource ? { blocked_resource: options.blockedResource } : {}),
    ...(options?.blockedApiMethod ? { blocked_api_method: options.blockedApiMethod } : {}),
  };
}

export function buildSetupModeError(
  setupInfo: ReturnType<typeof getCredentialSetupInfo>,
  blockedApiMethod?: string,
): Error {
  const payload = buildSetupModePayload(setupInfo, { blockedApiMethod });
  return Object.assign(new Error(String(payload.error)), payload);
}

export function createSetupModeApiContext(setupInfo: ReturnType<typeof getCredentialSetupInfo>): ApiContext {
  return new Proxy({}, {
    get(_target, apiSection) {
      return new Proxy({}, {
        get(_innerTarget, apiMethod) {
          throw buildSetupModeError(setupInfo, `${String(apiSection)}.${String(apiMethod)}`);
        },
      });
    },
  }) as ApiContext;
}

export function isSetupModeError(
  error: unknown,
): error is Error & {
  mode?: string;
  hint?: string;
  blocked_api_method?: string;
  working_directory?: string;
  searched_directories?: string[];
} {
  return typeof error === "object" && error !== null &&
    "mode" in error &&
    (error as { mode?: unknown }).mode === "setup" &&
    "working_directory" in error &&
    "searched_directories" in error;
}

export function getResourceUri(args: unknown[]): string {
  const candidate = args[0];
  if (candidate instanceof URL) return candidate.href;
  if (typeof candidate === "object" && candidate !== null && "href" in candidate) {
    const href = (candidate as { href?: unknown }).href;
    if (typeof href === "string") return href;
  }
  return "earveldaja://setup";
}

export function buildSetupInstructionsPayload(
  setupInfo: ReturnType<typeof getCredentialSetupInfo>,
  isSetupMode: boolean,
): Record<string, unknown> {
  return {
    ...setupInfo,
    import_tool: "import_apikey_credentials",
    mode: isSetupMode ? "setup" : "configured",
    message: isSetupMode
      ? "No API credentials configured. Server is running in setup mode."
      : "API credentials are configured. These are the supported ways to provide credentials for this working directory.",
    profile: {
      env_var: "EARVELDAJA_PROFILE",
      default_for_this_release: "standard",
      choices: SETUP_PROFILE_CHOICES,
      note: "Choose one surface. Guided and guided-sales are opt-in compatibility profiles; after changing profile, restart and run fresh previews.",
    },
  };
}
