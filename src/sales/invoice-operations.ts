import type { OperationOutcome } from "../operation-outcome.js";
import type { ExecutionPlanInput, PlanRecord } from "../plan-store.js";
import type { ApiContext } from "../tools/crud/shared.js";
import { computeRecurringClone, validateRecurringParams, type RecurringCloneParams } from "../tools/recurring-invoices.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import { desandboxAllStrings } from "../external-text-renderer.js";
import { wrapUntrustedOcr } from "../mcp-json.js";
import { isRecord } from "../record-utils.js";
import { resolveSupplierInternal } from "../tools/supplier-resolution.js";
import { resolveOwnCompanyIdentifiers } from "../tools/own-company-identity.js";
import { decodeApiResponseCritical, decodeInvoiceStatusCritical } from "../api/critical-codecs.js";
import { canonicalPlanJson, stripUndefinedDeep } from "../tools/camt-plan.js";
import { validateOptionalStrictDateRange } from "../strict-date.js";
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

const MUTATION_ACTIONS = new Set<SaleInvoiceMutationAction>(["create", "update", "delete", "confirm", "invalidate", "send", "recurring"]);

/**
 * Extract the recurring-clone params from a façade payload. Returns undefined
 * when a required field (source_month/target_date/target_journal_date) is
 * missing or the wrong type. Fields are desandboxed at this write boundary.
 */
function parseRecurringParams(payload: Record<string, unknown> | undefined): RecurringCloneParams | undefined {
  if (!payload) return undefined;
  const p = desandboxAllStrings(payload) as Record<string, unknown>;
  const source_month = typeof p.source_month === "string" ? p.source_month : undefined;
  const target_date = typeof p.target_date === "string" ? p.target_date : undefined;
  const target_journal_date = typeof p.target_journal_date === "string" ? p.target_journal_date : undefined;
  if (source_month === undefined || target_date === undefined || target_journal_date === undefined) return undefined;
  const invoice_ids = typeof p.invoice_ids === "string" ? p.invoice_ids : undefined;
  const auto_confirm = typeof p.auto_confirm === "boolean" ? p.auto_confirm : undefined;
  return {
    source_month,
    target_date,
    target_journal_date,
    ...(invoice_ids !== undefined ? { invoice_ids } : {}),
    ...(auto_confirm !== undefined ? { auto_confirm } : {}),
  };
}

/**
 * The drift-binding fingerprint for a recurring plan. Binds the reviewed clone
 * params (source_month/target_date/target_journal_date/invoice_ids) AND
 * auto_confirm — the dry-run preview can never reflect confirmation, so
 * auto_confirm is bound here to stop an approved "create DRAFT clones" preview
 * from being executed as "create AND register" via the same handle. It is
 * normalized to a canonical boolean (absent === false) so an unchanged run
 * still matches, while flipping it to true drifts. NOT an invoice id (recurring
 * has none).
 */
function recurringNormalizedArgs(params: RecurringCloneParams): PlanRecord {
  return {
    action: "recurring",
    source_month: params.source_month,
    target_date: params.target_date,
    target_journal_date: params.target_journal_date,
    auto_confirm: params.auto_confirm === true,
    ...(params.invoice_ids !== undefined ? { invoice_ids: params.invoice_ids } : {}),
  };
}

/** The inline resolve-or-create customer fields accepted on a create payload as
 * an ALTERNATIVE to `clients_id`. Mapped onto resolveSupplierInternal's
 * SupplierIdentityFields — a customer is a `client` record, same as a supplier. */
interface InvoiceClientInput {
  readonly name: string;
  readonly reg_code?: string;
  readonly vat_no?: string;
  readonly iban?: string;
  readonly country?: string;
}

/** Extract the inline `client` object from a create payload. Returns undefined
 * when absent or when `name` is missing/blank (the resolver's only hard
 * requirement). Values are read as-is; markers are stripped inside the resolver
 * (matchSupplier canonicalizes) and, for execute, the payload is already
 * desandboxed at the write boundary. */
function parseClientInput(payload: Record<string, unknown> | undefined): InvoiceClientInput | undefined {
  const client = payload?.client;
  if (!isRecord(client)) return undefined;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
  const name = str(client.name);
  if (name === undefined) return undefined;
  return {
    name,
    ...(str(client.reg_code) !== undefined ? { reg_code: str(client.reg_code) } : {}),
    ...(str(client.vat_no) !== undefined ? { vat_no: str(client.vat_no) } : {}),
    ...(str(client.iban) !== undefined ? { iban: str(client.iban) } : {}),
    ...(str(client.country) !== undefined ? { country: str(client.country) } : {}),
  };
}

/** True iff the RAW create payload carries a `client` key with a non-null value.
 * Presence is checked on the raw key — NOT via parseClientInput — so a malformed
 * or empty inline `client` (e.g. `{}`) is still detected as "the caller intended
 * an inline client" and cannot be silently dropped. */
function hasInlineClientKey(payload: Record<string, unknown> | undefined): boolean {
  if (payload === undefined) return false;
  if (!Object.prototype.hasOwnProperty.call(payload, "client")) return false;
  return payload.client !== undefined && payload.client !== null;
}

/** Reject a create payload whose inline-`client` intent cannot be honoured.
 * Two failure shapes, both decided from the RAW key presence (a wrapped OCR name
 * is still non-blank, so no desandbox is needed):
 *  - `clients_id` AND an inline `client` key together → `client_input_conflict`.
 *    The documented contract is EITHER/OR; silently dropping the inline client
 *    (and its H13/P17/self-match identity guards) would contradict it. Detected
 *    from the raw `client` key, so `clients_id + {client:{}}` no longer slips
 *    through with the inline client vanishing.
 *  - an inline `client` key present WITHOUT clients_id but malformed/empty (no
 *    non-blank name) → `client_invalid`. A caller that clearly meant to pass an
 *    inline client but sent an unusable object must get an explicit error, never
 *    a silent fall-through to "clients_id missing".
 * Returns a failure outcome when either holds, otherwise undefined. */
function clientInputConflict(payload: Record<string, unknown> | undefined): OperationOutcome<never> | undefined {
  const hasClientsId = payload?.clients_id !== undefined && payload?.clients_id !== null;
  const hasClientKey = hasInlineClientKey(payload);
  if (hasClientsId && hasClientKey) {
    return fail<never>("client_input_conflict", "Provide EITHER clients_id OR an inline client object, not both.");
  }
  if (!hasClientsId && hasClientKey && parseClientInput(payload) === undefined) {
    return fail<never>("client_invalid", "The inline client object is missing a non-blank name. Provide { name, reg_code?, vat_no?, iban?, country? } or a clients_id.");
  }
  return undefined;
}

/**
 * Apply the sale-invoice create defaults that `executeCreate` applies before the
 * API call, IN PLACE on a copy's field set, so the effective payload the drift
 * fingerprint binds matches the effective payload the API receives. An omitted
 * default and its explicit value therefore fingerprint identically (no spurious
 * plan_drift), while a changed real field still drifts. This is the SINGLE
 * source of these defaults — executeCreate calls it too, so the fingerprint and
 * the API write can never disagree on what the default is. Only the
 * always-defaulted scalar fields are normalized here; `notes` (tagNotes
 * transform) and `items` (parseSaleInvoiceItems) stay bound verbatim. */
function applyCreateDefaults(rest: Record<string, unknown>): void {
  rest.number_suffix = (rest.number_suffix as string | undefined) ?? "";
  rest.cl_currencies_id = (rest.cl_currencies_id as string | undefined) ?? "EUR";
  rest.cl_countries_id = (rest.cl_countries_id as string | undefined) ?? "EST";
  rest.sale_invoice_type = (rest.sale_invoice_type as string | undefined) ?? "INVOICE";
  rest.show_client_balance = (rest.show_client_balance as boolean | undefined) ?? false;
}

/**
 * Canonical drift fingerprint of a create/update/send mutation PAYLOAD, bound
 * into the plan at prepare AND recomputed at execute so canonicalPlanJson
 * rejects a changed payload as plan_drift with zero side effect. The payload is
 * desandboxAllStrings-desandboxed FIRST — the per-call random OCR nonce would
 * otherwise always drift between prepare and execute. For create the fingerprint
 * binds the EFFECTIVE payload the API receives after defaulting
 * (applyCreateDefaults, matching executeCreate) so a semantically-identical
 * omitted-vs-explicit default (cl_currencies_id "EUR", cl_countries_id "EST",
 * sale_invoice_type "INVOICE", show_client_balance false, number_suffix "")
 * does NOT produce a spurious drift; the inline `client` contribution is reduced
 * to IDENTITY-only (name/reg_code/vat_no/iban/country via parseClientInput) so it
 * agrees with prepareClientPreview's read-only resolution; the raw `client`
 * object and the non-semantic `view` field are dropped. Everything else
 * (clients_id, items, invoice-level amounts, dates, send flags/recipients) is
 * bound verbatim — conservatively, a spurious drift is safer than an unbound
 * field. delete/confirm/invalidate carry no meaningful payload and are NOT routed
 * here (they stay id-only). stripUndefinedDeep makes the result safe for the plan
 * store (which rejects `undefined`) and order-insensitive for the comparison.
 */
function saleMutationFingerprint(
  action: "create" | "update" | "send",
  id: number | undefined,
  payload: Record<string, unknown> | undefined,
): PlanRecord {
  const p = desandboxAllStrings(payload ?? {}) as Record<string, unknown>;
  const base: Record<string, unknown> = { action, ...(id !== undefined ? { invoice_id: id } : {}) };
  if (action === "create") {
    const rest = { ...p };
    delete rest.client;
    delete rest.view;
    applyCreateDefaults(rest);
    const clientInput = parseClientInput(p);
    return stripUndefinedDeep({
      ...base,
      ...rest,
      ...(clientInput !== undefined ? { client: { ...clientInput } } : {}),
    }) as PlanRecord;
  }
  const rest = { ...p };
  delete rest.view;
  return stripUndefinedDeep({ ...base, ...rest }) as PlanRecord;
}

/** Operator-facing summary of the bound payload fingerprint for the prepare
 * projection: the list of bound field names plus the bound scalars.
 *
 * Numbers and booleans go through as-is. String scalars used to be dropped
 * wholesale to keep unsandboxed text off the card, but that hid the one thing
 * some approvals are ABOUT: an `action='send'` card showed `send_einvoice: true`
 * and never the address it would go to, so the operator approved a delivery
 * without seeing the destination. The value was bound in the fingerprint all
 * along — execute could not change it — the card just refused to show it.
 * Strings are now shown, sandbox-wrapped, which addresses the original concern
 * without withholding the destination. Nested values (items, inline client) stay
 * summarised by name only; the display client name is still wrapped separately
 * by prepareClientPreview. */
const BOUND_STRING_MAX_CHARS = 200;

function boundPayloadProjection(fp: PlanRecord): Record<string, string | number | boolean> {
  const keys = Object.keys(fp).filter(k => k !== "action" && k !== "invoice_id");
  const out: Record<string, string | number | boolean> = { bound_fields: keys.slice().sort().join(", ") };
  for (const k of keys) {
    const v = fp[k];
    if (typeof v === "number" || typeof v === "boolean") {
      out[`bound_${k}`] = v;
    } else if (typeof v === "string" && v.length > 0) {
      const wrapped = wrapUntrustedOcr(v.slice(0, BOUND_STRING_MAX_CHARS));
      if (wrapped !== undefined) out[`bound_${k}`] = wrapped;
    }
  }
  return out;
}

/** Result of the inline customer resolve-or-create. `needs_input` is the P17
 * "create neither" signal — the resolver refused (identity gate / conflict /
 * self-match / unresolved), so the caller must create NEITHER the client NOR
 * the invoice. */
type InvoiceClientResolution =
  | { readonly status: "existing"; readonly clients_id: number }
  | { readonly status: "created"; readonly clients_id: number }
  | { readonly status: "would_create"; readonly preview_name?: string; readonly reg_code?: string }
  | { readonly status: "needs_input"; readonly code: string; readonly message: string };

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
        // Strict calendar-date validation for the list filters: a malformed or
        // non-existent date (2026-02-31, 2026-13-01, date_from > date_to) is
        // rejected here rather than passed to the backend to coerce ambiguously.
        const dateError = validateOptionalStrictDateRange("date_from", f.date_from, "date_to", f.date_to);
        if (dateError) return fail("invalid_date_filter", dateError);
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
    if (input.action === "recurring") return this.prepareRecurring(input);
    if (input.action !== "create" && input.id === undefined) {
      return fail("id_required", `action='${input.action}' requires an id.`);
    }
    // Reject clients_id + inline client both present BEFORE issuing a plan.
    if (input.action === "create") {
      const conflict = clientInputConflict(input.payload);
      if (conflict) return conflict;
    }
    // Bind the DESANDBOXED payload fingerprint for create/update/send so the
    // execute-time drift check rejects a changed payload (amounts, line items,
    // send channel/recipients, inline customer). delete/confirm/invalidate carry
    // no meaningful payload → id-only, as before.
    const bindsPayload = input.action === "create" || input.action === "update" || input.action === "send";
    const normalizedArgs: PlanRecord = bindsPayload
      ? saleMutationFingerprint(input.action, input.id, input.payload)
      : { action: input.action, ...(input.id !== undefined ? { invoice_id: input.id } : {}) };
    const projection: Record<string, string | number | boolean> = {
      action: input.action,
      ...(input.id !== undefined ? { invoice_id: input.id } : {}),
      destructive: input.action === "delete" || input.action === "confirm" || input.action === "invalidate" || input.action === "send",
      ...(bindsPayload ? boundPayloadProjection(normalizedArgs) : {}),
    };
    const planProjection = projection as unknown as ExecutionPlanInput["liveSnapshot"];
    const planInput: ExecutionPlanInput = {
      normalizedArgs,
      sourceIdentities: [],
      liveSnapshot: planProjection,
      commands: [{ id: `sale-invoice-${input.action}`, category: `sale_invoice_${input.action}`, reviewProjection: planProjection }],
      counts: {},
      totals: {},
      exclusions: [],
      reviews: [],
      privatePayload: { action: input.action, ...(input.id !== undefined ? { invoice_id: input.id } : {}) },
    };
    // Create-preview: resolve the inline customer READ-ONLY (creation disabled)
    // so the operator reviews the customer identity — EXISTING (id) vs NEW
    // (would-create) — before approving. Resolved BEFORE issuing the handle: an
    // inline customer the read-only resolver refuses (P17 needs_input) must NOT
    // be shown ready-for-approval with a usable handle (the matching execute
    // would refuse it anyway), so on needs_input we return a needs_input outcome
    // and issue NO plan handle. Kept OUT of the plan snapshot above so the
    // wrapped (nonce-bearing) name never enters the plan fingerprint; the
    // clients_id path (no `client`) leaves the projection untouched.
    const clientPreview = await this.prepareClientPreview(input);
    if (clientPreview.kind === "needs_input") {
      return fail(clientPreview.code, clientPreview.message);
    }
    const planHandle = this.runtimeSafetyContext.planStore.issue(SALE_INVOICE_PLAN_DOMAIN, planInput);
    return ok({ mode: "prepare", action: input.action, ...(input.id !== undefined ? { id: input.id } : {}), planHandle, projection: { ...projection, ...clientPreview.projection } });
  }

  /** Read-only projection add-on describing how the inline `client` on a create
   * would resolve. `kind:"display"` (empty for non-create actions or a
   * clients_id-only payload) carries the projection; `kind:"needs_input"` is the
   * P17 refusal (H13 conflict / self-match) — the caller must issue no handle. */
  private async prepareClientPreview(input: SaleInvoicePrepareInput): Promise<
    | { readonly kind: "display"; readonly projection: Record<string, string | number | boolean> }
    | { readonly kind: "needs_input"; readonly code: string; readonly message: string }
  > {
    if (input.action !== "create") return { kind: "display", projection: {} };
    const hasClientsId = input.payload?.clients_id !== undefined && input.payload?.clients_id !== null;
    const clientInput = parseClientInput(input.payload);
    if (hasClientsId || clientInput === undefined) return { kind: "display", projection: {} };
    const resolved = await this.resolveInvoiceClient(clientInput, false);
    if (resolved.status === "existing") {
      return { kind: "display", projection: { client_resolution: "existing", clients_id: resolved.clients_id } };
    }
    if (resolved.status === "needs_input") {
      return { kind: "needs_input", code: resolved.code, message: resolved.message };
    }
    if (resolved.status === "would_create") {
      const wrapped = wrapUntrustedOcr(resolved.preview_name ?? clientInput.name);
      return {
        kind: "display",
        projection: {
          client_resolution: "would_create",
          ...(wrapped !== undefined ? { client_name: wrapped } : {}),
          ...(resolved.reg_code !== undefined ? { client_reg_code: resolved.reg_code } : {}),
        },
      };
    }
    return { kind: "display", projection: {} };
  }

  private async prepareRecurring(input: SaleInvoicePrepareInput): Promise<OperationOutcome<SaleInvoiceOperationResult>> {
    const params = parseRecurringParams(input.payload);
    if (!params) {
      return fail("recurring_params_required", "action='recurring' requires payload with source_month (YYYY-MM), target_date and target_journal_date (YYYY-MM-DD).");
    }
    // Enforce the recurring format regexes the standalone tool gets from its Zod
    // schema — the façade would otherwise reach the core with a malformed shape.
    // Reject BEFORE issuing a plan handle or reading the clone via computeRecurringClone.
    const paramsError = validateRecurringParams(params);
    if (paramsError) return fail("recurring_params_invalid", paramsError);
    // PREVIEW: run the shared clone core with dryRun=true. This is the projection
    // the operator reviews before approving.
    const preview = await computeRecurringClone(this.api, params, { dryRun: true });
    const normalizedArgs = recurringNormalizedArgs(params);
    const planSnapshot: PlanRecord = { ...normalizedArgs, destructive: false };
    const planInput: ExecutionPlanInput = {
      normalizedArgs,
      sourceIdentities: [],
      liveSnapshot: planSnapshot,
      commands: [{ id: "sale-invoice-recurring", category: "sale_invoice_recurring", reviewProjection: planSnapshot }],
      counts: {},
      totals: {},
      exclusions: [],
      reviews: [],
      privatePayload: normalizedArgs,
    };
    const planHandle = this.runtimeSafetyContext.planStore.issue(SALE_INVOICE_PLAN_DOMAIN, planInput);
    return ok({ mode: "prepare", action: "recurring", planHandle, projection: preview });
  }

  private async execute(input: SaleInvoiceExecuteInput): Promise<OperationOutcome<SaleInvoiceOperationResult>> {
    if (!MUTATION_ACTIONS.has(input.action)) return fail("invalid_action", `Unknown action "${String(input.action)}".`);
    // Reject clients_id + inline client both present BEFORE consuming the plan
    // or touching any API (defense in depth — prepare already refuses it).
    if (input.action === "create") {
      const conflict = clientInputConflict(input.payload);
      if (conflict) return conflict;
    }
    // Consume the reviewed plan (consume-once). A missing/replayed handle is a
    // hard failure — the plan handle is not itself approval. EVERY mutation,
    // destructive action AND send passes this gate.
    if (input.planHandle === undefined) {
      return fail("plan_handle_required", `action='${input.action}' requires a plan_handle from a prior mode='prepare'.`);
    }
    // Syntactic validation of recurring params runs BEFORE the plan handle is
    // consumed: a malformed date/month/invoice_ids is a bad-input rejection, not
    // a drift, and must never burn a consume-once handle. (The semantic drift
    // check below still uses the consumed plan.)
    let recurringParams: RecurringCloneParams | undefined;
    if (input.action === "recurring") {
      recurringParams = parseRecurringParams(input.payload);
      if (!recurringParams) {
        return fail("recurring_params_required", "action='recurring' requires payload with source_month (YYYY-MM), target_date and target_journal_date (YYYY-MM-DD).");
      }
      // Reject a malformed recurring payload BEFORE consuming the handle and
      // before computeRecurringClone (the clone/API read). Without this a bad
      // invoice_ids/source_month would slip past a matching handle into the core.
      const paramsError = validateRecurringParams(recurringParams);
      if (paramsError) return fail("recurring_params_invalid", paramsError);
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
    // For recurring, the plan binds the reviewed clone PARAMS (not an invoice id).
    let boundArgs: PlanRecord;
    if (input.action === "recurring") {
      boundArgs = recurringNormalizedArgs(recurringParams!);
    } else if (input.action === "create" || input.action === "update" || input.action === "send") {
      // Recompute the SAME payload fingerprint bound at prepare so a changed
      // create/update/send payload drift-rejects here, before any api call.
      boundArgs = saleMutationFingerprint(input.action, input.id, input.payload);
    } else {
      boundArgs = { action: input.action, ...(input.id !== undefined ? { invoice_id: input.id } : {}) };
    }
    if (canonicalPlanJson(storedPlan.normalizedArgs) !== canonicalPlanJson(boundArgs)) {
      return fail("plan_drift", "The reviewed sale-invoice plan no longer matches the requested action/id.");
    }

    if (input.action !== "create" && input.action !== "recurring" && input.id === undefined) {
      return fail("id_required", `action='${input.action}' requires an id.`);
    }

    switch (input.action) {
      case "create": return this.executeCreate(input);
      case "update": return this.executeUpdate(input);
      case "delete": return this.executeSimple("delete", input.id!, () => this.api.saleInvoices.delete(input.id!));
      case "confirm": return this.executeSimple("confirm", input.id!, () => this.api.saleInvoices.confirm(input.id!));
      case "invalidate": return this.executeSimple("invalidate", input.id!, () => this.api.saleInvoices.invalidate(input.id!));
      case "send": return this.executeSend(input);
      case "recurring": {
        const result = await computeRecurringClone(this.api, recurringParams!, { dryRun: false });
        return ok({ mode: "execute", action: "recurring", result });
      }
      default:
        return fail("invalid_action", `Unknown action "${String(input.action)}".`);
    }
  }

  /**
   * Resolve-or-create the inline `client` for a create, REUSING the purchase
   * side's resolveSupplierInternal primitive directly (a customer is a `client`
   * record just like a supplier). All of its guards apply unchanged: the
   * self-match block (#14/#22), the H13 strong-identifier conflict, and the P17
   * legal-entity identity gate. `execute=false` is the read-only preview
   * (`api.clients.create` never runs). P17 "create neither": on ANY refusal the
   * resolver returns created:false, so returning `needs_input` here guarantees
   * no client was persisted and the caller skips the invoice too.
   */
  private async resolveInvoiceClient(clientInput: InvoiceClientInput, execute: boolean): Promise<InvoiceClientResolution> {
    const clients = await this.api.clients.listAll();
    const { ownCompanyVat, ownCompanyRegistryCode } = await resolveOwnCompanyIdentifiers(this.api, clients);
    const resolution = await resolveSupplierInternal(
      this.api,
      clients,
      {
        supplier_name: clientInput.name,
        ...(clientInput.reg_code !== undefined ? { supplier_reg_code: clientInput.reg_code } : {}),
        ...(clientInput.vat_no !== undefined ? { supplier_vat_no: clientInput.vat_no } : {}),
        ...(clientInput.iban !== undefined ? { supplier_iban: clientInput.iban } : {}),
      },
      execute,
      {
        ...(ownCompanyVat !== undefined ? { ownCompanyVat } : {}),
        ...(ownCompanyRegistryCode !== undefined ? { ownCompanyRegistryCode } : {}),
        // A sales-created customer is a CLIENT, not a supplier — invert the
        // resolver's supplier-only default so it appears in customer lists.
        _resolveSupplierOverrides: { country: clientInput.country ?? "EST", role: { is_client: true, is_supplier: false } },
      },
    );

    // P17 / H13 / self-match refusals — create NEITHER client NOR invoice.
    if (resolution.requires_manual_review) {
      return { status: "needs_input", code: "client_identifier_conflict", message: resolution.reason ?? "The customer identity conflicts with an existing client — resolve it manually." };
    }
    if (resolution.code === "legal_entity_identity_required") {
      return { status: "needs_input", code: resolution.code, message: resolution.reason ?? "Refusing to auto-create a customer without a verified legal-entity identity. Supply a checksum-valid Estonian reg_code, or an existing clients_id." };
    }
    if (resolution.self_match_blocked) {
      return { status: "needs_input", code: "client_is_own_company", message: "The customer identifiers match the active company itself — refusing to resolve or create the buyer as its own customer." };
    }
    if (resolution.found && resolution.client?.id !== undefined) {
      return { status: "existing", clients_id: resolution.client.id };
    }
    if (resolution.created && resolution.client?.id !== undefined) {
      return { status: "created", clients_id: resolution.client.id };
    }
    if (!execute) {
      return {
        status: "would_create",
        ...(resolution.preview_client?.name !== undefined ? { preview_name: resolution.preview_client.name } : {}),
        ...(clientInput.reg_code !== undefined ? { reg_code: clientInput.reg_code } : {}),
      };
    }
    return { status: "needs_input", code: "client_unresolved", message: "Could not resolve or create the customer from the provided client fields — supply a clients_id or a verified identity." };
  }

  private async executeCreate(input: SaleInvoiceExecuteInput): Promise<OperationOutcome<SaleInvoiceOperationResult>> {
    const raw = input.payload ?? {};
    const params = desandboxAllStrings(raw) as Record<string, unknown>;
    // Inline resolve-or-create customer: create requires EITHER clients_id OR a
    // client object with a name. When only `client` is present, resolve it (with
    // creation enabled) and use the resolved/created id as clients_id.
    // Defense in depth — prepare/execute already reject this, but keep the guard
    // local to the mutation too.
    const conflict = clientInputConflict(params);
    if (conflict) return conflict;
    const hasClientsId = params.clients_id !== undefined && params.clients_id !== null;
    const clientInput = parseClientInput(params);
    if (!hasClientsId && clientInput === undefined) {
      return fail("client_required", "create requires either clients_id or a client object with at least { name }.");
    }
    // Run ALL local parsing + account-dimension validation FIRST so a validation
    // failure creates NEITHER the inline customer NOR the invoice — resolving-or-
    // creating the customer before this left orphan master data on a bad item.
    const items = desandboxAllStrings(parseSaleInvoiceItems(raw.items));
    const [accounts, accountDimensions] = await Promise.all([
      this.api.readonly.getAccounts(),
      this.api.readonly.getAccountDimensions(),
    ]);
    const dimErrors = validateSaleInvoiceItemDimensions(items, accounts, accountDimensions);
    if (dimErrors.length > 0) return fail("account_validation_failed", `Account validation failed: ${dimErrors.join("; ")}`);
    // Only after validation passes: resolve-or-create the inline customer.
    // Track whether the customer was CREATED here (vs. an existing match) so a
    // later invoice-create failure can compensate the orphaned master-data row.
    let resolvedClientsId: number | undefined;
    let createdClientId: number | undefined;
    if (!hasClientsId && clientInput !== undefined) {
      const resolved = await this.resolveInvoiceClient(clientInput, true);
      if (resolved.status !== "existing" && resolved.status !== "created") {
        // needs_input (P17 refusal) — or, defensively, an unexpected would_create
        // on the execute path. Create NEITHER the client NOR the invoice.
        const code = resolved.status === "needs_input" ? resolved.code : "client_unresolved";
        const message = resolved.status === "needs_input" ? resolved.message : "Could not resolve or create the customer.";
        return fail(code, message);
      }
      resolvedClientsId = resolved.clients_id;
      if (resolved.status === "created") createdClientId = resolved.clients_id;
    }
    // Never forward the inline `client` object to the sale-invoice API. Also
    // drop `view` so the payload sent to the API exactly matches the surface the
    // plan fingerprint bound (saleMutationFingerprint drops `view` too).
    delete params.client;
    delete params.view;
    if (resolvedClientsId !== undefined) params.clients_id = resolvedClientsId;
    // Apply the SAME defaults saleMutationFingerprint bound, so the API write and
    // the drift fingerprint agree on every effective field.
    applyCreateDefaults(params);
    let result: unknown;
    try {
      result = await this.api.saleInvoices.create({
        ...params,
        notes: tagNotes(params.notes as string | undefined),
        items,
      } as never);
    } catch (createError) {
      // Compensating cleanup: the inline customer we JUST created is now orphaned
      // master data (the invoice it was created for did not persist). An existing
      // client is never touched. Deactivate the new client to roll it back.
      if (createdClientId === undefined) throw createError;
      const invoiceErrorMessage = createError instanceof Error ? createError.message : String(createError);
      try {
        await this.api.clients.deactivate(createdClientId);
      } catch (cleanupError) {
        // Cleanup itself failed or is indeterminate (e.g. network) — surface a
        // structured partial outcome carrying the created client id, the invoice
        // failure, the cleanup failure, and the exact next action. NEVER hide it
        // behind a generic error: the operator must know a client row remains.
        const cleanupErrorMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        return {
          ok: false,
          error: {
            code: "client_rollback_indeterminate",
            message:
              `The sale-invoice create failed (${invoiceErrorMessage}) and the compensating deactivation of the newly-created customer (clients_id=${createdClientId}) ALSO failed (${cleanupErrorMessage}). ` +
              `A customer record may remain active. Next action: manually deactivate or delete clients_id=${createdClientId} in e-arveldaja, then retry the invoice.`,
            retry: "unknown",
            // A client row is very likely still ACTIVE. The façade must not
            // report this as "nothing was written".
            mutationOccurred: true,
            mutatedObjects: [{ type: "client", id: createdClientId }],
          },
          blockers: [],
        };
      }
      // Cleanup succeeded — the orphan was rolled back. Report a structured
      // failure that states the invoice was not created and the client was
      // deactivated, so no active orphan remains.
      return {
        ok: false,
        error: {
          code: "invoice_create_failed_client_rolled_back",
          message:
            `The sale-invoice create failed (${invoiceErrorMessage}). The newly-created customer (clients_id=${createdClientId}) was rolled back (deactivated), so no orphaned customer remains. Retry the invoice once the create error is resolved.`,
          retry: "safe",
          // The invoice did not persist, but a deactivated client record DOES
          // exist. Rolled back is not the same as never written.
          mutationOccurred: true,
          mutatedObjects: [{ type: "client", id: createdClientId }],
        },
        blockers: [],
      };
    }
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
