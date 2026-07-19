import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { extname, join } from "path";
import { createHash } from "crypto";
import {
  FILE_TYPE_EXTENSIONS,
  MAX_RECEIPT_SIZE,
  MAX_RECEIPT_BATCH_TOTAL_SIZE,
  SUPPORTED_RECEIPT_EXTENSIONS,
  type FileType,
  type ReceiptApprovedManifestEntry,
  type ReceiptBatchSnapshot,
  type ReceiptFileInfo,
  type ReceiptFileSnapshot,
  type ReceiptScanResult,
} from "./receipt-inbox-types.js";
import { getAllowedRoots, isPathWithinRoot, resolveFilePath, validateFilePath } from "../file-validation.js";
import { FileReferenceStoreError } from "../file-reference-store.js";

export interface ReceiptDirectoryAccessOptions {
  /** Stored canonical identity for opaque-reference flows; direct paths omit it. */
  expectedCanonicalPath?: string;
  /** Testable seam for a retarget after caller revalidation but before helper validation. */
  beforeDirectoryValidation?: () => void | Promise<void>;
  /** Testable seam for a concurrent rename/retarget immediately after bind. */
  afterDirectoryBound?: () => void | Promise<void>;
  /** Testable seam after child validation but before its no-follow open. */
  beforeReceiptFileOpen?: (file: ReceiptFileInfo) => void | Promise<void>;
}

interface BoundReceiptDirectory {
  canonicalPath: string;
  accessPath: string;
  descriptorPath?: string;
  handle: FileHandle;
}

interface BoundReceiptScan {
  scan: ReceiptScanResult;
  descriptorPaths: Map<string, string>;
}

function sameFilesystemObject(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function receiptDirectoryChanged(): FileReferenceStoreError {
  return new FileReferenceStoreError("file_reference_path_changed");
}

async function assertReceiptDirectoryBinding(binding: BoundReceiptDirectory): Promise<void> {
  try {
    const [openedInfo, currentInfo] = await Promise.all([
      binding.handle.stat(),
      stat(binding.canonicalPath),
    ]);
    if (!openedInfo.isDirectory() || !currentInfo.isDirectory() ||
      !sameFilesystemObject(openedInfo, currentInfo)) {
      throw receiptDirectoryChanged();
    }
    if (binding.descriptorPath !== undefined &&
      await realpath(binding.descriptorPath) !== binding.canonicalPath) {
      throw receiptDirectoryChanged();
    }
  } catch (error) {
    if (error instanceof FileReferenceStoreError) throw error;
    throw receiptDirectoryChanged();
  }
}

/**
 * Bind the exact directory object, not merely its path string. Linux/macOS
 * descriptor paths keep all enumeration and reads relative to the retained
 * no-follow handle. If descriptor-relative access is unavailable, fail closed:
 * falling back to another pathname lookup would re-open the TOCTOU window.
 */
async function openBoundReceiptDirectory(
  folderPath: string,
  options: ReceiptDirectoryAccessOptions = {},
): Promise<BoundReceiptDirectory> {
  await options.beforeDirectoryValidation?.();
  const canonicalPath = await validateReceiptFolderPath(folderPath);
  if (options.expectedCanonicalPath !== undefined &&
    canonicalPath !== options.expectedCanonicalPath) {
    throw receiptDirectoryChanged();
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      canonicalPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const openedInfo = await handle.stat();
    if (!openedInfo.isDirectory()) throw receiptDirectoryChanged();

    let descriptorPath: string | undefined;
    for (const candidate of [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]) {
      try {
        if (await realpath(candidate) === canonicalPath) {
          descriptorPath = candidate;
          break;
        }
      } catch {
        // Try the next platform descriptor namespace.
      }
    }
    // Opaque references require descriptor-relative access: weakening them to
    // a second pathname lookup would recreate the exact path-retarget race the
    // reference is meant to close. Direct folder_path calls retain portable
    // support with an opened-object identity check before/after pathname work.
    if (!descriptorPath && options.expectedCanonicalPath !== undefined) {
      throw receiptDirectoryChanged();
    }

    const binding = {
      canonicalPath,
      accessPath: descriptorPath ?? canonicalPath,
      ...(descriptorPath !== undefined ? { descriptorPath } : {}),
      handle,
    };
    await assertReceiptDirectoryBinding(binding);
    await options.afterDirectoryBound?.();
    return binding;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof FileReferenceStoreError) throw error;
    throw receiptDirectoryChanged();
  }
}

export async function validateReceiptFolderPath(folderPath: string): Promise<string> {
  const resolved = resolveFilePath(folderPath);
  const real = await realpath(resolved);
  const roots = getAllowedRoots();

  if (!roots.some(root => isPathWithinRoot(real, root))) {
    throw new Error(
      `Folder path outside allowed directories. Allowed roots: ${roots.join(", ")}. ` +
      `Set EARVELDAJA_ALLOWED_PATHS to override.`,
    );
  }

  const info = await stat(real);
  if (!info.isDirectory()) {
    throw new Error("Not a directory");
  }

  return real;
}

function extensionsForTypes(fileTypes?: FileType[]): string[] {
  if (!fileTypes || fileTypes.length === 0) {
    return SUPPORTED_RECEIPT_EXTENSIONS;
  }

  const expanded = new Set<string>();
  for (const fileType of fileTypes) {
    for (const extension of FILE_TYPE_EXTENSIONS[fileType]) {
      expanded.add(extension);
    }
  }

  return [...expanded];
}

function extensionToFileType(extension: string): FileType | undefined {
  const normalized = extension.toLowerCase();
  if (normalized === ".pdf") return "pdf";
  if (normalized === ".jpg" || normalized === ".jpeg") return "jpg";
  if (normalized === ".png") return "png";
  return undefined;
}

export async function scanReceiptFolderInternal(
  folderPath: string,
  fileTypes?: FileType[],
  dateFrom?: string,
  dateTo?: string,
  accessOptions: ReceiptDirectoryAccessOptions = {},
): Promise<ReceiptScanResult> {
  const binding = await openBoundReceiptDirectory(folderPath, accessOptions);
  try {
    await assertReceiptDirectoryBinding(binding);
    const { scan } = await scanBoundReceiptDirectory(binding, fileTypes, dateFrom, dateTo);
    await assertReceiptDirectoryBinding(binding);
    return scan;
  } finally {
    await binding.handle.close().catch(() => {});
  }
}

async function scanBoundReceiptDirectory(
  binding: BoundReceiptDirectory,
  fileTypes?: FileType[],
  dateFrom?: string,
  dateTo?: string,
): Promise<BoundReceiptScan> {
  const allowedExtensions = extensionsForTypes(fileTypes);
  const entries = await readdir(binding.accessPath, { withFileTypes: true });
  const files: ReceiptFileInfo[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const descriptorPaths = new Map<string, string>();

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;

    const extension = extname(entry.name).toLowerCase();
    if (!allowedExtensions.includes(extension)) continue;

    const fileType = extensionToFileType(extension);
    if (!fileType) continue;

    const candidatePath = join(binding.accessPath, entry.name);

    try {
      await validateFilePath(candidatePath, allowedExtensions, MAX_RECEIPT_SIZE);
      const info = await stat(candidatePath);
      const modifiedAt = info.mtime.toISOString();
      const modifiedDate = modifiedAt.slice(0, 10);

      if ((dateFrom && modifiedDate < dateFrom) || (dateTo && modifiedDate > dateTo)) {
        continue;
      }

      files.push({
        name: entry.name,
        path: join(binding.canonicalPath, entry.name),
        extension,
        file_type: fileType,
        size_bytes: info.size,
        modified_at: modifiedAt,
      });
      descriptorPaths.set(entry.name, candidatePath);
    } catch (error) {
      skipped.push({
        name: entry.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    scan: {
      files,
      skipped,
      folder_path: binding.canonicalPath,
      total_candidates: files.length,
    },
    descriptorPaths,
  };
}

export async function revalidateReceiptFilePath(file: ReceiptFileInfo): Promise<string> {
  return validateFilePath(file.path, [file.extension], MAX_RECEIPT_SIZE);
}

export async function readValidatedReceiptFile(file: ReceiptFileInfo): Promise<Buffer> {
  const validatedPath = await revalidateReceiptFilePath(file);
  return readFile(validatedPath);
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

async function readBoundReceiptFile(
  binding: BoundReceiptDirectory,
  file: ReceiptFileInfo,
  candidatePath: string,
  accessOptions: ReceiptDirectoryAccessOptions,
): Promise<Buffer> {
  await accessOptions.beforeReceiptFileOpen?.(file);
  let handle: FileHandle | undefined;
  try {
    handle = await open(candidatePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || openedInfo.size > MAX_RECEIPT_SIZE) {
      throw receiptDirectoryChanged();
    }

    if (binding.descriptorPath !== undefined) {
      let openedCanonicalPath: string | undefined;
      for (const descriptorPath of [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]) {
        try {
          openedCanonicalPath = await realpath(descriptorPath);
          break;
        } catch {
          // Try the next platform descriptor namespace.
        }
      }
      const roots = getAllowedRoots();
      if (openedCanonicalPath !== file.path ||
        !roots.some(root => isPathWithinRoot(openedCanonicalPath, root))) {
        throw receiptDirectoryChanged();
      }
    }

    const bytes = await handle.readFile();
    if (bytes.length > MAX_RECEIPT_SIZE) throw receiptDirectoryChanged();
    return bytes;
  } catch (error) {
    if (error instanceof FileReferenceStoreError) throw error;
    throw receiptDirectoryChanged();
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Snapshot every scanned receipt's bytes ONCE into an isolated temp directory
 * and bind the batch to a SHA-256 manifest. Parsing and upload consume the
 * immutable snapshot bytes, so a file replaced/added/removed between the
 * dry-run preview and the create/confirm run cannot slip past the operator's
 * approval. When `approvedManifest` is supplied, any drift from it throws
 * `manifest_mismatch` BEFORE any API mutation. Callers MUST invoke
 * `cleanup()` (in a `finally`) to remove the temp snapshot.
 *
 * Bounded: the whole batch is held in memory and duplicated on temp disk at
 * once, so an aggregate over `MAX_RECEIPT_BATCH_TOTAL_SIZE` is refused up front
 * (`batch_too_large`) before any allocation. Cleanup is best-effort — a failed
 * temp removal must never mask a completed accounting mutation upstream.
 */
export async function prepareReceiptBatchSnapshot(
  folderPath: string,
  fileTypes?: FileType[],
  dateFrom?: string,
  dateTo?: string,
  approvedManifest?: readonly ReceiptApprovedManifestEntry[],
  accessOptions: ReceiptDirectoryAccessOptions = {},
): Promise<ReceiptBatchSnapshot> {
  const binding = await openBoundReceiptDirectory(folderPath, accessOptions);
  try {
    await assertReceiptDirectoryBinding(binding);
    const boundScan = await scanBoundReceiptDirectory(binding, fileTypes, dateFrom, dateTo);
    const scan = boundScan.scan;
    const totalBytes = scan.files.reduce((sum, file) => sum + file.size_bytes, 0);
    if (totalBytes > MAX_RECEIPT_BATCH_TOTAL_SIZE) {
      throw Object.assign(
        new Error(
          `Receipt batch total size ${totalBytes} bytes exceeds the ${MAX_RECEIPT_BATCH_TOTAL_SIZE}-byte limit. ` +
          `Split the folder into smaller batches.`,
        ),
        {
          category: "batch_too_large",
          total_bytes: totalBytes,
          max_total_bytes: MAX_RECEIPT_BATCH_TOTAL_SIZE,
          file_count: scan.files.length,
        },
      );
    }
    const createdSnapshotDir = await mkdtemp(join(tmpdir(), "e-arveldaja-receipts-"));
    const removeSnapshotDir = () => rm(createdSnapshotDir, { recursive: true, force: true }).catch(() => {});
    try {
      const files: ReceiptFileSnapshot[] = [];
      // The stat-based pre-check above is a fast early reject; enforce the cap
      // again on the ACTUAL bytes read, cumulatively, so a file that grew
      // between scan and read (concurrent producer) cannot push the retained
      // in-memory buffers past the bound. Peak stays at cap + one ≤50 MB file.
      let readBytes = 0;
      for (const file of scan.files) {
        const descriptorPath = boundScan.descriptorPaths.get(file.name);
        if (!descriptorPath) throw receiptDirectoryChanged();
        const bytes = await readBoundReceiptFile(binding, file, descriptorPath, accessOptions);
        readBytes += bytes.length;
        if (readBytes > MAX_RECEIPT_BATCH_TOTAL_SIZE) {
          throw Object.assign(
            new Error(
              `Receipt batch bytes read (${readBytes}) exceed the ${MAX_RECEIPT_BATCH_TOTAL_SIZE}-byte limit. ` +
              `Split the folder into smaller batches.`,
            ),
            {
              category: "batch_too_large",
              total_bytes: readBytes,
              max_total_bytes: MAX_RECEIPT_BATCH_TOTAL_SIZE,
              file_count: scan.files.length,
            },
          );
        }
        const relative_path = file.name;
        const sha256 = sha256Hex(bytes);
        const snapshot_path = join(createdSnapshotDir, `${files.length}${file.extension}`);
        await writeFile(snapshot_path, bytes, { mode: 0o600 });
        // Keep the ORIGINAL validated folder path in file.path (downstream
        // review/booking may reference it); the immutable copy is snapshot_path.
        files.push({ file, relative_path, sha256, bytes, snapshot_path });
      }
      const manifest = files
        .map(({ relative_path, sha256 }) => ({ relative_path, sha256 }))
        .sort((a, b) => a.relative_path.localeCompare(b.relative_path));
      if (approvedManifest) {
        const approved = [...approvedManifest].sort((a, b) => a.relative_path.localeCompare(b.relative_path));
        if (JSON.stringify(manifest) !== JSON.stringify(approved)) {
          throw Object.assign(
            new Error("Receipt folder differs from the approved manifest"),
            { category: "manifest_mismatch", approved_manifest: approved, current_manifest: manifest },
          );
        }
      }
      // Do not publish or execute from the snapshot if the canonical directory
      // name was retargeted at any point after the descriptor was opened.
      await assertReceiptDirectoryBinding(binding);
      return { scan, files, manifest, cleanup: removeSnapshotDir };
    } catch (error) {
      await removeSnapshotDir();
      throw error;
    }
  } finally {
    await binding.handle.close().catch(() => {});
  }
}
