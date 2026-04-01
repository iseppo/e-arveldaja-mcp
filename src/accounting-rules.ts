import { existsSync, readFileSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";
import { z } from "zod";
import { getProjectRoot } from "./paths.js";

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

const autoBookingRuleSchema = z.object({
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

let cachedRules: AccountingRules | undefined;
let cachedRulesPath: string | undefined;
let cachedRulesSignature: string | undefined;

function getRulesPath(): string {
  const configured = process.env.EARVELDAJA_RULES_FILE?.trim();
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }
  return resolve(getProjectRoot(), "accounting-rules.md");
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, "_");
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

export function findAutoBookingRule(
  normalizedCounterparty: string,
  category?: z.infer<typeof transactionCategorySchema>,
): AccountingAutoBookingRule | undefined {
  const rules = loadAccountingRules();
  return rules.auto_booking?.counterparties?.find((rule) =>
    normalizedCounterparty.includes(rule.match.toLowerCase()) &&
    (rule.category === undefined || rule.category === category),
  );
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
