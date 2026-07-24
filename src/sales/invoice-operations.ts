import type { OperationOutcome } from "../operation-outcome.js";
import type { ExecutionPlanInput } from "../plan-store.js";
import type { ApiContext } from "../tools/crud/shared.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import { desandboxAllStrings } from "../external-text-renderer.js";
import { decodeApiResponseCritical, decodeInvoiceStatusCritical } from "../api/critical-codecs.js";
import { canonicalPlanJson } from "../tools/camt-plan.js";
import { validateSaleInvoiceItemDimensions } from "../account-validation.js";
import { parseSaleInvoiceItems, tagNotes } from "../tools/crud/shared.js";
import { logAudit } from "../audit-log.js";
import type { SaleInvoiceDeliveryRequest } from "../types/api.js";
import {
  SALE_INVOICE_PLAN_DOMAIN,
  type SaleInvoiceExecuteInput,
  type SaleInvoiceMutationAction,
  type SaleInvoiceOperationInput,
  type SaleInvoiceOperationResult,
  type SaleInvoiceOperations,
  type SaleInvoicePrepareInput,
  type SaleInvoiceReadInput,
} from "./invoice-types.js";

function ok<T>(value: T): OperationOutcome<T> {
  return { ok: true, value, warnings: [], blockers: [] };
}
function fail<T>(code: string, message: string): OperationOutcome<T> {
  return { ok: false, error: { code, message, retry: "never" }, blockers: [] };
}

const MUTATION_ACTIONS = new Set<SaleInvoiceMutationAction>(["create", "update", "delete", "confirm", "invalidate", "send"]);

class SaleInvoiceOperationsImpl implements SaleInvoiceOperations {
  constructor(
    private readonly api: ApiContext,
    private readonly runtimeSafetyContext: RuntimeSafetyContext,
  ) {}

  async run(input: SaleInvoiceOperationInput): Promise<OperationOutcome<SaleInvoiceOperationResult>> {
    switch (input.mode) {
      case "read": return this.read(input);
      case "prepare": return this.prepare(input);
      case "execute": return this.execute(input);
      default:
        return fail("invalid_mode", `Unknown mode "${String((input as { mode?: unknown }).mode)}".`);
    }
  }

  private async read(input: SaleInvoiceReadInput): Promise<OperationOutcome<SaleInvoiceOperationResult>> {
    const action = input.action ?? (input.id !== undefined ? "get" : "list");
    if (action !== "list" && input.id === undefined) {
      return fail("id_required", `mode='read' action='${action}' requires an id.`);
    }
    switch (action) {
      case "list": {
        const f = input.filters ?? {};
        const result = await this.api.saleInvoices.list({
          ...(f.page !== undefined ? { page: f.page } : {}),
          ...(f.date_from !== undefined ? { start_date: f.date_from } : {}),
          ...(f.date_to !== undefined ? { end_date: f.date_to } : {}),
          ...(f.status !== undefined ? { status: f.status } : {}),
          ...(f.payment_status !== undefined ? { payment_status: f.payment_status } : {}),
          ...(f.clients_id !== undefined ? { clients_id: f.clients_id } : {}),
        });
        return ok({ mode: "read", action: "list", data: result });
      }
      case "get":
        return ok({ mode: "read", action: "get", data: await this.api.saleInvoices.get(input.id!) });
      case "document":
        return ok({ mode: "read", action: "document", data: await this.api.saleInvoices.getSystemPdf(input.id!) });
      case "xml":
        return ok({ mode: "read", action: "xml", data: await this.api.saleInvoices.getSystemXml(input.id!) });
      case "delivery_options":
        return ok({ mode: "read", action: "delivery_options", data: await this.api.saleInvoices.getDeliveryOptions(input.id!) });
      default:
        return fail("invalid_read_action", `Unknown read action "${String(action)}".`);
    }
  }

  private async prepare(input: SaleInvoicePrepareInput): Promise<OperationOutcome<SaleInvoiceOperationResult>> {
    if (!MUTATION_ACTIONS.has(input.action)) return fail("invalid_action", `Unknown action "${String(input.action)}".`);
    if (input.action !== "create" && input.id === undefined) {
      return fail("id_required", `action='${input.action}' requires an id.`);
    }
    const projection: Record<string, string | number | boolean> = {
      action: input.action,
      ...(input.id !== undefined ? { invoice_id: input.id } : {}),
      destructive: input.action === "delete" || input.action === "confirm" || input.action === "invalidate" || input.action === "send",
    };
    const planProjection = projection as unknown as ExecutionPlanInput["liveSnapshot"];
    const planInput: ExecutionPlanInput = {
      normalizedArgs: { action: input.action, ...(input.id !== undefined ? { invoice_id: input.id } : {}) },
      sourceIdentities: [],
      liveSnapshot: planProjection,
      commands: [{ id: `sale-invoice-${input.action}`, category: `sale_invoice_${input.action}`, reviewProjection: planProjection }],
      counts: {},
      totals: {},
      exclusions: [],
      reviews: [],
      privatePayload: { action: input.action, ...(input.id !== undefined ? { invoice_id: input.id } : {}) },
    };
    const planHandle = this.runtimeSafetyContext.planStore.issue(SALE_INVOICE_PLAN_DOMAIN, planInput);
    return ok({ mode: "prepare", action: input.action, ...(input.id !== undefined ? { id: input.id } : {}), planHandle, projection });
  }

  private async execute(input: SaleInvoiceExecuteInput): Promise<OperationOutcome<SaleInvoiceOperationResult>> {
    if (!MUTATION_ACTIONS.has(input.action)) return fail("invalid_action", `Unknown action "${String(input.action)}".`);
    // Consume the reviewed plan (consume-once). A missing/replayed handle is a
    // hard failure — the plan handle is not itself approval. EVERY mutation,
    // destructive action AND send passes this gate.
    if (input.planHandle === undefined) {
      return fail("plan_handle_required", `action='${input.action}' requires a plan_handle from a prior mode='prepare'.`);
    }
    let storedPlan;
    try {
      storedPlan = this.runtimeSafetyContext.planStore.consume(input.planHandle, SALE_INVOICE_PLAN_DOMAIN);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "plan_handle_invalid";
      return fail(code, "The reviewed execution plan could not be consumed.");
    }

    // Bind the consumed plan to the {action,id} it was reviewed for. Without
    // this, one approved prepare of any sale mutation would authorize ANY single
    // sale mutation (e.g. approve confirm id=5, then send/delete an arbitrary
    // id on the same handle). Mirrors the plan_drift binding in the banking
    // reconciliation executor. Rejected with ZERO side effect — before any
    // api.saleInvoices.* call.
    const boundArgs = { action: input.action, ...(input.id !== undefined ? { invoice_id: input.id } : {}) };
    if (canonicalPlanJson(storedPlan.normalizedArgs) !== canonicalPlanJson(boundArgs)) {
      return fail("plan_drift", "The reviewed sale-invoice plan no longer matches the requested action/id.");
    }

    if (input.action !== "create" && input.id === undefined) {
      return fail("id_required", `action='${input.action}' requires an id.`);
    }

    switch (input.action) {
      case "create": return this.executeCreate(input);
      case "update": return this.executeUpdate(input);
      case "delete": return this.executeSimple("delete", input.id!, () => this.api.saleInvoices.delete(input.id!));
      case "confirm": return this.executeSimple("confirm", input.id!, () => this.api.saleInvoices.confirm(input.id!));
      case "invalidate": return this.executeSimple("invalidate", input.id!, () => this.api.saleInvoices.invalidate(input.id!));
      case "send": return this.executeSend(input);
      default:
        return fail("invalid_action", `Unknown action "${String(input.action)}".`);
    }
  }

  private async executeCreate(input: SaleInvoiceExecuteInput): Promise<OperationOutcome<SaleInvoiceOperationResult>> {
    const raw = input.payload ?? {};
    const params = desandboxAllStrings(raw) as Record<string, unknown>;
    const items = desandboxAllStrings(parseSaleInvoiceItems(raw.items));
    const [accounts, accountDimensions] = await Promise.all([
      this.api.readonly.getAccounts(),
      this.api.readonly.getAccountDimensions(),
    ]);
    const dimErrors = validateSaleInvoiceItemDimensions(items, accounts, accountDimensions);
    if (dimErrors.length > 0) return fail("account_validation_failed", `Account validation failed: ${dimErrors.join("; ")}`);
    const result = await this.api.saleInvoices.create({
      ...params,
      number_suffix: (params.number_suffix as string | undefined) ?? "",
      cl_currencies_id: (params.cl_currencies_id as string | undefined) ?? "EUR",
      cl_countries_id: (params.cl_countries_id as string | undefined) ?? "EST",
      sale_invoice_type: (params.sale_invoice_type as string | undefined) ?? "INVOICE",
      show_client_balance: (params.show_client_balance as boolean | undefined) ?? false,
      notes: tagNotes(params.notes as string | undefined),
      items,
    } as never);
    logAudit({
      tool: "manage_sale_invoice", action: "CREATED", entity_type: "sale_invoice",
      entity_id: decodeApiResponseCritical(result).created_object_id,
      summary: `Created sale invoice for client ${String(params.clients_id)}`,
      details: { clients_id: params.clients_id },
    });
    return ok({ mode: "execute", action: "create", result });
  }

  private async executeUpdate(input: SaleInvoiceExecuteInput): Promise<OperationOutcome<SaleInvoiceOperationResult>> {
    const parsed = desandboxAllStrings(input.payload ?? {}) as Record<string, unknown>;
    const current = await this.api.saleInvoices.get(input.id!);
    if (decodeInvoiceStatusCritical(current).status === "CONFIRMED") {
      return fail("confirmed_record_immutable", "Confirmed sale_invoice cannot be updated — invalidate, edit the draft, then re-confirm.");
    }
    const result = await this.api.saleInvoices.update(input.id!, parsed as never);
    logAudit({
      tool: "manage_sale_invoice", action: "UPDATED", entity_type: "sale_invoice", entity_id: input.id!,
      summary: `Updated sale invoice ${input.id!}`, details: { fields_changed: Object.keys(parsed) },
    });
    return ok({ mode: "execute", action: "update", id: input.id!, result });
  }

  private async executeSimple(
    action: "delete" | "confirm" | "invalidate",
    id: number,
    call: () => Promise<unknown>,
  ): Promise<OperationOutcome<SaleInvoiceOperationResult>> {
    const result = await call();
    logAudit({
      tool: "manage_sale_invoice", action: action.toUpperCase(), entity_type: "sale_invoice", entity_id: id,
      summary: `${action} sale invoice ${id}`, details: {},
    });
    return ok({ mode: "execute", action, id, result });
  }

  private async executeSend(input: SaleInvoiceExecuteInput): Promise<OperationOutcome<SaleInvoiceOperationResult>> {
    const request = desandboxAllStrings(input.payload ?? {}) as SaleInvoiceDeliveryRequest;
    const result = await this.api.saleInvoices.sendEinvoice(input.id!, request);
    logAudit({
      tool: "manage_sale_invoice", action: "SENT", entity_type: "sale_invoice", entity_id: input.id!,
      summary: `Sent sale invoice ${input.id!}`,
      details: { send_einvoice: (request as { send_einvoice?: boolean }).send_einvoice, send_email: (request as { send_email?: boolean }).send_email },
    });
    return ok({ mode: "execute", action: "send", id: input.id!, result });
  }
}

export function createSaleInvoiceOperations(api: ApiContext, runtimeSafetyContext: RuntimeSafetyContext): SaleInvoiceOperations {
  return new SaleInvoiceOperationsImpl(api, runtimeSafetyContext);
}
