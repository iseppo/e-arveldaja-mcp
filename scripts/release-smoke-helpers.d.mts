import type { ChildProcess, SpawnOptions } from "node:child_process";

export interface PackageJsonLike {
  name?: string;
  main?: string;
  bin?: Record<string, string>;
}

export interface PackedSmokePlan {
  importCheck: { command: string; args: string[] };
  binCheck: { command: string; args: string[]; shell: boolean; binTarget: string };
}

export interface ChildCloseResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
}

export type RunCommand = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions & { timeoutMs?: number },
) => Promise<RunCommandResult>;

export interface StartAndObserveOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean | string;
  minimumAliveMs?: number;
  timeoutMs?: number;
  terminateGraceMs?: number;
}

export function validatePackedFileList(
  files: readonly string[],
  packageJson: PackageJsonLike,
  requiredWorkflowSlugs?: readonly string[] | null,
  sourceModules?: readonly string[] | null,
): string[];

export function buildPackedSmokePlan(packageRoot: string, packageJson: PackageJsonLike, nodeExecutable: string): PackedSmokePlan;

export function terminateChild(
  child: ChildProcess,
  graceMs?: number,
): Promise<ChildCloseResult & { terminationSignal: NodeJS.Signals | null }>;

export function runCommand(
  command: string,
  args: readonly string[],
  options?: SpawnOptions & { timeoutMs?: number },
): Promise<RunCommandResult>;

export function startAndObserve(
  command: string,
  args: readonly string[],
  options: StartAndObserveOptions,
): Promise<ChildCloseResult & { terminationSignal: "stdin-eof" }>;

export function assertInstalledPackagePaths(packageRoot: string, packageJson: PackageJsonLike & { main: string }): Promise<void>;

export function assertPackedBinIsExecutable(installRoot: string, packageJson: PackageJsonLike & { name: string }): Promise<void>;

export function smokePackedRuntime(options: { root: string; nodeExecutable?: string; run?: RunCommand }): Promise<void>;
