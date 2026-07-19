import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPrompt as registerMcpPrompt } from "./mcp-compat.js";
import type { CredentialSetupInfo, ToolExposureConfig } from "./config.js";
import {
  enabledPromptDefinitions,
  type RegisteredPromptDefinition,
  type SetupPromptOptions,
} from "./prompt-registry.js";
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
): string {
  const availableTools = [
    "get_setup_instructions",
    "list_connections",
    "import_apikey_credentials",
    ...(options.offlineTools ?? []),
  ];

  const trustedBody = `The server is currently running in setup mode, so the \`${workflowName}\` workflow cannot complete yet.

First call \`get_setup_instructions\` and configure credentials.
- Read the working directory and searched directories from the bounded \`setup\` run data.
- Read the shared config directory and shared env file from the bounded \`setup\` run data when configuration should work from any folder.
- Import tool: \`import_apikey_credentials\`
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
  toolExposure: ToolExposureConfig | undefined,
): PromptResult {
  if (setupInfo && definition.setupOptions) {
    return promptText(buildSetupModePromptText(
      definition.name,
      setupInfo,
      args,
      definition.setupOptions,
    ));
  }
  return promptText(buildWorkflowPromptSourceText(
    definition.slug,
    args,
    definition.variants,
    toolExposure,
  ));
}

export function registerPrompts(
  server: McpServer,
  options: { setupInfo?: CredentialSetupInfo; toolExposure?: ToolExposureConfig } = {},
): void {
  for (const definition of enabledPromptDefinitions(options.toolExposure)) {
    if (definition.argsSchema) {
      registerMcpPrompt(
        server,
        definition.name,
        definition.description,
        definition.argsSchema,
        async args => renderRegisteredPrompt(definition, options.setupInfo, args, options.toolExposure),
      );
    } else {
      registerMcpPrompt(
        server,
        definition.name,
        definition.description,
        async () => renderRegisteredPrompt(definition, options.setupInfo, {}, options.toolExposure),
      );
    }
  }
}
