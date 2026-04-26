import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { installStderrTee, _resetStderrTeeForTesting } from "./stderr-tee.js";

let tmpDir: string;
let originalWrite: typeof process.stderr.write;

beforeEach(() => {
  originalWrite = process.stderr.write.bind(process.stderr);
  tmpDir = mkdtempSync(join(tmpdir(), "stderr-tee-test-"));
});

afterEach(() => {
  _resetStderrTeeForTesting(originalWrite);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("installStderrTee", () => {
  it("is a no-op when EARVELDAJA_LOG_FILE is unset", () => {
    expect(installStderrTee({}).enabled).toBe(false);
  });

  it("is a no-op when EARVELDAJA_LOG_FILE is empty/whitespace", () => {
    expect(installStderrTee({ EARVELDAJA_LOG_FILE: "   " }).enabled).toBe(false);
  });

  it("opens the file, writes the open stamp, and tees string/Buffer/Uint8Array", () => {
    const path = join(tmpDir, "tee.log");
    const r = installStderrTee({ EARVELDAJA_LOG_FILE: path });
    expect(r.enabled).toBe(true);
    expect(r.path).toBe(path);

    process.stderr.write("hello\n");
    process.stderr.write(Buffer.from("buf\n"));
    process.stderr.write(new Uint8Array([0x55, 0x38, 0x0a])); // "U8\n"

    const contents = readFileSync(path, "utf8");
    expect(contents).toMatch(/--- e-arveldaja-mcp stderr tee opened .* \(pid \d+\) ---/);
    expect(contents).toContain("hello\n");
    expect(contents).toContain("buf\n");
    expect(contents).toContain("U8\n");
  });

  it("supports (chunk, cb) and (chunk, encoding, cb) overloads", () => {
    const path = join(tmpDir, "overloads.log");
    installStderrTee({ EARVELDAJA_LOG_FILE: path });
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    expect(() => process.stderr.write("a\n", cb1)).not.toThrow();
    expect(() => process.stderr.write("b\n", "utf8", cb2)).not.toThrow();
    const contents = readFileSync(path, "utf8");
    expect(contents).toContain("a\n");
    expect(contents).toContain("b\n");
  });

  it("creates the file with mode 0o600 on POSIX and appends across reopens", () => {
    const path = join(tmpDir, "append.log");
    installStderrTee({ EARVELDAJA_LOG_FILE: path });
    process.stderr.write("first\n");
    if (process.platform !== "win32") {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    _resetStderrTeeForTesting(originalWrite);
    installStderrTee({ EARVELDAJA_LOG_FILE: path });
    process.stderr.write("second\n");
    const contents = readFileSync(path, "utf8");
    expect(contents).toContain("first\n");
    expect(contents).toContain("second\n");
    expect((contents.match(/stderr tee opened/g) ?? []).length).toBe(2);
  });

  it("returns enabled=false when the path cannot be opened", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = installStderrTee({ EARVELDAJA_LOG_FILE: join(tmpDir, "no-such-dir", "nope.log") });
    spy.mockRestore();
    expect(r.enabled).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("refuses non-regular file targets (FIFO)", () => {
    if (process.platform === "win32") return;
    const fifoPath = join(tmpDir, "pipe");
    try {
      execSync(`mkfifo "${fifoPath}"`, { stdio: "ignore" });
    } catch {
      return;
    }
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = installStderrTee({ EARVELDAJA_LOG_FILE: fifoPath });
    spy.mockRestore();
    expect(r.enabled).toBe(false);
    expect(r.error).toMatch(/regular file/);
  });

  it("refuses /dev/stdout so it cannot clobber the MCP stdio transport", () => {
    if (process.platform === "win32") return;
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = installStderrTee({ EARVELDAJA_LOG_FILE: "/dev/stdout" });
    spy.mockRestore();
    expect(r.enabled).toBe(false);
    expect(r.error).toMatch(/regular file/);
  });

  it("is idempotent — second call does not re-install or duplicate the open stamp", () => {
    const path = join(tmpDir, "idempotent.log");
    expect(installStderrTee({ EARVELDAJA_LOG_FILE: path }).enabled).toBe(true);
    expect(installStderrTee({ EARVELDAJA_LOG_FILE: path }).enabled).toBe(true);
    process.stderr.write("once\n");
    const contents = readFileSync(path, "utf8");
    expect((contents.match(/stderr tee opened/g) ?? []).length).toBe(1);
    expect(contents).toContain("once\n");
  });
});
