#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertInstalledPackagePaths } from "./release-smoke-helpers.mjs";

const packageRoot = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: smoke-node18-paths.mjs <installed-package-root>");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const pathsModule = await import(pathToFileURL(resolve(packageRoot, "dist/paths.js")).href);
const actualRoot = pathsModule.getProjectRoot(pathToFileURL(resolve(packageRoot, "dist/paths.js")));
if (actualRoot !== packageRoot) throw new Error(`getProjectRoot returned ${actualRoot}; expected ${packageRoot}`);
await assertInstalledPackagePaths(packageRoot, packageJson);
process.stdout.write(`Node ${process.version}: packed path/resource smoke passed\n`);
