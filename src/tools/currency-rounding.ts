import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import type { ApiContext } from "./crud-tools.js";
import { mutate } from "../annotations.js";
import { logAudit } from "../audit-log.js";
import { roundMoney, roundTo } from "../money.js";
import {
  DEFAULT_FX_GAIN_ACCOUNT,
  DEFAULT_FX_LOSS_ACCOUNT,
} from "../accounting-defaults.js";
import { resolveFxAccount } from "../account-resolution.js";
import type { PurchaseInvoice, Transaction, TransactionItem } from "../types/api.js";
import { BookingGuard } from "../booking-guard.js";

const SMALL_ROUNDING_THRESHOLD = 0.10; // up to 10 cents → in-place fix
const FX_DIFFERENCE_LIMIT = 1.00;      // up to 1 EUR → FX journal posting

interface ReconcileCandidate {
  invoice_id: number;
  invoice_number: string;
  supplier_name: string;
  payment_status: string;
  cl_currencies_id: string;
  net_price?: number;
  vat_price?: number;
  gross_price?: number;
  base_gross_price?: number;
  invoice_date?: string;
  /** Latest linked-payment date; the FX journal is posted here (settlement period). */
  settlement_date?: string;
  paid_eur: number | null;
  diff_eur: number | null;
  category: "small_rounding" | "fx_difference" | "review";
  proposed_action: string;
  proposed_currency_rate?: number;
  proposed_base_gross_price?: number;
  proposed_base_net_price?: number;
  proposed_base_vat_price?: number;
  linked_transaction_ids: number[];
  contributing_transaction_ids: number[];
  liability_account_id: number | null;
  liability_account_dimension_id: number | null;
  provenance_error?: SettlementProvenanceError;
  // True when an FX-difference journal (document_number "FX:{invoice_id}")
  // already exists for this invoice. The paid-vs-booked diff persists after the
  // FX journal is posted (the journal touches the liability/P&L accounts, not
  // the invoice's linked payments), so without this guard a second execute run
  // would create a duplicate FX journal for the same residual.
  already_reconciled?: boolean;
}

export type SettlementProvenanceErrorCode =
  | "booked_base_missing_or_invalid"
  | "invoice_liability_account_missing_or_invalid"
  | "invoice_liability_dimension_invalid"
  | "liability_account_assertion_conflict"
  | "linked_transactions_missing"
  | "linked_transaction_id_invalid"
  | "linked_transaction_load_failed"
  | "linked_transaction_identity_conflict"
  | "linked_transaction_not_confirmed"
  | "linked_transaction_direction_conflict"
  | "invoice_distribution_missing"
  | "allocation_amount_invalid"
  | "allocation_currency_missing"
  | "allocation_currency_conflict"
  | "allocation_rate_invalid"
  | "allocation_base_invalid"
  | "allocation_eur_evidence_missing"
  | "allocation_base_conflict"
  | "no_active_settlement_allocation";

export interface SettlementProvenanceError {
  code: SettlementProvenanceErrorCode;
  message: string;
  transaction_id?: number;
}

export const SETTLEMENT_PROVENANCE_MESSAGES: Record<SettlementProvenanceErrorCode, string> = {
  booked_base_missing_or_invalid: "The invoice has no finite positive booked EUR gross amount.",
  invoice_liability_account_missing_or_invalid: "The invoice liability account is missing or invalid.",
  invoice_liability_dimension_invalid: "The invoice liability dimension is invalid.",
  liability_account_assertion_conflict: "The deprecated liability account assertion conflicts with the invoice liability account.",
  linked_transactions_missing: "The partially paid invoice has no linked transactions.",
  linked_transaction_id_invalid: "A linked transaction ID is invalid.",
  linked_transaction_load_failed: "A linked transaction could not be loaded.",
  linked_transaction_identity_conflict: "A loaded transaction identity conflicts with the requested linked transaction ID.",
  linked_transaction_not_confirmed: "An active linked transaction is not confirmed.",
  linked_transaction_direction_conflict: "An active linked transaction is not an outgoing supplier payment.",
  invoice_distribution_missing: "An active linked transaction has no canonical allocation to this purchase invoice.",
  allocation_amount_invalid: "An invoice allocation amount is missing, non-finite, non-positive, or exceeds its transaction.",
  allocation_currency_missing: "An invoice allocation has no explicit source currency.",
  allocation_currency_conflict: "Invoice allocation and transaction currencies conflict.",
  allocation_rate_invalid: "An invoice allocation exchange rate is non-finite or non-positive.",
  allocation_base_invalid: "An allocation or transaction base amount is non-finite or non-positive.",
  allocation_eur_evidence_missing: "An invoice allocation has no authoritative EUR amount evidence.",
  allocation_base_conflict: "Available EUR allocation evidence conflicts by more than one cent or exceeds its transaction base.",
  no_active_settlement_allocation: "No active linked transaction provides a valid allocation to this purchase invoice.",
};

export type InvoiceSettlementProvenance =
  | {
      ok: true;
      liabilityAccountId: number;
      liabilityDimensionId?: number;
      paidEur: number;
      settlementDate?: string;
      contributingTransactionIds: number[];
    }
  | {
      ok: false;
      error: SettlementProvenanceError;
      contributingTransactionIds: number[];
    };

const PROVENANCE_ERROR_PRECEDENCE: SettlementProvenanceErrorCode[] = [
  "booked_base_missing_or_invalid",
  "invoice_liability_account_missing_or_invalid",
  "invoice_liability_dimension_invalid",
  "liability_account_assertion_conflict",
  "linked_transactions_missing",
  "linked_transaction_id_invalid",
  "linked_transaction_load_failed",
  "linked_transaction_identity_conflict",
  "linked_transaction_not_confirmed",
  "linked_transaction_direction_conflict",
  "invoice_distribution_missing",
  "allocation_amount_invalid",
  "allocation_currency_missing",
  "allocation_currency_conflict",
  "allocation_rate_invalid",
  "allocation_base_invalid",
  "allocation_eur_evidence_missing",
  "allocation_base_conflict",
  "no_active_settlement_allocation",
];

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeCurrency(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function provenanceError(code: SettlementProvenanceErrorCode, transactionId?: number): SettlementProvenanceError {
  return {
    code,
    message: SETTLEMENT_PROVENANCE_MESSAGES[code],
    ...(transactionId === undefined ? {} : { transaction_id: transactionId }),
  };
}

function selectProvenanceError(errors: SettlementProvenanceError[]): SettlementProvenanceError | undefined {
  return [...errors].sort((a, b) => {
    const classOrder = PROVENANCE_ERROR_PRECEDENCE.indexOf(a.code) - PROVENANCE_ERROR_PRECEDENCE.indexOf(b.code);
    if (classOrder !== 0) return classOrder;
    if (a.transaction_id === undefined) return b.transaction_id === undefined ? 0 : -1;
    if (b.transaction_id === undefined) return 1;
    return a.transaction_id - b.transaction_id;
  })[0];
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function conflictsByMoreThanCent(values: number[]): boolean {
  if (values.length < 2) return false;
  const authoritativeCents = Math.round(values[0]! * 100);
  return values.slice(1).some(value => Math.abs(Math.round(value * 100) - authoritativeCents) > 1);
}

function exceedsByMoreThanCent(total: number, limit: number): boolean {
  return roundMoney(total - limit) > 0.01;
}

function isValidSettlementDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function resolveInvoiceSettlementProvenance(
  invoice: PurchaseInvoice,
  loadTransaction: (id: number) => Promise<Transaction>,
  liabilityAccountAssertion?: number,
): Promise<InvoiceSettlementProvenance> {
  const errors: SettlementProvenanceError[] = [];
  const liabilityAccountId = invoice.liability_accounts_id;
  const dimension = invoice.liability_accounts_dimensions_id;

  if (!isPositiveInteger(liabilityAccountId)) {
    errors.push(provenanceError("invoice_liability_account_missing_or_invalid"));
  }
  if (dimension !== undefined && dimension !== null && !isPositiveInteger(dimension)) {
    errors.push(provenanceError("invoice_liability_dimension_invalid"));
  }
  if (liabilityAccountAssertion !== undefined &&
      isPositiveInteger(liabilityAccountId) &&
      liabilityAccountAssertion !== liabilityAccountId) {
    errors.push(provenanceError("liability_account_assertion_conflict"));
  }

  const rawLinks = invoice.transactions;
  if (!Array.isArray(rawLinks) || rawLinks.length === 0) {
    errors.push(provenanceError("linked_transactions_missing"));
  }
  const linkedTransactions = Array.isArray(rawLinks) ? rawLinks : [];
  const validIds: number[] = [];
  for (const rawId of linkedTransactions) {
    if (!isPositiveInteger(rawId)) {
      errors.push(provenanceError("linked_transaction_id_invalid"));
    } else if (!validIds.includes(rawId)) {
      validIds.push(rawId);
    }
  }

  const loaded = await Promise.all(validIds.map(async (requestedId) => {
    try {
      return { requestedId, transaction: await loadTransaction(requestedId) };
    } catch {
      return { requestedId, transaction: undefined };
    }
  }));

  const contributions: Array<{ transactionId: number; paidEur: number; settlementDate?: string }> = [];
  for (const { requestedId, transaction: tx } of loaded) {
    if (tx === undefined || tx === null || typeof tx !== "object" || Array.isArray(tx)) {
      errors.push(provenanceError("linked_transaction_load_failed", requestedId));
      continue;
    }
    if (tx.id !== undefined && tx.id !== requestedId) {
      errors.push(provenanceError("linked_transaction_identity_conflict", requestedId));
      continue;
    }
    if (tx.is_deleted === true || tx.status === "VOID") continue;
    if (tx.status !== "CONFIRMED") errors.push(provenanceError("linked_transaction_not_confirmed", requestedId));
    if (tx.type !== "C") errors.push(provenanceError("linked_transaction_direction_conflict", requestedId));

    const rawItems: unknown[] = Array.isArray(tx.items) ? tx.items : [];
    const hasMalformedItems = !Array.isArray(tx.items) || rawItems.some(item =>
      item === null || typeof item !== "object" || Array.isArray(item)
    );
    const items = rawItems.filter((item): item is TransactionItem =>
      item !== null && typeof item === "object" && !Array.isArray(item)
    );
    const matchingItems = items.filter(item =>
      item.relation_table === "purchase_invoices" && item.relation_id === invoice.id
    );
    if (hasMalformedItems || matchingItems.length === 0) {
      errors.push(provenanceError("invoice_distribution_missing", requestedId));
    }

    let transactionValid = tx.status === "CONFIRMED" && tx.type === "C" &&
      !hasMalformedItems && matchingItems.length > 0;
    if (!isFinitePositive(tx.amount)) {
      errors.push(provenanceError("allocation_amount_invalid", requestedId));
      transactionValid = false;
    }
    const txCurrency = normalizeCurrency(tx.cl_currencies_id);
    if (txCurrency === undefined) {
      errors.push(provenanceError("allocation_currency_missing", requestedId));
      transactionValid = false;
    }
    if (isPresent(tx.currency_rate) && !isFinitePositive(tx.currency_rate)) {
      errors.push(provenanceError("allocation_rate_invalid", requestedId));
      transactionValid = false;
    }
    if (isPresent(tx.base_amount) && !isFinitePositive(tx.base_amount)) {
      errors.push(provenanceError("allocation_base_invalid", requestedId));
      transactionValid = false;
    }

    let nominalSum = 0;
    let eurSum = 0;
    for (const item of matchingItems) {
      let itemValid = true;
      if (!isFinitePositive(item.amount)) {
        errors.push(provenanceError("allocation_amount_invalid", requestedId));
        itemValid = false;
      } else {
        nominalSum += item.amount;
      }
      const itemCurrency = normalizeCurrency(item.cl_currencies_id);
      if (itemCurrency !== undefined && txCurrency !== undefined && itemCurrency !== txCurrency) {
        errors.push(provenanceError("allocation_currency_conflict", requestedId));
        itemValid = false;
      }
      if (isPresent(item.currency_rate) && !isFinitePositive(item.currency_rate)) {
        errors.push(provenanceError("allocation_rate_invalid", requestedId));
        itemValid = false;
      }
      if (isPresent(item.base_amount) && !isFinitePositive(item.base_amount)) {
        errors.push(provenanceError("allocation_base_invalid", requestedId));
        itemValid = false;
      }

      const rawEvidences: number[] = [];
      if (isFinitePositive(item.base_amount)) rawEvidences.push(item.base_amount);
      if (isFinitePositive(item.amount) && txCurrency === "EUR") rawEvidences.push(item.amount);
      if (isFinitePositive(item.amount) && isFinitePositive(item.currency_rate)) rawEvidences.push(item.amount * item.currency_rate);
      if (isFinitePositive(item.amount) && isFinitePositive(tx.currency_rate)) rawEvidences.push(item.amount * tx.currency_rate);
      if (isFinitePositive(item.amount) && isFinitePositive(tx.base_amount) && isFinitePositive(tx.amount)) {
        rawEvidences.push(item.amount * tx.base_amount / tx.amount);
      }
      const evidenceIsInvalid = rawEvidences.some(value => !Number.isFinite(value) || value <= 0);
      if (evidenceIsInvalid) {
        errors.push(provenanceError("allocation_base_invalid", requestedId));
        itemValid = false;
      }
      const evidences = evidenceIsInvalid ? [] : rawEvidences.map(roundMoney);
      if (evidences.length === 0) {
        if (!evidenceIsInvalid) errors.push(provenanceError("allocation_eur_evidence_missing", requestedId));
        itemValid = false;
      } else if (conflictsByMoreThanCent(evidences)) {
        errors.push(provenanceError("allocation_base_conflict", requestedId));
        itemValid = false;
      }
      if (itemValid) eurSum += evidences[0]!;
      else transactionValid = false;
    }

    if (!Number.isFinite(nominalSum)) {
      errors.push(provenanceError("allocation_amount_invalid", requestedId));
      transactionValid = false;
    }
    if (!Number.isFinite(eurSum)) {
      errors.push(provenanceError("allocation_base_invalid", requestedId));
      transactionValid = false;
    }
    if (Number.isFinite(nominalSum) && isFinitePositive(tx.amount) && exceedsByMoreThanCent(nominalSum, tx.amount)) {
      errors.push(provenanceError("allocation_amount_invalid", requestedId));
      transactionValid = false;
    }
    if (Number.isFinite(eurSum) && isFinitePositive(tx.base_amount) && exceedsByMoreThanCent(eurSum, tx.base_amount)) {
      errors.push(provenanceError("allocation_base_conflict", requestedId));
      transactionValid = false;
    }
    if (transactionValid) {
      contributions.push({
        transactionId: requestedId,
        paidEur: roundMoney(eurSum),
        ...(isValidSettlementDate(tx.date) ? { settlementDate: tx.date } : {}),
      });
    }
  }

  if (contributions.length === 0 && errors.length === 0) {
    errors.push(provenanceError("no_active_settlement_allocation"));
  }

  const contributingTransactionIds = contributions.map(value => value.transactionId).sort((a, b) => a - b);
  const totalPaidEur = contributions.reduce((sum, value) => sum + value.paidEur, 0);
  if (!Number.isFinite(totalPaidEur)) errors.push(provenanceError("allocation_base_invalid"));
  const selectedError = selectProvenanceError(errors);
  if (selectedError !== undefined || !isPositiveInteger(liabilityAccountId)) {
    return {
      ok: false,
      error: selectedError ?? provenanceError("invoice_liability_account_missing_or_invalid"),
      contributingTransactionIds,
    };
  }

  const settlementDates = contributions.flatMap(value => value.settlementDate === undefined ? [] : [value.settlementDate]);
  settlementDates.sort();
  return {
    ok: true,
    liabilityAccountId,
    ...(isPositiveInteger(dimension) ? { liabilityDimensionId: dimension } : {}),
    paidEur: roundMoney(totalPaidEur),
    ...(settlementDates.length === 0 ? {} : { settlementDate: settlementDates.at(-1) }),
    contributingTransactionIds,
  };
}

function effectiveBaseGross(inv: PurchaseInvoice): number | undefined {
  if (inv.base_gross_price !== undefined && inv.base_gross_price !== null) return inv.base_gross_price;
  if ((inv.cl_currencies_id ?? "EUR").toUpperCase() === "EUR") return inv.gross_price ?? undefined;
  return undefined;
}

function categorizeDiff(diff: number): "small_rounding" | "fx_difference" | "review" {
  const abs = Math.abs(diff);
  if (abs < SMALL_ROUNDING_THRESHOLD) return "small_rounding";
  if (abs <= FX_DIFFERENCE_LIMIT) return "fx_difference";
  return "review";
}

export function registerCurrencyRoundingTools(server: McpServer, api: ApiContext): void {
  registerTool(server, "reconcile_currency_rounding",
    "Reconcile small PARTIALLY_PAID purchase-invoice currency residuals. DRY RUN by default; execute=true applies in-place fixes for <0.10 EUR or FX journals for 0.10-1.00 EUR.",
    {
      execute: z.boolean().optional().describe("Apply the proposed fixes (default false = dry run)"),
      max_candidates: z.number().int().positive().optional().describe("Limit to first N PARTIALLY_PAID invoices"),
      liability_accounts_id: z.number().int().positive().optional().describe("Deprecated compatibility assertion. When supplied, it must match the invoice liability account; it never overrides or supplies that account."),
      fx_gain_account_id: z.number().int().positive().optional().describe(`Account for FX gains (diff > 0, paid less than booked) — default: auto-detect combined "Kasum/kahjum valuutakursi muutustest" (standard ${DEFAULT_FX_GAIN_ACCOUNT})`),
      fx_loss_account_id: z.number().int().positive().optional().describe(`Account for FX losses (diff < 0, paid more than booked) — default: same combined FX account as gains (standard ${DEFAULT_FX_LOSS_ACCOUNT})`),
    },
    { ...mutate, openWorldHint: true, title: "Reconcile Currency Rounding" },
    async ({
      execute,
      max_candidates,
      liability_accounts_id,
      fx_gain_account_id,
      fx_loss_account_id,
    }) => {
      const dryRun = execute !== true;
      // Resolve the FX account by name against the company's actual chart. Both
      // the gain and the loss default to the SAME combined account "Kasum/kahjum
      // valuutakursi muutustest" (standard 8500) — the standard chart has one
      // combined FX result account, not a separate gain/loss pair. A caller
      // override still lets the two diverge. (The old DEFAULT_FX_LOSS_ACCOUNT=8600
      // pointed at "Muud finantstulud", a financial INCOME account, so an FX loss
      // would have posted to income with the wrong sign.)
      const fxAccounts = await api.readonly.getAccounts();
      const fxGainAccount = resolveFxAccount(fxAccounts, fx_gain_account_id);
      const fxLossAccount = resolveFxAccount(fxAccounts, fx_loss_account_id);

      const allInvoices = await api.purchaseInvoices.listAll();
      let partiallyPaid = allInvoices.filter(inv =>
        inv.payment_status === "PARTIALLY_PAID" && inv.id !== undefined
      );
      if (max_candidates !== undefined) partiallyPaid = partiallyPaid.slice(0, max_candidates);

      // An FX journal is stamped with document_number "FX:{invoice_id}". The
      // BookingGuard snapshots the ledger once and exposes idempotent lookup
      // (`find`) + guarded create (`createJournalOnce`) so we never post a
      // second FX journal for the same residual (the diff does not clear when
      // the journal is booked, so execute is otherwise not idempotent). Its
      // default `not_deleted` liveness means a deleted/invalidated FX journal
      // does NOT block re-booking — the residual is still open, so the operator
      // invalidated it precisely to re-post it.
      const guard = await BookingGuard.load(api);
      const isFxReconciled = (invoiceId: number): boolean =>
        guard.find({ ns: "FX", id: String(invoiceId) }) !== undefined;

      const candidates: ReconcileCandidate[] = [];

      for (const inv of partiallyPaid) {
        const full = await api.purchaseInvoices.get(inv.id!);
        const txIds = Array.isArray(full.transactions) ? full.transactions : [];
        const bookedEur = effectiveBaseGross(full);
        const currency = (full.cl_currencies_id ?? "EUR").toUpperCase();
        const provenLiabilityAccount = isPositiveInteger(full.liability_accounts_id)
          ? full.liability_accounts_id
          : null;
        const provenLiabilityDimension = full.liability_accounts_dimensions_id === undefined ||
          full.liability_accounts_dimensions_id === null
          ? null
          : isPositiveInteger(full.liability_accounts_dimensions_id)
            ? full.liability_accounts_dimensions_id
            : null;
        const pushProvenanceReview = (
          error: SettlementProvenanceError,
          contributingTransactionIds: number[],
        ): void => {
          candidates.push({
            invoice_id: full.id!,
            invoice_number: full.number,
            supplier_name: full.client_name ?? "",
            payment_status: full.payment_status ?? "",
            cl_currencies_id: currency,
            net_price: full.net_price,
            vat_price: full.vat_price,
            gross_price: full.gross_price,
            base_gross_price: full.base_gross_price,
            invoice_date: full.create_date,
            paid_eur: null,
            diff_eur: null,
            category: "review",
            proposed_action: `Flag for review — ${error.message}`,
            linked_transaction_ids: txIds,
            contributing_transaction_ids: contributingTransactionIds,
            liability_account_id: provenLiabilityAccount,
            liability_account_dimension_id: provenLiabilityDimension,
            provenance_error: error,
          });
        };
        if (!isFinitePositive(bookedEur)) {
          pushProvenanceReview(provenanceError("booked_base_missing_or_invalid"), []);
          continue;
        }

        const provenance = await resolveInvoiceSettlementProvenance(
          full,
          id => api.transactions.get(id),
          liability_accounts_id,
        );
        if (!provenance.ok) {
          pushProvenanceReview(provenance.error, provenance.contributingTransactionIds);
          continue;
        }

        const paidEur = provenance.paidEur;
        const diff = roundMoney(bookedEur - paidEur);
        if (diff === 0) continue;

        const isForeignCurrency = currency !== "EUR";
        let category = categorizeDiff(diff);
        // An EUR invoice has no exchange-rate difference: a 0.10–1.00 EUR
        // residual is a genuine over/under-payment, never an FX rounding artifact
        // — do not auto-book it as an FX journal.
        if (category === "fx_difference" && !isForeignCurrency) category = "review";

        let proposedAction: string;
        let proposedCurrencyRate: number | undefined;
        let proposedBaseGrossPrice: number | undefined;
        let proposedBaseNetPrice: number | undefined;
        let proposedBaseVatPrice: number | undefined;

        if (category === "small_rounding") {
          if (isForeignCurrency && full.gross_price && full.gross_price > 0) {
            proposedBaseGrossPrice = paidEur;
            proposedCurrencyRate = roundTo(paidEur / full.gross_price, 6);
            // Recompute base_net/base_vat from foreign-currency components so
            // base_net + base_vat ≈ base_gross stays consistent for VAT
            // invoices with multi-line / mixed-rate items.
            if (full.net_price !== undefined && full.net_price !== null) {
              proposedBaseNetPrice = roundMoney(full.net_price * proposedCurrencyRate);
              // Derive base_vat as the residual against the pinned base_gross
              // (paidEur) so base_net + base_vat == base_gross to the cent.
              // Rounding net, vat, and gross independently could leave the trio
              // off by 1 cent and re-trip this same rounding check next run.
              if (full.vat_price !== undefined && full.vat_price !== null) {
                proposedBaseVatPrice = roundMoney(proposedBaseGrossPrice - proposedBaseNetPrice);
              }
            } else if (full.vat_price !== undefined && full.vat_price !== null) {
              proposedBaseVatPrice = roundMoney(full.vat_price * proposedCurrencyRate);
              // Mirror the net-present branch: pin base_net as the residual so the
              // patched trio still reconciles (base_net + base_vat == base_gross).
              // Without this, execute mode would patch base_gross/base_vat but
              // leave a stale base_net, re-tripping this same rounding check.
              proposedBaseNetPrice = roundMoney(proposedBaseGrossPrice - proposedBaseVatPrice);
            }
            proposedAction = `Update base_gross_price ${bookedEur.toFixed(2)} → ${paidEur.toFixed(2)} EUR and currency_rate to ${proposedCurrencyRate} (locks Wise actual conversion).`;
          } else {
            proposedBaseGrossPrice = paidEur;
            proposedAction = `Update gross_price ${bookedEur.toFixed(2)} → ${paidEur.toFixed(2)} EUR (legacy EUR booking; Wise paid actual amount).`;
          }
        } else if (category === "fx_difference") {
          // diff = bookedEur - paidEur. diff > 0 means we booked the supplier
          // liability higher than what actually settled in EUR → liability is
          // overstated, reduce it (D liability) and book the offset as FX gain
          // (C 8500). diff < 0 is the mirror: liability understated, debit FX
          // loss (D 8500, the same combined FX account) and credit liability.
          const isOverstated = diff > 0;
          const fxAccount = isOverstated ? fxGainAccount : fxLossAccount;
          if (isFxReconciled(full.id!)) {
            proposedAction = `Already reconciled — an FX journal (FX:${full.id}) exists for this invoice; skipping to avoid a duplicate.`;
          } else {
            proposedAction = `Book ${Math.abs(diff).toFixed(2)} EUR FX adjustment journal: ${isOverstated ? `D ${provenance.liabilityAccountId} / C ${fxAccount} (FX gain — booked liability higher than Wise settlement)` : `D ${fxAccount} / C ${provenance.liabilityAccountId} (FX loss — booked liability lower than Wise settlement)`}.`;
          }
        } else {
          proposedAction = !isForeignCurrency
            ? `Flag for review — EUR invoice residual ${diff.toFixed(2)} EUR is a genuine over/under-payment, not an FX rounding difference.`
            : `Flag for review — diff ${diff.toFixed(2)} EUR exceeds ${FX_DIFFERENCE_LIMIT.toFixed(2)} EUR FX threshold.`;
        }

        candidates.push({
          invoice_id: full.id!,
          invoice_number: full.number,
          supplier_name: full.client_name ?? "",
          payment_status: full.payment_status ?? "",
          cl_currencies_id: currency,
          net_price: full.net_price,
          vat_price: full.vat_price,
          gross_price: full.gross_price,
          base_gross_price: full.base_gross_price,
          invoice_date: full.create_date,
          settlement_date: provenance.settlementDate,
          paid_eur: paidEur,
          diff_eur: diff,
          category,
          proposed_action: proposedAction,
          proposed_currency_rate: proposedCurrencyRate,
          proposed_base_gross_price: proposedBaseGrossPrice,
          proposed_base_net_price: proposedBaseNetPrice,
          proposed_base_vat_price: proposedBaseVatPrice,
          linked_transaction_ids: txIds,
          contributing_transaction_ids: provenance.contributingTransactionIds,
          liability_account_id: provenance.liabilityAccountId,
          liability_account_dimension_id: provenance.liabilityDimensionId ?? null,
          already_reconciled: category === "fx_difference" && isFxReconciled(full.id!),
        });
      }

      const applied: Array<{
        invoice_id: number;
        category: string;
        action: string;
        result: "success" | "error";
        error?: string;
      }> = [];

      if (!dryRun) {
        for (const c of candidates) {
          if (c.category === "review") continue;
          if (c.diff_eur === null || c.paid_eur === null || c.liability_account_id === null) continue;
          // Idempotency guard: an FX journal already exists for this invoice.
          // The paid-vs-booked residual does not clear when the journal is
          // posted, so re-running execute would otherwise double-book it.
          if (c.already_reconciled) continue;
          try {
            if (c.category === "small_rounding") {
              const patch: Partial<PurchaseInvoice> = {};
              const isForeignCurrency = c.cl_currencies_id !== "EUR";
              if (isForeignCurrency && c.proposed_base_gross_price !== undefined && c.proposed_currency_rate !== undefined) {
                patch.base_gross_price = c.proposed_base_gross_price;
                patch.currency_rate = c.proposed_currency_rate;
                // Only adjust base_net/base_vat when the candidate carries a
                // proposal computed from the foreign-currency components,
                // preserving any existing VAT/net split for multi-line and
                // mixed-rate invoices.
                if (c.proposed_base_net_price !== undefined) patch.base_net_price = c.proposed_base_net_price;
                if (c.proposed_base_vat_price !== undefined) patch.base_vat_price = c.proposed_base_vat_price;
              } else if (c.proposed_base_gross_price !== undefined) {
                patch.gross_price = c.proposed_base_gross_price;
              }
              await api.purchaseInvoices.update(c.invoice_id, patch);
              logAudit({
                tool: "reconcile_currency_rounding", action: "UPDATED", entity_type: "purchase_invoice",
                entity_id: c.invoice_id,
                summary: `Adjusted EUR rounding for invoice ${c.invoice_number}: diff ${c.diff_eur.toFixed(2)} EUR`,
                details: {
                  patch,
                  paid_eur: c.paid_eur,
                  booked_eur: c.base_gross_price ?? c.gross_price,
                  diff_eur: c.diff_eur,
                  liability_account_id: c.liability_account_id,
                  liability_account_dimension_id: c.liability_account_dimension_id,
                  linked_transaction_ids: c.linked_transaction_ids,
                  contributing_transaction_ids: c.contributing_transaction_ids,
                },
              });
              applied.push({ invoice_id: c.invoice_id, category: c.category, action: c.proposed_action, result: "success" });
            } else if (c.category === "fx_difference") {
              const absDiff = Math.abs(c.diff_eur);
              // diff > 0 ⇒ booked liability higher than paid ⇒ overstated;
              // reduce liability (D) and post the windfall as FX gain (C 8500).
              const isOverstated = c.diff_eur > 0;
              const fxAccount = isOverstated ? fxGainAccount : fxLossAccount;
              // Post the FX difference in the SETTLEMENT period (latest payment
              // date), not the invoice date — a Dec invoice paid in Jan books the
              // rate difference in Jan. Fall back to invoice date, then today.
              const journalDate = c.settlement_date ?? c.invoice_date ?? new Date().toISOString().slice(0, 10);
              // Guarded write: find-then-create against the run snapshot. The
              // guard stamps document_number "FX:{invoice_id}", best-effort
              // confirms, and records the journal so a duplicate can never be
              // posted for the same residual (within or across runs).
              const outcome = await guard.createJournalOnce(
                { ns: "FX", id: String(c.invoice_id) },
                {
                  effective_date: journalDate,
                  title: `FX kursivahe ostuarvele ${c.invoice_number}`,
                  cl_currencies_id: "EUR",
                  postings: isOverstated
                    ? [
                        {
                          accounts_id: c.liability_account_id,
                          ...(c.liability_account_dimension_id === null ? {} : { accounts_dimensions_id: c.liability_account_dimension_id }),
                          type: "D",
                          amount: absDiff,
                        }, // reduce payable
                        { accounts_id: fxAccount, type: "C", amount: absDiff },          // FX gain
                      ]
                    : [
                        { accounts_id: fxAccount, type: "D", amount: absDiff },          // FX loss
                        {
                          accounts_id: c.liability_account_id,
                          ...(c.liability_account_dimension_id === null ? {} : { accounts_dimensions_id: c.liability_account_dimension_id }),
                          type: "C",
                          amount: absDiff,
                        }, // increase payable
                      ],
                },
              );
              if (outcome.status === "duplicate") {
                // A concurrent run (or an in-snapshot journal the pre-scan
                // missed) already booked this residual — treat as already
                // reconciled rather than double-posting.
                applied.push({
                  invoice_id: c.invoice_id,
                  category: c.category,
                  action: `Already reconciled — FX journal (FX:${c.invoice_id}, id ${outcome.journal_id}) exists; skipped to avoid a duplicate.`,
                  result: "success",
                });
                continue;
              }
              logAudit({
                tool: "reconcile_currency_rounding", action: "CREATED", entity_type: "journal",
                entity_id: outcome.journal_id,
                summary: `FX kursivahe journal for invoice ${c.invoice_number}: ${absDiff.toFixed(2)} EUR ${isOverstated ? "gain" : "loss"}`,
                details: {
                  invoice_id: c.invoice_id,
                  diff_eur: c.diff_eur,
                  fx_account: fxAccount,
                  liability_account_id: c.liability_account_id,
                  liability_account_dimension_id: c.liability_account_dimension_id,
                  linked_transaction_ids: c.linked_transaction_ids,
                  contributing_transaction_ids: c.contributing_transaction_ids,
                  paid_eur: c.paid_eur,
                },
              });
              applied.push({ invoice_id: c.invoice_id, category: c.category, action: c.proposed_action, result: "success" });
            }
          } catch (err) {
            applied.push({
              invoice_id: c.invoice_id,
              category: c.category,
              action: c.proposed_action,
              result: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      const summary = {
        total_partially_paid_scanned: partiallyPaid.length,
        candidates_with_diff: candidates.length,
        small_rounding: candidates.filter(c => c.category === "small_rounding").length,
        fx_difference: candidates.filter(c => c.category === "fx_difference" && !c.already_reconciled).length,
        fx_already_reconciled: candidates.filter(c => c.already_reconciled).length,
        review: candidates.filter(c => c.category === "review").length,
        ...(dryRun ? {} : {
          applied_success: applied.filter(a => a.result === "success").length,
          applied_errors: applied.filter(a => a.result === "error").length,
        }),
      };

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            mode: dryRun ? "DRY_RUN" : "EXECUTED",
            summary,
            candidates,
            ...(dryRun ? {} : { applied }),
            note: dryRun
              ? "Dry run. Re-run with execute=true to apply small_rounding patches and fx_difference journals. review-bucket items are never auto-applied."
              : "Applied.",
          }),
        }],
      };
    }
  );
}
