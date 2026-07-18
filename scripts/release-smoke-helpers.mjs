import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Pure check: which required files a packed payload (npm pack --json `files[].path`,
// each prefixed with "package/") is missing. Directory requirements (trailing "/")
// are satisfied by any packed entry under that prefix.
export function validatePackedFileList(files, packageJson, requiredWorkflowSlugs = null) {
  const names = new Set(files.map(file => file.replace(/^package\//, "")));
  const required = [packageJson.main, ...Object.values(packageJson.bin ?? {}), "package.json", "workflows/", ".claude/commands/"];
  const errors = required
    .filter(requiredName => requiredName.endsWith("/")
      ? ![...names].some(name => name.startsWith(requiredName))
      : !names.has(requiredName))
    .map(name => `packed payload must include ${name}`);
  // Each workflow prompt is loaded lazily by name at runtime and must ship with
  // BOTH its source and its generated .claude/commands mirror. A dir-exists
  // check would pass a partially packed directory that then ENOENTs in use.
  // When the caller passes the source-of-truth slug set, we validate against it
  // so a workflow dropped from BOTH directories is still caught; otherwise we
  // fall back to the union of what is packed (catches one-sided omissions).
  const slugsUnder = prefix => new Set(
    [...names].filter(name => name.startsWith(prefix) && name.endsWith(".md")).map(name => name.slice(prefix.length, -3)),
  );
  const workflowSlugs = slugsUnder("workflows/");
  const commandSlugs = slugsUnder(".claude/commands/");
  const expected = requiredWorkflowSlugs
    ? new Set(requiredWorkflowSlugs)
    : new Set([...workflowSlugs, ...commandSlugs]);
  for (const slug of expected) {
    if (!workflowSlugs.has(slug)) errors.push(`packed payload missing workflows/${slug}.md`);
    if (!commandSlugs.has(slug)) errors.push(`packed payload missing .claude/commands/${slug}.md`);
  }
  return errors;
}

// Pure plan: the two runtime checks run against an installed package tree. The
// import check loads the built module graph with a specific Node executable
// (getProjectRoot resolves to the installed root). The bin check invokes the
// installed `.bin` shim itself — not `node <file>` — so the real executable
// entrypoint (bin mapping, shebang, exec bit) is exercised end to end.
export function buildPackedSmokePlan(packageRoot, packageJson, nodeExecutable) {
  const [binName, binRelative] = Object.entries(packageJson.bin ?? {})[0] ?? [];
  if (!binName) throw new Error("package.json must declare a bin entry");
  const onWindows = process.platform === "win32";
  const shim = resolve(packageRoot, "..", ".bin", onWindows ? `${binName}.cmd` : binName);
  return {
    importCheck: {
      command: nodeExecutable,
      args: [
        "--input-type=module",
        "--eval",
        `import { getProjectRoot } from ${JSON.stringify(pathToFileURL(resolve(packageRoot, "dist/paths.js")).href)}; ` +
        `const root=getProjectRoot(); if(root!==${JSON.stringify(packageRoot)}) throw new Error(root);`,
      ],
    },
    binCheck: { command: shim, args: [], shell: onWindows, binTarget: binRelative },
  };
}

const closed = child => new Promise(resolveClose => child.once("close", (code, signal) => resolveClose({ code, signal })));
const wait = ms => new Promise(resolveWait => {
  const timer = setTimeout(resolveWait, ms);
  timer.unref?.(); // a losing race timer must not keep the CLI alive after real work is done
});

function closedAlready(child) {
  return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
}

// Terminate a running child gracefully (SIGTERM), escalating to SIGKILL after a
// grace window, and await its actual close so callers never leak a process.
export async function terminateChild(child, graceMs = 1_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { ...(await closedAlready(child)), terminationSignal: child.signalCode };
  }
  const closePromise = closed(child);
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    closePromise.then(value => ({ closed: true, value })),
    wait(graceMs).then(() => ({ closed: false })),
  ]);
  if (graceful.closed) return { ...graceful.value, terminationSignal: "SIGTERM" };
  child.kill("SIGKILL");
  const forced = await closePromise;
  return { ...forced, terminationSignal: "SIGKILL" };
}

// Windows-only: reap a process tree with `taskkill /T /F`, bounded by graceMs.
// Resolves when taskkill closes, errors, or the grace elapses; a taskkill that
// outlives the grace is unref'd so it can never retain the event loop. Runs
// BEFORE the wrapper is signalled, so the cmd.exe root still exists for /T to
// enumerate its Node descendant.
function killTree(pid, graceMs) {
  return new Promise(resolveKill => {
    let killer;
    try {
      killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      resolveKill();
      return;
    }
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolveKill(); } };
    killer.once("close", finish);
    killer.once("error", finish);
    wait(graceMs).then(() => { killer.unref?.(); finish(); });
  });
}

// Best-effort bounded stop for error/timeout paths: terminate the child (and, on
// Windows, its whole process tree) and wait at most graceMs for close. Never
// blocks indefinitely and never throws. On Windows the observed child may be a
// cmd.exe shim wrapping the Node server; SIGKILL to the shell does not cascade,
// so the tree is reaped with taskkill first — otherwise the wrapped Node
// descendant would be orphaned (and would keep the temp install tree locked).
async function stopChild(child, closePromise, graceMs) {
  if (process.platform === "win32" && typeof child.pid === "number") {
    await killTree(child.pid, graceMs);
  }
  child.kill("SIGKILL");
  await Promise.race([closePromise, wait(graceMs)]);
  // Final release: if a descendant somehow survived (e.g. a Windows tree-kill
  // that failed or timed out), drop our references to its pipes and the process
  // so it can never keep this runner alive or hold the temp tree open. Harmless
  // on the normal path where the child is already gone.
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
  child.unref?.();
}

// Run a command to completion with a hard timeout; closes stdin, captures
// stdout/stderr, throws on non-zero exit or timeout (terminating the child).
export async function runCommand(command, args, { timeoutMs = 120_000, ...options } = {}) {
  const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end();
  let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const closePromise = closed(child);
  const outcome = await Promise.race([
    closePromise.then(value => ({ kind: "close", value })),
    wait(timeoutMs).then(() => ({ kind: "timeout" })),
  ]);
  if (outcome.kind === "timeout") {
    await terminateChild(child);
    throw new Error(`${command} timed out after ${timeoutMs}ms`);
  }
  if (outcome.value.code !== 0) {
    throw new Error(`${command} exited ${outcome.value.code ?? outcome.value.signal}: ${stderr}`);
  }
  return { stdout, stderr };
}

// Start a long-lived process (the packed bin), require it to survive a minimum
// window without crashing or emitting a fatal load error, then terminate it and
// return how it closed. stdin is left OPEN for the whole window: a stdio MCP
// server treats stdin EOF as a shutdown signal, so closing it would make a
// perfectly healthy server exit cleanly and look like a crash.
export async function startAndObserve(command, args, { cwd, env, shell, minimumAliveMs = 1_000, timeoutMs = 10_000, terminateGraceMs = 1_000 }) {
  const child = spawn(command, args, { cwd, env, shell, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let spawnError;
  child.stderr.on("data", chunk => { stderr += chunk; });
  // A failed spawn (missing/non-executable bin) emits "error", not "close" —
  // surface it instead of silently timing into the alive window.
  const errorPromise = new Promise(resolveError => child.once("error", err => { spawnError = err; resolveError({ kind: "error" }); }));
  try {
    const closePromise = closed(child);
    const early = await Promise.race([
      closePromise.then(value => ({ kind: "close", value })),
      errorPromise,
      wait(minimumAliveMs).then(() => ({ kind: "alive" })),
    ]);
    if (early.kind === "error") {
      throw new Error(`Packed bin failed to start: ${spawnError?.message ?? spawnError}`);
    }
    if (early.kind === "close") {
      throw new Error(`Packed bin exited before smoke window (${early.value.code ?? early.value.signal}): ${stderr}`);
    }
    if (/SyntaxError|ERR_MODULE_NOT_FOUND|ENOENT.*(?:workflow|command|package)/i.test(stderr)) {
      await stopChild(child, closePromise, terminateGraceMs);
      throw new Error(stderr);
    }
    // Teardown via stdin EOF, not an OS signal: a stdio MCP server shuts down
    // cleanly when its stdin closes, and the EOF propagates through the shared
    // stdin pipe even when a Windows .cmd shim wraps the server — whereas a
    // signal to the shell would not cascade to the wrapped Node process, leaving
    // it alive and holding the pipes. Bounded so a server that ignores EOF fails
    // (with a best-effort hard stop) instead of hanging the CI job forever.
    child.stdin.end();
    const settled = await Promise.race([
      closePromise.then(value => ({ ...value, terminationSignal: "stdin-eof" })),
      wait(timeoutMs).then(() => "TIMEOUT"),
    ]);
    if (settled === "TIMEOUT") {
      await stopChild(child, closePromise, terminateGraceMs);
      throw new Error(`Packed bin did not exit after stdin EOF within ${timeoutMs}ms`);
    }
    // A server that starts fine but crashes during EOF shutdown must not pass.
    if (settled.code !== 0 || settled.signal) {
      throw new Error(`Packed bin exited uncleanly on shutdown (code ${settled.code}, signal ${settled.signal}): ${stderr}`);
    }
    return settled;
  } finally {
    child.stdin.destroy();
  }
}

async function assertReadable(path) {
  const info = await stat(path);
  if (!info.isDirectory() && !info.isFile()) throw new Error(`Unreadable packed path: ${path}`);
}

// Assert the installed package tree exposes the runtime resources the server
// resolves at startup (entry, workflows, command mirrors).
export async function assertInstalledPackagePaths(packageRoot, packageJson) {
  await assertReadable(resolve(packageRoot, packageJson.main));
  await assertReadable(resolve(packageRoot, "workflows"));
  await assertReadable(resolve(packageRoot, ".claude", "commands"));
}

// Assert the CLI is installable as an executable, not just loadable via `node
// <file>`: npm must have created the bin shim (a broken bin mapping fails here)
// and the bin target must carry a shebang (a stripped shebang makes the shim
// non-runnable even though `node <file>` still works).
export async function assertPackedBinIsExecutable(installRoot, packageJson) {
  const [binName, binTarget] = Object.entries(packageJson.bin ?? {})[0] ?? [];
  if (!binName) throw new Error("package.json must declare a bin entry");
  await assertReadable(resolve(installRoot, "node_modules", ".bin", binName));
  const target = resolve(installRoot, "node_modules", packageJson.name, binTarget);
  const info = await stat(target);
  if (process.platform !== "win32" && !(info.mode & 0o111)) {
    throw new Error(`packed bin ${binTarget} is not executable`);
  }
  const head = (await readFile(target, "utf8")).slice(0, 2);
  if (head !== "#!") throw new Error(`packed bin ${binTarget} is missing a shebang`);
}

// Full release smoke: build, pack, verify the packed file list, install the
// tarball into a throwaway tree, then run the import + path + bin startup checks
// with the given Node executable. No live API calls and no credentials; the
// tarball's declared dependencies are installed with --prefer-offline (cache
// first, registry only as a fallback).
export async function smokePackedRuntime({ root, nodeExecutable = process.execPath, run = runCommand }) {
  const temp = await mkdtemp(resolve(tmpdir(), "e-arveldaja-pack-smoke-"));
  try {
    await run("npm", ["run", "build"], { cwd: root, timeoutMs: 120_000 });
    const packed = JSON.parse(
      (await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], { cwd: root, timeoutMs: 120_000 })).stdout,
    )[0];
    const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    // Source-of-truth slug set: every workflow prompt present in the source tree
    // must survive packing in BOTH directories (a workflow dropped from both is
    // otherwise invisible to a set-equality check).
    const requiredWorkflowSlugs = (await readdir(resolve(root, "workflows")))
      .filter(name => name.endsWith(".md")).map(name => name.slice(0, -3));
    const errors = validatePackedFileList(packed.files.map(file => file.path), packageJson, requiredWorkflowSlugs);
    if (errors.length) throw new Error(errors.join("\n"));
    const installRoot = resolve(temp, "install");
    await mkdir(installRoot);
    await writeFile(resolve(installRoot, "package.json"), "{\"private\":true,\"type\":\"module\"}\n");
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", resolve(temp, packed.filename)], { cwd: installRoot, timeoutMs: 120_000 });
    const packageRoot = resolve(installRoot, "node_modules", packageJson.name);
    const plan = buildPackedSmokePlan(packageRoot, packageJson, nodeExecutable);
    await run(plan.importCheck.command, plan.importCheck.args, { cwd: installRoot, timeoutMs: 20_000 });
    await assertInstalledPackagePaths(packageRoot, packageJson);
    await assertPackedBinIsExecutable(installRoot, packageJson);
    // Run the bin hermetically: strip every inherited EARVELDAJA_* credential var
    // (case-insensitively — Windows env lookups ignore case) and point config
    // discovery at an empty dir, so the smoke reflects the packed artifact alone
    // and never touches the developer's real connections.
    const emptyConfigDir = resolve(temp, "empty-config");
    await mkdir(emptyConfigDir);
    const hermeticEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("EARVELDAJA_")),
    );
    hermeticEnv.EARVELDAJA_CONFIG_DIR = emptyConfigDir;
    await startAndObserve(plan.binCheck.command, plan.binCheck.args, {
      cwd: installRoot,
      timeoutMs: 10_000,
      env: hermeticEnv,
      shell: plan.binCheck.shell,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
