#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_PACKAGE_FILES = ["workflows/", ".claude/commands/", "CHANGELOG.md", "server.json"];

export function generatedClaudeCommandText(slug, workflowText) {
  return `<!-- Generated from workflows/${slug}.md. Edit that source file, then run npm run sync:workflow-prompts. -->

${workflowText.trimEnd()}
`;
}

function firstPackage(serverJson) {
  return Array.isArray(serverJson?.packages) ? serverJson.packages[0] : undefined;
}

function includesFile(files, file) {
  return Array.isArray(files) && files.includes(file);
}

export function validateReleaseMetadata(packageJson, packageLock, serverJson) {
  const errors = [];
  const packageVersion = packageJson?.version;
  const lockVersion = packageLock?.version;
  const lockRootVersion = packageLock?.packages?.[""]?.version;
  const serverPackage = firstPackage(serverJson);

  if (lockVersion !== packageVersion) {
    errors.push(`package-lock.json version (${lockVersion}) must match package.json version (${packageVersion})`);
  }
  if (lockRootVersion !== packageVersion) {
    errors.push(`package-lock.json packages[""] version (${lockRootVersion}) must match package.json version (${packageVersion})`);
  }
  if (serverJson?.name !== packageJson?.mcpName) {
    errors.push(`server.json name (${serverJson?.name}) must match package.json mcpName (${packageJson?.mcpName})`);
  }
  if (serverJson?.version !== packageVersion) {
    errors.push(`server.json version (${serverJson?.version}) must match package.json version (${packageVersion})`);
  }
  if (serverPackage?.registryType !== "npm") {
    errors.push(`server.json packages[0].registryType (${serverPackage?.registryType}) must be npm`);
  }
  if (serverPackage?.identifier !== packageJson?.name) {
    errors.push(`server.json packages[0].identifier (${serverPackage?.identifier}) must match package.json name (${packageJson?.name})`);
  }
  if (serverPackage?.version !== packageVersion) {
    errors.push(`server.json packages[0].version (${serverPackage?.version}) must match package.json version (${packageVersion})`);
  }
  for (const file of REQUIRED_PACKAGE_FILES) {
    if (!includesFile(packageJson?.files, file)) {
      errors.push(`package.json files must include ${file}`);
    }
  }

  return errors;
}

async function readDirNames(path) {
  try {
    return await readdir(path);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function validateWorkflowPromptSurfaces(root) {
  const errors = [];
  const workflowsDir = resolve(root, "workflows");
  const commandsDir = resolve(root, ".claude", "commands");
  const workflowFiles = (await readDirNames(workflowsDir)).filter((name) => name.endsWith(".md")).sort();

  for (const fileName of workflowFiles) {
    const slug = fileName.replace(/\.md$/, "");
    const workflowPath = resolve(workflowsDir, fileName);
    const commandPath = resolve(commandsDir, fileName);
    const workflowText = await readFile(workflowPath, "utf8");
    let commandText;
    try {
      commandText = await readFile(commandPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        errors.push(`.claude/commands/${fileName} must exist for workflows/${fileName}`);
        continue;
      }
      throw error;
    }

    if (commandText !== generatedClaudeCommandText(slug, workflowText)) {
      errors.push(`.claude/commands/${fileName} must be regenerated from workflows/${fileName}`);
    }
  }

  return errors;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const root = process.cwd();
  const errors = validateReleaseMetadata(
    await readJson(resolve(root, "package.json")),
    await readJson(resolve(root, "package-lock.json")),
    await readJson(resolve(root, "server.json")),
  );
  errors.push(...await validateWorkflowPromptSurfaces(root));

  if (errors.length > 0) {
    console.error("Release metadata validation failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Release metadata is consistent.");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) {
  await main();
}
