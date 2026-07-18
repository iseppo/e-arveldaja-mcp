import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LockBusyError,
  acquireOwnedFileLock,
  ownerDefinitelyDead,
  parseOwner,
  withOwnedFileLock,
  withOwnedFileLockSync,
  type OwnerToken,
} from "./file-lock.js";

const dirs: string[] = [];
async function lockPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "h06-lock-"));
  dirs.push(dir);
  return join(dir, "key.lock");
}
async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}
const deadOwner = (): OwnerToken => ({ pid: 2_147_483_646, nonce: "dead", createdAt: new Date().toISOString() });

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("H06-B owned file lock", () => {
  it("H06-B publishes only a complete 0600 owner token", async () => {
    const path = await lockPath();
    const lock = await acquireOwnedFileLock(path);
    const text = await readFile(path, "utf8");
    expect(parseOwner(text)).toEqual({ kind: "valid", token: lock.token });
    expect((await stat(path)).mode & 0o077).toBe(0);
    await lock.release();
  });

  it("H06-B parses strictly and proves only ESRCH owners dead", () => {
    const dead = deadOwner();
    expect(parseOwner("not-json")).toEqual({ kind: "invalid" });
    expect(parseOwner(JSON.stringify(dead))).toEqual({ kind: "valid", token: dead });
    expect(ownerDefinitelyDead(parseOwner(JSON.stringify(dead)))).toBe(true);
    expect(ownerDefinitelyDead(parseOwner(JSON.stringify({ ...dead, pid: process.pid })))).toBe(false);
  });

  it("H06-B reclaims a definitely dead main owner", async () => {
    const path = await lockPath();
    await writeFile(path, JSON.stringify(deadOwner()), { mode: 0o600 });
    const lock = await acquireOwnedFileLock(path, { timeoutMs: 200, pollMs: 5 });
    expect((parseOwner(await readFile(path, "utf8")) as { kind: "valid"; token: OwnerToken }).token.nonce)
      .toBe(lock.token.nonce);
    await lock.release();
  });

  it.each([
    "", "not-json", "{\"pid\":1", JSON.stringify({ ...deadOwner(), pid: 0 }),
    JSON.stringify({ ...deadOwner(), nonce: "" }), JSON.stringify({ ...deadOwner(), createdAt: "bad" }),
  ])("H06-B leaves invalid owner unchanged and reports stable busy metadata: %j", async text => {
    const path = await lockPath();
    await writeFile(path, text, { mode: 0o600 });
    await expect(acquireOwnedFileLock(path, { timeoutMs: 20, pollMs: 2 })).rejects.toMatchObject({
      category: "lock_busy", mutationMayHaveOccurred: false, lockPath: path,
    });
    expect(await readFile(path, "utf8")).toBe(text);
  });

  it("H06-B keeps live and EPERM owners busy", async () => {
    const path = await lockPath();
    const live = JSON.stringify({ ...deadOwner(), pid: process.pid });
    await writeFile(path, live, { mode: 0o600 });
    await expect(acquireOwnedFileLock(path, { timeoutMs: 10, pollMs: 2 })).rejects.toBeInstanceOf(LockBusyError);
    expect(await readFile(path, "utf8")).toBe(live);
    await writeFile(path, JSON.stringify(deadOwner()));
    vi.spyOn(process, "kill").mockImplementation(() => { const e = new Error("denied") as NodeJS.ErrnoException; e.code = "EPERM"; throw e; });
    await expect(acquireOwnedFileLock(path, { timeoutMs: 10, pollMs: 2 })).rejects.toBeInstanceOf(LockBusyError);
  });

  it("H06-B serializes two reclaimers", async () => {
    const path = await lockPath();
    await writeFile(path, JSON.stringify(deadOwner()));
    let resolved = 0;
    const contenders = [
      acquireOwnedFileLock(path, { timeoutMs: 500, pollMs: 2 }),
      acquireOwnedFileLock(path, { timeoutMs: 500, pollMs: 2 }),
    ].map((promise, index) => promise.then(lock => {
      resolved += 1;
      return { index, lock };
    }));
    const winner = await Promise.race(contenders);
    expect(resolved).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(resolved).toBe(1);
    await winner.lock.release();
    const loser = await contenders[1 - winner.index]!;
    expect(loser.index).not.toBe(winner.index);
    expect(resolved).toBe(2);
    await loser.lock.release();
  });

  it.each(["malformed", "live", "dead"])("H06-B never auto-reclaims an existing %s reclaim guard", async kind => {
    const path = await lockPath();
    const main = JSON.stringify(deadOwner());
    const reclaim = kind === "malformed" ? "bad" : JSON.stringify({ ...deadOwner(), pid: kind === "live" ? process.pid : deadOwner().pid });
    await writeFile(path, main);
    await writeFile(`${path}.reclaim`, reclaim);
    await expect(acquireOwnedFileLock(path, { timeoutMs: 20, pollMs: 2 })).rejects.toBeInstanceOf(LockBusyError);
    expect(await readFile(path, "utf8")).toBe(main);
    expect(await readFile(`${path}.reclaim`, "utf8")).toBe(reclaim);
    await rm(`${path}.reclaim`);
    const lock = await acquireOwnedFileLock(path, { timeoutMs: 200, pollMs: 2 });
    await lock.release();
  });

  it("H06-B releases idempotently without deleting a foreign replacement", async () => {
    const path = await lockPath();
    const lock = await acquireOwnedFileLock(path);
    await lock.release();
    await lock.release();
    expect(await exists(path)).toBe(false);
    const another = await acquireOwnedFileLock(path);
    const foreign = JSON.stringify({ ...deadOwner(), nonce: "foreign" });
    await writeFile(path, foreign);
    await another.release();
    expect(await readFile(path, "utf8")).toBe(foreign);
  });

  it("H06-B executes queued callbacks FIFO", async () => {
    const path = await lockPath();
    const order: number[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const a = withOwnedFileLock(path, async () => { order.push(1); await held; });
    const b = withOwnedFileLock(path, async () => { order.push(2); });
    const c = withOwnedFileLock(path, async () => { order.push(3); });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(order).toEqual([1]);
    release();
    await Promise.all([a, b, c]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("H06-B rejection releases and advances the FIFO", async () => {
    const path = await lockPath();
    const order: number[] = [];
    const a = withOwnedFileLock(path, async () => { order.push(1); throw new Error("boom"); });
    const b = withOwnedFileLock(path, async () => { order.push(2); return 2; });
    await expect(a).rejects.toThrow("boom");
    await expect(b).resolves.toBe(2);
    expect(order).toEqual([1, 2]);
    expect(await exists(path)).toBe(false);
  });

  it("H06-B advances the FIFO even when releasing the predecessor fails", async () => {
    const path = await lockPath();
    let letFirstReturn!: () => void;
    let firstEntered!: () => void;
    const returnGate = new Promise<void>(resolve => { letFirstReturn = resolve; });
    const entered = new Promise<void>(resolve => { firstEntered = resolve; });
    const first = withOwnedFileLock(path, async () => {
      firstEntered();
      await returnGate;
      await rm(path);
      await mkdir(path);
    }, { timeoutMs: 500, pollMs: 2 });
    await entered;
    const second = withOwnedFileLock(path, async () => "second", { timeoutMs: 200, pollMs: 2 });
    letFirstReturn();
    await expect(first).rejects.toMatchObject({ code: "EISDIR" });
    await expect(second).rejects.toSatisfy(
      error => (error as NodeJS.ErrnoException).code === "EISDIR" && !(error instanceof LockBusyError),
    );
  });

  it("H06-B queued timeout uses the total entry deadline and does not poison successors", async () => {
    const path = await lockPath();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = withOwnedFileLock(path, () => held, { timeoutMs: 500, pollMs: 2 });
    let ran = false;
    const started = Date.now();
    const timed = withOwnedFileLock(path, async () => { ran = true; }, { timeoutMs: 25, pollMs: 2 });
    const later = withOwnedFileLock(path, async () => "later", { timeoutMs: 500, pollMs: 2 });
    await expect(timed).rejects.toBeInstanceOf(LockBusyError);
    expect(Date.now() - started).toBeLessThan(200);
    expect(ran).toBe(false);
    release();
    await first;
    await expect(later).resolves.toBe("later");
  });
});

describe("M17 synchronous owned file lock", () => {
  it("keeps a malformed owner busy without replacing it", async () => {
    const path = await lockPath();
    await writeFile(path, "not-json", { mode: 0o600 });
    expect(() => withOwnedFileLockSync(path, () => "ran", { timeoutMs: 20, pollMs: 2 }))
      .toThrow(LockBusyError);
    expect(await readFile(path, "utf8")).toBe("not-json");
  });

  it("reclaims a definitely-dead owner and runs the callback", async () => {
    const path = await lockPath();
    await writeFile(path, JSON.stringify(deadOwner()), { mode: 0o600 });
    const result = withOwnedFileLockSync(path, () => "ran", { timeoutMs: 200, pollMs: 5 });
    expect(result).toBe("ran");
  });

  it("keeps a live owner busy without replacing it", async () => {
    const path = await lockPath();
    const live = JSON.stringify({ ...deadOwner(), pid: process.pid });
    await writeFile(path, live, { mode: 0o600 });
    expect(() => withOwnedFileLockSync(path, () => "ran", { timeoutMs: 10, pollMs: 2 }))
      .toThrow(LockBusyError);
    expect(await readFile(path, "utf8")).toBe(live);
  });

  it("releases its own token after the callback throws", async () => {
    const path = await lockPath();
    expect(() => withOwnedFileLockSync(path, () => { throw new Error("boom"); }))
      .toThrow("boom");
    // Lock released → a fresh acquisition succeeds and the file holds our token.
    const observed = withOwnedFileLockSync(path, () => readFileSync(path, "utf8"), { timeoutMs: 200, pollMs: 5 });
    expect(parseOwner(observed)).toMatchObject({ kind: "valid" });
  });
});
