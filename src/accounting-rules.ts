import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { isAbsolute, resolve } from "path";
import { z } from "zod";
import { getProjectRoot } from "./paths.js";
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
let cachedRulesPath: string | undefined;
let cachedRulesSignature: string | undefined;

const AUTO_BOOKING_RULE_ACTION_FIELDS = [
  "purchase_article_id",
  "purchase_account_id",
  "purchase_account_dimensions_id",
  "liability_account_id",
  "vat_rate_dropdown",
  "reversed_vat_id",
] as const;

function getRulesPath(): string {
  const configured = process.env.EARVELDAJA_RULES_FILE?.trim();
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }
  return resolve(getProjectRoot(), "accounting-rules.md");
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
  const liabilityRows = parseMarkdownTable(sectionMap.get("liability_classification") ?? []);
  const cashFlowRows = parseMarkdownTable(sectionMap.get("cash_flow_category") ?? []);

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

  if (Object.keys(liabilityClassification).length === 0 && Object.keys(cashFlowCategory).length === 0) {
    return undefined;
  }

  return {
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

function loadAccountingRules(): AccountingRules {
  const filePath = getRulesPath();
  const signature = getRulesSignature(filePath);
  if (cachedRules && cachedRulesPath === filePath && cachedRulesSignature === signature) {
    return cachedRules;
  }

  cachedRulesPath = filePath;
  if (!existsSync(filePath)) {
    cachedRules = {};
    cachedRulesSignature = signature;
    return cachedRules;
  }

  try {
    const parsed = parseMarkdownRules(readFileSync(filePath, "utf-8"));
    cachedRules = parsed;
    cachedRulesSignature = signature;
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`WARNING: Could not load accounting rules from ${filePath}: ${message}\n`);
    cachedRules = {};
    cachedRulesSignature = signature;
    return cachedRules;
  }
}

export function resetAccountingRulesCache(): void {
  cachedRules = undefined;
  cachedRulesPath = undefined;
  cachedRulesSignature = undefined;
}

export function getAccountingRulesPath(): string {
  return getRulesPath();
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
  const parsed = autoBookingRuleSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map(issue => issue.message).join("; "));
  }

  const validatedInput = parsed.data;
  const path = getRulesPath();
  if (!existsSync(path)) {
    writeFileSync(path, DEFAULT_RULES_TEMPLATE, "utf8");
  }

  const original = readFileSync(path, "utf8");
  const lines = original.split(/\r?\n/);
  let sectionStart = lines.findIndex(line => line.trim() === "## Auto Booking");
  if (sectionStart === -1) {
    const suffix = original.endsWith("\n") ? "" : "\n";
    writeFileSync(path, `${original}${suffix}\n## Auto Booking\n`, "utf8");
    return saveAutoBookingRule(input);
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
  if (category !== undefined) {
    return matches.find(rule => rule.category === category) ?? matches.find(rule => rule.category === undefined);
  }
  return matches.find(rule => rule.category === undefined);
}

export function getLiabilityClassificationRule(accountId: number): LiabilityClassificationRule | undefined {
  return loadAccountingRules().annual_report?.liability_classification?.[String(accountId)];
}

export function getCashFlowCategoryRule(accountId: number): CashFlowCategoryRule | undefined {
  return loadAccountingRules().annual_report?.cash_flow_category?.[String(accountId)];
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
