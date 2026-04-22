import { stat, realpath, mkdtemp, writeFile, rm } from "fs/promises";
import { resolve, extname, isAbsolute, relative, delimiter, join } from "path";
import { existsSync, realpathSync } from "fs";
import { homedir, tmpdir } from "os";
import { randomUUID } from "crypto";
import { getProjectRoot } from "./paths.js";

function resolveAllowedRoots(roots: string[]): string[] {
  return roots.map(root => {
    try { return realpathSync(root); } catch { return root; }
  });
}

/**
 * Default root directories for file reads: working directory + OS temp dir.
 * Set EARVELDAJA_ALLOW_HOME=true to also include $HOME.
 * Override entirely with EARVELDAJA_ALLOWED_PATHS (platform-delimited list).
 * Roots are resolved through symlinks so that the check works even if
 * e.g. the temp dir is a symlink on macOS.
 */
function getDefaultRoots(): string[] {
  const roots = [process.cwd(), tmpdir()];
  if (process.env.EARVELDAJA_ALLOW_HOME === "true") {
    const home = homedir();
    if (!roots.includes(home)) roots.push(home);
  }
  return roots;
}

export function splitAllowedPaths(raw: string, separator = delimiter): string[] {
  return raw
    .split(separator)
    .map(part => part.trim())
    .filter(Boolean);
}

type PathContainmentOps = {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
};

export function isPathWithinRoot(
  targetPath: string,
  rootPath: string,
  pathOps: PathContainmentOps = { relative, isAbsolute },
): boolean {
  const rel = pathOps.relative(rootPath, targetPath);
  return rel === "" || (!rel.startsWith("..") && !pathOps.isAbsolute(rel));
}

export function getAllowedRoots(): string[] {
  const raw = process.env.EARVELDAJA_ALLOWED_PATHS
    ? splitAllowedPaths(process.env.EARVELDAJA_ALLOWED_PATHS).map(p => {
        const resolved = resolve(p);
        if (resolved === "/") {
          process.stderr.write("WARNING: EARVELDAJA_ALLOWED_PATHS includes filesystem root '/'. This is insecure.\n");
        }
        return resolved;
      })
    : getDefaultRoots();

  return resolveAllowedRoots(raw);
}

export function getAllowedRootsStartupWarning(): string | undefined {
  if (process.env.EARVELDAJA_ALLOWED_PATHS) return undefined;

  const roots = resolveAllowedRoots(getDefaultRoots());
  return `File-reading tools can access supported files under ${roots.join(", ")}. ` +
    "Set EARVELDAJA_ALLOWED_PATHS to restrict, or EARVELDAJA_ALLOW_HOME=true to also include $HOME.";
}

/**
 * Resolve a file path. For relative paths, tries:
 * 1. Parent of project root (where accounting documents typically live)
 * 2. Project root
 * 3. Current working directory (fallback)
 */
export function resolveFilePath(filePath: string): string {
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
  if (!roots.some(root => isPathWithinRoot(real, root))) {
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

// ---------------------------------------------------------------------------
// Cross-system file input support (base64 payloads from remote MCP clients)
// ---------------------------------------------------------------------------

// Syntax:
//   base64:<b64>         — magic-byte detection (PDF, PNG, JPEG, XML)
//   base64:<ext>:<b64>   — explicit extension hint (required for CSV / TXT or any
//                          format without a reliable magic-byte signature)
// The decoded content is materialized to a secure per-call tmp file so the rest
// of the server can keep treating every input as a local path. Callers must
// invoke the returned `cleanup` once the file is no longer needed.
const BASE64_PREFIX = "base64:";

interface MagicSignature {
  // All extensions that this signature is considered equivalent to. The first one is the
  // canonical form used for the tmp file suffix when none of the caller's allowedExtensions
  // match any variant.
  extensions: [string, ...string[]];
  prefix: Uint8Array;
  // If true, the prefix is text and may sit after a UTF-8 BOM (0xEF 0xBB 0xBF).
  allowsUtf8Bom?: boolean;
}
const MAGIC_SIGNATURES: MagicSignature[] = [
  { extensions: [".pdf"], prefix: Buffer.from("%PDF-") },
  { extensions: [".png"], prefix: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { extensions: [".jpg", ".jpeg"], prefix: Buffer.from([0xff, 0xd8, 0xff]) },
  { extensions: [".xml"], prefix: Buffer.from("<?xml"), allowsUtf8Bom: true },
];

function hasUtf8Bom(content: Buffer): boolean {
  return content.length >= 3 && content[0] === 0xEF && content[1] === 0xBB && content[2] === 0xBF;
}

function sniffExtensionFromBytes(content: Buffer, allowedExtensions: string[]): string | undefined {
  const bomPresent = hasUtf8Bom(content);
  for (const sig of MAGIC_SIGNATURES) {
    const offset = sig.allowsUtf8Bom && bomPresent ? 3 : 0;
    if (content.length - offset >= sig.prefix.length &&
        sig.prefix.every((byte, i) => content[offset + i] === byte)) {
      // Return the variant the caller declared, so `.jpg` magic can satisfy an allow-list
      // that only spelled `.jpeg`. Falls back to the canonical form otherwise.
      return sig.extensions.find(ext => allowedExtensions.includes(ext)) ?? sig.extensions[0];
    }
  }
  return undefined;
}

function canonicalExtension(ext: string): string {
  for (const sig of MAGIC_SIGNATURES) {
    if (sig.extensions.includes(ext)) return sig.extensions[0];
  }
  return ext;
}

function normalizeExtensionHint(hint: string): string {
  const trimmed = hint.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function decodeBase64Strict(encoded: string, maxSize?: number): Buffer {
  const cleaned = encoded.replace(/\s+/g, "");
  if (cleaned.length === 0) throw new Error("base64 payload is empty");
  // Bail out before Buffer.from allocates hundreds of MB for an obviously-oversized
  // payload. The exact decoded size is floor(length / 4) * 3 minus the number of `=`
  // padding chars — a naive "* 3 / 4" over-counts by up to 2 bytes and would falsely
  // reject uploads that sit exactly at maxSize when the byte count isn't divisible by 3.
  if (maxSize !== undefined) {
    const padCount = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
    const approxDecoded = Math.floor(cleaned.length / 4) * 3 - padCount;
    if (approxDecoded > maxSize) {
      throw new Error(`base64 payload too large: ~${(approxDecoded / 1024 / 1024).toFixed(1)} MB (max ${maxSize / 1024 / 1024} MB)`);
    }
  }
  // Node's Buffer.from tolerates partial garbage; re-encode and compare to catch corruption.
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length === 0 || buf.toString("base64").replace(/=+$/, "") !== cleaned.replace(/=+$/, "")) {
    throw new Error("base64 payload could not be decoded cleanly");
  }
  return buf;
}

async function materializeBase64Input(
  payload: string,
  allowedExtensions: string[],
  maxSize: number,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  // Strip the `base64:` prefix (already asserted by caller).
  const body = payload.slice(BASE64_PREFIX.length);

  let explicitExt: string | undefined;
  let b64Data: string;
  const firstColon = body.indexOf(":");
  // A short alphanumeric prefix ending in ":" is an extension hint (e.g. "csv:"/"xml:").
  // Base64's alphabet never contains ":", so the only way to see one here is a hint boundary;
  // the length/alphanumeric guards just keep obviously-bogus prefixes (like urls) from being
  // interpreted as file extensions.
  if (firstColon > 0 && firstColon <= 5 && /^[A-Za-z0-9]+$/.test(body.slice(0, firstColon))) {
    explicitExt = normalizeExtensionHint(body.slice(0, firstColon));
    b64Data = body.slice(firstColon + 1);
  } else {
    b64Data = body;
  }

  // Decode and size-check before writing anything to disk. decodeBase64Strict does an
  // approximate pre-decode check to avoid allocating huge buffers for garbage input;
  // after decode we re-validate the exact size.
  const decoded = decodeBase64Strict(b64Data, maxSize);
  if (decoded.length > maxSize) {
    throw new Error(`base64 payload too large: ${(decoded.length / 1024 / 1024).toFixed(1)} MB (max ${maxSize / 1024 / 1024} MB)`);
  }

  const detectedExt = sniffExtensionFromBytes(decoded, allowedExtensions);
  // Prefer the sniffed extension when both are available — sniffExtensionFromBytes already
  // picks the variant the caller declared (`.jpg` vs `.jpeg`), so the tmp file suffix matches
  // the caller's allow-list exactly. The explicit hint only kicks in for formats that have
  // no magic signature (CSV, TXT, etc.).
  const extension = detectedExt ?? explicitExt;
  if (!extension) {
    throw new Error(
      "Could not determine file type for base64 input. " +
      "Prefix the payload with an extension hint, e.g. \"base64:csv:<data>\" or \"base64:xml:<data>\".",
    );
  }
  // Allow `.jpg` magic to satisfy `.jpeg` in allowedExtensions and vice versa via canonicalization.
  const canonicalAllowed = new Set(allowedExtensions.map(canonicalExtension));
  if (!canonicalAllowed.has(canonicalExtension(extension))) {
    throw new Error(`base64 payload has disallowed extension ${extension}. Expected one of ${allowedExtensions.join("/")}.`);
  }
  if (explicitExt && detectedExt && canonicalExtension(explicitExt) !== canonicalExtension(detectedExt)) {
    throw new Error(`base64 extension hint ${explicitExt} conflicts with detected content type ${detectedExt}.`);
  }

  const dir = await mkdtemp(join(tmpdir(), "earveldaja-b64-"));
  const filePath = join(dir, `${randomUUID()}${extension}`);
  await writeFile(filePath, decoded, { mode: 0o600 });

  return {
    path: filePath,
    cleanup: async () => {
      try { await rm(dir, { recursive: true, force: true }); }
      catch { /* best-effort cleanup; tmpdir eviction will catch the rest */ }
    },
  };
}

export async function resolveFileInput(
  input: string,
  allowedExtensions: string[],
  maxSize: number,
): Promise<{ path: string; cleanup?: () => Promise<void> }> {
  if (typeof input === "string" && input.toLowerCase().startsWith(BASE64_PREFIX)) {
    return materializeBase64Input(input, allowedExtensions, maxSize);
  }
  const path = await validateFilePath(input, allowedExtensions, maxSize);
  return { path };
}
