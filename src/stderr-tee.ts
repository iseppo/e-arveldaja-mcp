import { openSync, writeSync, closeSync, fstatSync, statSync } from "node:fs";
import { resolve } from "node:path";

let installed = false;
let fd: number | null = null;
let exitHandler: (() => void) | null = null;

export interface StderrTeeResult {
  enabled: boolean;
  path?: string;
  error?: string;
}

/**
 * If EARVELDAJA_LOG_FILE is set, tee everything written to process.stderr
 * into that file (append mode). Cross-platform: uses Node fs primitives,
 * works on Linux, macOS, and Windows. No-op when the env var is unset.
 *
 * Safe to call multiple times — only the first call installs the hook.
 */
export function installStderrTee(env: NodeJS.ProcessEnv = process.env): StderrTeeResult {
  if (installed) return { enabled: fd !== null };
  installed = true;

  const raw = env.EARVELDAJA_LOG_FILE;
  if (!raw || raw.trim() === "") return { enabled: false };

  const path = resolve(raw);

  // Pre-open guard: if the path already exists and is NOT a regular file,
  // refuse before opening. Opening a FIFO with `O_APPEND` would block until
  // a reader appears, and pointing the tee at /dev/stdout, /proc/self/fd/*,
  // or a character device could corrupt the MCP stdio transport (which uses
  // stdout) or stall the event loop on a blocking write. Cross-platform:
  // statSync follows symlinks so /dev/stdout (symlink → char device) is
  // caught here.
  const REGULAR_FILE_REQUIRED =
    "EARVELDAJA_LOG_FILE must point at a regular file (refusing pipes, devices, sockets, /dev/stdout, /proc/self/fd/*)";
  try {
    const pre = statSync(path, { throwIfNoEntry: false });
    if (pre && !pre.isFile()) {
      process.stderr.write(`WARNING: ${REGULAR_FILE_REQUIRED}: ${path}\n`);
      return { enabled: false, path, error: REGULAR_FILE_REQUIRED };
    }
  } catch (err) {
    // statSync with throwIfNoEntry:false only throws on permission errors etc.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`WARNING: EARVELDAJA_LOG_FILE stat failed (${path}): ${message}\n`);
    return { enabled: false, path, error: message };
  }

  let openedFd: number;
  try {
    // 'a' = append, create if missing. 0o600 so secrets aren't world-readable.
    openedFd = openSync(path, "a", 0o600);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`WARNING: EARVELDAJA_LOG_FILE could not be opened (${path}): ${message}\n`);
    return { enabled: false, path, error: message };
  }

  // Post-open verification belt-and-braces: if the path was a regular file at
  // pre-open and got swapped (TOCTOU), the fstat catches it before we tee.
  try {
    const st = fstatSync(openedFd);
    if (!st.isFile()) {
      try { closeSync(openedFd); } catch { /* ignore */ }
      process.stderr.write(`WARNING: ${REGULAR_FILE_REQUIRED}: ${path}\n`);
      return { enabled: false, path, error: REGULAR_FILE_REQUIRED };
    }
  } catch (err) {
    try { closeSync(openedFd); } catch { /* ignore */ }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`WARNING: EARVELDAJA_LOG_FILE fstat failed (${path}): ${message}\n`);
    return { enabled: false, path, error: message };
  }

  fd = openedFd;

  const writeAll = (targetFd: number, buf: Buffer): void => {
    let offset = 0;
    while (offset < buf.length) {
      const n = writeSync(targetFd, buf, offset, buf.length - offset);
      if (n <= 0) break; // pathological; bail rather than spin
      offset += n;
    }
  };

  const originalWrite = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    try {
      if (fd !== null) {
        const buf =
          typeof chunk === "string"
            ? Buffer.from(
                chunk,
                typeof encodingOrCb === "string" ? encodingOrCb : "utf8",
              )
            : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        writeAll(fd, buf);
      }
    } catch {
      // Never let logging failures break the server.
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalWrite as any)(chunk, encodingOrCb as any, cb as any);
  };

  const close = () => {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
      fd = null;
    }
  };
  process.on("exit", close);
  exitHandler = close;

  // Stamp open so a fresh tail makes sense.
  try {
    writeAll(openedFd, Buffer.from(`--- e-arveldaja-mcp stderr tee opened ${new Date().toISOString()} (pid ${process.pid}) ---\n`));
  } catch { /* ignore */ }

  return { enabled: true, path };
}

/**
 * Test-only: tear down the installed tee and reset state so unit tests can
 * exercise installStderrTee() repeatedly with different envs. Restores the
 * original process.stderr.write reference if one was captured.
 *
 * NOTE: do not call from production code paths.
 */
export function _resetStderrTeeForTesting(restoreWrite?: typeof process.stderr.write): void {
  if (fd !== null) {
    try { closeSync(fd); } catch { /* ignore */ }
    fd = null;
  }
  if (exitHandler) {
    try { process.removeListener("exit", exitHandler); } catch { /* ignore */ }
    exitHandler = null;
  }
  if (restoreWrite) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = restoreWrite;
  }
  installed = false;
}
