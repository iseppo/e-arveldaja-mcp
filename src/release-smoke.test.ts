import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  assertPackedBinIsExecutable,
  buildPackedSmokePlan,
  runCommand,
  startAndObserve,
  terminateChild,
  validatePackedFileList,
} from "../scripts/release-smoke-helpers.mjs";

const validPackage = {
  name: "e-arveldaja-mcp",
  main: "dist/index.js",
  bin: { "e-arveldaja-mcp": "dist/index.js" },
};

describe("validatePackedFileList", () => {
  it("accepts a payload that carries entry, bin, workflows, and command mirrors", () => {
    const files = [
      "package/package.json",
      "package/dist/index.js",
      "package/workflows/receipt-batch.md",
      "package/.claude/commands/receipt-batch.md",
    ];
    expect(validatePackedFileList(files, validPackage)).toEqual([]);
  });

  it("reports the missing required entries (built entry, workflows, command mirrors)", () => {
    const errors = validatePackedFileList(["package/package.json"], validPackage);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("dist/index.js"),
      expect.stringContaining("workflows/"),
      expect.stringContaining(".claude/commands/"),
    ]));
  });

  it("reports a workflow whose generated command mirror is missing (partial directory)", () => {
    const files = [
      "package/package.json",
      "package/dist/index.js",
      "package/workflows/receipt-batch.md",
      "package/workflows/book-invoice.md",
      "package/.claude/commands/receipt-batch.md",
      // book-invoice command mirror deliberately absent
    ];
    const errors = validatePackedFileList(files, validPackage);
    expect(errors).toEqual(["packed payload missing .claude/commands/book-invoice.md"]);
  });

  it("reports a command mirror whose source workflow is missing", () => {
    const files = [
      "package/package.json",
      "package/dist/index.js",
      "package/workflows/receipt-batch.md",
      "package/.claude/commands/receipt-batch.md",
      "package/.claude/commands/orphan.md",
    ];
    const errors = validatePackedFileList(files, validPackage);
    expect(errors).toContain("packed payload missing workflows/orphan.md");
  });

  it("catches a matched omission: a required workflow dropped from BOTH directories", () => {
    // Both files for book-invoice are absent, so a set-equality check would pass.
    // The source-of-truth slug set makes the omission visible.
    const files = [
      "package/package.json",
      "package/dist/index.js",
      "package/workflows/receipt-batch.md",
      "package/.claude/commands/receipt-batch.md",
    ];
    const errors = validatePackedFileList(files, validPackage, ["receipt-batch", "book-invoice"]);
    expect(errors).toEqual(expect.arrayContaining([
      "packed payload missing workflows/book-invoice.md",
      "packed payload missing .claude/commands/book-invoice.md",
    ]));
  });
});

describe("buildPackedSmokePlan", () => {
  it("imports under the supplied Node executable and invokes the installed bin shim", () => {
    const packageRoot = "/tmp/install/node_modules/e-arveldaja-mcp";
    const plan = buildPackedSmokePlan(packageRoot, validPackage, "/opt/node18/bin/node");
    expect(plan.importCheck.command).toBe("/opt/node18/bin/node");
    expect(plan.importCheck.args.at(-1)).toContain("dist/prompt-registry.js");
    const shimName = process.platform === "win32" ? "e-arveldaja-mcp.cmd" : "e-arveldaja-mcp";
    expect(plan.binCheck).toEqual(expect.objectContaining({
      command: resolve(packageRoot, "..", ".bin", shimName),
      args: [],
      shell: process.platform === "win32",
    }));
  });

  it("throws when the package declares no bin entry", () => {
    expect(() => buildPackedSmokePlan("/tmp/x", { name: "x", main: "dist/index.js" }, "/usr/bin/node"))
      .toThrow(/bin/);
  });
});

describe("runCommand", () => {
  it("resolves stdout on success", async () => {
    const { stdout } = await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"], { timeoutMs: 5_000 });
    expect(stdout).toContain("ok");
  });

  it("throws on a non-zero exit, including stderr", async () => {
    await expect(runCommand(process.execPath, ["-e", "process.stderr.write('boom'); process.exit(3)"], { timeoutMs: 5_000 }))
      .rejects.toThrow(/boom/);
  });

  it("throws on timeout", async () => {
    await expect(runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 }))
      .rejects.toThrow(/timed out/);
  });
});

describe("terminateChild", () => {
  it.skipIf(process.platform === "win32")("escalates SIGTERM to SIGKILL when the child ignores SIGTERM, and awaits close", async () => {
    // The child installs a no-op SIGTERM handler (so SIGTERM will NOT kill it)
    // and announces readiness on stdout so the test is deterministic rather than
    // racing Node's cold start.
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdin.end();
    await new Promise(res => child.stdout.on("data", d => { if (String(d).includes("ready")) res(undefined); }));
    const started = Date.now();
    const result = await terminateChild(child, 50);
    expect(result.terminationSignal).toBe("SIGKILL");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("startAndObserve", () => {
  it("shuts a healthy stdio-style child down by closing stdin after the alive window", async () => {
    // Models the real stdio MCP server: alive while stdin is open, exits cleanly
    // on stdin EOF. Teardown must be the EOF, not a signal.
    const result = await startAndObserve(
      process.execPath,
      ["-e", "process.stdin.on('end',()=>process.exit(0)); process.stdin.resume(); setInterval(()=>{},1000)"],
      { cwd: process.cwd(), minimumAliveMs: 50, timeoutMs: 2_000, terminateGraceMs: 500, env: process.env },
    );
    expect(result.terminationSignal).toBe("stdin-eof");
    expect(result.code).toBe(0);
  });

  it("throws when the process exits before the window, even with no fatal-pattern stderr", async () => {
    // Benign stderr on purpose: only the early-close guard can catch this, so the
    // test fails if that guard is removed (a silently crashing bin must not pass).
    await expect(startAndObserve(process.execPath, ["-e", "process.stderr.write('bye'); process.exit(1)"], {
      cwd: process.cwd(), minimumAliveMs: 500, timeoutMs: 2_000, terminateGraceMs: 25, env: process.env,
    })).rejects.toThrow(/exited before smoke window/);
  });

  it("throws when a surviving process emits a fatal load-error pattern on stderr", async () => {
    // Alive past the window but a fatal loader message was printed: only the
    // fatal-pattern guard can catch this, isolating it from the early-close guard.
    await expect(startAndObserve(process.execPath, ["-e", "process.stderr.write('ERR_MODULE_NOT_FOUND: nope'); setInterval(()=>{},1000)"], {
      cwd: process.cwd(), minimumAliveMs: 200, timeoutMs: 2_000, terminateGraceMs: 500, env: process.env,
    })).rejects.toThrow(/ERR_MODULE_NOT_FOUND/);
  });

  it("throws a clear error when the command cannot be spawned at all", async () => {
    await expect(startAndObserve(resolve(process.cwd(), "does", "not", "exist-binary"), [], {
      cwd: process.cwd(), minimumAliveMs: 500, timeoutMs: 2_000, terminateGraceMs: 25, env: process.env,
    })).rejects.toThrow(/failed to start/);
  });

  it("throws when the server survives startup but exits non-zero during EOF shutdown", async () => {
    await expect(startAndObserve(
      process.execPath,
      ["-e", "process.stdin.on('end',()=>process.exit(1)); process.stdin.resume(); setInterval(()=>{},1000)"],
      { cwd: process.cwd(), minimumAliveMs: 50, timeoutMs: 2_000, terminateGraceMs: 500, env: process.env },
    )).rejects.toThrow(/uncleanly/);
  });

  it("fails (bounded, does not hang) when the server ignores stdin EOF", async () => {
    // Never exits on stdin 'end'; the teardown must time out and stop it rather
    // than awaiting a close that never comes.
    await expect(startAndObserve(
      process.execPath,
      ["-e", "process.stdin.resume(); setInterval(()=>{},1000)"],
      { cwd: process.cwd(), minimumAliveMs: 50, timeoutMs: 300, terminateGraceMs: 500, env: process.env },
    )).rejects.toThrow(/did not exit after stdin EOF/);
  });
});

describe("assertPackedBinIsExecutable", () => {
  const pkg = { name: "e-arveldaja-mcp", bin: { "e-arveldaja-mcp": "dist/index.js" } };

  async function makeInstallTree(root, { shim = true, shebang = true, exec = true } = {}) {
    const pkgRoot = resolve(root, "node_modules", pkg.name);
    await mkdir(resolve(pkgRoot, "dist"), { recursive: true });
    const target = resolve(pkgRoot, "dist", "index.js");
    await writeFile(target, `${shebang ? "#!/usr/bin/env node\n" : ""}console.log('x');\n`);
    await chmod(target, exec ? 0o755 : 0o644);
    if (shim) {
      await mkdir(resolve(root, "node_modules", ".bin"), { recursive: true });
      await writeFile(resolve(root, "node_modules", ".bin", "e-arveldaja-mcp"), "shim\n");
    }
    return root;
  }

  it("passes when the bin shim exists and the target carries a shebang", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bin-exec-ok-"));
    try {
      await makeInstallTree(root);
      await expect(assertPackedBinIsExecutable(root, pkg)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws when npm created no bin shim", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bin-exec-noshim-"));
    try {
      await makeInstallTree(root, { shim: false });
      await expect(assertPackedBinIsExecutable(root, pkg)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws when the bin target has no shebang", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bin-exec-noshebang-"));
    try {
      await makeInstallTree(root, { shebang: false });
      await expect(assertPackedBinIsExecutable(root, pkg)).rejects.toThrow(/shebang/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("throws when the bin target is not executable", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bin-exec-nonexec-"));
    try {
      await makeInstallTree(root, { exec: false });
      await expect(assertPackedBinIsExecutable(root, pkg)).rejects.toThrow(/not executable/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("release smoke CLI wiring", () => {
  it("imports the validator and smoke CLI without recursive main execution, and the CLI delegates to the injected smoke", async () => {
    const validator = await import(resolve(process.cwd(), "scripts/validate-release-metadata.ts"));
    const cli = await import(resolve(process.cwd(), "scripts/smoke-packed-runtime.mjs"));
    expect(typeof validator.main).toBe("function");
    expect(typeof cli.main).toBe("function");
    const smoke = vi.fn().mockResolvedValue(undefined);
    await cli.main({ root: process.cwd(), smokePackedRuntime: smoke });
    expect(smoke).toHaveBeenCalledTimes(1);
  });
});
