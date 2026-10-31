// Vitest setup (vitest.config.ts setupFiles): every test gets its own, not yet
// existing global config dir, so code paths that persist to the default
// accounting-rules bundle (statement balances, receipt attachment digests)
// never write to the developer's real ~/.config and never leak records from
// one test into the next. A test that sets EARVELDAJA_CONFIG_DIR or
// EARVELDAJA_RULES_DIR itself still wins (its own hooks run later).
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeEach } from "vitest";

const root = mkdtempSync(join(tmpdir(), "earveldaja-test-config-"));
let counter = 0;
process.env.EARVELDAJA_CONFIG_DIR = join(root, "module");

beforeEach(() => {
  process.env.EARVELDAJA_CONFIG_DIR = join(root, `t${counter++}`);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
