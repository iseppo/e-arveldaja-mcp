import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "fs";
import { randomUUID } from "crypto";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { z } from "zod";
import { getProjectRoot } from "./paths.js";
import { getGlobalConfigDir } from "./config.js";
import { normalizeCompanyName } from "./company-name.js";

const liabilityClassificationSchema = z.enum(["current", "non_current"]);
const cashFlowCategorySchema = z.enum(["operating", "investing", "financing"]);
const vatDeductionModeSchema = z.enum(["none", "full", "partial"]);
const vatDeductionRatioSchema = z.number().min(0).max(1);
const transactionCategorySchema = z.enum([
  "saas_subscriptions",
  "bank_fees",
  "tax_payments",
  "salary_payroll",
  "owner_transfers",
  "card_purchases",
  "revenue_without_invoice",
  "unknown",
]);

const autoBookingRuleSchemaBase = z.object({
  match: z.string().min(1),
  category: transactionCategorySchema.optional(),
  purchase_article_id: z.number().int().optional(),
  purchase_account_id: z.number().int().optional(),
  purchase_account_dimensions_id: z.number().int().optional(),
  liability_account_id: z.number().int().optional(),
  vat_rate_dropdown: z.string().optional(),
  reversed_vat_id: z.number().int().optional(),
  reason: z.string().optional(),
});

const autoBookingRuleSchema = autoBookingRuleSchemaBase.superRefine((value, ctx) => {
  if (!hasAnyAutoBookingRuleActionField(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "auto-booking rules require at least one concrete booking field besides match/category/reason",
      path: ["match"],
    });
  }
});

const ownerExpenseVatRuleSchema = z.object({
  mode: vatDeductionModeSchema,
  ratio: vatDeductionRatioSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.mode === "partial" && value.ratio === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "partial VAT deduction rules require a ratio between 0 and 1",
      path: ["ratio"],
    });
  }
});

const accountingRulesSchema = z.object({
  auto_booking: z.object({
    counterparties: z.array(autoBookingRuleSchema).optional(),
  }).optional(),
  owner_expense_reimbursement: z.object({
    default_vat_deduction_mode: vatDeductionModeSchema.optional(),
    default_vat_deduction_ratio: vatDeductionRatioSchema.optional(),
    account_overrides: z.record(z.string(), ownerExpenseVatRuleSchema).optional(),
  }).optional(),
  annual_report: z.object({
    current_year_profit_account: z.number().int().optional(),
    liability_classification: z.record(z.string(), liabilityClassificationSchema).optional(),
    cash_flow_category: z.record(z.string(), cashFlowCategorySchema).optional(),
  }).optional(),
}).strict();

export type LiabilityClassificationRule = z.infer<typeof liabilityClassificationSchema>;
export type CashFlowCategoryRule = z.infer<typeof cashFlowCategorySchema>;
export type OwnerExpenseVatDeductionModeRule = z.infer<typeof vatDeductionModeSchema>;
export type AccountingAutoBookingRule = z.infer<typeof autoBookingRuleSchema>;

type AccountingRules = z.infer<typeof accountingRulesSchema>;

export interface SaveAutoBookingRuleInput {
  match: string;
  category?: z.infer<typeof transactionCategorySchema>;
  purchase_article_id?: number;
  purchase_account_id?: number;
  purchase_account_dimensions_id?: number;
  liability_account_id?: number;
  vat_rate_dropdown?: string;
  reversed_vat_id?: number;
  reason?: string;
}

let cachedRules: AccountingRules | undefined;
let cachedRulesKey: string | undefined;

const AUTO_BOOKING_RULE_ACTION_FIELDS = [
  "purchase_article_id",
  "purchase_account_id",
  "purchase_account_dimensions_id",
  "liability_account_id",
  "vat_rate_dropdown",
  "reversed_vat_id",
] as const;

const BUNDLE_DIR_NAME = "accounting-rules";
const LEGACY_FILE_NAME = "accounting-rules.md";
const OKF_VERSION = "0.1";

/**
 * Where company-specific accounting rules live.
 *
 * - `file` mode: the legacy single markdown file (`EARVELDAJA_RULES_FILE`).
 *   Behaviour is byte-for-byte what it always was.
 * - `bundle` mode (default): an Open Knowledge Format (OKF) v0.1 directory of
 *   concept files. `legacyFile` is the sibling single file that is read as a
 *   fallback and migrated into the bundle on first write.
 */
type RulesStorage =
  | { mode: "file"; file: string }
  | { mode: "bundle"; dir: string; legacyFile: string };

function resolveAbsolute(value: string): string {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function resolveStorage(): RulesStorage {
  const configuredFile = process.env.EARVELDAJA_RULES_FILE?.trim();
  if (configuredFile) {
    return { mode: "file", file: resolveAbsolute(configuredFile) };
  }
  const configuredDir = process.env.EARVELDAJA_RULES_DIR?.trim();
  if (configuredDir) {
    const dir = resolveAbsolute(configuredDir);
    return { mode: "bundle", dir, legacyFile: resolve(dirname(dir), LEGACY_FILE_NAME) };
  }
  return chooseDefaultBundleStorage(getProjectRoot(), getGlobalConfigDir());
}

/**
 * Default bundle location when neither `EARVELDAJA_RULES_FILE` nor
 * `EARVELDAJA_RULES_DIR` is set.
 *
 * Historically the bundle defaulted to `<project root>/accounting-rules`, which
 * for packaged installs resolves *inside the install directory* — ephemeral
 * across reinstalls and impossible to share between MCP clients. To fix that
 * without stranding anyone's existing rules:
 *   1. If rules already live next to the project (an initialized bundle dir or a
 *      legacy `accounting-rules.md`), keep using that location in place.
 *   2. Otherwise default to the per-user global config dir — the same
 *      convention credentials already use (`~/.config/e-arveldaja-mcp` or the
 *      platform equivalent) — so a fresh install gets a host-stable home that
 *      survives reinstalls and is shared across clients.
 *
 * Pure with respect to its inputs (only existence checks on derived paths), so
 * the decision can be unit-tested without touching the real home directory.
 */
export function chooseDefaultBundleStorage(
  projectRoot: string,
  globalConfigDir: string,
): { mode: "bundle"; dir: string; legacyFile: string } {
  const projectDir = resolve(projectRoot, BUNDLE_DIR_NAME);
  const projectLegacy = resolve(projectRoot, LEGACY_FILE_NAME);
  if (isInitializedBundle(projectDir) || existsSync(projectLegacy)) {
    return { mode: "bundle", dir: projectDir, legacyFile: projectLegacy };
  }
  const dir = resolve(globalConfigDir, BUNDLE_DIR_NAME);
  return { mode: "bundle", dir, legacyFile: resolve(globalConfigDir, LEGACY_FILE_NAME) };
}

// ---- Cross-process write lock --------------------------------------------
//
// A single rule write is three file operations (the concept file, a `log.md`
// append, and a regenerated `index.md`). When several MCP clients share one
// `EARVELDAJA_RULES_DIR` — now an explicitly documented setup — two server
// processes writing at once could interleave and leave `index.md` out of sync
// with the concept files. We serialize the mutating cycle with an `O_EXCL` lock
// file at `<dir>.lock`.
//
// The lock file is a *sibling* of the bundle dir, never a child: the atomic
// migration renames a staging dir onto `dir` and relies on `dir` being absent,
// so a child lock file would break it. It is re-entrant within a single process
// (the JS event loop already serializes in-process writers), which lets the
// public save path and the exported migration helper nest without deadlocking.
//
// Mutual exclusion is guaranteed solely by `openSync(lockPath, "wx")` (O_EXCL):
// only one process can ever create the lock. The extra machinery only governs
// *reclaiming* a lock left behind by a crashed holder, and is built so it can
// never produce two live holders:
//  - The lock records its owner's `pid` (+ a random token). A contended lock is
//    reclaimed only when that pid is provably dead (`process.kill(pid, 0)` →
//    ESRCH) — never from a slow-but-alive holder, regardless of how long it
//    holds. (Reclaim assumes a same-host setup, which is what "shared by several
//    MCP clients" means; for an exotic network-shared dir across hosts a stuck
//    lock is surfaced via the timeout error instead.)
//  - Reclaim is serialized by a short-lived guard file and *removes* (never
//    moves) the dead lock, and only after re-reading `lockPath` and confirming it
//    STILL carries the exact dead token. A dead process cannot have re-released
//    it, and while that dead token occupies `lockPath` no successor can be created
//    (their `openSync(wx)` fails) and no other reclaimer holds the guard — so the
//    removal can never strand a live holder that acquired in between, and removal
//    + the next `openSync(wx)` still yields a single winner.
//  - Release deletes the lock only if it still carries our token, so a holder can
//    never delete someone else's lock.
//  - A failed/short token write is treated as a failed acquisition (the
//    just-created lock is removed and the error rethrown), never leaked tokenless.

const BUNDLE_LOCK_POLL_MS = 25;
const BUNDLE_LOCK_MAX_WAIT_MS = 10_000;
const heldBundleLocks = new Set<string>();

function sleepSync(ms: number): void {
  // Block the current tick without busy-spinning. Only reached under
  // cross-process lock contention, which is rare and short at human write pace.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Whether the process that owns a lock token (`"<pid>:<uuid>"`) is still alive. */
export function lockHolderAlive(token: string): boolean {
  // Parse strictly: only a leading "<digits>:" with a real-pid-sized number is a
  // pid. Anything else (no colon, garbage, out-of-range) is treated as alive so
  // we never reclaim a lock we can't identify.
  const match = /^(\d{1,10}):/.exec(token);
  if (!match) return true;
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0); // signal 0 only probes; it does not terminate
    return true;
  } catch (error) {
    // Only an explicit "no such process" proves the holder is gone. Treat every
    // other probe failure (EPERM = exists but not ours; range/arg errors = can't
    // tell) as alive, so we never reclaim on uncertainty.
    return errno(error) !== "ESRCH";
  }
}

/**
 * Reclaim a contended lock whose holder is dead. Returns true if the caller
 * should retry acquiring (the lock was cleared or already gone), false if it
 * should keep waiting (a live holder, or another process is reclaiming).
 *
 * Serialized by a guard file so exactly one process decides-and-removes at a
 * time. A crashed reclaimer that leaks the guard merely disables auto-reclaim
 * (the acquire deadline still bounds the wait); it can never cause a double hold.
 */
function reclaimDeadLock(lockPath: string): boolean {
  const guardPath = `${lockPath}.reclaim`;
  let guardFd = -1;
  try {
    guardFd = openSync(guardPath, "wx");
  } catch {
    return false; // another reclaimer active (or a leaked guard) → wait
  }
  try {
    let token: string;
    try {
      token = readFileSync(lockPath, "utf8");
    } catch (error) {
      return errno(error) === "ENOENT"; // already released → retry acquire
    }
    if (lockHolderAlive(token)) return false; // live holder → keep waiting
    // The holder of `token` is dead — but it may have cleanly released and a live
    // successor may have acquired the lock between our read and now. Re-read and
    // remove ONLY if the lock still carries that exact dead token: a dead process
    // cannot have re-released it, and (while we hold the reclaim guard) no
    // successor can occupy `lockPath` while that dead token sits there, so this
    // can never delete a live successor's lock.
    let current: string;
    try {
      current = readFileSync(lockPath, "utf8");
    } catch (error) {
      return errno(error) === "ENOENT"; // released in between → retry acquire
    }
    if (current !== token) return false; // a (live) successor holds it → keep waiting
    try {
      rmSync(lockPath, { force: true }); // force ignores ENOENT (already gone)
      return true; // dead lock removed → retry acquire
    } catch {
      // Couldn't remove it (perms, file-in-use, …). Don't claim success — let the
      // caller fall through to the deadline + sleep instead of spinning.
      return false;
    }
  } finally {
    try { closeSync(guardFd); } catch { /* already closed */ }
    try { rmSync(guardPath, { force: true }); } catch { /* already gone */ }
  }
}

export function withBundleLock<T>(dir: string, fn: () => T): T {
  const lockPath = `${dir}.lock`;
  if (heldBundleLocks.has(lockPath)) {
    return fn();
  }
  mkdirSync(dirname(dir), { recursive: true });
  const token = `${process.pid}:${randomUUID()}\n`;
  const deadline = Date.now() + BUNDLE_LOCK_MAX_WAIT_MS;
  let fd = -1;
  acquire: for (;;) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
      // Held by another process (we'd have short-circuited if it were ours).
      if (reclaimDeadLock(lockPath)) continue acquire;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${BUNDLE_LOCK_MAX_WAIT_MS}ms waiting for the accounting-knowledge lock at ${lockPath}. ` +
          "If no other e-arveldaja process is running, remove that stale lock file.",
        );
      }
      sleepSync(BUNDLE_LOCK_POLL_MS);
      continue acquire;
    }
    // Acquired exclusively. Stamp our ownership token; if we can't write it whole
    // (exception or short write), abandon the acquisition rather than leaving a
    // lock that release won't recognize and reclaim might misjudge.
    try {
      const written = writeSync(fd, token);
      if (written !== Buffer.byteLength(token)) {
        throw new Error(`short write stamping lock token (${written}/${Buffer.byteLength(token)} bytes)`);
      }
    } catch (error) {
      try { closeSync(fd); } catch { /* fd already closed */ }
      fd = -1;
      try { rmSync(lockPath, { force: true }); } catch { /* already gone */ }
      throw error;
    }
    break;
  }
  heldBundleLocks.add(lockPath);
  try {
    return fn();
  } finally {
    heldBundleLocks.delete(lockPath);
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* fd already closed */ }
    }
    // Only remove the lock if it is still ours — never delete a successor's lock.
    try {
      if (readFileSync(lockPath, "utf8") === token) {
        rmSync(lockPath, { force: true });
      }
    } catch {
      // Already gone or unreadable — nothing for us to release.
    }
  }
}

/**
 * A directory counts as a bundle once it contains at least one markdown file
 * (a concept, or the reserved `index.md`/`log.md`). An empty or absent
 * directory (e.g. a manually created folder, or a dir left over from an
 * interrupted setup) is NOT treated as a bundle, so the legacy file is still
 * read/migrated instead of being silently shadowed. `index.md` is intentionally
 * not required — OKF consumers must tolerate bundles without it.
 */
function isInitializedBundle(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return listBundleMarkdownFiles(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether a bundle holds at least one real concept file (not just the reserved
 * `index.md`/`log.md`). This — not mere existence of markdown — is what makes a
 * bundle the AUTHORITATIVE rule source: a bundle that contains only reserved
 * files (e.g. a bare scaffold or an interrupted in-place migration) must not
 * shadow a legacy `accounting-rules.md` that still has rules.
 */
function bundleHasConcepts(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return listBundleMarkdownFiles(dir).some((rel) => {
      const name = rel.replace(/\\/g, "/");
      return name !== "index.md" && name !== "log.md";
    });
  } catch {
    return false;
  }
}

const DEFAULT_RULES_TEMPLATE = `# Accounting Rules

Use this file for company-specific accounting choices that the ledger cannot prove by itself.
Keep free-form notes here if useful; only the markdown tables below are machine-read.

## Auto Booking

Add counterparty-specific defaults here when supplier history is not enough.

Columns:
- \`match\`
- \`category\`
- \`purchase_article_id\`
- \`purchase_account_id\`
- \`purchase_account_dimensions_id\`
- \`liability_account_id\`
- \`vat_rate_dropdown\`
- \`reversed_vat_id\`
- \`reason\`

## Owner Expense Reimbursement

Set a default only if your policy is stable.

If you want a global default, add a plain text line here using:
- \`Default VAT deduction mode: full\`
- \`Default VAT deduction mode: none\`
- \`Default VAT deduction mode: partial ratio 0.5\`

Optional account overrides table:
- \`expense_account\`
- \`vat_deduction_mode\`
- \`vat_deduction_ratio\`

## Annual Report

If your chart of accounts uses a custom current-year profit/loss account, add a plain text line under Annual Report:
- \`Current year profit account: 2970\`

## Liability Classification

Add account-level overrides only when maturity is known outside the ledger.

Columns:
- \`account_id\`
- \`classification\`

## Cash Flow Category

Add account-level overrides when the standard chart-of-accounts heuristic is not enough.

Columns:
- \`account_id\`
- \`category\`
`;

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, "_");
}

export function normalizeAutoBookingRuleMatch(match: string): string {
  return normalizeCompanyName(match, { stripNonAlphanumeric: true }) || match.trim().toLowerCase();
}

export function hasAnyAutoBookingRuleActionField(
  value: Partial<Pick<
    AccountingAutoBookingRule,
    typeof AUTO_BOOKING_RULE_ACTION_FIELDS[number]
  >>,
): boolean {
  return AUTO_BOOKING_RULE_ACTION_FIELDS.some((field) => value[field] !== undefined);
}

export function hasConcreteAutoBookingRuleBookingTarget(
  value: Partial<Pick<AccountingAutoBookingRule, "purchase_article_id" | "purchase_account_id">>,
): boolean {
  return value.purchase_article_id !== undefined || value.purchase_account_id !== undefined;
}

function getRulesSignature(filePath: string): string {
  if (!existsSync(filePath)) {
    return `${filePath}:missing`;
  }
  const info = statSync(filePath);
  return `${filePath}:${info.mtimeMs}:${info.size}`;
}

function splitMarkdownSections(markdown: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let currentSection = "";
  sections.set(currentSection, []);

  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (match) {
      currentSection = normalizeHeader(match[2]!);
      sections.set(currentSection, []);
      continue;
    }
    sections.get(currentSection)!.push(line);
  }

  return sections;
}

function parseMarkdownTable(sectionLines: string[]): Array<Record<string, string>> {
  const tableLines = sectionLines
    .map(line => line.trim())
    .filter(line => line.startsWith("|"));

  if (tableLines.length < 2) {
    return [];
  }

  const headers = tableLines[0]!
    .split("|")
    .map(cell => normalizeHeader(cell))
    .filter(Boolean);

  return tableLines.slice(2).map((line) => {
    const cells = line
      .split("|")
      .map(cell => cell.trim())
      .filter((_, index, all) => index > 0 && index < all.length - 1);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      const value = cells[index];
      if (value) {
        row[header] = value;
      }
    });
    return row;
  });
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parseOptionalRatio(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

function parseOwnerExpenseDefaults(sectionLines: string[]): AccountingRules["owner_expense_reimbursement"] {
  const rules: NonNullable<AccountingRules["owner_expense_reimbursement"]> = {};
  const defaultLine = sectionLines
    .map(line => line.trim())
    .find(line => /^default vat deduction mode:/i.test(line));
  const match = defaultLine?.match(/^default vat deduction mode:\s*(none|full|partial)(?:\s+ratio\s+([0-9]*\.?[0-9]+))?$/i);
  if (match) {
    const parsed = ownerExpenseVatRuleSchema.safeParse({
      mode: match[1]!.toLowerCase(),
      ratio: parseOptionalRatio(match[2]),
    });
    if (parsed.success) {
      rules.default_vat_deduction_mode = parsed.data.mode;
      if (parsed.data.ratio !== undefined) {
        rules.default_vat_deduction_ratio = parsed.data.ratio;
      }
    }
  }

  const rows = parseMarkdownTable(sectionLines);
  if (rows.length > 0) {
    const overrides: NonNullable<AccountingRules["owner_expense_reimbursement"]>["account_overrides"] = {};
    for (const row of rows) {
      const accountId = row.expense_account;
      const parsed = ownerExpenseVatRuleSchema.safeParse({
        mode: row.vat_deduction_mode?.toLowerCase(),
        ratio: parseOptionalRatio(row.vat_deduction_ratio),
      });
      if (!accountId || !parsed.success) continue;
      overrides[accountId] = parsed.data;
    }
    if (Object.keys(overrides).length > 0) {
      rules.account_overrides = overrides;
    }
  }

  return Object.keys(rules).length > 0 ? rules : undefined;
}

function parseAutoBookingRules(sectionLines: string[]): AccountingRules["auto_booking"] {
  const rows = parseMarkdownTable(sectionLines);
  const counterparties: AccountingAutoBookingRule[] = [];
  for (const row of rows) {
    const parsed = autoBookingRuleSchema.safeParse({
      match: row.match,
      category: row.category?.toLowerCase(),
      purchase_article_id: parseOptionalInt(row.purchase_article_id),
      purchase_account_id: parseOptionalInt(row.purchase_account_id),
      purchase_account_dimensions_id: parseOptionalInt(row.purchase_account_dimensions_id),
      liability_account_id: parseOptionalInt(row.liability_account_id),
      vat_rate_dropdown: row.vat_rate_dropdown,
      reversed_vat_id: parseOptionalInt(row.reversed_vat_id),
      reason: row.reason,
    });
    if (parsed.success) {
      counterparties.push(parsed.data);
    }
  }

  return counterparties.length > 0 ? { counterparties } : undefined;
}

function parseAnnualReportRules(sectionMap: Map<string, string[]>): AccountingRules["annual_report"] {
  const annualReportLines = sectionMap.get("annual_report") ?? [];
  const liabilityRows = parseMarkdownTable(sectionMap.get("liability_classification") ?? []);
  const cashFlowRows = parseMarkdownTable(sectionMap.get("cash_flow_category") ?? []);
  const currentYearProfitAccountLine = annualReportLines
    .map(line => line.trim())
    .find(line => /^current year profit account:/i.test(line));
  const currentYearProfitAccount = parseOptionalInt(
    currentYearProfitAccountLine?.match(/^current year profit account:\s*(\d+)$/i)?.[1],
  );

  const liabilityClassification: Record<string, LiabilityClassificationRule> = {};
  for (const row of liabilityRows) {
    const accountId = row.account_id;
    const classification = row.classification?.toLowerCase();
    if (!accountId || (classification !== "current" && classification !== "non_current")) continue;
    liabilityClassification[accountId] = classification;
  }

  const cashFlowCategory: Record<string, CashFlowCategoryRule> = {};
  for (const row of cashFlowRows) {
    const accountId = row.account_id;
    const category = row.category?.toLowerCase();
    if (!accountId || (category !== "operating" && category !== "investing" && category !== "financing")) continue;
    cashFlowCategory[accountId] = category;
  }

  if (
    currentYearProfitAccount === undefined &&
    Object.keys(liabilityClassification).length === 0 &&
    Object.keys(cashFlowCategory).length === 0
  ) {
    return undefined;
  }

  return {
    ...(currentYearProfitAccount !== undefined ? { current_year_profit_account: currentYearProfitAccount } : {}),
    ...(Object.keys(liabilityClassification).length > 0 ? { liability_classification: liabilityClassification } : {}),
    ...(Object.keys(cashFlowCategory).length > 0 ? { cash_flow_category: cashFlowCategory } : {}),
  };
}

function parseMarkdownRules(markdown: string): AccountingRules {
  const sectionMap = splitMarkdownSections(markdown);
  return accountingRulesSchema.parse({
    auto_booking: parseAutoBookingRules(sectionMap.get("auto_booking") ?? []),
    owner_expense_reimbursement: parseOwnerExpenseDefaults(sectionMap.get("owner_expense_reimbursement") ?? []),
    annual_report: parseAnnualReportRules(sectionMap),
  });
}

function safeParseLegacyFile(file: string): AccountingRules {
  try {
    return parseMarkdownRules(readFileSync(file, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`WARNING: Could not load accounting rules from ${file}: ${message}\n`);
    return {};
  }
}

function safeLoadBundle(dir: string): AccountingRules {
  try {
    return loadBundleRules(dir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`WARNING: Could not load accounting rules bundle from ${dir}: ${message}\n`);
    return {};
  }
}

function loadAccountingRules(): AccountingRules {
  const storage = resolveStorage();
  let key: string;
  let produce: () => AccountingRules;
  if (storage.mode === "file") {
    key = `file:${getRulesSignature(storage.file)}`;
    produce = () => (existsSync(storage.file) ? safeParseLegacyFile(storage.file) : {});
  } else if (bundleHasConcepts(storage.dir)) {
    key = `bundle:${getBundleSignature(storage.dir)}`;
    produce = () => safeLoadBundle(storage.dir);
  } else if (existsSync(storage.legacyFile)) {
    // Bundle not created yet — read the legacy file in place so existing rules
    // keep working until the first write migrates them.
    key = `legacy-fallback:${getRulesSignature(storage.legacyFile)}`;
    produce = () => safeParseLegacyFile(storage.legacyFile);
  } else {
    key = `empty:${storage.dir}`;
    produce = () => ({});
  }

  if (cachedRules && cachedRulesKey === key) {
    return cachedRules;
  }
  cachedRules = produce();
  cachedRulesKey = key;
  return cachedRules;
}

export function resetAccountingRulesCache(): void {
  cachedRules = undefined;
  cachedRulesKey = undefined;
}

export function getAccountingRulesPath(): string {
  const storage = resolveStorage();
  if (storage.mode === "file") return storage.file;
  if (bundleHasConcepts(storage.dir)) return storage.dir;
  if (existsSync(storage.legacyFile)) return storage.legacyFile;
  return storage.dir;
}

function sanitizeMarkdownCell(value: string | number | undefined): string {
  if (value === undefined) return "";
  return String(value).replace(/[|\r\n]+/g, " ").trim();
}

function buildAutoBookingRuleRow(input: SaveAutoBookingRuleInput): string {
  return [
    sanitizeMarkdownCell(input.match),
    sanitizeMarkdownCell(input.category),
    sanitizeMarkdownCell(input.purchase_article_id),
    sanitizeMarkdownCell(input.purchase_account_id),
    sanitizeMarkdownCell(input.purchase_account_dimensions_id),
    sanitizeMarkdownCell(input.liability_account_id),
    sanitizeMarkdownCell(input.vat_rate_dropdown),
    sanitizeMarkdownCell(input.reversed_vat_id),
    sanitizeMarkdownCell(input.reason),
  ].join(" | ");
}

function ensureAutoBookingTable(lines: string[], sectionStart: number, sectionEnd: number): { headerIndex: number; insertIndex: number; updatedLines: string[] } {
  const mutableLines = [...lines];
  let headerIndex = -1;
  for (let index = sectionStart + 1; index < sectionEnd; index++) {
    if (mutableLines[index]?.trim().startsWith("| match |")) {
      headerIndex = index;
      break;
    }
  }

  if (headerIndex !== -1) {
    let insertIndex = headerIndex + 2;
    while (insertIndex < mutableLines.length && mutableLines[insertIndex]?.trim().startsWith("|")) {
      insertIndex += 1;
    }
    return { headerIndex, insertIndex, updatedLines: mutableLines };
  }

  const insertionPoint = sectionStart + 1;
  const tableLines = [
    "",
    "| match | category | purchase_article_id | purchase_account_id | purchase_account_dimensions_id | liability_account_id | vat_rate_dropdown | reversed_vat_id | reason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  mutableLines.splice(insertionPoint, 0, ...tableLines);
  return {
    headerIndex: insertionPoint + 1,
    insertIndex: insertionPoint + 3,
    updatedLines: mutableLines,
  };
}

export function saveAutoBookingRule(input: SaveAutoBookingRuleInput): {
  path: string;
  action: "inserted" | "updated";
  match: string;
  category?: string;
} {
  const storage = resolveStorage();
  if (storage.mode === "file") {
    return legacySaveAutoBookingRule(input, storage.file);
  }
  const parsed = autoBookingRuleSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map(issue => issue.message).join("; "));
  }
  return withBundleLock(storage.dir, () => {
    ensureBundle(storage.dir, storage.legacyFile);
    return saveAutoBookingRuleToBundle(parsed.data, storage.dir);
  });
}

function legacySaveAutoBookingRule(input: SaveAutoBookingRuleInput, path: string): {
  path: string;
  action: "inserted" | "updated";
  match: string;
  category?: string;
} {
  const parsed = autoBookingRuleSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map(issue => issue.message).join("; "));
  }

  const validatedInput = parsed.data;
  if (!existsSync(path)) {
    writeFileSync(path, DEFAULT_RULES_TEMPLATE, "utf8");
  }

  const original = readFileSync(path, "utf8");
  const lines = original.split(/\r?\n/);
  let sectionStart = lines.findIndex(line => line.trim() === "## Auto Booking");
  if (sectionStart === -1) {
    const suffix = original.endsWith("\n") ? "" : "\n";
    writeFileSync(path, `${original}${suffix}\n## Auto Booking\n`, "utf8");
    return legacySaveAutoBookingRule(input, path);
  }
  let sectionEnd = lines.findIndex((line, index) => index > sectionStart && /^##\s+/.test(line.trim()));
  if (sectionEnd === -1) sectionEnd = lines.length;

  const table = ensureAutoBookingTable(lines, sectionStart, sectionEnd);
  const mutableLines = table.updatedLines;
  sectionStart = mutableLines.findIndex(line => line.trim() === "## Auto Booking");
  sectionEnd = mutableLines.findIndex((line, index) => index > sectionStart && /^##\s+/.test(line.trim()));
  if (sectionEnd === -1) sectionEnd = mutableLines.length;

  const matchKey = normalizeAutoBookingRuleMatch(validatedInput.match);
  const categoryKey = (validatedInput.category ?? "").trim().toLowerCase();
  let action: "inserted" | "updated" = "inserted";
  const rowText = `| ${buildAutoBookingRuleRow(validatedInput)} |`;

  for (let index = table.headerIndex + 2; index < sectionEnd; index++) {
    const line = mutableLines[index]?.trim();
    if (!line?.startsWith("|")) break;
    const cells = line
      .split("|")
      .map(cell => cell.trim())
      .filter((_, cellIndex, all) => cellIndex > 0 && cellIndex < all.length - 1);
    const existingMatch = normalizeAutoBookingRuleMatch(cells[0] ?? "");
    const existingCategory = (cells[1] ?? "").toLowerCase();
    if (existingMatch === matchKey && existingCategory === categoryKey) {
      mutableLines[index] = rowText;
      action = "updated";
      writeFileSync(path, `${mutableLines.join("\n")}\n`, "utf8");
      resetAccountingRulesCache();
      return {
        path,
        action,
        match: validatedInput.match,
        category: validatedInput.category,
      };
    }
  }

  mutableLines.splice(table.insertIndex, 0, rowText);
  writeFileSync(path, `${mutableLines.join("\n")}\n`, "utf8");
  resetAccountingRulesCache();
  return {
    path,
    action,
    match: validatedInput.match,
    category: validatedInput.category,
  };
}

export function findAutoBookingRule(
  normalizedCounterparty: string,
  category?: z.infer<typeof transactionCategorySchema>,
): AccountingAutoBookingRule | undefined {
  const rules = loadAccountingRules();
  const matches = rules.auto_booking?.counterparties?.filter((rule) =>
    normalizedCounterparty.includes(
      normalizeAutoBookingRuleMatch(rule.match)
    )
  );
  if (!matches || matches.length === 0) {
    return undefined;
  }
  // Most specific (longest normalized match) wins, deterministically, so the
  // result never depends on counterparty file/row ordering (legacy markdown row
  // order vs bundle filename order).
  const bySpecificity = (a: AccountingAutoBookingRule, b: AccountingAutoBookingRule): number =>
    normalizeAutoBookingRuleMatch(b.match).length - normalizeAutoBookingRuleMatch(a.match).length;
  const pick = (
    predicate: (rule: AccountingAutoBookingRule) => boolean,
  ): AccountingAutoBookingRule | undefined => matches.filter(predicate).sort(bySpecificity)[0];
  if (category !== undefined) {
    return pick(rule => rule.category === category) ?? pick(rule => rule.category === undefined);
  }
  return pick(rule => rule.category === undefined);
}

export function getLiabilityClassificationRule(accountId: number): LiabilityClassificationRule | undefined {
  return loadAccountingRules().annual_report?.liability_classification?.[String(accountId)];
}

export function getCashFlowCategoryRule(accountId: number): CashFlowCategoryRule | undefined {
  return loadAccountingRules().annual_report?.cash_flow_category?.[String(accountId)];
}

export function getCurrentYearProfitAccountRule(): number | undefined {
  return loadAccountingRules().annual_report?.current_year_profit_account;
}

export function getDefaultOwnerExpenseVatDeductionMode(): OwnerExpenseVatDeductionModeRule | undefined {
  return loadAccountingRules().owner_expense_reimbursement?.default_vat_deduction_mode;
}

export function getDefaultOwnerExpenseVatDeductionRatio(): number | undefined {
  return loadAccountingRules().owner_expense_reimbursement?.default_vat_deduction_ratio;
}

export function getOwnerExpenseVatDeductionModeForAccount(
  expenseAccount: number,
): OwnerExpenseVatDeductionModeRule | undefined {
  return loadAccountingRules().owner_expense_reimbursement?.account_overrides?.[String(expenseAccount)]?.mode;
}

export function getOwnerExpenseVatDeductionRatioForAccount(
  expenseAccount: number,
): number | undefined {
  return loadAccountingRules().owner_expense_reimbursement?.account_overrides?.[String(expenseAccount)]?.ratio;
}

// ---------------------------------------------------------------------------
// OKF (Open Knowledge Format) bundle storage
//
// A bundle is a directory of markdown concept files with YAML frontmatter,
// following Open Knowledge Format v0.1 conventions (reserved `index.md` and
// `log.md`, one concept per file, `/`-rooted cross links). The public read API
// above is unchanged; only the on-disk representation differs from the legacy
// single-file `accounting-rules.md`, which stays supported for back-compat and
// is migrated into a bundle on first write.
// ---------------------------------------------------------------------------

const AUTO_BOOKING_SUBDIR = "auto-booking";
const OWNER_EXPENSE_FILE = ["owner-expense", "policy.md"];
const ANNUAL_REPORT_SUBDIR = "annual-report";
const ANNUAL_REPORT_SETTINGS_FILE = ["annual-report", "settings.md"];
const ANNUAL_REPORT_LIABILITY_FILE = ["annual-report", "liability-classification.md"];
const ANNUAL_REPORT_CASHFLOW_FILE = ["annual-report", "cash-flow-category.md"];

interface ParsedConcept {
  frontmatter: Record<string, string>;
  body: string;
}

function stripFrontmatterQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  return value;
}

/**
 * Minimal, tolerant YAML-frontmatter reader for the flat scalar key/value pairs
 * we write. It deliberately ignores nested structures, list items and unknown
 * lines so hand-edited files never throw (OKF asks consumers to tolerate
 * unknown keys and shapes). Numeric coercion/validation happens downstream via
 * the existing zod schemas.
 */
function parseFrontmatter(content: string): ParsedConcept {
  const normalized = content.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: normalized };
  }
  const frontmatter: Record<string, string> = {};
  let index = 1;
  for (; index < lines.length; index++) {
    if (lines[index]!.trim() === "---") {
      index++;
      break;
    }
    const line = lines[index]!;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (!key || key.startsWith("#") || key.startsWith("-")) continue;
    frontmatter[key] = stripFrontmatterQuotes(line.slice(separator + 1).trim());
  }
  return { frontmatter, body: lines.slice(index).join("\n") };
}

// Strings that a YAML parser would otherwise read as a non-string (so external
// OKF consumers keep them as strings). Numeric *fields* are serialized from a
// `number` and stay bare; only string values matching these are quoted.
const YAML_AMBIGUOUS_SCALAR = /^(?:true|false|null|yes|no|on|off|~|[+-]?(?:\d[\d_]*)(?:\.\d*)?(?:[eE][+-]?\d+)?|[+-]?\.\d+|\d{4}-\d{2}-\d{2}.*)$/i;

function serializeFrontmatterValue(value: string | number): string {
  // Numeric fields stay bare.
  if (typeof value === "number") return String(value);
  // Frontmatter scalars are single-line: collapse any newlines (e.g. from
  // OCR-derived reason/match text) to spaces so a value can never break out of
  // the `---` block or fail to round-trip. Mirrors the legacy table writer's
  // sanitizeMarkdownCell, then quotes anything YAML-significant or ambiguous.
  const text = value.replace(/[\r\n]+/g, " ");
  if (
    text === ""
    || /[:#]/.test(text)
    || /^\s|\s$/.test(text)
    || /^[>|&*!%@`"'[\]{}?-]/.test(text)
    || YAML_AMBIGUOUS_SCALAR.test(text)
  ) {
    return `"${text.replace(/"/g, '\\"')}"`;
  }
  return text;
}

function buildConcept(frontmatter: Array<[string, string | number | undefined]>, body: string): string {
  const out = ["---"];
  for (const [key, value] of frontmatter) {
    if (value === undefined || value === "") continue;
    out.push(`${key}: ${serializeFrontmatterValue(value)}`);
  }
  out.push("---", "");
  const trimmedBody = body.replace(/\s+$/, "");
  if (trimmedBody) {
    out.push(trimmedBody, "");
  }
  return out.join("\n");
}

function buildMarkdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map(row => `| ${row.map(cell => sanitizeMarkdownCell(cell)).join(" | ")} |`),
  ].join("\n");
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function bundleRelativeLink(rel: string): string {
  return `/${rel.replace(/\\/g, "/")}`;
}

function isoNow(): string {
  return new Date().toISOString();
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

function getBundleSignature(dir: string): string {
  if (!existsSync(dir)) return `${dir}:missing`;
  const parts = listBundleMarkdownFiles(dir).map((rel) => {
    const info = statSync(resolve(dir, rel));
    return `${rel}:${info.mtimeMs}:${info.size}`;
  });
  parts.sort();
  return `${dir}|${parts.join(",")}`;
}

// ---- Bundle reading -------------------------------------------------------

function readAutoBookingConcepts(dir: string): AccountingAutoBookingRule[] {
  const subdir = resolve(dir, AUTO_BOOKING_SUBDIR);
  if (!existsSync(subdir)) return [];
  const rules: AccountingAutoBookingRule[] = [];
  for (const name of readdirSync(subdir).sort()) {
    if (!name.endsWith(".md") || name === "index.md") continue;
    const { frontmatter } = parseFrontmatter(readFileSync(resolve(subdir, name), "utf8"));
    const parsed = autoBookingRuleSchema.safeParse({
      match: emptyToUndefined(frontmatter.match),
      category: emptyToUndefined(frontmatter.category)?.toLowerCase(),
      purchase_article_id: parseOptionalInt(frontmatter.purchase_article_id),
      purchase_account_id: parseOptionalInt(frontmatter.purchase_account_id),
      purchase_account_dimensions_id: parseOptionalInt(frontmatter.purchase_account_dimensions_id),
      liability_account_id: parseOptionalInt(frontmatter.liability_account_id),
      vat_rate_dropdown: emptyToUndefined(frontmatter.vat_rate_dropdown),
      reversed_vat_id: parseOptionalInt(frontmatter.reversed_vat_id),
      reason: emptyToUndefined(frontmatter.reason),
    });
    if (parsed.success) {
      rules.push(parsed.data);
    }
  }
  return rules;
}

function readOwnerExpenseConcept(dir: string): AccountingRules["owner_expense_reimbursement"] {
  const file = resolve(dir, ...OWNER_EXPENSE_FILE);
  if (!existsSync(file)) return undefined;
  const { frontmatter, body } = parseFrontmatter(readFileSync(file, "utf8"));
  const rules: NonNullable<AccountingRules["owner_expense_reimbursement"]> = {};

  const mode = emptyToUndefined(frontmatter.default_vat_deduction_mode)?.toLowerCase();
  if (mode) {
    const parsed = ownerExpenseVatRuleSchema.safeParse({
      mode,
      ratio: parseOptionalRatio(frontmatter.default_vat_deduction_ratio),
    });
    if (parsed.success) {
      rules.default_vat_deduction_mode = parsed.data.mode;
      if (parsed.data.ratio !== undefined) {
        rules.default_vat_deduction_ratio = parsed.data.ratio;
      }
    }
  }

  const overrides: NonNullable<NonNullable<AccountingRules["owner_expense_reimbursement"]>["account_overrides"]> = {};
  for (const row of parseMarkdownTable(body.split(/\r?\n/))) {
    const accountId = row.expense_account;
    const parsed = ownerExpenseVatRuleSchema.safeParse({
      mode: row.vat_deduction_mode?.toLowerCase(),
      ratio: parseOptionalRatio(row.vat_deduction_ratio),
    });
    if (!accountId || !parsed.success) continue;
    overrides[accountId] = parsed.data;
  }
  if (Object.keys(overrides).length > 0) {
    rules.account_overrides = overrides;
  }

  return Object.keys(rules).length > 0 ? rules : undefined;
}

function readAnnualReportConcepts(dir: string): AccountingRules["annual_report"] {
  const settingsFile = resolve(dir, ...ANNUAL_REPORT_SETTINGS_FILE);
  const liabilityFile = resolve(dir, ...ANNUAL_REPORT_LIABILITY_FILE);
  const cashFlowFile = resolve(dir, ...ANNUAL_REPORT_CASHFLOW_FILE);

  let currentYearProfitAccount: number | undefined;
  if (existsSync(settingsFile)) {
    const { frontmatter } = parseFrontmatter(readFileSync(settingsFile, "utf8"));
    currentYearProfitAccount = parseOptionalInt(frontmatter.current_year_profit_account);
  }

  const liabilityClassification: Record<string, LiabilityClassificationRule> = {};
  if (existsSync(liabilityFile)) {
    const { body } = parseFrontmatter(readFileSync(liabilityFile, "utf8"));
    for (const row of parseMarkdownTable(body.split(/\r?\n/))) {
      const accountId = row.account_id;
      const classification = row.classification?.toLowerCase();
      if (!accountId || (classification !== "current" && classification !== "non_current")) continue;
      liabilityClassification[accountId] = classification;
    }
  }

  const cashFlowCategory: Record<string, CashFlowCategoryRule> = {};
  if (existsSync(cashFlowFile)) {
    const { body } = parseFrontmatter(readFileSync(cashFlowFile, "utf8"));
    for (const row of parseMarkdownTable(body.split(/\r?\n/))) {
      const accountId = row.account_id;
      const category = row.category?.toLowerCase();
      if (!accountId || (category !== "operating" && category !== "investing" && category !== "financing")) continue;
      cashFlowCategory[accountId] = category;
    }
  }

  if (
    currentYearProfitAccount === undefined &&
    Object.keys(liabilityClassification).length === 0 &&
    Object.keys(cashFlowCategory).length === 0
  ) {
    return undefined;
  }
  return {
    ...(currentYearProfitAccount !== undefined ? { current_year_profit_account: currentYearProfitAccount } : {}),
    ...(Object.keys(liabilityClassification).length > 0 ? { liability_classification: liabilityClassification } : {}),
    ...(Object.keys(cashFlowCategory).length > 0 ? { cash_flow_category: cashFlowCategory } : {}),
  };
}

function loadBundleRules(dir: string): AccountingRules {
  const counterparties = readAutoBookingConcepts(dir);
  return accountingRulesSchema.parse({
    auto_booking: counterparties.length > 0 ? { counterparties } : undefined,
    owner_expense_reimbursement: readOwnerExpenseConcept(dir),
    annual_report: readAnnualReportConcepts(dir),
  });
}

// ---- Bundle writing -------------------------------------------------------

function stableShortHash(value: string): string {
  // FNV-1a 32-bit — deterministic, dependency-free, only used to disambiguate
  // degenerate slugs.
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function autoBookingConceptSlug(match: string, category?: string): string {
  const slugify = (value: string): string =>
    value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const normalized = normalizeAutoBookingRuleMatch(match);
  // The normalized match is already [a-z0-9], so distinct matches slugify to
  // distinct bases; only the degenerate empty case can collide. Disambiguate it
  // with a short stable hash so punctuation-only names cannot clobber each other.
  const base = slugify(normalized) || `rule-${stableShortHash(normalized || match)}`;
  const categorySlug = slugify(category ?? "");
  return categorySlug ? `${base}--${categorySlug}` : base;
}

function autoBookingConceptRelativeTarget(match: string, category?: string): string {
  return `${AUTO_BOOKING_SUBDIR}/${autoBookingConceptSlug(match, category)}.md`;
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function findRuleMigrationConflicts(
  rules: AccountingAutoBookingRule[],
): Array<{ canonicalKey: string; sourceMatches: string[] }> {
  const sourcesByTarget = new Map<string, string[]>();

  for (const rule of rules) {
    const canonicalKey = autoBookingConceptRelativeTarget(rule.match, rule.category);
    const sourceMatches = sourcesByTarget.get(canonicalKey) ?? [];
    sourceMatches.push(rule.match);
    sourcesByTarget.set(canonicalKey, sourceMatches);
  }

  return [...sourcesByTarget.entries()]
    .filter(([, sourceMatches]) => sourceMatches.length > 1)
    .map(([canonicalKey, sourceMatches]) => ({
      canonicalKey,
      sourceMatches: [...sourceMatches].sort(compareCodePoints),
    }))
    .sort((a, b) => compareCodePoints(a.canonicalKey, b.canonicalKey));
}

function assertNoRuleMigrationConflicts(rules: AccountingRules): void {
  const conflicts = findRuleMigrationConflicts(rules.auto_booking?.counterparties ?? []);
  if (conflicts.length === 0) return;

  const details = conflicts
    .map(conflict =>
      `${conflict.canonicalKey} <= [${conflict.sourceMatches.map(source => JSON.stringify(source)).join(", ")}]`
    )
    .join("; ");
  throw new Error(
    `Normalized rule collision: ${details}. ` +
    "Resolve duplicate legacy rows so every normalized auto-booking target is unique before retrying migration.",
  );
}

function buildAutoBookingConcept(rule: AccountingAutoBookingRule): string {
  const oneLine = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();
  const title = rule.category ? `${rule.match} — ${rule.category}` : rule.match;
  const body = rule.reason
    ? `Auto-booking rule for ${oneLine(rule.match)}. ${oneLine(rule.reason)}`
    : `Auto-booking rule for ${oneLine(rule.match)}.`;
  return buildConcept(
    [
      ["type", "SupplierBookingRule"],
      ["title", title],
      ["match", rule.match],
      ["category", rule.category],
      ["purchase_article_id", rule.purchase_article_id],
      ["purchase_account_id", rule.purchase_account_id],
      ["purchase_account_dimensions_id", rule.purchase_account_dimensions_id],
      ["liability_account_id", rule.liability_account_id],
      ["vat_rate_dropdown", rule.vat_rate_dropdown],
      ["reversed_vat_id", rule.reversed_vat_id],
      ["reason", rule.reason],
      ["timestamp", isoNow()],
    ],
    body,
  );
}

function writeAutoBookingConcept(dir: string, rule: AccountingAutoBookingRule): { file: string; rel: string; action: "inserted" | "updated" } {
  const rel = autoBookingConceptRelativeTarget(rule.match, rule.category);
  const file = resolve(dir, rel);
  const action: "inserted" | "updated" = existsSync(file) ? "updated" : "inserted";
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buildAutoBookingConcept(rule), "utf8");
  return { file, rel, action };
}

function writeOwnerExpenseConcept(dir: string, oe: NonNullable<AccountingRules["owner_expense_reimbursement"]>): string {
  const rel = join(...OWNER_EXPENSE_FILE);
  const file = resolve(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  const overrides = oe.account_overrides ?? {};
  const rows = Object.entries(overrides).map(([account, rule]) => [
    account,
    rule.mode,
    rule.ratio !== undefined ? String(rule.ratio) : "",
  ]);
  const body = rows.length > 0
    ? `# Schema\n\n${buildMarkdownTable(["expense_account", "vat_deduction_mode", "vat_deduction_ratio"], rows)}`
    : "";
  writeFileSync(file, buildConcept(
    [
      ["type", "OwnerExpenseVatPolicy"],
      ["title", "Owner expense VAT deduction policy"],
      ["default_vat_deduction_mode", oe.default_vat_deduction_mode],
      ["default_vat_deduction_ratio", oe.default_vat_deduction_ratio],
      ["timestamp", isoNow()],
    ],
    body,
  ), "utf8");
  return rel;
}

function writeAnnualReportConcepts(dir: string, ar: NonNullable<AccountingRules["annual_report"]>): string[] {
  const written: string[] = [];
  mkdirSync(resolve(dir, ANNUAL_REPORT_SUBDIR), { recursive: true });

  if (ar.current_year_profit_account !== undefined) {
    const rel = join(...ANNUAL_REPORT_SETTINGS_FILE);
    writeFileSync(resolve(dir, rel), buildConcept(
      [
        ["type", "AnnualReportSetting"],
        ["title", "Annual report settings"],
        ["current_year_profit_account", ar.current_year_profit_account],
        ["timestamp", isoNow()],
      ],
      "",
    ), "utf8");
    written.push(rel);
  }

  if (ar.liability_classification && Object.keys(ar.liability_classification).length > 0) {
    const rel = join(...ANNUAL_REPORT_LIABILITY_FILE);
    const rows = Object.entries(ar.liability_classification).map(([account, classification]) => [account, classification]);
    writeFileSync(resolve(dir, rel), buildConcept(
      [
        ["type", "LiabilityClassification"],
        ["title", "Liability maturity classification overrides"],
        ["timestamp", isoNow()],
      ],
      `# Schema\n\n${buildMarkdownTable(["account_id", "classification"], rows)}`,
    ), "utf8");
    written.push(rel);
  }

  if (ar.cash_flow_category && Object.keys(ar.cash_flow_category).length > 0) {
    const rel = join(...ANNUAL_REPORT_CASHFLOW_FILE);
    const rows = Object.entries(ar.cash_flow_category).map(([account, category]) => [account, category]);
    writeFileSync(resolve(dir, rel), buildConcept(
      [
        ["type", "CashFlowCategory"],
        ["title", "Cash flow statement category overrides"],
        ["timestamp", isoNow()],
      ],
      `# Schema\n\n${buildMarkdownTable(["account_id", "category"], rows)}`,
    ), "utf8");
    written.push(rel);
  }

  return written;
}

function scaffoldBundle(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const logFile = resolve(dir, "log.md");
  if (!existsSync(logFile)) {
    writeFileSync(logFile, "# Log\n", "utf8");
  }
}

function regenerateBundleIndex(dir: string): void {
  const lines: string[] = [
    "---",
    `okf_version: "${OKF_VERSION}"`,
    "type: Index",
    "title: Accounting knowledge",
    "---",
    "",
    "# Accounting knowledge",
    "",
    "Company-specific accounting knowledge the ledger cannot prove by itself, in Open Knowledge Format (OKF) v0.1.",
    "",
  ];
  for (const rel of listBundleMarkdownFiles(dir).sort()) {
    if (rel === "index.md" || rel === "log.md") continue;
    const { frontmatter } = parseFrontmatter(readFileSync(resolve(dir, rel), "utf8"));
    const title = frontmatter.title || rel;
    const type = frontmatter.type || "Concept";
    lines.push(`- [${title}](${bundleRelativeLink(rel)}) — ${type}`);
  }
  lines.push("");
  writeFileSync(resolve(dir, "index.md"), lines.join("\n"), "utf8");
}

function appendBundleLog(dir: string, messages: string[]): void {
  if (messages.length === 0) return;
  const logFile = resolve(dir, "log.md");
  const existing = existsSync(logFile) ? readFileSync(logFile, "utf8") : "# Log\n";
  const lines = existing.split(/\r?\n/);
  const date = isoNow().slice(0, 10);
  const entries = messages.map(message => `- ${message}`);

  let titleIndex = lines.findIndex(line => line.trim() === "# Log");
  if (titleIndex === -1) {
    lines.unshift("# Log", "");
    titleIndex = 0;
  }
  const firstHeadingIndex = lines.findIndex((line, i) => i > titleIndex && /^##\s+/.test(line.trim()));
  if (firstHeadingIndex !== -1 && lines[firstHeadingIndex]!.trim() === `## ${date}`) {
    lines.splice(firstHeadingIndex + 1, 0, ...entries);
  } else {
    lines.splice(titleIndex + 1, 0, "", `## ${date}`, ...entries);
  }
  writeFileSync(logFile, `${lines.join("\n").replace(/\s+$/, "")}\n`, "utf8");
}

/**
 * Convert a legacy single-file `accounting-rules.md` into an OKF bundle.
 * Non-destructive: the legacy file is moved aside to `<file>.migrated` so it
 * cannot silently diverge from the bundle, never deleted. Exported for tooling
 * and tests.
 */
type MigrationResult = {
  migrated: boolean;
  source: string;
  bundle: string;
  counterparties: number;
  files: string[];
};

export function migrateLegacyRulesToBundle(legacyFile: string, dir: string): MigrationResult {
  if (existsSync(legacyFile)) {
    let preflightRules: AccountingRules | undefined;
    try {
      preflightRules = parseMarkdownRules(readFileSync(legacyFile, "utf-8"));
    } catch {
      // Preserve the locked path's existing unreadable/invalid-source warning
      // and refusal semantics rather than duplicating diagnostics here.
    }
    if (preflightRules) assertNoRuleMigrationConflicts(preflightRules);
  }
  return withBundleLock(dir, () => migrateLegacyRulesToBundleLocked(legacyFile, dir));
}

function migrateLegacyRulesToBundleLocked(legacyFile: string, dir: string): MigrationResult {
  // Parse strictly so we can tell "legacy file genuinely empty" from "could not
  // read/parse it". We must never archive the only source after a failure.
  const legacyExists = existsSync(legacyFile);
  let rules: AccountingRules = {};
  let parsedCleanly = false;
  let parseError = "";
  try {
    rules = legacyExists ? parseMarkdownRules(readFileSync(legacyFile, "utf-8")) : {};
    parsedCleanly = true;
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
    process.stderr.write(`WARNING: Could not migrate accounting rules from ${legacyFile}: ${parseError}\n`);
  }
  // Data-safety gate: a legacy file that exists but could not be read/parsed may
  // hold rules we cannot see. Refuse to build an (empty) bundle that would
  // permanently shadow it — failing the write loudly is far safer for accounting
  // data than silently stranding the source. The operator fixes/moves it first.
  if (legacyExists && !parsedCleanly) {
    throw new Error(
      `Refusing to migrate ${legacyFile}: it exists but could not be read or parsed (${parseError}). ` +
      "Fix or move that file before writing accounting rules, so its contents are not lost.",
    );
  }
  assertNoRuleMigrationConflicts(rules);
  const counterparties = rules.auto_booking?.counterparties ?? [];

  const buildInto = (target: string): string[] => {
    scaffoldBundle(target);
    const written: string[] = [];
    for (const rule of counterparties) {
      written.push(writeAutoBookingConcept(target, rule).rel);
    }
    if (rules.owner_expense_reimbursement) {
      written.push(writeOwnerExpenseConcept(target, rules.owner_expense_reimbursement));
    }
    if (rules.annual_report) {
      written.push(...writeAnnualReportConcepts(target, rules.annual_report));
    }
    regenerateBundleIndex(target);
    return written;
  };

  let files: string[];
  if (existsSync(dir) && bundleHasConcepts(dir)) {
    // `dir` is already an authoritative bundle (has real concepts). Merge the
    // legacy-derived concepts in place (writeAutoBookingConcept upserts by slug)
    // rather than replacing real concept files wholesale. The normal save path
    // never reaches here (ensureBundle returns early for an authoritative dir);
    // this only guards a direct migrateLegacyRulesToBundle() call from tooling.
    files = buildInto(dir);
  } else {
    // New or non-authoritative (reserved-only / empty) `dir`: build the bundle
    // fully in a staging sibling, then expose it via an atomic rename, so an
    // interrupted migration can never leave a half-written bundle that a later
    // run would treat as authoritative (and shadow the still-present legacy file).
    // Staging is a sibling of `dir` (same parent → same filesystem → atomic rename).
    const staging = `${dir}.migrating`;
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    files = buildInto(staging);
    if (existsSync(dir)) {
      // Reserved-only/empty dir exists: we cannot rename onto a non-empty dir, so
      // move it aside, swap in the finished bundle, then drop the backup. A crash
      // mid-swap leaves `dir` intact or briefly absent (backup recoverable), never
      // a partially built bundle.
      const backup = `${dir}.replacing`;
      if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
      renameSync(dir, backup);
      try {
        renameSync(staging, dir);
      } catch (error) {
        renameSync(backup, dir); // roll back to the original directory
        throw error;
      }
      rmSync(backup, { recursive: true, force: true });
    } else {
      renameSync(staging, dir);
    }
  }

  // Archive the legacy file only after the bundle is in place AND only when it
  // was read/parsed cleanly, so a read/parse failure never moves the only
  // source aside and silently empties the rules.
  if (parsedCleanly && existsSync(legacyFile)) {
    const archived = `${legacyFile}.migrated`;
    try {
      if (!existsSync(archived)) {
        renameSync(legacyFile, archived);
      }
    } catch {
      // Leave the legacy file in place if it cannot be moved; the authoritative
      // bundle still takes precedence on the next read.
    }
  }

  appendBundleLog(dir, [
    `migrated ${counterparties.length} auto-booking rule(s) and ${files.length} concept file(s) from ${legacyFile}`,
  ]);
  regenerateBundleIndex(dir);

  return { migrated: true, source: legacyFile, bundle: dir, counterparties: counterparties.length, files };
}

function ensureBundle(dir: string, legacyFile: string): void {
  // An authoritative bundle (has real concepts) is ready to write to as-is.
  if (bundleHasConcepts(dir)) return;
  // Otherwise, if a legacy file still holds rules, migrate them in first so they
  // are never lost — even when a bare/reserved-only bundle dir already exists.
  if (existsSync(legacyFile)) {
    migrateLegacyRulesToBundle(legacyFile, dir);
    return;
  }
  // No legacy and no concepts: make sure a writable scaffold exists.
  if (isInitializedBundle(dir)) return;
  scaffoldBundle(dir);
  regenerateBundleIndex(dir);
}

function saveAutoBookingRuleToBundle(rule: AccountingAutoBookingRule, dir: string): {
  path: string;
  action: "inserted" | "updated";
  match: string;
  category?: string;
} {
  const { file, rel, action } = writeAutoBookingConcept(dir, rule);
  appendBundleLog(dir, [
    `${action} ${rel} (match: ${rule.match}${rule.category ? `, category: ${rule.category}` : ""})`,
  ]);
  regenerateBundleIndex(dir);
  resetAccountingRulesCache();
  return { path: file, action, match: rule.match, category: rule.category };
}

// ---- Browsable knowledge surface (for MCP resource exposure) --------------

export const ACCOUNTING_KNOWLEDGE_URI_BASE = "earveldaja://accounting_knowledge";

export interface AccountingKnowledgeConcept {
  /** Bundle-relative path, e.g. "auto-booking/openai--saas-subscriptions.md". */
  rel: string;
  /** Full MCP resource URI for this concept. */
  uri: string;
  title: string;
  description: string;
  type: string;
}

export interface AccountingKnowledgeOverview {
  /** `bundle` when an OKF bundle exists, `legacy-file` for the single-file
   *  store, `empty` when nothing has been written yet. */
  mode: "bundle" | "legacy-file" | "empty";
  /** Bundle directory or legacy file path that backs the knowledge. */
  root: string;
  /** Markdown to return for the top-level knowledge resource (the bundle
   *  `index.md`, the legacy file, or a short placeholder). */
  indexMarkdown: string;
  /** Individually addressable concept files (bundle mode only). */
  concepts: AccountingKnowledgeConcept[];
}

const EMPTY_KNOWLEDGE_NOTE = `# Accounting knowledge

No company-specific accounting knowledge has been recorded yet. Rules are created
on approval via \`save_auto_booking_rule\` and stored as an Open Knowledge Format
(OKF) v0.1 bundle. Until then, bookings rely on supplier history and reference data.
`;

function accountingKnowledgeConceptUri(rel: string): string {
  // Percent-encode each path segment (bundles are human-editable, so a concept
  // filename may contain spaces or reserved characters); slashes stay literal.
  const encoded = rel.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
  return `${ACCOUNTING_KNOWLEDGE_URI_BASE}/${encoded}`;
}

/** Lists the knowledge bundle for browsing as MCP resources. Read-only. */
export function getAccountingKnowledgeOverview(): AccountingKnowledgeOverview {
  const storage = resolveStorage();

  // Use the same authoritative test as loadAccountingRules()/getAccountingRulesPath():
  // a reserved-only bundle (index/log, no concepts) must NOT be surfaced as the
  // source while a legacy file still holds the rules the booking logic reads.
  if (storage.mode === "bundle" && bundleHasConcepts(storage.dir)) {
    const concepts: AccountingKnowledgeConcept[] = [];
    for (const raw of listBundleMarkdownFiles(storage.dir).sort()) {
      const rel = raw.replace(/\\/g, "/");
      if (rel === "index.md") continue;
      const { frontmatter } = parseFrontmatter(readFileSync(resolve(storage.dir, raw), "utf8"));
      const type = frontmatter.type || (rel === "log.md" ? "Log" : "Concept");
      concepts.push({
        rel,
        uri: accountingKnowledgeConceptUri(rel),
        title: frontmatter.title || rel,
        description: frontmatter.description || type,
        type,
      });
    }
    const indexFile = resolve(storage.dir, "index.md");
    const indexMarkdown = existsSync(indexFile)
      ? readFileSync(indexFile, "utf8")
      : EMPTY_KNOWLEDGE_NOTE;
    return { mode: "bundle", root: storage.dir, indexMarkdown, concepts };
  }

  const legacyFile = storage.mode === "file" ? storage.file : storage.legacyFile;
  if (existsSync(legacyFile)) {
    return {
      mode: "legacy-file",
      root: legacyFile,
      indexMarkdown: readFileSync(legacyFile, "utf8"),
      concepts: [],
    };
  }

  return {
    mode: "empty",
    root: storage.mode === "file" ? storage.file : storage.dir,
    indexMarkdown: EMPTY_KNOWLEDGE_NOTE,
    concepts: [],
  };
}

/**
 * Reads a single concept file from the knowledge bundle by its bundle-relative
 * path. Returns `undefined` for anything that is not a `.md` file inside the
 * bundle. Hardened against path traversal: the resolved path (symlinks
 * included) must stay within the bundle directory.
 */
export function readAccountingKnowledgeConcept(rel: string): { rel: string; text: string } | undefined {
  const storage = resolveStorage();
  if (storage.mode !== "bundle" || !bundleHasConcepts(storage.dir)) return undefined;

  const cleaned = rel.replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("\0") || !cleaned.endsWith(".md")) return undefined;

  try {
    const resolved = resolve(storage.dir, cleaned);
    const relCheck = relative(storage.dir, resolved);
    if (relCheck.startsWith("..") || isAbsolute(relCheck)) return undefined;
    if (!existsSync(resolved)) return undefined;

    // Re-check containment after resolving symlinks (matches the file-read
    // posture used elsewhere in the server).
    const realBase = realpathSync(storage.dir);
    const realTarget = realpathSync(resolved);
    const relReal = relative(realBase, realTarget);
    if (relReal.startsWith("..") || isAbsolute(relReal)) return undefined;
    if (!realTarget.endsWith(".md")) return undefined;

    return { rel: relCheck.replace(/\\/g, "/"), text: readFileSync(realTarget, "utf8") };
  } catch {
    // Any fs/path error (null bytes, races, permission) is treated as "not found"
    // rather than leaking an internal error through the resource handler.
    return undefined;
  }
}
