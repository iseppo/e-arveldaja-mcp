import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server-bootstrap.js";
import { TOOL_SURFACE_SETUP_INFO } from "../__fixtures__/tool-surface.js";
import { parseMcpResponse } from "../mcp-json.js";
import { buildCredentialSetupNextSteps } from "../config.js";
import { isToolVisibleForProfile, parseToolProfile, type ToolProfile } from "../tool-profile.js";

async function setupInstructions(toolProfile: ToolProfile): Promise<{ tools: string[]; payload: Record<string, unknown> }> {
  const bootstrap = await createMcpServer({ configs: [], setupInfo: TOOL_SURFACE_SETUP_INFO, toolProfile, connect: false });
  const client = new Client({ name: "setup-profile-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([bootstrap.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = (await client.listTools()).tools.map(({ name }) => name);
    const result = await client.callTool({ name: "get_setup_instructions", arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    return { tools, payload: parseMcpResponse(text) as Record<string, unknown> };
  } finally {
    await client.close();
  }
}

describe("get_setup_instructions next_steps are exposure-aware", () => {
  it("guided setup mode names no unregistered credential tool", async () => {
    const { tools, payload } = await setupInstructions("guided");
    expect(tools).not.toContain("import_apikey_credentials");
    expect(payload.import_tool).toBeUndefined();
    const steps = (payload.next_steps as string[]).join("\n");
    expect(steps).not.toMatch(/import_apikey_credentials|list_stored_credentials|remove_stored_credentials/);
    expect(steps).toContain(".env");
    // A legacy exposure flag would normalize the profile to custom and replace
    // the guided surface, so guided is pointed at a temporary full profile.
    expect(steps).toContain("EARVELDAJA_PROFILE=full");
    expect(steps).toContain("EARVELDAJA_PROFILE=guided");
    expect(steps).not.toContain("EARVELDAJA_EXPOSE_SETUP_TOOLS=1");
    expect(steps).toContain("switches the profile to custom");
  });

  it("guided-sales setup advice switches back to guided-sales", async () => {
    const { payload } = await setupInstructions("guided-sales");
    const steps = (payload.next_steps as string[]).join("\n");
    expect(steps).toContain("EARVELDAJA_PROFILE=guided-sales");
    expect(steps).not.toContain("EARVELDAJA_EXPOSE_SETUP_TOOLS=1");
  });

  it("full setup mode keeps naming the registered import tool", async () => {
    const { tools, payload } = await setupInstructions("full");
    expect(tools).toContain("import_apikey_credentials");
    expect(payload.import_tool).toBe("import_apikey_credentials");
    // The caller-supplied setup info is passed through unchanged.
    expect(payload.next_steps).toEqual(TOOL_SURFACE_SETUP_INFO.next_steps);
  });

  it("buildCredentialSetupNextSteps switches wording on availability", () => {
    const base = { globalConfigDirectory: "/cfg", globalEnvFile: "/cfg/.env" };
    const available = buildCredentialSetupNextSteps({ ...base, credentialToolsAvailable: true }).join("\n");
    const absent = buildCredentialSetupNextSteps({ ...base, credentialToolsAvailable: false }).join("\n");
    expect(available).toContain("import_apikey_credentials");
    expect(absent).not.toContain("import_apikey_credentials");
    expect(absent).toContain("/cfg/.env");
    // Non-guided (standard/custom): the flag is fine, and the custom normalization is stated.
    const standard = buildCredentialSetupNextSteps({ ...base, credentialToolsAvailable: false, toolProfile: "standard" }).join("\n");
    expect(standard).toContain("EARVELDAJA_EXPOSE_SETUP_TOOLS=1");
    expect(standard).toContain("normalizes the profile to custom");
  });

  it("the stated custom normalization matches parseToolProfile", () => {
    expect(parseToolProfile({ EARVELDAJA_PROFILE: "guided", EARVELDAJA_EXPOSE_SETUP_TOOLS: "1" })).toBe("custom");
    expect(parseToolProfile({ EARVELDAJA_PROFILE: "standard", EARVELDAJA_EXPOSE_SETUP_TOOLS: "1" })).toBe("custom");
    expect(isToolVisibleForProfile("import_apikey_credentials", "full")).toBe(true);
    expect(isToolVisibleForProfile("import_apikey_credentials", "guided")).toBe(false);
  });
});
