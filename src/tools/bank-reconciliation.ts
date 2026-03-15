import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiContext } from "./crud-tools.js";
import type { Transaction, SaleInvoice, PurchaseInvoice } from "../types/api.js";

interface MatchCandidate {
  type: "sale_invoice" | "purchase_invoice";
  id: number;
  number: string;
  client_name: string;
  clients_id: number;
  gross_price: number;
  ref_number?: string | null;
  confidence: number;
  match_reasons: string[];
}

function matchScore(
  tx: Transaction,
  invoice: { gross_price?: number; bank_ref_number?: string | null; clients_id?: number; client_name?: string },
  txAmount: number
): { confidence: number; reasons: string[] } {
  let confidence = 0;
  const reasons: string[] = [];

  // Amount match
  const invoiceAmount = invoice.gross_price ?? 0;
  if (Math.abs(txAmount - invoiceAmount) < 0.01) {
    confidence += 40;
    reasons.push("exact_amount");
  } else if (Math.abs(txAmount - invoiceAmount) < 1) {
    confidence += 20;
    reasons.push("close_amount");
  }

  // Reference number match
  if (tx.ref_number && invoice.bank_ref_number && tx.ref_number === invoice.bank_ref_number) {
    confidence += 40;
    reasons.push("ref_number");
  }

  // Client match
  if (tx.clients_id && invoice.clients_id && tx.clients_id === invoice.clients_id) {
    confidence += 15;
    reasons.push("client_id");
  } else if (tx.bank_account_name && invoice.client_name) {
    const nameLower = tx.bank_account_name.toLowerCase();
    const clientLower = invoice.client_name.toLowerCase();
    if (nameLower.includes(clientLower) || clientLower.includes(nameLower)) {
      confidence += 10;
      reasons.push("client_name_partial");
    }
  }

  return { confidence: Math.min(confidence, 100), reasons };
}

export function registerBankReconciliationTools(server: McpServer, api: ApiContext): void {

  server.tool("reconcile_transactions",
    "Match unconfirmed bank transactions to open sale/purchase invoices. " +
    "Returns suggested matches with confidence scores and ready-to-use distribution data.",
    {
      min_confidence: z.number().optional().describe("Minimum confidence threshold 0-100 (default 50)"),
      page: z.number().optional().describe("Transactions page to process (default 1)"),
    },
    async ({ min_confidence, page }) => {
      const threshold = min_confidence ?? 50;

      // Get unconfirmed transactions
      const txPage = await api.transactions.list({ page: page ?? 1 });
      const unconfirmed = txPage.items.filter(tx => tx.status !== "CONFIRMED" && !tx.is_deleted);

      // Get unpaid invoices (exclude partially paid - amount won't match)
      const allSales = await api.saleInvoices.listAll();
      const openSales = allSales.filter((inv: SaleInvoice) =>
        inv.payment_status === "NOT_PAID" && inv.status === "CONFIRMED"
      );

      const allPurchases = await api.purchaseInvoices.listAll();
      const openPurchases = allPurchases.filter((inv: PurchaseInvoice) =>
        inv.payment_status === "NOT_PAID" && inv.status === "CONFIRMED"
      );

      const results = [];

      for (const tx of unconfirmed) {
        const candidates: MatchCandidate[] = [];

        // Match against sale invoices (incoming payments - type D)
        if (tx.type === "D") {
          for (const inv of openSales) {
            const { confidence, reasons } = matchScore(tx, inv, tx.amount);
            if (confidence >= threshold) {
              candidates.push({
                type: "sale_invoice",
                id: inv.id!,
                number: inv.number ?? `${inv.number_prefix}${inv.number_suffix}`,
                client_name: inv.client_name ?? "",
                clients_id: inv.clients_id,
                gross_price: inv.gross_price ?? 0,
                ref_number: inv.bank_ref_number,
                confidence,
                match_reasons: reasons,
              });
            }
          }
        }

        // Match against purchase invoices (outgoing payments - type C)
        if (tx.type === "C") {
          for (const inv of openPurchases) {
            const { confidence, reasons } = matchScore(tx, inv, tx.amount);
            if (confidence >= threshold) {
              candidates.push({
                type: "purchase_invoice",
                id: inv.id!,
                number: inv.number,
                client_name: inv.client_name,
                clients_id: inv.clients_id,
                gross_price: inv.gross_price ?? 0,
                ref_number: inv.bank_ref_number,
                confidence,
                match_reasons: reasons,
              });
            }
          }
        }

        if (candidates.length > 0) {
          candidates.sort((a, b) => b.confidence - a.confidence);
          results.push({
            transaction_id: tx.id,
            date: tx.date,
            amount: tx.amount,
            type: tx.type,
            description: tx.description,
            bank_account_name: tx.bank_account_name,
            ref_number: tx.ref_number,
            best_match: candidates[0],
            other_candidates: candidates.slice(1, 3),
            distribution: {
              related_table: candidates[0].type === "sale_invoice" ? "sale_invoices" : "purchase_invoices",
              related_id: candidates[0].id,
              amount: tx.amount,
            },
          });
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total_unconfirmed: unconfirmed.length,
            matched: results.length,
            unmatched: unconfirmed.length - results.length,
            matches: results,
          }, null, 2),
        }],
      };
    }
  );

  server.tool("auto_confirm_exact_matches",
    "Automatically confirm bank transactions that have a single high-confidence match (>=90). " +
    "DRY RUN by default - set execute=true to actually confirm.",
    {
      execute: z.boolean().optional().describe("Actually confirm transactions (default false = dry run)"),
      min_confidence: z.number().optional().describe("Minimum confidence (default 90)"),
    },
    async ({ execute, min_confidence }) => {
      const threshold = min_confidence ?? 90;
      const dryRun = execute !== true;

      // Get all unconfirmed transactions across pages
      const allTx = await api.transactions.listAll();
      const unconfirmed = allTx.filter(tx => tx.status !== "CONFIRMED" && !tx.is_deleted);

      const allSales = await api.saleInvoices.listAll();
      const openSales = allSales.filter((inv: SaleInvoice) =>
        inv.payment_status === "NOT_PAID" && inv.status === "CONFIRMED"
      );

      const allPurchases = await api.purchaseInvoices.listAll();
      const openPurchases = allPurchases.filter((inv: PurchaseInvoice) =>
        inv.payment_status === "NOT_PAID" && inv.status === "CONFIRMED"
      );

      const confirmed = [];
      const skipped = [];
      // Track consumed invoices to avoid double-matching (keyed by type:id to prevent cross-table collisions)
      const consumedInvoiceKeys = new Set<string>();

      for (const tx of unconfirmed) {
        // Only process known transaction types
        if (tx.type !== "D" && tx.type !== "C") {
          skipped.push({ transaction_id: tx.id, reason: `Unknown transaction type "${tx.type}"` });
          continue;
        }

        const candidates: MatchCandidate[] = [];
        const invoices = tx.type === "D" ? openSales : openPurchases;
        const table = tx.type === "D" ? "sale_invoices" : "purchase_invoices";

        for (const inv of invoices) {
          const invKey = `${tx.type === "D" ? "sale" : "purchase"}:${inv.id!}`;
          if (consumedInvoiceKeys.has(invKey)) continue;
          const { confidence, reasons } = matchScore(tx, inv, tx.amount);
          if (confidence >= threshold) {
            candidates.push({
              type: tx.type === "D" ? "sale_invoice" : "purchase_invoice",
              id: inv.id!,
              number: inv.number ?? "",
              client_name: inv.client_name ?? "",
              clients_id: inv.clients_id,
              gross_price: inv.gross_price ?? 0,
              confidence,
              match_reasons: reasons,
            });
          }
        }

        // Only auto-confirm if exactly one high-confidence match
        if (candidates.length === 1) {
          consumedInvoiceKeys.add(`${candidates[0]!.type.replace("_invoice", "")}:${candidates[0]!.id}`);
          const match = candidates[0]!;
          if (dryRun) {
            confirmed.push({
              transaction_id: tx.id,
              amount: tx.amount,
              date: tx.date,
              match: { type: match.type, id: match.id, number: match.number, confidence: match.confidence },
              status: "would_confirm",
            });
          } else {
            try {
              await api.transactions.confirm(tx.id!, [{
                related_table: table,
                related_id: match.id,
                amount: tx.amount,
              }]);
              confirmed.push({
                transaction_id: tx.id,
                amount: tx.amount,
                match: { type: match.type, id: match.id, number: match.number },
                status: "confirmed",
              });
            } catch (err: any) {
              skipped.push({ transaction_id: tx.id, reason: err.message });
            }
          }
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            mode: dryRun ? "DRY_RUN" : "EXECUTED",
            total_unconfirmed: unconfirmed.length,
            auto_confirmed: confirmed.length,
            skipped: skipped.length,
            results: confirmed,
            errors: skipped,
          }, null, 2),
        }],
      };
    }
  );
}
