import { link, mkdir, open, rm, writeFile } from "node:fs/promises";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface OwnerToken { pid: number; nonce: string; createdAt: string }
export type ObservedOwner = { kind: "valid"; token: OwnerToken } | { kind: "invalid" };
export interface LockOptions { timeoutMs?: number; pollMs?: number }
export interface OwnedFileLock { token: OwnerToken; release(): Promise<void> }

export class LockBusyError extends Error {
  readonly category = "lock_busy" as const;
  readonly mutationMayHaveOccurred = false;
  readonly nextAction: string;

  constructor(readonly lockPath: string, readonly timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for lock ${lockPath}.`);
    this.name = "LockBusyError";
    this.nextAction = `If no e-arveldaja process owns ${lockPath}, inspect its owner token before manual removal.`;
  }
}

export function parseOwner(text: string): ObservedOwner {
  try {
    const value = JSON.parse(text) as Partial<OwnerToken>;
    if (!Number.isInteger(value.pid) || (value.pid ?? 0) <= 0) return { kind: "invalid" };
    if (typeof value.nonce !== "string" || value.nonce.length === 0) return { kind: "invalid" };
    if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
      return { kind: "invalid" };
    }
    return { kind: "valid", token: value as OwnerToken };
  } catch {
    return { kind: "invalid" };
  }
}

export function ownerDefinitelyDead(owner: ObservedOwner): boolean {
  if (owner.kind !== "valid") return false;
  try {
    process.kill(owner.token.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    const handle = await open(path, "r");
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function publishOwnedPath(path: string, text: string): Promise<boolean> {
  const candidate = `${path}.${process.pid}.${randomUUID()}.candidate`;
  await writeFile(candidate, text, { flag: "wx", mode: 0o600 });
  try {
    await link(candidate, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(candidate, { force: true });
  }
}

async function releaseIfOwned(path: string, ownerText: string): Promise<void> {
  if (await readText(path) === ownerText) await rm(path, { force: true });
}

function validateOptions(options: LockOptions): { timeoutMs: number; pollMs: number } {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 25;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError("timeoutMs must be finite and non-negative");
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new RangeError("pollMs must be finite and positive");
  return { timeoutMs, pollMs };
}

async function pause(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export async function acquireOwnedFileLock(
  lockPath: string,
  options: LockOptions = {},
): Promise<OwnedFileLock> {
  const { timeoutMs, pollMs } = validateOptions(options);
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token: OwnerToken = { pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() };
  const ownerText = JSON.stringify(token);

  while (true) {
    if (await publishOwnedPath(lockPath, ownerText)) {
      let released = false;
      return {
        token,
        async release() {
          if (released) return;
          released = true;
          await releaseIfOwned(lockPath, ownerText);
        },
      };
    }

    const observedText = await readText(lockPath);
    const observed = observedText === undefined ? { kind: "invalid" } as const : parseOwner(observedText);
    if (observedText !== undefined && observed.kind === "valid" && ownerDefinitelyDead(observed)) {
      const reclaimPath = `${lockPath}.reclaim`;
      if (await publishOwnedPath(reclaimPath, ownerText)) {
        try {
          const current = await readText(lockPath);
          if (current === observedText && ownerDefinitelyDead(parseOwner(current))) {
            await rm(lockPath, { force: true });
            continue;
          }
        } finally {
          await releaseIfOwned(reclaimPath, ownerText);
        }
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new LockBusyError(lockPath, timeoutMs);
    await pause(Math.min(pollMs, remaining));
  }
}

const queueTails = new Map<string, Promise<void>>();

async function waitForPredecessor(
  predecessor: Promise<void>,
  deadline: number,
  lockPath: string,
  timeoutMs: number,
): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new LockBusyError(lockPath, timeoutMs);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      predecessor.catch(() => undefined),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LockBusyError(lockPath, timeoutMs)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Synchronous owned file lock (same cross-process protocol as the async lock)
// ---------------------------------------------------------------------------
//
// Some call sites (audit logging) are synchronous by contract and must not
// consume a Promise as a lock. This mirrors acquireOwnedFileLock's policy
// exactly — hard-link publish, strict owner parsing, ESRCH-only reclaim of a
// definitely-dead owner via a guarded reclaim path, invalid/live owners stay
// busy — but blocks the thread synchronously. Within a single process the JS
// event loop already serializes sync sections; the file lock adds cross-process
// mutual exclusion.

// Backing cell for Atomics.wait. Its value is never changed (no notifier
// exists), so Atomics.wait always blocks for the full requested timeout and
// then returns "timed-out" — a CPU-friendly synchronous sleep. Node permits
// Atomics.wait on the main thread.
const syncWaitCell = new Int32Array(new SharedArrayBuffer(4));

function readTextSync(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function publishOwnedPathSync(path: string, text: string): boolean {
  const candidate = `${path}.${process.pid}.${randomUUID()}.candidate`;
  writeFileSync(candidate, text, { flag: "wx", mode: 0o600 });
  try {
    linkSync(candidate, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(candidate, { force: true });
  }
}

function releaseIfOwnedSync(path: string, ownerText: string): void {
  if (readTextSync(path) === ownerText) rmSync(path, { force: true });
}

function sleepSync(ms: number): void {
  Atomics.wait(syncWaitCell, 0, 0, ms);
}

export function withOwnedFileLockSync<T>(
  lockPath: string,
  fn: () => T,
  options: LockOptions = {},
): T {
  const { timeoutMs, pollMs } = validateOptions(options);
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token: OwnerToken = { pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() };
  const ownerText = JSON.stringify(token);

  while (true) {
    if (publishOwnedPathSync(lockPath, ownerText)) {
      try {
        return fn();
      } finally {
        releaseIfOwnedSync(lockPath, ownerText);
      }
    }

    const observedText = readTextSync(lockPath);
    const observed = observedText === undefined ? { kind: "invalid" } as const : parseOwner(observedText);
    if (observedText !== undefined && observed.kind === "valid" && ownerDefinitelyDead(observed)) {
      const reclaimPath = `${lockPath}.reclaim`;
      if (publishOwnedPathSync(reclaimPath, ownerText)) {
        try {
          const current = readTextSync(lockPath);
          if (current !== undefined && current === observedText && ownerDefinitelyDead(parseOwner(current))) {
            rmSync(lockPath, { force: true });
            continue;
          }
        } finally {
          releaseIfOwnedSync(reclaimPath, ownerText);
        }
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new LockBusyError(lockPath, timeoutMs);
    sleepSync(Math.min(pollMs, remaining));
  }
}

export async function withOwnedFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const normalized = validateOptions(options);
  const deadline = Date.now() + normalized.timeoutMs;
  const predecessor = queueTails.get(lockPath) ?? Promise.resolve();
  let finish!: () => void;
  const ownDone = new Promise<void>(resolve => { finish = resolve; });
  const ownTail = predecessor.catch(() => undefined).then(() => ownDone);
  queueTails.set(lockPath, ownTail);

  let lock: OwnedFileLock | undefined;
  try {
    await waitForPredecessor(predecessor, deadline, lockPath, normalized.timeoutMs);
    const remaining = Math.max(0, deadline - Date.now());
    lock = await acquireOwnedFileLock(lockPath, { timeoutMs: remaining, pollMs: normalized.pollMs });
    return await fn();
  } finally {
    try {
      if (lock) await lock.release();
    } finally {
      finish();
      if (queueTails.get(lockPath) === ownTail) {
        void ownTail.finally(() => {
          if (queueTails.get(lockPath) === ownTail) queueTails.delete(lockPath);
        });
      }
    }
  }
}
