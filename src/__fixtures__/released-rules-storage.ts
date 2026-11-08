import { readdirSync, readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import { relative, resolve } from "path";
import { isDefaultAccountingRulesTemplate } from "../accounting-rules.js";

/**
 * The default-store decision of the RELEASED versions (≤ 0.41.x), copied
 * verbatim from master ea021d4 `src/accounting-rules.ts`
 * (`chooseDefaultBundleStorage` and its helpers). Tests run it against the
 * on-disk layout new versions write, to prove an older server started on the
 * same config dir still picks its per-key store, not a shared root bundle.
 * Do not "fix" this copy: it must stay what is installed in the field.
 */

const BUNDLE_DIR_NAME = "accounting-rules";
const LEGACY_FILE_NAME = "accounting-rules.md";

function buildAccountingRulesConnectionScope(_name: string, stableIdentity: string): string {
  if (!stableIdentity.trim()) {
    throw new Error("Accounting rules stable identity must not be blank.");
  }
  return createHash("sha256").update(stableIdentity).digest("hex");
}

export function releasedChooseDefaultBundleStorage(
  projectRoot: string,
  globalConfigDir: string,
  connectionName = "default",
  stableIdentity = connectionName,
): { mode: "bundle"; dir: string; legacyFile: string } {
  const scope = buildAccountingRulesConnectionScope(connectionName, stableIdentity);
  const projectDir = resolve(projectRoot, BUNDLE_DIR_NAME);
  const projectLegacy = resolve(projectRoot, LEGACY_FILE_NAME);
  if (isRootInitializedBundle(projectDir) || existingLegacyContainsUserData(projectLegacy)) {
    return { mode: "bundle", dir: projectDir, legacyFile: projectLegacy };
  }
  const globalDir = resolve(globalConfigDir, BUNDLE_DIR_NAME);
  const globalLegacy = resolve(globalConfigDir, LEGACY_FILE_NAME);
  if (isRootInitializedBundle(globalDir) || existingLegacyContainsUserData(globalLegacy)) {
    return { mode: "bundle", dir: globalDir, legacyFile: globalLegacy };
  }
  return {
    mode: "bundle",
    dir: resolve(globalDir, scope),
    legacyFile: resolve(globalConfigDir, scope, LEGACY_FILE_NAME),
  };
}

function existingLegacyContainsUserData(file: string): boolean {
  try {
    return !isDefaultAccountingRulesTemplate(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

const SCOPED_RULES_DIRECTORY_NAME = /^[0-9a-f]{64}$/;
const SCOPED_RULES_LOCK_FILE_NAME = /^[0-9a-f]{64}\.lock(?:\.reclaim)?$/;
const SCOPED_RULES_STAGING_DIRECTORY_NAME = /^[0-9a-f]{64}\.(?:migrating|replacing)$/;

function isRootInitializedBundle(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
  try {
    const knownSubdirs = new Set(["auto-booking", "owner-expense", "annual-report"]);
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "index.md" || entry.name === "log.md") {
        return true;
      }
      if (SCOPED_RULES_DIRECTORY_NAME.test(entry.name)) {
        if (!entry.isDirectory()) return true;
        continue;
      }
      if (SCOPED_RULES_LOCK_FILE_NAME.test(entry.name)) {
        if (!entry.isFile()) return true;
        continue;
      }
      if (SCOPED_RULES_STAGING_DIRECTORY_NAME.test(entry.name)) {
        if (!entry.isDirectory()) return true;
        continue;
      }
      if (!knownSubdirs.has(entry.name)) {
        return true;
      }
      if (!entry.isDirectory()) {
        return true;
      }
      if (listBundleMarkdownFiles(resolve(dir, entry.name)).length > 0) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

function listBundleMarkdownFiles(dir: string): string[] {
  const result: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        result.push(relative(dir, full));
      }
    }
  };
  walk(dir);
  return result;
}
