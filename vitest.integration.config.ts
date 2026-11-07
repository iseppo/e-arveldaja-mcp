import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/__integration__/**/*.test.ts"],
    // Per-file temp root: os.tmpdir() points into it and it is removed after the file.
    setupFiles: ["src/__fixtures__/vitest-temp-root.ts"],
    testTimeout: 30000,
  },
});
