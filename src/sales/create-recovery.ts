import { createHash, randomUUID } from "node:crypto";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import type { PlanRecord } from "../plan-store.js";
import { canonicalPlanJson } from "../tools/camt-plan.js";
import type { OperationRecoveryContext } from "../operation-outcome.js";

export interface SaleCreateScope {
  readonly connectionFingerprint: string;
  readonly baseUrl: string;
}
export interface SaleCreateIntent {
  readonly intentSha256: string;
  readonly invoicePayload: PlanRecord;
  readonly inlineIdentity?: PlanRecord;
  readonly clientsId?: number;
}
export interface SaleCreateReservation { readonly token: string }
export interface SaleCreateRecoveryMarker {
  readonly publicContext: OperationRecoveryContext;
  readonly intent: SaleCreateIntent;
  readonly clientsId?: number;
  readonly createdClientId?: number;
}
export interface SaleCreateRecoveryEvidence {
  readonly clientsId: number;
  readonly createdClientId?: number;
  readonly intent: SaleCreateIntent;
}
export interface SaleCreateRecoverySession {
  findPending(intent: SaleCreateIntent): SaleCreateRecoveryMarker | undefined;
  findReleased(intent: SaleCreateIntent): SaleCreateRecoveryMarker | undefined;
  reserve(intent: SaleCreateIntent): SaleCreateReservation;
  bindResolvedClient(reservation: SaleCreateReservation, clientsId: number): void;
  markIndeterminate(reservation: SaleCreateReservation, evidence: SaleCreateRecoveryEvidence): SaleCreateRecoveryMarker;
  complete(reservation: SaleCreateReservation, createdInvoiceId: number): void;
  abandonDefinitive(reservation: SaleCreateReservation): void;
  release(marker: string, intent: SaleCreateIntent): boolean;
  requiresFreshScan(intent: SaleCreateIntent): boolean;
}

/** Capture invocation identity before queueing; a generation change never erases a hold. */
export function captureSaleCreateScope(runtime: RuntimeSafetyContext): SaleCreateScope {
  const scope = runtime.getActiveScope();
  if (!scope.baseUrl || !scope.connectionFingerprint || scope.connectionFingerprint === "setup") {
    throw new Error("A configured connection is required for sale-invoice creation.");
  }
  return Object.freeze({ connectionFingerprint: scope.connectionFingerprint, baseUrl: scope.baseUrl });
}

export function saleCreateIntent(normalized: PlanRecord): SaleCreateIntent {
  const invoicePayload = { ...normalized };
  const inlineIdentity = invoicePayload.client as PlanRecord | undefined;
  const clientsId = typeof invoicePayload.clients_id === "number" ? invoicePayload.clients_id : undefined;
  delete invoicePayload.action;
  delete invoicePayload.client;
  delete invoicePayload.clients_id;
  return Object.freeze({
    intentSha256: createHash("sha256").update(canonicalPlanJson(normalized)).digest("hex"),
    invoicePayload, ...(inlineIdentity ? { inlineIdentity } : {}), ...(clientsId ? { clientsId } : {}),
  });
}

/** Conservative economic overlap: changed cosmetics/rows cannot bypass an uncertain POST. */
export function saleCreateMayBeSameEvent(a: SaleCreateIntent, b: SaleCreateIntent, resolvedClient?: number): boolean {
  const aid = resolvedClient ?? a.clientsId;
  if (aid !== undefined && b.clientsId !== undefined && aid !== b.clientsId) return false;
  if (a.inlineIdentity && b.inlineIdentity) {
    const ac = a.inlineIdentity.reg_code, bc = b.inlineIdentity.reg_code;
    if (ac && bc && ac !== bc) return false;
  }
  for (const field of ["create_date", "sale_invoice_type", "cl_currencies_id", "gross_price"] as const) {
    const av = a.invoicePayload[field], bv = b.invoicePayload[field];
    if (av !== undefined && av !== null && bv !== undefined && bv !== null && av !== bv) return false;
  }
  return true;
}

interface Partition {
  tail: Promise<void>;
  markers: SaleCreateRecoveryMarker[];
  reservations: Map<string, { intent: SaleCreateIntent; clientsId?: number }>;
  released: SaleCreateRecoveryMarker[];
}

export class SaleCreateRecoveryGuard {
  private readonly partitions = new Map<string, Partition>();
  constructor(private readonly capacity = 128) {}

  async withLock<T>(scope: SaleCreateScope, run: (session: SaleCreateRecoverySession) => Promise<T>): Promise<T> {
    const key = canonicalPlanJson(scope);
    let partition = this.partitions.get(key);
    if (!partition) {
      partition = { tail: Promise.resolve(), markers: [], reservations: new Map(), released: [] };
      this.partitions.set(key, partition);
    }
    const previous = partition.tail;
    let unlock!: () => void;
    partition.tail = new Promise<void>(resolve => { unlock = resolve; });
    await previous;
    let active = true;
    const ensureActive = () => { if (!active) throw new Error("Recovery session is closed."); };
    const find = (intent: SaleCreateIntent) => partition.markers.find(m => saleCreateMayBeSameEvent(m.intent, intent, m.clientsId));
    const reservation = (r: SaleCreateReservation) => {
      ensureActive();
      const row = partition.reservations.get(r.token);
      if (!row) throw new Error("Unknown sale create reservation.");
      return row;
    };
    const session: SaleCreateRecoverySession = {
      findPending: intent => { ensureActive(); return find(intent); },
      findReleased: intent => {
        ensureActive();
        return partition.released.find(released => saleCreateMayBeSameEvent(released.intent, intent, released.clientsId));
      },
      reserve: intent => {
        ensureActive();
        if (find(intent)) throw new Error("An earlier sale create is indeterminate.");
        if ([...partition.reservations.values()].some(row => saleCreateMayBeSameEvent(row.intent, intent, row.clientsId))) throw new Error("An overlapping sale create is already in flight.");
        if (partition.markers.length + partition.reservations.size + partition.released.length >= this.capacity) {
          throw new Error("Sale create recovery capacity exceeded; no pending evidence was evicted.");
        }
        const token = randomUUID();
        partition.reservations.set(token, { intent, clientsId: intent.clientsId });
        return Object.freeze({ token });
      },
      bindResolvedClient: (r, id) => {
        const row = reservation(r);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid resolved client ID.");
        const alias = { ...row.intent, clientsId: id };
        if (find(alias)) throw new Error("The resolved client has an indeterminate sale create.");
        row.clientsId = id;
      },
      markIndeterminate: (r, evidence) => {
        reservation(r);
        const marker = Object.freeze({
          intent: evidence.intent, clientsId: evidence.clientsId,
          ...(evidence.createdClientId !== undefined ? { createdClientId: evidence.createdClientId } : {}),
          publicContext: Object.freeze({
            operation: "sale_invoice_create", marker: randomUUID(), business_key: evidence.intent.intentSha256,
            related_objects: [{ type: "client", id: evidence.clientsId }],
          }),
        });
        partition.markers.push(marker);
        partition.reservations.delete(r.token);
        return marker;
      },
      complete: (r, id) => {
        reservation(r);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Sale create returned no positive safe-integer invoice ID.");
        partition.reservations.delete(r.token);
      },
      abandonDefinitive: r => { reservation(r); partition.reservations.delete(r.token); },
      release: (marker, intent) => {
        ensureActive();
        const index = partition.markers.findIndex(m => m.publicContext.marker === marker
          && canonicalPlanJson(m.intent.invoicePayload) === canonicalPlanJson(intent.invoicePayload)
          && (m.intent.intentSha256 === intent.intentSha256 || intent.clientsId === m.clientsId));
        if (index < 0) return false;
        const [released] = partition.markers.splice(index, 1);
        // Retain evidence for permanently fresh scans without restoring an
        // active hold or making the released marker releasable again.
        partition.released.push(released!);
        return true;
      },
      requiresFreshScan: intent => {
        ensureActive();
        return partition.released.some(released => saleCreateMayBeSameEvent(released.intent, intent, released.clientsId));
      },
    };
    try { return await run(session); }
    finally { active = false; unlock(); }
  }
}

const guards = new WeakMap<RuntimeSafetyContext, SaleCreateRecoveryGuard>();
export function saleCreateRecoveryFor(runtime: RuntimeSafetyContext): SaleCreateRecoveryGuard {
  let guard = guards.get(runtime);
  if (!guard) { guard = new SaleCreateRecoveryGuard(); guards.set(runtime, guard); }
  return guard;
}
