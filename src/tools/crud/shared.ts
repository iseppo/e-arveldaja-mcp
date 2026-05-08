import { z } from "zod";
import { isRecord } from "../../record-utils.js";
import type { ClientsApi } from "../../api/clients.api.js";
import type { ProductsApi } from "../../api/products.api.js";
import type { JournalsApi } from "../../api/journals.api.js";
import type { TransactionsApi } from "../../api/transactions.api.js";
import type { SaleInvoicesApi } from "../../api/sale-invoices.api.js";
import type { PurchaseInvoicesApi } from "../../api/purchase-invoices.api.js";
import type { ReferenceDataApi } from "../../api/readonly.api.js";
import type { Posting, TransactionDistribution, SaleInvoiceItem, PurchaseInvoiceItem } from "../../types/api.js";

export interface ApiContext {
  clients: ClientsApi;
  products: ProductsApi;
  journals: JournalsApi;
  transactions: TransactionsApi;
  saleInvoices: SaleInvoicesApi;
  purchaseInvoices: PurchaseInvoicesApi;
  readonly: ReferenceDataApi;
}

/** Check if company is VAT-registered via /vat_info */
export async function isCompanyVatRegistered(api: ApiContext): Promise<boolean> {
  const vatInfo = await api.readonly.getVatInfo();
  return !!vatInfo.vat_number;
}

export const MAX_JSON_INPUT_SIZE = 1024 * 1024; // 1 MB

export function safeJsonParse(input: string, label: string): unknown {
  if (Buffer.byteLength(input, "utf-8") > MAX_JSON_INPUT_SIZE) {
    throw new Error(`JSON input for "${label}" exceeds maximum size of ${MAX_JSON_INPUT_SIZE} bytes`);
  }
  try {
    return JSON.parse(input);
  } catch {
    throw new Error(`Invalid JSON in "${label}"`);
  }
}

export function parseJsonObject(input: unknown, label: string): Record<string, unknown> {
  const parsed = typeof input === "string" ? safeJsonParse(input, label) : input;
  if (!isRecord(parsed)) {
    throw new Error(`"${label}" must be a JSON object`);
  }
  return parsed;
}

export function parseJsonObjectArray(input: unknown, label: string): Record<string, unknown>[] {
  const parsed = typeof input === "string" ? safeJsonParse(input, label) : input;
  if (!Array.isArray(parsed)) {
    throw new Error(`"${label}" must be a JSON array`);
  }

  parsed.forEach((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`"${label}" item ${index + 1} must be a JSON object`);
    }
  });

  return parsed;
}

export function requireFields(items: Record<string, unknown>[], label: string, fields: string[]): void {
  items.forEach((item, index) => {
    for (const field of fields) {
      if (!(field in item) || item[field] === null || item[field] === undefined || item[field] === "") {
        throw new Error(`"${label}" item ${index + 1} is missing required field "${field}"`);
      }
    }
  });
}

/**
 * Coerce string-typed numbers to actual numbers (LLMs often quote numbers in JSON).
 * Rejects empty/whitespace strings: `Number("") === 0` would silently turn a
 * pasted empty CSV cell into a 0-EUR line, which is a bug factory. Callers who
 * want "absent" must omit the field or pass null.
 */
export function coerceNumericFields(items: Record<string, unknown>[], fields: string[]): void {
  items.forEach((item, index) => {
    for (const field of fields) {
      if (field in item && typeof item[field] === "string") {
        const raw = item[field] as string;
        if (raw.trim() === "") {
          throw new Error(
            `Numeric field "${field}" at item ${index + 1} cannot be an empty string. Omit the field or pass null to leave it unset.`
          );
        }
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) {
          item[field] = parsed;
        }
      }
    }
  });
}

export function requireNumericFields(items: Record<string, unknown>[], label: string, fields: string[]): void {
  coerceNumericFields(items, fields);
  items.forEach((item, index) => {
    for (const field of fields) {
      if (field in item && item[field] !== null && item[field] !== undefined) {
        if (typeof item[field] !== "number" || !Number.isFinite(item[field] as number)) {
          throw new Error(`"${label}" item ${index + 1} field "${field}" must be a finite number, got ${typeof item[field]}`);
        }
      }
    }
  });
}

export function parsePostings(input: unknown): Posting[] {
  const postings = parseJsonObjectArray(input, "postings");
  requireFields(postings, "postings", ["accounts_id", "type", "amount"]);
  requireNumericFields(postings, "postings", [
    "accounts_id", "amount", "accounts_dimensions_id",
    "projects_project_id", "projects_location_id", "projects_person_id",
    "base_amount",
  ]);

  postings.forEach((posting, index) => {
    if (posting.type !== "D" && posting.type !== "C") {
      throw new Error(`"postings" item ${index + 1} has invalid type "${String(posting.type)}" (expected "D" or "C")`);
    }
  });

  return postings as unknown as Posting[];
}

export function parseTransactionDistributions(input: unknown): TransactionDistribution[] {
  const distributions = parseJsonObjectArray(input, "distributions");
  requireFields(distributions, "distributions", ["related_table", "amount"]);
  requireNumericFields(distributions, "distributions", ["amount", "related_id", "related_sub_id"]);

  const allowedRelatedTables = new Set(["accounts", "purchase_invoices", "sale_invoices"]);
  distributions.forEach((distribution, index) => {
    const relatedTable = distribution.related_table;
    if (typeof relatedTable !== "string" || !allowedRelatedTables.has(relatedTable)) {
      throw new Error(
        `"distributions" item ${index + 1} field "related_table" must be one of: accounts, purchase_invoices, sale_invoices`
      );
    }

    if (
      (relatedTable === "accounts" || relatedTable === "purchase_invoices" || relatedTable === "sale_invoices") &&
      (!Number.isInteger(distribution.related_id) || (distribution.related_id as number) <= 0)
    ) {
      throw new Error(
        `"distributions" item ${index + 1} field "related_id" must be a positive number when related_table="${relatedTable}"`
      );
    }
  });

  return distributions as unknown as TransactionDistribution[];
}

export function parseSaleInvoiceItems(input: unknown): SaleInvoiceItem[] {
  const items = parseJsonObjectArray(input, "items");
  requireFields(items, "items", ["products_id", "custom_title", "amount"]);
  requireNumericFields(items, "items", [
    "products_id", "amount", "unit_net_price", "discount_percent",
    "vat_accounts_id",
    "sale_accounts_id", "sale_accounts_dimensions_id",
    "cl_sale_articles_id",
    "projects_project_id", "projects_location_id", "projects_person_id",
  ]);
  return items as unknown as SaleInvoiceItem[];
}

export function parsePurchaseInvoiceItems(input: unknown): PurchaseInvoiceItem[] {
  const items = parseJsonObjectArray(input, "items");
  requireFields(items, "items", ["cl_purchase_articles_id", "custom_title"]);
  requireNumericFields(items, "items", [
    "cl_purchase_articles_id", "total_net_price", "unit_net_price", "amount",
    "vat_accounts_id", "vat_accounts_dimensions_id",
    "purchase_accounts_id", "purchase_accounts_dimensions_id",
    "cl_vat_articles_id", "project_no_vat_gross_price", "cl_fringe_benefits_id",
  ]);
  return items as unknown as PurchaseInvoiceItem[];
}

export const pageParam = z.object({
  page: z.number().optional().describe("Page number (default 1)"),
  modified_since: z.string().optional().describe("Return only objects modified since this timestamp (ISO 8601)"),
});

export const coerceId = z.coerce.number().int().positive();
export const idParam = z.object({ id: coerceId.describe("Object ID") });
export const jsonObjectInput = z.union([
  z.record(z.unknown()),
  z.string(),
]);
export const jsonObjectArrayInput = z.union([
  z.array(z.record(z.unknown())),
  z.string(),
]);
export const jsonObjectOrArrayInput = z.union([
  z.record(z.unknown()),
  z.array(z.record(z.unknown())),
  z.string(),
]);

const MCP_TAG = "e-arveldaja-mcp";

/** Append "(e-arveldaja-mcp)" to notes when EARVELDAJA_TAG_NOTES=true. */
export function tagNotes(notes?: string): string | undefined {
  if (process.env.EARVELDAJA_TAG_NOTES !== "true") return notes;
  return notes ? `${notes} (${MCP_TAG})` : `(${MCP_TAG})`;
}
const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;
export const isoDateString = (description: string) =>
  z.string().regex(isoDateRegex, "Expected YYYY-MM-DD").describe(description);

const TRANSACTION_METADATA_FIELDS = new Set([
  "bank_ref_number",
  "bank_account_name",
  "bank_account_no",
  "description",
  "ref_number",
]);

export function validateTransactionUpdateData(data: Record<string, unknown>): string[] {
  const fields = Object.keys(data);
  const allowedFields = Array.from(TRANSACTION_METADATA_FIELDS).join(", ");
  const errors: string[] = [];

  if (fields.length === 0) {
    return [`Provide at least one transaction metadata field to update. Allowed fields: ${allowedFields}.`];
  }

  for (const field of fields) {
    if (!TRANSACTION_METADATA_FIELDS.has(field)) {
      errors.push(
        `Field "${field}" is not supported by update_transaction. Allowed fields: ${allowedFields}.`
      );
      continue;
    }

    const value = data[field];
    if (value !== null && typeof value !== "string") {
      errors.push(`Field "${field}" must be a string or null.`);
    }
  }

  return errors;
}

/**
 * Per-entity denylist of fields that must never be set via the generic
 * `update_*` tools because they are either server-managed, state-flipping,
 * or have dedicated action tools (confirm/invalidate/deactivate/restore).
 *
 * Mirrors the pattern `update_transaction` uses with `TRANSACTION_METADATA_FIELDS`,
 * but denylist-style so we don't have to track every legitimately-updatable
 * field as the API surface grows.
 */
const UPDATE_BLOCKED_FIELDS: Record<string, { fields: string[]; alt: string; post_confirm_fields?: string[] }> = {
  client:           { fields: ["id", "is_active", "deactivated_date"],
                       alt: "use deactivate_client / restore_client to change activation state" },
  product:          { fields: ["id", "is_active", "deactivated_date"],
                       alt: "use deactivate_product / restore_product to change activation state" },
  journal:          { fields: ["id", "registered", "register_date", "status"],
                       alt: "use confirm_journal / invalidate_journal to change registration state",
                       post_confirm_fields: ["effective_date"] },
  sale_invoice:     { fields: ["id", "status", "registered", "register_date"],
                       alt: "use confirm_sale_invoice / invalidate_sale_invoice to change registration state",
                       post_confirm_fields: ["create_date", "journal_date"] },
  purchase_invoice: { fields: ["id", "status", "registered", "register_date", "payment_status"],
                       alt: "use confirm_purchase_invoice / invalidate_purchase_invoice to change registration state",
                       post_confirm_fields: ["create_date", "journal_date"] },
};

export function validateUpdateFields(
  data: Record<string, unknown>,
  entity: keyof typeof UPDATE_BLOCKED_FIELDS,
  opts?: { isConfirmed?: boolean },
): string[] {
  const errors: string[] = [];
  if (Object.keys(data).length === 0) {
    errors.push(`update_${entity}: provide at least one field to update.`);
    return errors;
  }
  const entry = UPDATE_BLOCKED_FIELDS[entity]!;
  for (const field of entry.fields) {
    if (field in data) {
      errors.push(`Field "${field}" cannot be set via update_${entity} — ${entry.alt}.`);
    }
  }
  // Post-confirmation audit-trail protection: once a journal is registered or
  // an invoice is CONFIRMED, certain fields (dates) are audit-locked. Edits
  // must go through invalidate -> edit -> re-confirm so the audit trail
  // records the reversal explicitly.
  if (opts?.isConfirmed && entry.post_confirm_fields) {
    for (const field of entry.post_confirm_fields) {
      if (field in data) {
        errors.push(
          `Field "${field}" cannot be edited on a CONFIRMED ${entity} — ` +
          `invalidate_${entity} first, then edit, then re-confirm. Preserves the audit trail.`
        );
      }
    }
  }
  return errors;
}
