import { open, type FileHandle } from "node:fs/promises";

export const FILE_CHANGED_WHILE_READING_MESSAGE =
  "File changed while reading; retry once it is no longer being written";

export function fileTooLargeMessage(sizeBytes: number, maxBytes: number): string {
  return `File too large: ${(sizeBytes / 1024 / 1024).toFixed(1)} MB (max ${maxBytes / 1024 / 1024} MB)`;
}

/**
 * Read an already-open file from offset 0 into an exact-size buffer of
 * `min(size, maxBytes)` bytes plus a one-byte probe past the end, so at most
 * `maxBytes + 1` bytes are ever read. A separate `stat` size check cannot bound the read:
 * the file may grow between the check and the read (TOCTOU). Throws the same
 * "File too large" error as `validateFilePath` when the content exceeds
 * `maxBytes`. The handle is `fstat`ed before and after the read; a changed
 * size or mtime, content past the original size, or a byte count that differs from the final size,
 * throws "File changed while reading" instead of returning a torn mix of old
 * and new content. The returned buffer is exactly the bytes read.
 */
export async function readFileHandleCapped(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const before = await handle.stat();
  // Exact-size allocation from fstat (allocUnsafeSlow: no shared-pool slice),
  // so the returned buffer retains no extra memory.
  const buffer = Buffer.allocUnsafeSlow(Math.min(before.size, maxBytes));
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  // Probe one byte past the expected end to detect content beyond it.
  const { bytesRead: extra } = total === buffer.length
    ? await handle.read(Buffer.alloc(1), 0, 1, total)
    : { bytesRead: 0 };
  const after = await handle.stat();
  if (total + extra > maxBytes) {
    throw new Error(fileTooLargeMessage(Math.max(after.size, total + extra), maxBytes));
  }
  if (extra !== 0 || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
    total !== after.size) {
    throw new Error(FILE_CHANGED_WHILE_READING_MESSAGE);
  }
  return buffer;
}

/** Open `path` read-only and read it with {@link readFileHandleCapped}. */
export async function readFileCapped(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    return await readFileHandleCapped(handle, maxBytes);
  } finally {
    await handle.close();
  }
}
