import { z } from "zod";

/**
 * Field whitelists for list_* responses. Brief view returns the fields an
 * agent needs to triage / pick a row by ID; full detail comes from get_*.
 *
 * Token impact (measured on synthetic 30-row payloads with TOON encoding):
 *   - clients:           ~93% smaller (objects-with-records break tabular)
 *   - transactions:      ~85% smaller
 *   - sale/purchase inv: ~70% smaller
 * Brief output also re-enables TOON tabular form by stripping nested
 * objects/arrays, which compounds the saving.
 */
export const BRIEF_FIELDS = {
  client: [
    "id", "name", "code", "email", "invoice_vat_no",
    "is_client", "is_supplier", "is_deleted",
  ],
  product: [
    "id", "name", "code", "sales_price", "unit", "price_currency", "is_deleted",
  ],
  journal: [
    "id", "effective_date", "number", "title", "document_number",
    "registered", "clients_id", "operation_type", "cl_currencies_id",
  ],
  transaction: [
    "id", "date", "amount", "base_amount", "cl_currencies_id",
    "status", "type", "clients_id", "accounts_dimensions_id",
    "bank_ref_number", "description",
  ],
  sale_invoice: [
    "id", "number_prefix", "number_suffix", "number",
    "clients_id", "client_name", "create_date", "journal_date",
    "status", "payment_status", "gross_price", "net_price",
    "cl_currencies_id", "term_days",
  ],
  purchase_invoice: [
    "id", "number", "clients_id", "client_name",
    "create_date", "journal_date", "status", "payment_status",
    "gross_price", "net_price", "vat_price",
    "cl_currencies_id", "term_days", "bank_ref_number",
  ],
} as const;

export type BriefEntity = keyof typeof BRIEF_FIELDS;
export type ListView = "brief" | "full";

export const viewParam = {
  view: z.enum(["brief", "full"]).optional().describe(
    "Response detail level. 'brief' (default) returns triage fields only — sufficient to pick a row by ID; call the matching get_* tool for full detail. 'full' returns every field the API exposes (much larger)."
  ),
};

function pickFields<T extends Record<string, unknown>>(
  item: T,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f in item) out[f] = item[f];
  }
  return out;
}

/**
 * Apply the requested view to a list of entities.
 * - view === "full" → returns items unchanged
 * - view === "brief" / undefined → strips down to BRIEF_FIELDS[entity]
 *
 * Items are typed as `unknown[]` so callers don't need to coerce — the
 * function only operates on object rows and passes through anything else
 * (e.g. already-trimmed shapes, null entries) untouched.
 */
export function applyListView<T>(
  entity: BriefEntity,
  items: T[],
  view: ListView | undefined,
): T[] | Array<Record<string, unknown>> {
  if (view === "full") return items;
  const fields = BRIEF_FIELDS[entity];
  return items.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return item as unknown as Record<string, unknown>;
    }
    return pickFields(item as Record<string, unknown>, fields);
  });
}
