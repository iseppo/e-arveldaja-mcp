import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/__integration__/**"],
    // Files run in parallel on every core, so on a loaded machine the 5 s/10 s
    // defaults turn slow-but-correct tests into flakes.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
