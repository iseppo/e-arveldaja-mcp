import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getProjectRoot } from "./paths.js";

describe("getProjectRoot", () => {
  it("does not depend on the Node 20 import.meta.dirname extension", () => {
    const source = readFileSync(new URL("./paths.ts", import.meta.url), "utf8");
    expect(source).not.toContain("import.meta.dirname");
  });

  it("derives the root through Node 18 ESM APIs", () => {
    const sourceUrl = pathToFileURL(resolve(process.cwd(), "src/paths.ts"));
    expect(getProjectRoot(sourceUrl)).toBe(process.cwd());
  });
});
