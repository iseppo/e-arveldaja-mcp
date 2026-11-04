// Vitest setup (vitest.config.ts setupFiles): every test gets its own, not yet
// existing global config dir, so code paths that persist to the default
// accounting-rules bundle (statement balances, receipt attachment digests)
// never write to the developer's real ~/.config and never leak records from
// one test into the next. A test that sets EARVELDAJA_CONFIG_DIR or
// EARVELDAJA_RULES_DIR itself still wins (its own hooks run later).
//
// Unit tests never reach the network: a test that needs fetch stubs it itself
// (vi.stubGlobal). Without a stub, a code path that calls a live service (the
// business registry lookup, ECB rates) gets an immediate network failure
// instead of waiting on the real host — a slow host used to turn such tests
// into timeouts.
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeEach } from "vitest";
import { clearRegistryNameCache } from "../receipts/registry-name-cache.js";

const root = mkdtempSync(join(tmpdir(), "earveldaja-test-config-"));
let counter = 0;

globalThis.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: string })?.url ?? "";
  throw new TypeError(`fetch failed: network is disabled in unit tests (${url})`);
}) as typeof fetch;
process.env.EARVELDAJA_CONFIG_DIR = join(root, "module");

beforeEach(() => {
  process.env.EARVELDAJA_CONFIG_DIR = join(root, `t${counter++}`);
  // Business-register names cached by the extraction cross-check never carry
  // from one test's fetch stub into the next.
  clearRegistryNameCache();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
