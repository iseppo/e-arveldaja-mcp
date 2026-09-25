import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPrompt as registerMcpPrompt } from "./mcp-compat.js";
import { credentialImportUnavailableAdvice, type CredentialSetupInfo, type ToolExposureConfig } from "./config.js";
import {
  enabledPromptDefinitions,
  promptToolAvailability,
  type PromptToolAvailability,
  type RegisteredPromptDefinition,
  type SetupPromptOptions,
} from "./prompt-registry.js";
import type { ToolProfile } from "./tool-profile.js";
import {
  buildWorkflowRunData,
  buildWorkflowPromptSourceText,
} from "./workflow-prompt-source.js";
import { renderPromptSurface } from "./prompt-surface.js";

interface PromptResult {
  messages: Array<{
    role: "user";
    content: {
      type: "text";
      text: string;
    };
  }>;
}

function promptText(text: string): PromptResult {
  return {
    messages: [{
      role: "user",
      content: { type: "text", text },
    }],
  };
}

function buildSetupModePromptText(
  workflowName: string,
  setupInfo: CredentialSetupInfo,
  args: unknown,
  options: SetupPromptOptions,
  hasTool: PromptToolAvailability,
  toolProfile: ToolProfile | undefined,
): string {
  const canImport = hasTool("import_apikey_credentials");
  const availableTools = [
    "get_setup_instructions",
    "list_connections",
    "import_apikey_credentials",
    ...(options.offlineTools ?? []),
  ].filter(hasTool);

  const trustedBody = `The server is currently running in setup mode, so the \`${workflowName}\` workflow cannot complete yet.

First call \`get_setup_instructions\` and configure credentials.
- Read the working directory and searched directories from the bounded \`setup\` run data.
- Read the shared config directory and shared env file from the bounded \`setup\` run data when configuration should work from any folder.
${canImport
    ? "- Import tool: `import_apikey_credentials`"
    : `- ${credentialImportUnavailableAdvice(toolProfile)} The environment variable names and \`.env\` locations are in the \`setup\` run data.`}
- Read required environment variable names, the optional direct credential-file variable, and the credential-file pattern from the bounded \`setup\` run data.
- If exactly one secure matching credential file is present and the client supports prompts, the server may offer to verify it and save the resulting \`.env\` either only for this folder or so it works when you start the MCP server from any folder.

Tools you can use right now:
${availableTools.map(tool => `- \`${tool}\``).join("\n")}
${options.note ? `\nSpecific guidance:\n- ${options.note}` : ""}

After credentials are configured and the MCP server is restarted, run \`${workflowName}\` again.`;

  return renderPromptSurface(trustedBody, {
    ...buildWorkflowRunData(args),
    setup: setupInfo,
  });
}

function renderRegisteredPrompt(
  definition: RegisteredPromptDefinition,
  setupInfo: CredentialSetupInfo | undefined,
  args: unknown,
  hasTool: PromptToolAvailability,
  toolProfile?: ToolProfile,
): PromptResult {
  if (setupInfo && definition.setupOptions) {
    return promptText(buildSetupModePromptText(
      definition.name,
      setupInfo,
      args,
      definition.setupOptions,
      hasTool,
      toolProfile,
    ));
  }
  return promptText(buildWorkflowPromptSourceText(
    definition.slug,
    args,
    definition.variants,
    hasTool,
  ));
}

/**
 * Register the workflow prompts for the active tool surface. Prompts whose
 * tools are all absent are not registered, and each rendered prompt keeps only
 * the capability sections whose tools are registered on `toolProfile` +
 * `toolExposure`, so a prompt never names a tool missing from tools/list.
 */
export function registerPrompts(
  server: McpServer,
  options: { setupInfo?: CredentialSetupInfo; toolExposure?: ToolExposureConfig; toolProfile?: ToolProfile } = {},
): void {
  const surface = {
    ...(options.toolProfile ? { toolProfile: options.toolProfile } : {}),
    setupMode: options.setupInfo !== undefined,
  };
  const hasTool = promptToolAvailability({
    ...surface,
    ...(options.toolExposure ? { toolExposure: options.toolExposure } : {}),
  });
  for (const definition of enabledPromptDefinitions(options.toolExposure, surface)) {
    if (definition.argsSchema) {
      registerMcpPrompt(
        server,
        definition.name,
        definition.description,
        definition.argsSchema,
        async args => renderRegisteredPrompt(definition, options.setupInfo, args, hasTool, options.toolProfile),
      );
    } else {
      registerMcpPrompt(
        server,
        definition.name,
        definition.description,
        async () => renderRegisteredPrompt(definition, options.setupInfo, {}, hasTool, options.toolProfile),
      );
    }
  }
}
