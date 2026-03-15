import { stat, realpath } from "fs/promises";
import { resolve, extname } from "path";
import { homedir } from "os";

/**
 * Allowed root directories for file reads. Configurable via EARVELDAJA_ALLOWED_PATHS
 * (colon-separated list). Defaults to $HOME and /tmp.
 */
function getAllowedRoots(): string[] {
  const envPaths = process.env.EARVELDAJA_ALLOWED_PATHS;
  if (envPaths) {
    return envPaths.split(":").map(p => resolve(p));
  }
  return [homedir(), "/tmp"];
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
  const resolved = resolve(filePath);
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
