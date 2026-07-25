import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolMeta } from "./tool-catalog.js";
import type { ToolProfile } from "./tool-profile.js";
import { isToolVisibleForProfile, runWithToolProfile } from "./tool-profile.js";

interface CatalogState { readonly publicNames: Set<string> }
const SERVER_STATES = new WeakMap<McpServer, CatalogState>();

function stateFor(server: McpServer): CatalogState {
  let state = SERVER_STATES.get(server);
  if (!state) { state = { publicNames: new Set() }; SERVER_STATES.set(server, state); }
  return state;
}

function buildPublicToolServer(server: McpServer, profile: ToolProfile): McpServer {
  const state = stateFor(server);
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      return (name: string, config: Record<string, any>, callback: (...args: any[]) => any) => {
        const meta = config?._meta?.earveldajaTool as ToolMeta | undefined;
        if (!meta || meta.name !== name) throw new Error(`Missing ToolMeta for registered tool: ${name}`);
        const destructive = config.annotations?.destructiveHint === true;
        const catalogDestructive = meta.risk === "destructive" || meta.risk === "send";
        if (destructive !== catalogDestructive) throw new Error(`Tool ${name} destructive-risk metadata mismatch`);
        // A read-only claim must never disagree with the catalog in the direction
        // that hides a mutation: a mutating façade catalogued as read/preview (or a
        // tool annotated readOnly whose catalog risk mutates) would let an approval
        // policy silently auto-approve a real ledger write. read/preview are the
        // read-only-hinted risks; mutate, destructive and send are not. An omitted
        // readOnlyHint makes no claim, so — like the destructive check above — it is
        // tolerated; only an explicit annotation that contradicts the catalog throws.
        const catalogReadOnly = meta.risk === "read" || meta.risk === "preview";
        const declaredReadOnly = config.annotations?.readOnlyHint;
        if (declaredReadOnly === true && !catalogReadOnly) throw new Error(`Tool ${name} read-only-risk metadata mismatch`);
        if (declaredReadOnly === false && catalogReadOnly) throw new Error(`Tool ${name} read-only-risk metadata mismatch`);
        if (!isToolVisibleForProfile(name, profile)) return Object.freeze({ enabled: false, disable() {}, enable() {}, remove() {}, update() {} });
        if (state.publicNames.has(name)) throw new Error(`Duplicate public MCP tool name: ${name}`);
        state.publicNames.add(name);
        const nestedMeta = { ...(config._meta ?? {}) };
        delete nestedMeta.earveldajaTool;
        const publicConfig = { ...config, ...(Object.keys(nestedMeta).length ? { _meta: nestedMeta } : {}) };
        if (Object.keys(nestedMeta).length === 0) delete publicConfig._meta;
        const profiledCallback = (...args: any[]) => runWithToolProfile(profile, () => callback(...args));
        return (target.registerTool as any).call(target, name, publicConfig, profiledCallback);
      };
    },
  }) as McpServer;
}

export class PublicToolRegistrar {
  readonly server: McpServer;

  constructor(server: McpServer, profile: ToolProfile) {
    this.server = buildPublicToolServer(server, profile);
  }
}

export function createPublicToolRegistrar(server: McpServer, profile: ToolProfile): McpServer {
  return new PublicToolRegistrar(server, profile).server;
}
