#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generatedClaudeCommandText } from "./validate-release-metadata.mjs";

async function main() {
  const root = process.cwd();
  const workflowsDir = resolve(root, "workflows");
  const commandsDir = resolve(root, ".claude", "commands");
  const workflowFiles = (await readdir(workflowsDir)).filter((name) => name.endsWith(".md")).sort();

  await mkdir(commandsDir, { recursive: true });

  for (const fileName of workflowFiles) {
    const slug = fileName.replace(/\.md$/, "");
    const workflowText = await readFile(resolve(workflowsDir, fileName), "utf8");
    await writeFile(resolve(commandsDir, fileName), generatedClaudeCommandText(slug, workflowText), "utf8");
  }

  console.log(`Synchronized ${workflowFiles.length} Claude command prompt(s) from workflows/.`);
}

await main();
