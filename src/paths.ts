import { existsSync } from "fs";
import { resolve } from "path";

/** Find project root by walking up from import.meta.dirname to package.json. */
export function getProjectRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  process.stderr.write("WARNING: Could not find package.json; falling back to process.cwd()\n");
  return process.cwd();
}
