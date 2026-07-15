import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Find project root by walking up from the module URL to package.json. */
export function getProjectRoot(startUrl: string | URL = import.meta.url): string {
  let dir = dirname(fileURLToPath(startUrl));
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  process.stderr.write("WARNING: Could not find package.json; falling back to process.cwd()\n");
  return process.cwd();
}
