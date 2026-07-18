#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { smokePackedRuntime } from "./release-smoke-helpers.mjs";

export async function main({ root = process.cwd(), smokePackedRuntime: smoke = smokePackedRuntime } = {}) {
  await smoke({ root });
  console.log("Packed release smoke passed.");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
