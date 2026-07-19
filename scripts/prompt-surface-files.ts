import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { PROMPT_ARGUMENT_LIMITS } from "../src/prompt-arguments.js";
import {
  PROMPT_REGISTRY,
  type PromptDefinition,
  type WorkflowPromptName,
} from "../src/prompt-registry.js";
import {
  PROMPT_SURFACE_LIMIT,
  renderStaticFeatureSections,
  renderStaticPromptSurface,
} from "../src/prompt-surface.js";

export type PromptSurfaceRegistryEntry = Pick<PromptDefinition, "name" | "slug"> &
  Partial<Pick<PromptDefinition, "argsSchema" | "variants">>;

export interface SyncWorkflowPromptOptions {
  /** Test seam for proving rollback after the existing command set is moved aside. */
  beforeInstall?: () => void | Promise<void>;
  /** Test seam for modeling an installed set whose obsolete backup cannot be removed. */
  removeBackup?: (path: string) => Promise<void>;
  /** Receives a non-fatal warning after installation when backup cleanup fails. */
  onCleanupWarning?: (warning: string) => void;
}

const CANONICAL_PROMPT_TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MAX_PATH = `/${"p".repeat(PROMPT_ARGUMENT_LIMITS.pathCharacters - 1)}`;
const JSON_PREFIX = '{"value":"';
const JSON_SUFFIX = '"}';
const MAX_JSON_OBJECT = `${JSON_PREFIX}${"j".repeat(
  PROMPT_ARGUMENT_LIMITS.jsonBytes - Buffer.byteLength(JSON_PREFIX + JSON_SUFFIX, "utf8"),
)}${JSON_SUFFIX}`;
const MAX_ID = String(Number.MAX_SAFE_INTEGER);

/** Exhaustive, parser-valid wire strings at each prompt's practical argument maxima. */
export const MAXIMUM_VALID_PROMPT_ARGUMENTS: Readonly<Record<WorkflowPromptName, Readonly<Record<string, string>>>> = Object.freeze({
  "vat-registration-threshold": Object.freeze({
    year: "2100",
    financial_turnover: MAX_ID,
    insurance_turnover: MAX_ID,
    real_estate_turnover: MAX_ID,
    exempt_social_turnover: MAX_ID,
    incidental_excluded_turnover: MAX_ID,
    taxable_turnover_adjustment: `-${MAX_ID}`,
    manual_bucket_source: "included_in_sale_invoices",
  }),
  "setup-credentials": Object.freeze({ file_path: MAX_PATH, storage_scope: "global" }),
  "setup-e-arveldaja": Object.freeze({}),
  "accounting-inbox": Object.freeze({
    workspace_path: MAX_PATH,
    bank_account_dimension_id: MAX_ID,
    receipt_matching_dimension_id: MAX_ID,
    wise_account_dimension_id: MAX_ID,
  }),
  "resolve-accounting-review": Object.freeze({ review_item_json: MAX_JSON_OBJECT }),
  "prepare-accounting-review-action": Object.freeze({
    review_item_json: MAX_JSON_OBJECT,
    save_as_rule: "false",
    rule_override_json: MAX_JSON_OBJECT,
  }),
  "book-invoice": Object.freeze({ file_path: MAX_PATH }),
  "receipt-batch": Object.freeze({
    folder_path: MAX_PATH,
    accounts_dimensions_id: MAX_ID,
    date_from: "9999-01-01",
    date_to: "9999-12-31",
  }),
  "import-camt": Object.freeze({
    file_path: MAX_PATH,
    accounts_dimensions_id: MAX_ID,
    date_from: "9999-01-01",
    date_to: "9999-12-31",
  }),
  "import-wise": Object.freeze({
    file_path: MAX_PATH,
    accounts_dimensions_id: MAX_ID,
    fee_account_dimensions_id: MAX_ID,
    inter_account_dimension_id: MAX_ID,
    date_from: "9999-01-01",
    date_to: "9999-12-31",
    skip_jar_transfers: "false",
  }),
  "classify-unmatched": Object.freeze({
    accounts_dimensions_id: MAX_ID,
    date_from: "9999-01-01",
    date_to: "9999-12-31",
  }),
  "reconcile-bank": Object.freeze({
    mode: "transaction",
    transaction_id: MAX_ID,
    target_accounts_dimensions_id: MAX_ID,
  }),
  "month-end-close": Object.freeze({ month: "9999-12" }),
  "new-supplier": Object.freeze({ identifier: "i".repeat(PROMPT_ARGUMENT_LIMITS.identifierCharacters) }),
  "company-overview": Object.freeze({}),
  "lightyear-booking": Object.freeze({
    file_path: MAX_PATH,
    capital_gains_path: MAX_PATH,
    investment_account: MAX_ID,
    broker_account: MAX_ID,
    income_account: MAX_ID,
    gain_loss_account: MAX_ID,
    loss_account: MAX_ID,
    trade_fee_account: MAX_ID,
    distribution_fee_account: MAX_ID,
    tax_account: MAX_ID,
    investment_dimension_id: MAX_ID,
    broker_dimension_id: MAX_ID,
  }),
});

export function generatedClaudeCommandText(
  slug: string,
  workflowText: string,
  variants = PROMPT_REGISTRY.find(definition => definition.slug === slug)?.variants ?? [],
): string {
  const renderedWorkflow = renderStaticFeatureSections(workflowText.trimEnd(), variants);
  const trustedBody = `Canonical workflow source: workflows/${slug}.md\n\n${renderedWorkflow}\n`;
  const commandText = `<!-- Generated from workflows/${slug}.md. Edit that source file, then run npm run sync:workflow-prompts. -->\n\n${renderStaticPromptSurface(trustedBody).trimEnd()}\n`;
  if (commandText.length > PROMPT_SURFACE_LIMIT) {
    throw new Error("Generated prompt surface exceeds the maximum length");
  }
  return commandText;
}

async function readMarkdownNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).filter(name => name.endsWith(".md")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function isCanonicalPromptToken(value: string): boolean {
  return CANONICAL_PROMPT_TOKEN.test(value);
}

function containedMarkdownPath(base: string, slug: string): string {
  const candidate = resolve(base, `${slug}.md`);
  const relativePath = relative(base, candidate);
  if (isAbsolute(relativePath) || relativePath.startsWith("..") || relativePath !== `${slug}.md`) {
    throw new Error(`Invalid canonical prompt registry slug: ${slug}`);
  }
  return candidate;
}

async function pathKind(path: string): Promise<"missing" | "directory" | "file" | "symlink" | "other"> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function requireRealDirectory(path: string, label: string): Promise<void> {
  const kind = await pathKind(path);
  if (kind === "symlink") throw new Error(`${label} must not be a symbolic link`);
  if (kind !== "directory") throw new Error(`${label} must be a directory`);
}

function parseReadmeWorkflowSection(readme: string): {
  count: number | undefined;
  names: string[];
  errors: string[];
} {
  const errors: string[] = [];
  const headings = [...readme.matchAll(/^## Workflows \(MCP Prompts\)\s*$/gm)];
  if (headings.length !== 1) {
    errors.push(`README must contain exactly one ## Workflows (MCP Prompts) section (found ${headings.length})`);
    return { count: undefined, names: [], errors };
  }

  const start = headings[0]!.index! + headings[0]![0].length;
  const remainder = readme.slice(start);
  const nextHeading = /^##\s+/m.exec(remainder);
  const section = nextHeading ? remainder.slice(0, nextHeading.index) : remainder;
  const countMatch = /The server includes (\d+) built-in workflow prompts\b/.exec(section);
  if (!countMatch) {
    errors.push("README workflow section must declare its built-in workflow prompt count");
  }
  const names = [...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map(match => match[1]!);
  if (names.length === 0) {
    errors.push("README workflow section must contain the exhaustive prompt table");
  }
  return {
    count: countMatch ? Number(countMatch[1]) : undefined,
    names,
    errors,
  };
}

export async function validateWorkflowPromptSurfaces(
  root: string,
  registry: readonly PromptSurfaceRegistryEntry[] = PROMPT_REGISTRY,
): Promise<string[]> {
  const errors: string[] = [];
  for (const definition of registry) {
    if (!isCanonicalPromptToken(definition.name)) {
      errors.push(`invalid canonical registry prompt name ${definition.name}`);
    }
    if (!isCanonicalPromptToken(definition.slug)) {
      errors.push(`invalid canonical registry workflow slug ${definition.slug}`);
    }
  }
  const safeRegistry = registry.filter(definition =>
    isCanonicalPromptToken(definition.name) && isCanonicalPromptToken(definition.slug));
  const registryNames = safeRegistry.map(definition => definition.name);
  const registrySlugs = safeRegistry.map(definition => definition.slug);
  for (const name of duplicateValues(registryNames)) {
    errors.push(`duplicate registry prompt name ${name}`);
  }
  for (const slug of duplicateValues(registrySlugs)) {
    errors.push(`duplicate registry workflow slug ${slug}`);
  }

  const workflowsDir = resolve(root, "workflows");
  const commandsDir = resolve(root, ".claude", "commands");
  const workflowFiles = await readMarkdownNames(workflowsDir);
  const commandFiles = await readMarkdownNames(commandsDir);
  const workflowSlugs = workflowFiles.map(name => name.slice(0, -3));
  const commandSlugs = commandFiles.map(name => name.slice(0, -3));
  const registrySlugSet = new Set(registrySlugs);
  const workflowSlugSet = new Set(workflowSlugs);
  const commandSlugSet = new Set(commandSlugs);

  for (const slug of workflowSlugs) {
    if (!registrySlugSet.has(slug)) {
      errors.push(`workflows/${slug}.md is not declared in the prompt registry`);
    }
  }
  for (const slug of commandSlugs) {
    if (!registrySlugSet.has(slug)) {
      errors.push(`.claude/commands/${slug}.md is not declared in the prompt registry`);
    }
  }
  for (const slug of [...registrySlugSet].sort()) {
    if (!workflowSlugSet.has(slug)) {
      errors.push(`registry workflow ${slug} is missing workflows/${slug}.md`);
    }
    if (!commandSlugSet.has(slug)) {
      errors.push(`registry workflow ${slug} is missing .claude/commands/${slug}.md`);
    }
  }

  for (const slug of [...registrySlugSet].sort()) {
    if (!workflowSlugSet.has(slug) || !commandSlugSet.has(slug)) continue;
    const workflowText = await readFile(resolve(workflowsDir, `${slug}.md`), "utf8");
    const commandText = await readFile(resolve(commandsDir, `${slug}.md`), "utf8");
    let expected: string;
    try {
      const definition = safeRegistry.find(entry => entry.slug === slug)!;
      expected = generatedClaudeCommandText(slug, workflowText, definition.variants ?? []);
    } catch (error) {
      errors.push(`generated command ${slug} exceeds ${PROMPT_SURFACE_LIMIT} characters: ${(error as Error).message}`);
      continue;
    }
    if (commandText !== expected) {
      errors.push(`.claude/commands/${slug}.md must be regenerated from workflows/${slug}.md`);
    }
  }

  let readme: string | undefined;
  try {
    readme = await readFile(resolve(root, "README.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      errors.push("README.md must exist and document the workflow prompt registry");
    } else {
      throw error;
    }
  }
  if (readme !== undefined) {
    const parsed = parseReadmeWorkflowSection(readme);
    errors.push(...parsed.errors);
    for (const name of duplicateValues(parsed.names)) {
      errors.push(`README workflow table has duplicate prompt name ${name}`);
    }
    const registryNameSet = new Set(registryNames);
    const readmeNameSet = new Set(parsed.names);
    for (const name of [...readmeNameSet].sort()) {
      if (!registryNameSet.has(name)) {
        errors.push(`README workflow table prompt ${name} is not declared in the prompt registry`);
      }
    }
    for (const name of [...registryNameSet].sort()) {
      if (!readmeNameSet.has(name)) {
        errors.push(`registry prompt ${name} is missing from the README workflow table`);
      }
    }
    if (parsed.count !== undefined && parsed.count !== registry.length) {
      errors.push(`README declares ${parsed.count} workflow prompts but registry has ${registry.length}`);
    }
  }

  return errors;
}

/**
 * Replace the generated command set with rollback on installation failure.
 * Callers must hold exclusive workspace access: portable Node.js has no atomic
 * directory-exchange primitive, so readers can observe the brief rename window.
 */
export async function syncWorkflowPromptSurfaces(
  root: string,
  registry: readonly PromptSurfaceRegistryEntry[] = PROMPT_REGISTRY,
  options: SyncWorkflowPromptOptions = {},
): Promise<number> {
  const invalidDefinitions = registry.filter(definition =>
    !isCanonicalPromptToken(definition.name) || !isCanonicalPromptToken(definition.slug));
  if (invalidDefinitions.length > 0) {
    throw new Error(
      `Invalid canonical prompt registry: ${invalidDefinitions
        .map(definition => `${definition.name}:${definition.slug}`)
        .join(", ")}`,
    );
  }
  const duplicateNames = duplicateValues(registry.map(definition => definition.name));
  const duplicateSlugs = duplicateValues(registry.map(definition => definition.slug));
  if (duplicateNames.length || duplicateSlugs.length) {
    throw new Error(`Cannot synchronize a duplicate prompt registry: ${[...duplicateNames, ...duplicateSlugs].join(", ")}`);
  }

  const workflowsDir = resolve(root, "workflows");
  const claudeDir = resolve(root, ".claude");
  const commandsDir = resolve(root, ".claude", "commands");
  await requireRealDirectory(workflowsDir, "workflows directory");

  const expectedFiles = new Set(registry.map(definition => `${definition.slug}.md`));
  const workflowEntries = await readdir(workflowsDir, { withFileTypes: true });
  const unexpectedWorkflows = workflowEntries
    .filter(entry => entry.name.endsWith(".md") && !expectedFiles.has(entry.name))
    .map(entry => entry.name)
    .sort();
  if (unexpectedWorkflows.length > 0) {
    throw new Error(
      `Cannot synchronize while unexpected workflow files exist: ${unexpectedWorkflows.join(", ")}`,
    );
  }
  for (const definition of registry) {
    const sourcePath = containedMarkdownPath(workflowsDir, definition.slug);
    const kind = await pathKind(sourcePath);
    if (kind === "symlink") {
      throw new Error(`Workflow source ${definition.slug}.md must not be a symbolic link`);
    }
    if (kind !== "file") {
      throw new Error(`Workflow source ${definition.slug}.md must be a regular file`);
    }
  }

  const claudeKind = await pathKind(claudeDir);
  if (claudeKind === "missing") {
    await mkdir(claudeDir, { recursive: true });
  } else {
    await requireRealDirectory(claudeDir, ".claude directory");
  }
  const commandsKind = await pathKind(commandsDir);
  if (commandsKind === "symlink") {
    throw new Error(".claude/commands directory must not be a symbolic link");
  }
  if (commandsKind !== "missing" && commandsKind !== "directory") {
    throw new Error(".claude/commands must be a directory");
  }
  const commandEntries = commandsKind === "directory"
    ? await readdir(commandsDir, { withFileTypes: true })
    : [];
  const commandsMode = commandsKind === "directory"
    ? (await lstat(commandsDir)).mode & 0o7777
    : 0o777 & ~process.umask();
  const unexpectedFiles = commandEntries
    .filter(entry => !expectedFiles.has(entry.name))
    .map(entry => entry.name)
    .sort();
  if (unexpectedFiles.length > 0) {
    throw new Error(
      `Cannot synchronize while unexpected command files exist: ${unexpectedFiles.join(", ")}`,
    );
  }
  for (const entry of commandEntries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Command target ${entry.name} must not be a symbolic link`);
    }
    if (!entry.isFile()) {
      throw new Error(`Command target ${entry.name} must be a regular file`);
    }
  }
  const existingFileModes = new Map<string, number>();
  for (const entry of commandEntries) {
    existingFileModes.set(entry.name, (await lstat(resolve(commandsDir, entry.name))).mode & 0o7777);
  }

  const plannedWrites: Array<{ fileName: string; text: string }> = [];
  for (const definition of registry) {
    const workflowText = await readFile(containedMarkdownPath(workflowsDir, definition.slug), "utf8");
    plannedWrites.push({
      fileName: `${definition.slug}.md`,
      text: generatedClaudeCommandText(definition.slug, workflowText, definition.variants ?? []),
    });
  }

  const stagedDir = await mkdtemp(resolve(claudeDir, ".commands-stage-"));
  const backupDir = resolve(claudeDir, `.commands-backup-${randomUUID()}`);
  let existingMoved = false;
  let stagedInstalled = false;
  try {
    for (const plannedWrite of plannedWrites) {
      const stagedPath = resolve(stagedDir, plannedWrite.fileName);
      await writeFile(stagedPath, plannedWrite.text, "utf8");
      const existingMode = existingFileModes.get(plannedWrite.fileName);
      if (existingMode !== undefined) {
        await chmod(stagedPath, existingMode);
      }
    }
    await chmod(stagedDir, commandsMode);

    if (commandsKind === "directory") {
      await rename(commandsDir, backupDir);
      existingMoved = true;
    }
    try {
      await options.beforeInstall?.();
      await rename(stagedDir, commandsDir);
      stagedInstalled = true;
    } catch (error) {
      if (existingMoved) {
        try {
          await rename(backupDir, commandsDir);
          existingMoved = false;
        } catch (rollbackError) {
          throw new Error(
            `Command synchronization failed and rollback also failed: ${(rollbackError as Error).message}`,
            { cause: error },
          );
        }
      }
      throw error;
    }

    if (existingMoved) {
      try {
        await chmod(backupDir, commandsMode | 0o700);
        await (options.removeBackup ?? (path => rm(path, { recursive: true, force: true })))(backupDir);
      } catch (error) {
        const warning = `Command synchronization installed successfully, but backup cleanup failed at ${backupDir}: ${(error as Error).message}`;
        try {
          (options.onCleanupWarning ?? console.warn)(warning);
        } catch {
          // Installation already succeeded; a reporting callback must not turn it into a false failure.
        }
      }
      existingMoved = false;
    }
  } finally {
    if (!stagedInstalled) {
      try {
        await chmod(stagedDir, commandsMode | 0o700);
        await rm(stagedDir, { recursive: true, force: true });
      } catch (error) {
        const warning = `Command synchronization failed and staging cleanup also failed at ${stagedDir}: ${(error as Error).message}`;
        try {
          (options.onCleanupWarning ?? console.warn)(warning);
        } catch {
          // Preserve the primary synchronization failure even if warning delivery fails.
        }
      }
    }
  }
  return registry.length;
}
