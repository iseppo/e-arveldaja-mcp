import { open, type FileHandle } from "node:fs/promises";

const READ_CHUNK_SIZE = 1024 * 1024;

export function fileTooLargeMessage(sizeBytes: number, maxBytes: number): string {
  return `File too large: ${(sizeBytes / 1024 / 1024).toFixed(1)} MB (max ${maxBytes / 1024 / 1024} MB)`;
}

/**
 * Read an already-open file from offset 0, never buffering more than
 * `maxBytes + 1` bytes. A separate `stat` size check cannot bound the read:
 * the file may grow between the check and the read (TOCTOU). Throws the same
 * "File too large" error as `validateFilePath` when the content exceeds
 * `maxBytes`; the returned buffer is exactly the bytes read.
 */
export async function readFileHandleCapped(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_SIZE, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
    if (total > maxBytes) {
      const { size } = await handle.stat();
      throw new Error(fileTooLargeMessage(Math.max(size, total), maxBytes));
    }
  }
  return Buffer.concat(chunks, total);
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
