import type { AsyncLocalStorage } from "node:async_hooks";
import type { NamedConfig, ToolExposureConfig } from "../config.js";
import type { ConnectionSnapshot } from "../connection-safety.js";
import type { ToolProfile } from "../tool-profile.js";
import {
  createRuntimeSafetyContext,
  type RuntimeSafetyContext,
} from "../runtime-safety-context.js";

export interface BuildRuntimeSafetyContextInput {
  readonly invocationStorage: AsyncLocalStorage<ConnectionSnapshot>;
  readonly configs: readonly NamedConfig[];
  readonly toolExposure: ToolExposureConfig;
  readonly toolProfile: ToolProfile;
  readonly getVerifiedCompanyIdentity: (connectionIndex: number) => string | null;
}

/**
 * Assemble the inputs for and construct the runtime safety context (plan / file-
 * reference / operation-result / workflow-state stores + active-scope resolver).
 *
 * A thin composition seam moved out of `createMcpServer`: the field mapping is
 * unchanged, so the produced context is identical to the inline construction.
 */
export function buildRuntimeSafetyContext(
  input: BuildRuntimeSafetyContextInput,
): RuntimeSafetyContext {
  return createRuntimeSafetyContext({
    invocationStorage: input.invocationStorage,
    configs: input.configs,
    toolExposure: input.toolExposure,
    toolProfile: input.toolProfile,
    getVerifiedCompanyIdentity: input.getVerifiedCompanyIdentity,
  });
}
