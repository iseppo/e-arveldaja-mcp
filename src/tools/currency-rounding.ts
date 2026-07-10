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
  DEFAULT_LIABILITY_ACCOUNT,
} from "../accounting-defaults.js";
import type { PurchaseInvoice, Transaction } from "../types/api.js";

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
  paid_eur: number;
  diff_eur: number;
  category: "small_rounding" | "fx_difference" | "review";
  proposed_action: string;
  proposed_currency_rate?: number;
  proposed_base_gross_price?: number;
  proposed_base_net_price?: number;
  proposed_base_vat_price?: number;
  linked_transaction_ids: number[];
  // True when an FX-difference journal (document_number "FX:{invoice_id}")
  // already exists for this invoice. The paid-vs-booked diff persists after the
  // FX journal is posted (the journal touches the liability/P&L accounts, not
  // the invoice's linked payments), so without this guard a second execute run
  // would create a duplicate FX journal for the same residual.
  already_reconciled?: boolean;
}

function effectiveBaseGross(inv: PurchaseInvoice): number | undefined {
  if (inv.base_gross_price !== undefined && inv.base_gross_price !== null) return inv.base_gross_price;
  if ((inv.cl_currencies_id ?? "EUR").toUpperCase() === "EUR") return inv.gross_price ?? undefined;
  return undefined;
}

function transactionEurAmount(tx: Transaction): number {
  if (tx.base_amount !== undefined && tx.base_amount !== null && Number.isFinite(tx.base_amount)) return tx.base_amount;
  const currency = (tx.cl_currencies_id ?? "EUR").toUpperCase();
  if (currency === "EUR") return tx.amount;
  if (tx.currency_rate && Number.isFinite(tx.currency_rate)) return roundMoney(tx.amount * tx.currency_rate);
  return tx.amount;
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
      liability_accounts_id: z.number().int().positive().optional().describe(`Liability account for the supplier balance side of the FX posting (default ${DEFAULT_LIABILITY_ACCOUNT})`),
      fx_gain_account_id: z.number().int().positive().optional().describe(`Account for FX gains (diff < 0, paid less than booked) — default ${DEFAULT_FX_GAIN_ACCOUNT}`),
      fx_loss_account_id: z.number().int().positive().optional().describe(`Account for FX losses (diff > 0, paid more than booked) — default ${DEFAULT_FX_LOSS_ACCOUNT}`),
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
      const liabilityAccount = liability_accounts_id ?? DEFAULT_LIABILITY_ACCOUNT;
      const fxGainAccount = fx_gain_account_id ?? DEFAULT_FX_GAIN_ACCOUNT;
      const fxLossAccount = fx_loss_account_id ?? DEFAULT_FX_LOSS_ACCOUNT;

      const allInvoices = await api.purchaseInvoices.listAll();
      let partiallyPaid = allInvoices.filter(inv =>
        inv.payment_status === "PARTIALLY_PAID" && inv.id !== undefined
      );
      if (max_candidates !== undefined) partiallyPaid = partiallyPaid.slice(0, max_candidates);

      // An FX journal is stamped with document_number "FX:{invoice_id}". Collect
      // the invoice IDs that already carry one so we never post a second FX
      // journal for the same residual (the diff does not clear when the journal
      // is booked, so execute is otherwise not idempotent).
      const fxReconciledInvoiceIds = new Set<number>();
      for (const j of await api.journals.listAll()) {
        const dn = j.document_number;
        if (typeof dn === "string" && dn.startsWith("FX:")) {
          const invId = Number(dn.slice(3));
          if (Number.isInteger(invId)) fxReconciledInvoiceIds.add(invId);
        }
      }

      const candidates: ReconcileCandidate[] = [];

      for (const inv of partiallyPaid) {
        const full = await api.purchaseInvoices.get(inv.id!);
        const txIds = full.transactions ?? [];
        let paidEur = 0;
        for (const txId of txIds) {
          try {
            const tx = await api.transactions.get(txId);
            if (tx.status === "VOID" || tx.is_deleted) continue;
            paidEur += transactionEurAmount(tx);
          } catch {
            // Transaction unreachable — skip; the invoice can still be flagged
            // but we can't confidently propose an action without all payments.
          }
        }
        paidEur = roundMoney(paidEur);

        const bookedEur = effectiveBaseGross(full);
        if (bookedEur === undefined) continue; // can't compare
        const diff = roundMoney(bookedEur - paidEur);
        if (diff === 0) continue;

        const category = categorizeDiff(diff);
        const currency = (full.cl_currencies_id ?? "EUR").toUpperCase();
        const isForeignCurrency = currency !== "EUR";

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
          // loss (D 8600) and credit liability.
          const isOverstated = diff > 0;
          const fxAccount = isOverstated ? fxGainAccount : fxLossAccount;
          if (fxReconciledInvoiceIds.has(full.id!)) {
            proposedAction = `Already reconciled — an FX journal (FX:${full.id}) exists for this invoice; skipping to avoid a duplicate.`;
          } else {
            proposedAction = `Book ${Math.abs(diff).toFixed(2)} EUR FX adjustment journal: ${isOverstated ? `D ${liabilityAccount} / C ${fxAccount} (FX gain — booked liability higher than Wise settlement)` : `D ${fxAccount} / C ${liabilityAccount} (FX loss — booked liability lower than Wise settlement)`}.`;
          }
        } else {
          proposedAction = `Flag for review — diff ${diff.toFixed(2)} EUR exceeds ${FX_DIFFERENCE_LIMIT.toFixed(2)} EUR FX threshold.`;
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
          paid_eur: paidEur,
          diff_eur: diff,
          category,
          proposed_action: proposedAction,
          proposed_currency_rate: proposedCurrencyRate,
          proposed_base_gross_price: proposedBaseGrossPrice,
          proposed_base_net_price: proposedBaseNetPrice,
          proposed_base_vat_price: proposedBaseVatPrice,
          linked_transaction_ids: txIds,
          already_reconciled: category === "fx_difference" && fxReconciledInvoiceIds.has(full.id!),
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
                details: { patch, paid_eur: c.paid_eur, booked_eur: c.base_gross_price ?? c.gross_price, diff_eur: c.diff_eur },
              });
              applied.push({ invoice_id: c.invoice_id, category: c.category, action: c.proposed_action, result: "success" });
            } else if (c.category === "fx_difference") {
              const absDiff = Math.abs(c.diff_eur);
              // diff > 0 ⇒ booked liability higher than paid ⇒ overstated;
              // reduce liability (D) and post the windfall as FX gain (C 8500).
              const isOverstated = c.diff_eur > 0;
              const fxAccount = isOverstated ? fxGainAccount : fxLossAccount;
              const journalDate = c.invoice_date ?? new Date().toISOString().slice(0, 10);
              const journal = await api.journals.create({
                effective_date: journalDate,
                title: `FX kursivahe ostuarvele ${c.invoice_number}`,
                document_number: `FX:${c.invoice_id}`,
                cl_currencies_id: "EUR",
                postings: isOverstated
                  ? [
                      { accounts_id: liabilityAccount, type: "D", amount: absDiff }, // reduce payable
                      { accounts_id: fxAccount, type: "C", amount: absDiff },          // FX gain
                    ]
                  : [
                      { accounts_id: fxAccount, type: "D", amount: absDiff },          // FX loss
                      { accounts_id: liabilityAccount, type: "C", amount: absDiff }, // increase payable
                    ],
              });
              if (journal.created_object_id) {
                try {
                  await api.journals.confirm(journal.created_object_id);
                } catch {
                  // Leave journal in PROJECT for the operator to inspect if confirm fails
                }
              }
              logAudit({
                tool: "reconcile_currency_rounding", action: "CREATED", entity_type: "journal",
                entity_id: journal.created_object_id,
                summary: `FX kursivahe journal for invoice ${c.invoice_number}: ${absDiff.toFixed(2)} EUR ${isOverstated ? "gain" : "loss"}`,
                details: { invoice_id: c.invoice_id, diff_eur: c.diff_eur, fx_account: fxAccount, liability_account: liabilityAccount },
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
