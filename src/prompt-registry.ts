import { z } from "zod";
import type { ToolExposureConfig } from "./config.js";
import { renderVatMetadataTokens } from "./estonian-tax-rules.js";
import {
  parseAbsolutePath,
  parseExactBoolean,
  parseFiniteNumber,
  parseIdentifier,
  parseIsoDate,
  parseJsonObject,
  parseMonth,
  parsePositiveInteger,
} from "./prompt-arguments.js";

export interface SetupPromptOptions {
  offlineTools?: readonly string[];
  note?: string;
}

export interface PromptVariant {
  name: string;
  advertisedTools: readonly string[];
  featurePredicate: (toolExposure: ToolExposureConfig | undefined) => boolean;
}

export interface PromptDefinition {
  name: string;
  slug: string;
  description: string;
  argsSchema: z.ZodRawShape | undefined;
  setupOptions: SetupPromptOptions | undefined;
  featurePredicate: (toolExposure: ToolExposureConfig | undefined) => boolean;
  variants: readonly PromptVariant[];
}

type StringParser<T> = (value: string) => T;

function parsedString<T>(parser: StringParser<T>, requirement: string) {
  return z.string().transform((value, context) => {
    try {
      return parser(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: `Expected ${requirement}`,
      });
      return z.NEVER;
    }
  });
}

function positiveId(description: string) {
  return parsedString(parsePositiveInteger, "a canonical positive integer")
    .describe(description);
}

function optionalPositiveId(description: string) {
  return parsedString(parsePositiveInteger, "a canonical positive integer")
    .optional()
    .describe(description);
}

function optionalFiniteNumber(description: string, range: { min?: number; max?: number } = {}) {
  return parsedString(value => parseFiniteNumber(value, range), "a canonical finite decimal number")
    .optional()
    .describe(description);
}

function absolutePath(description: string) {
  return parsedString(parseAbsolutePath, "a bounded absolute path")
    .describe(description);
}

function optionalAbsolutePath(description: string) {
  return parsedString(parseAbsolutePath, "a bounded absolute path")
    .optional()
    .describe(description);
}

function optionalDate(description: string) {
  return parsedString(parseIsoDate, "a real date in YYYY-MM-DD format")
    .optional()
    .describe(description);
}

function jsonObject(description: string) {
  return parsedString(parseJsonObject, "a bounded JSON object")
    .describe(description);
}

function optionalJsonObject(description: string) {
  return parsedString(parseJsonObject, "a bounded JSON object")
    .optional()
    .describe(description);
}

function enabled(): boolean {
  return true;
}

const taxEnabled = (toolExposure: ToolExposureConfig | undefined): boolean =>
  toolExposure?.enableTaxTools !== false;
const lightyearEnabled = (toolExposure: ToolExposureConfig | undefined): boolean =>
  toolExposure?.enableLightyear !== false;
const salesEnabled = (toolExposure: ToolExposureConfig | undefined): boolean =>
  toolExposure?.enableSales !== false;
const NO_VARIANTS: readonly PromptVariant[] = Object.freeze([]);
const COMPANY_OVERVIEW_VARIANTS: readonly PromptVariant[] = [{
  name: "sales",
  advertisedTools: ["compute_receivables_aging"],
  featurePredicate: salesEnabled,
}];
const MONTH_END_VARIANTS: readonly PromptVariant[] = [{
  name: "sales",
  advertisedTools: ["confirm_sale_invoice"],
  featurePredicate: salesEnabled,
}];

const PROMPT_DEFINITIONS = [
  {
    name: "vat-registration-threshold",
    slug: "vat-registration-threshold",
    description: renderVatMetadataTokens("Check whether a non-VAT-registered company is approaching or exceeding the {{E_ARVELDAJA_VAT:THRESHOLD_DISPLAY}} VAT registration threshold (scope effective {{E_ARVELDAJA_VAT:SCOPE_EFFECTIVE_DATE}}, facts verified {{E_ARVELDAJA_VAT:VERIFIED_DATE}}), with financial/insurance/real-estate turnover separated for review."),
    argsSchema: {
      year: parsedString(
        value => parsePositiveInteger(value, { min: 2000, max: 2100 }),
        "a calendar year from 2000 through 2100",
      ).optional().describe("Calendar year to check; defaults to current year"),
      financial_turnover: optionalFiniteNumber("Optional financial-services turnover to include if not incidental", { min: 0 }),
      insurance_turnover: optionalFiniteNumber("Optional insurance-services turnover to include if not incidental", { min: 0 }),
      real_estate_turnover: optionalFiniteNumber("Optional real-estate turnover to include if not incidental", { min: 0 }),
      exempt_social_turnover: optionalFiniteNumber("Optional healthcare/education or similar exempt turnover to show as not counted", { min: 0 }),
      incidental_excluded_turnover: optionalFiniteNumber("Optional finance/insurance/real-estate turnover already judged incidental and excluded", { min: 0 }),
      taxable_turnover_adjustment: optionalFiniteNumber("Optional signed adjustment to sale-invoice taxable/0% turnover"),
      manual_bucket_source: z.enum(["outside_sale_invoices", "included_in_sale_invoices"]).optional()
        .describe("Whether manual bucket amounts are outside sale invoices or already included there"),
    },
    setupOptions: {
      note: "VAT threshold checking needs live VAT status and sale invoices from e-arveldaja, so it cannot run before credentials are configured.",
    },
    featurePredicate: taxEnabled,
    variants: NO_VARIANTS,
  },
  {
    name: "setup-credentials",
    slug: "setup-credentials",
    description: "Inspect the current e-arveldaja credential setup, import credentials from an apikey file, and explain the required restart and next steps.",
    argsSchema: {
      file_path: optionalAbsolutePath("Optional absolute path to an apikey*.txt file to import"),
      storage_scope: z.enum(["local", "global"]).optional()
        .describe("Optional target scope: local for this folder only, global for any folder"),
    },
    setupOptions: undefined,
    featurePredicate: enabled,
    variants: NO_VARIANTS,
  },
  {
    name: "setup-e-arveldaja",
    slug: "setup-e-arveldaja",
    description: "Explain how to configure e-arveldaja API credentials, including supported environment variables, apikey import, storage scope, restart, and first verification.",
    argsSchema: undefined,
    setupOptions: undefined,
    featurePredicate: enabled,
    variants: NO_VARIANTS,
  },
  {
    name: "accounting-inbox",
    slug: "accounting-inbox",
    description: "Scan a workspace for likely accounting inputs, propose the next safe dry-run steps, and ask only the smallest necessary follow-up questions.",
    argsSchema: {
      workspace_path: optionalAbsolutePath("Optional folder to scan for CAMT statements, Wise CSV files, and receipt folders"),
      bank_account_dimension_id: optionalPositiveId("Optional default bank-account dimension ID reused for CAMT and receipt suggestions"),
      receipt_matching_dimension_id: optionalPositiveId("Optional bank-account dimension ID used specifically for receipt matching"),
      wise_account_dimension_id: optionalPositiveId("Optional bank-account dimension ID used specifically for Wise suggestions"),
    },
    setupOptions: undefined,
    featurePredicate: enabled,
    variants: NO_VARIANTS,
  },
  {
    name: "resolve-accounting-review",
    slug: "resolve-accounting-review",
    description: "FIRST PASS of a two-step review flow. Calls `continue_accounting_workflow` with action='resolve_review' to surface the recommendation, compliance basis, unresolved questions, and suggested workflow.",
    argsSchema: {
      review_item_json: jsonObject("JSON object from autopilot.needs_accountant_review[*].resolver_input or a direct review item payload"),
    },
    setupOptions: undefined,
    featurePredicate: enabled,
    variants: NO_VARIANTS,
  },
  {
    name: "prepare-accounting-review-action",
    slug: "prepare-accounting-review-action",
    description: "SECOND PASS of the review flow: continue_accounting_workflow action='prepare_action' emits a concrete proposed_action for explicit approval.",
    argsSchema: {
      review_item_json: jsonObject("JSON object from autopilot.needs_accountant_review[*].resolver_input or a direct review item payload"),
      save_as_rule: parsedString(parseExactBoolean, "exactly true or false").optional()
        .describe("Optional hint to prepare a save_auto_booking_rule action when the treatment is stable"),
      rule_override_json: optionalJsonObject("Optional JSON object with explicit rule fields such as purchase_article_id, purchase_account_id, liability_account_id, vat_rate_dropdown, reversed_vat_id, reason, match, or category"),
    },
    setupOptions: undefined,
    featurePredicate: enabled,
    variants: NO_VARIANTS,
  },
  {
    name: "book-invoice",
    slug: "book-invoice",
    description: "Book a purchase invoice from a source document. Extracts invoice data, validates it, resolves the supplier, suggests booking accounts, previews the booking, and creates + confirms the invoice after approval.",
    argsSchema: {
      file_path: absolutePath("Absolute path to the invoice document file (PDF/JPG/PNG)"),
    },
    setupOptions: {
      offlineTools: ["extract_pdf_invoice", "validate_invoice_data"],
      note: "Supplier resolution, duplicate detection, booking suggestions, invoice creation, and confirmation all require configured e-arveldaja credentials.",
    },
    featurePredicate: enabled,
    variants: NO_VARIANTS,
  },
  {
    name: "receipt-batch",
    slug: "receipt-batch",
    description: "Scan a receipt folder, preview auto-bookable results, and only create purchase invoices after explicit approval.",
    argsSchema: {
      folder_path: absolutePath("Absolute path to the receipt folder"),
      accounts_dimensions_id: optionalPositiveId("Optional bank account dimension ID used for bank transaction matching; if omitted, list account dimensions and ask the user to confirm the best match"),
      date_from: optionalDate("Optional receipt modified-date lower bound (YYYY-MM-DD)"),
      date_to: optionalDate("Optional receipt modified-date upper bound (YYYY-MM-DD)"),
    },
    setupOptions: {
      offlineTools: ["receipt_batch"],
      note: "Full receipt processing, supplier resolution, duplicate checks, bank matching, and invoice creation all require configured credentials.",
    },
    featurePredicate: enabled,
    variants: NO_VARIANTS,
  },
  {
    name: "import-camt",
    slug: "import-camt",
    description: "Parse a CAMT.053 statement, preview imported bank transactions, and only create them after approval.",
    argsSchema: {
      file_path: absolutePath("Absolute path to the CAMT.053 XML file"),
      accounts_dimensions_id: optionalPositiveId("Optional bank account dimension ID in e-arveldaja; if omitted, list account dimensions and ask the user to confirm the bank account"),
      date_from: optionalDate("Optional statement-entry lower bound (YYYY-MM-DD)"),
      date_to: optionalDate("Optional statement-entry upper bound (YYYY-MM-DD)"),
    },
    setupOptions: {
      offlineTools: ["process_camt053"],
      note: "Parsing the CAMT file can be done locally (process_camt053 mode='parse'), but dry-run imports and transaction creation require configured e-arveldaja credentials.",
    },
    featurePredicate: enabled,
    variants: NO_VARIANTS,
  },
  {
    name: "import-wise",
    slug: "import-wise",
    description: "Preview Wise CSV import results (fees, skipped duplicates) before creating any bank transactions.",
    argsSchema: {
      file_path: absolutePath("Absolute path to the regular Wise transaction-history.csv export"),
      accounts_dimensions_id: optionalPositiveId("Optional bank account dimension ID for the Wise account; if omitted, list account dimensions and ask the user to confirm the Wise bank account"),
      fee_account_dimensions_id: optionalPositiveId("Optional Wise fee expense account dimension ID"),
      inter_account_dimension_id: optionalPositiveId("Optional other own bank account dimension for Wise inter-account transfers; required when there are 3+ bank accounts and auto-detection cannot pick one"),
      date_from: optionalDate("Optional transaction-date lower bound (YYYY-MM-DD)"),
      date_to: optionalDate("Optional transaction-date upper bound (YYYY-MM-DD)"),
      skip_jar_transfers: parsedString(parseExactBoolean, "exactly true or false").optional()
        .describe("Skip Jar transfers (default true)"),
    },
    setupOptions: {
      note: "Wise import preview and execution both depend on live e-arveldaja account and transaction data, so this workflow stays blocked until credentials are configured.",
    },
    featurePredicate: enabled,
    variants: NO_VARIANTS,
  },
  {
    name: "classify-unmatched",
    slug: "classify-unmatched",
    description: "Classify unmatched bank transactions, preview generated purchase-invoice bookings, and only apply them after approval.",
    argsSchema: {
      accounts_dimensions_id: optionalPositiveId("Optional bank account dimension ID used for transaction classification; if omitted, list account dimensions and ask the user to confirm the bank account"),
      date_from: optionalDate("Optional transaction-date lower bound (YYYY-MM-DD)"),
      date_to: optionalDate("Optional transaction-date upper bound (YYYY-MM-DD)"),
    },
    setupOptions: {
      note: "This workflow depends on live unmatched bank transactions and e-arveldaja booking data, so it cannot run before credentials are configured.",
    },
    featurePredicate: enabled,
    variants: NO_VARIANTS,
  },
  {
    name: "reconcile-bank",
    slug: "reconcile-bank",
    description: "Match bank transactions to invoices and optionally auto-confirm exact matches.",
    argsSchema: {
      mode: z.enum(["auto", "review", "transaction"]).optional()
        .describe('Reconciliation mode: "auto" (default), "review", or "transaction"'),
      transaction_id: optionalPositiveId('Specific bank transaction ID when mode is "transaction"'),
      target_accounts_dimensions_id: optionalPositiveId("Optional target own-bank account dimension for one-sided inter-account reconciliation; provide when there are 3+ bank accounts and the IBAN is missing"),
    },
    setupOptions: {
      note: "Bank reconciliation requires live transactions, invoices, and journals from e-arveldaja, so it cannot run in setup mode.",
    },
    featurePredicate: enabled,
    variants: NO_VARIANTS,
  },
  {
    name: "month-end-close",
    slug: "month-end",
    description: "Run the month-end close checklist: check for blockers, find missing documents, detect duplicates, and generate financial statements.",
    argsSchema: {
      month: parsedString(parseMonth, "a calendar month in YYYY-MM format")
        .describe('Month in YYYY-MM format, e.g. "2026-03"'),
    },
    setupOptions: {
      note: "Month-end checks rely on live e-arveldaja invoices, transactions, journals, and reports, so this workflow stays blocked until credentials are configured.",
    },
    featurePredicate: enabled,
    variants: MONTH_END_VARIANTS,
  },
  {
    name: "new-supplier",
    slug: "new-supplier",
    description: "Create a new supplier by looking up registry data and creating a client record.",
    argsSchema: {
      identifier: parsedString(parseIdentifier, "a bounded identifier without control characters")
        .describe("Supplier name or 8-digit Estonian registry code"),
    },
    setupOptions: {
      note: "Existing-client lookup, supplier resolution, and client creation are API-backed steps, so this workflow cannot complete before credentials are configured.",
    },
    featurePredicate: enabled,
    variants: NO_VARIANTS,
  },
  {
    name: "company-overview",
    slug: "company-overview",
    description: "Get a comprehensive dashboard overview of the company's current financial state.",
    argsSchema: undefined,
    setupOptions: {
      note: "This dashboard depends on live company settings and financial reports from e-arveldaja, so it cannot run before credentials are configured.",
    },
    featurePredicate: enabled,
    variants: COMPANY_OVERVIEW_VARIANTS,
  },
  {
    name: "lightyear-booking",
    slug: "lightyear-booking",
    description: "Book Lightyear investment trades and distributions into e-arveldaja journals. Parses CSV exports, pairs FX conversions, matches capital gains, and creates journal entries.",
    argsSchema: {
      file_path: absolutePath("Absolute path to Lightyear AccountStatement CSV file"),
      capital_gains_path: optionalAbsolutePath("Absolute path to Lightyear CapitalGainsStatement CSV (required for sells)"),
      investment_account: positiveId("Investment asset account number (e.g. 1550)"),
      broker_account: positiveId("Broker cash account number (e.g. 1120)"),
      income_account: optionalPositiveId("Distribution income account (dividends from shares → 8330; fund distributions → 8320; interest → 8400)"),
      gain_loss_account: optionalPositiveId("Realized gain account for sell gains (default: auto-detect 'Tulu aktsiatelt ja osadelt', standard 8330)"),
      loss_account: optionalPositiveId("Realized loss account for sell losses (default: auto-detect 'Kulu aktsiatelt ja osadelt', standard 8335)"),
      trade_fee_account: optionalPositiveId("Expensed TRADE fee account for book_lightyear_trades (default: auto-detect 'Kulu aktsiatelt ja osadelt', standard 8335). Do not reuse this for distributions."),
      distribution_fee_account: optionalPositiveId("Platform fee account for book_lightyear_distributions (default: auto-detect 'Muud finantskulud', standard 8610). Distinct from trade_fee_account."),
      tax_account: optionalPositiveId("Withheld tax account for distributions"),
      investment_dimension_id: optionalPositiveId("Optional dimension ID for the investment account"),
      broker_dimension_id: optionalPositiveId("Optional dimension ID for the broker account"),
    },
    setupOptions: {
      note: "Lightyear booking needs live e-arveldaja journal creation and duplicate checks, so it cannot run before credentials are configured.",
    },
    featurePredicate: lightyearEnabled,
    variants: NO_VARIANTS,
  },
] as const satisfies readonly PromptDefinition[];

for (const definition of PROMPT_DEFINITIONS) {
  if (definition.setupOptions) {
    if ("offlineTools" in definition.setupOptions && definition.setupOptions.offlineTools) {
      Object.freeze(definition.setupOptions.offlineTools);
    }
    Object.freeze(definition.setupOptions);
  }
  for (const variant of definition.variants) {
    Object.freeze(variant.advertisedTools);
    Object.freeze(variant);
  }
  Object.freeze(definition.variants);
  Object.freeze(definition);
}

export const PROMPT_REGISTRY = Object.freeze(PROMPT_DEFINITIONS);

export type WorkflowPromptName = typeof PROMPT_REGISTRY[number]["name"];
export type WorkflowPromptSlug = typeof PROMPT_REGISTRY[number]["slug"];
export type RegisteredPromptDefinition = typeof PROMPT_REGISTRY[number];

export const PROMPT_NAMES: readonly WorkflowPromptName[] = Object.freeze(
  PROMPT_REGISTRY.map(definition => definition.name),
);

export const PROMPT_SLUGS: readonly WorkflowPromptSlug[] = Object.freeze(
  PROMPT_REGISTRY.map(definition => definition.slug),
);

export function enabledPromptDefinitions(
  toolExposure?: ToolExposureConfig,
): readonly RegisteredPromptDefinition[] {
  return PROMPT_REGISTRY.filter(definition => definition.featurePredicate(toolExposure));
}
