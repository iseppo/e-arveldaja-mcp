import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "fs/promises";
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

async function validateFolderPath(folderPath: string): Promise<string> {
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
): Promise<ReceiptScanResult> {
  const resolvedFolder = await validateFolderPath(folderPath);
  const allowedExtensions = extensionsForTypes(fileTypes);
  const entries = await readdir(resolvedFolder, { withFileTypes: true });
  const files: ReceiptFileInfo[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;

    const extension = extname(entry.name).toLowerCase();
    if (!allowedExtensions.includes(extension)) continue;

    const fileType = extensionToFileType(extension);
    if (!fileType) continue;

    const candidatePath = join(resolvedFolder, entry.name);

    try {
      const validatedPath = await validateFilePath(candidatePath, allowedExtensions, MAX_RECEIPT_SIZE);
      const info = await stat(validatedPath);
      const modifiedAt = info.mtime.toISOString();
      const modifiedDate = modifiedAt.slice(0, 10);

      if ((dateFrom && modifiedDate < dateFrom) || (dateTo && modifiedDate > dateTo)) {
        continue;
      }

      files.push({
        name: entry.name,
        path: validatedPath,
        extension,
        file_type: fileType,
        size_bytes: info.size,
        modified_at: modifiedAt,
      });
    } catch (error) {
      skipped.push({
        name: entry.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    files,
    skipped,
    folder_path: resolvedFolder,
    total_candidates: files.length,
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
): Promise<ReceiptBatchSnapshot> {
  const scan = await scanReceiptFolderInternal(folderPath, fileTypes, dateFrom, dateTo);
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
  const snapshotDir = await mkdtemp(join(tmpdir(), "e-arveldaja-receipts-"));
  const removeSnapshotDir = () => rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
  try {
    const files: ReceiptFileSnapshot[] = [];
    // The stat-based pre-check above is a fast early reject; enforce the cap
    // again on the ACTUAL bytes read, cumulatively, so a file that grew
    // between scan and read (concurrent producer) cannot push the retained
    // in-memory buffers past the bound. Peak stays at cap + one ≤50 MB file.
    let readBytes = 0;
    for (const file of scan.files) {
      const bytes = await readFile(await revalidateReceiptFilePath(file));
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
      const snapshot_path = join(snapshotDir, `${files.length}${file.extension}`);
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
    return { scan, files, manifest, cleanup: removeSnapshotDir };
  } catch (error) {
    await removeSnapshotDir();
    throw error;
  }
}
