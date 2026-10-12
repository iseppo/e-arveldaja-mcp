import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/__integration__/**"],
    // Files run in parallel on every core, so on a loaded machine the 5 s/10 s
    // defaults turn slow-but-correct tests into flakes.
    // Several agents often run the suite at once in separate worktrees; with
    // one worker per core each, that saturates CPU and RAM. Override with
    // VITEST_MAX_WORKERS when running alone.
    maxWorkers: process.env.VITEST_MAX_WORKERS ?? 4,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
