import { stat, realpath } from "fs/promises";
import { resolve, extname, isAbsolute } from "path";
import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { getProjectRoot } from "./paths.js";

/**
 * Allowed root directories for file reads. Configurable via EARVELDAJA_ALLOWED_PATHS
 * (colon-separated list). Defaults to $HOME and /tmp.
 * Roots are resolved through symlinks so that the check works even if
 * e.g. /tmp is a symlink to /private/tmp (macOS).
 */
function getAllowedRoots(): string[] {
  const raw = process.env.EARVELDAJA_ALLOWED_PATHS
    ? process.env.EARVELDAJA_ALLOWED_PATHS.split(":").map(p => resolve(p))
    : [homedir(), "/tmp"];

  return raw.map(root => {
    try { return realpathSync(root); } catch { return root; }
  });
}

/**
 * Resolve a file path. For relative paths, tries:
 * 1. Parent of project root (where accounting documents typically live)
 * 2. Project root
 * 3. Current working directory (fallback)
 */
function resolveFilePath(filePath: string): string {
  if (isAbsolute(filePath)) return resolve(filePath);

  const projectRoot = getProjectRoot();
  const searchBases = [
    resolve(projectRoot, ".."),  // parent dir (e.g. e_arveldaja/)
    projectRoot,                 // project root (e.g. e-arveldaja-mcp/)
    process.cwd(),               // cwd fallback
  ];

  for (const base of searchBases) {
    const candidate = resolve(base, filePath);
    if (existsSync(candidate)) return candidate;
  }

  // Nothing found — return resolved from parent dir for the best error message
  return resolve(searchBases[0]!, filePath);
}

/**
 * Validate a file path: extension check, symlink resolution, allowed directory,
 * size limit. Returns the resolved real path.
 */
export async function validateFilePath(
  filePath: string,
  allowedExtensions: string[],
  maxSize: number,
): Promise<string> {
  const resolved = resolveFilePath(filePath);
  const ext = extname(resolved).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    throw new Error(`Only ${allowedExtensions.join("/")} files are allowed, got: ${ext}`);
  }

  // Resolve symlinks to get the real path
  const real = await realpath(resolved);
  const realExt = extname(real).toLowerCase();
  if (!allowedExtensions.includes(realExt)) {
    throw new Error(`Symlink target has disallowed extension: ${realExt}`);
  }

  // Check allowed directory roots
  const roots = getAllowedRoots();
  if (!roots.some(root => real.startsWith(root + "/") || real === root)) {
    throw new Error(
      `File path outside allowed directories. Allowed roots: ${roots.join(", ")}. ` +
      `Set EARVELDAJA_ALLOWED_PATHS to override.`
    );
  }

  const info = await stat(real);
  if (!info.isFile()) {
    throw new Error(`Not a file`);
  }
  if (info.size > maxSize) {
    throw new Error(`File too large: ${(info.size / 1024 / 1024).toFixed(1)} MB (max ${maxSize / 1024 / 1024} MB)`);
  }

  return real;
}
