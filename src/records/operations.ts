import type { OperationOutcome } from "../operation-outcome.js";
import type { ApiContext } from "../tools/crud/shared.js";
import type { ListParams } from "../api/base-resource.js";
import type {
  AccountingRecord,
  InspectAccountingRecordInput,
  RecordEntity,
  RecordOperations,
  RecordSearchFilters,
  RecordSearchResult,
  SearchAccountingRecordsInput,
} from "./types.js";

function ok<T>(value: T): OperationOutcome<T> {
  return { ok: true, value, warnings: [], blockers: [] };
}
function fail<T>(code: string, message: string): OperationOutcome<T> {
  return { ok: false, error: { code, message, retry: "never" }, blockers: [] };
}

type FilterKey = keyof RecordSearchFilters;

// The closed, per-entity filter allowlist. Each entity maps to ONE fixed
// api.<entity>.list; only the listed filter keys may be forwarded. This IS the
// "no universal API executor" boundary — a key outside an entity's set is
// rejected, and the entity itself is a fixed enum member (no arbitrary path).
const ENTITY_FILTERS: Record<RecordEntity, ReadonlySet<FilterKey>> = {
  journals: new Set<FilterKey>(["page", "date_from", "date_to"]),
  transactions: new Set<FilterKey>(["page", "date_from", "date_to", "status", "clients_id"]),
  clients: new Set<FilterKey>(["page"]),
  purchase_invoices: new Set<FilterKey>(["page", "date_from", "date_to", "status", "payment_status", "clients_id"]),
  sale_invoices: new Set<FilterKey>(["page", "date_from", "date_to", "status", "payment_status", "clients_id"]),
  products: new Set<FilterKey>(["page"]),
};

function resource(api: ApiContext, entity: RecordEntity) {
  switch (entity) {
    case "journals": return api.journals;
    case "transactions": return api.transactions;
    case "clients": return api.clients;
    case "purchase_invoices": return api.purchaseInvoices;
    case "sale_invoices": return api.saleInvoices;
    case "products": return api.products;
  }
}

export interface RecordOperationsExposure {
  readonly enableSales: boolean;
  readonly enableProducts: boolean;
}

class RecordOperationsImpl implements RecordOperations {
  constructor(
    private readonly api: ApiContext,
    private readonly exposure: RecordOperationsExposure,
  ) {}

  private entityGate(entity: RecordEntity): string | undefined {
    if (entity === "sale_invoices" && !this.exposure.enableSales) {
      return "sale_invoices are unavailable on this purchase-side deployment.";
    }
    if (entity === "products" && !this.exposure.enableProducts) {
      return "products are unavailable when the product catalog is disabled.";
    }
    return undefined;
  }

  async search(input: SearchAccountingRecordsInput): Promise<OperationOutcome<RecordSearchResult>> {
    const allowed = ENTITY_FILTERS[input.entity];
    if (!allowed) return fail("invalid_entity", `Unknown entity "${String(input.entity)}".`);
    const gate = this.entityGate(input.entity);
    if (gate) return fail("entity_unavailable", gate);

    const filters = input.filters ?? {};
    // Reject any filter key outside this entity's bounded allowlist.
    for (const key of Object.keys(filters) as FilterKey[]) {
      if (filters[key] === undefined) continue;
      if (!allowed.has(key)) {
        return fail("filter_not_allowed", `Filter "${key}" is not allowed for entity "${input.entity}".`);
      }
    }

    const params: ListParams = { page: filters.page ?? 1 };
    if (allowed.has("date_from") && filters.date_from !== undefined) params.start_date = filters.date_from;
    if (allowed.has("date_to") && filters.date_to !== undefined) params.end_date = filters.date_to;
    if (allowed.has("status") && filters.status !== undefined) params.status = filters.status;
    if (allowed.has("payment_status") && filters.payment_status !== undefined) params.payment_status = filters.payment_status;
    if (allowed.has("clients_id") && filters.clients_id !== undefined) params.clients_id = filters.clients_id;

    const res = resource(this.api, input.entity);
    const result = await res.list(params);
    return ok({
      entity: input.entity,
      page: result.current_page,
      total_pages: result.total_pages,
      ...(typeof (result as { total_items?: number }).total_items === "number" ? { total_items: (result as { total_items?: number }).total_items } : {}),
      items: result.items,
    });
  }

  async inspect(input: InspectAccountingRecordInput): Promise<OperationOutcome<AccountingRecord>> {
    if (!ENTITY_FILTERS[input.entity]) return fail("invalid_entity", `Unknown entity "${String(input.entity)}".`);
    const gate = this.entityGate(input.entity);
    if (gate) return fail("entity_unavailable", gate);
    if (!Number.isInteger(input.id) || input.id <= 0) {
      return fail("invalid_id", "A positive integer record id is required.");
    }
    const res = resource(this.api, input.entity);
    const record = await res.get(input.id);
    return ok({ entity: input.entity, record });
  }
}

export function createRecordOperations(api: ApiContext, exposure: RecordOperationsExposure): RecordOperations {
  return new RecordOperationsImpl(api, exposure);
}
