import { readFile, readdir, realpath, stat } from "fs/promises";
import { extname, join } from "path";
import {
  FILE_TYPE_EXTENSIONS,
  MAX_RECEIPT_SIZE,
  SUPPORTED_RECEIPT_EXTENSIONS,
  type FileType,
  type ReceiptFileInfo,
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
