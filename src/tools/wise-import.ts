import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "fs/promises";
import { registerTool } from "../mcp-compat.js";
import type { ApiContext } from "./crud-tools.js";
import { validateFilePath } from "../file-validation.js";
import { batch } from "../annotations.js";
import { reportProgress } from "../progress.js";
import { parseCSVLine } from "../csv.js";

interface WiseRow {
  id: string;
  status: string;
  direction: string;
  createdOn: string;
  finishedOn: string;
  sourceFeeAmount: number;
  sourceFeeCurrency: string;
  sourceAmount: number;
  sourceCurrency: string;
  targetName: string;
  targetAmount: number;
  targetCurrency: string;
  exchangeRate: number;
  reference: string;
  category: string;
  note: string;
}

const EXPECTED_HEADERS = [
  "ID", "Status", "Direction", "Created on", "Finished on",
  "Source fee amount", "Source fee currency", "Target fee amount", "Target fee currency",
  "Source name", "Source amount (after fees)", "Source currency",
  "Target name", "Target amount (after fees)", "Target currency",
  "Exchange rate", "Reference", "Batch", "Created by", "Category", "Note",
];

function parseWiseCSV(csv: string): WiseRow[] {
  const lines = csv.trim().split("\n").filter(l => l.trim());
  if (lines.length < 2) throw new Error("CSV has no data rows");

  const headers = parseCSVLine(lines[0]!);
  // Validate key headers exist
  for (const expected of ["ID", "Status", "Direction", "Source amount (after fees)"]) {
    if (!headers.includes(expected)) {
      throw new Error(`Missing expected header "${expected}". Found: ${headers.slice(0, 10).join(", ")}`);
    }
  }

  const idx = (name: string) => headers.indexOf(name);

  const rows: WiseRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]!);
    if (fields.length < headers.length - 2) continue; // allow slightly short rows

    rows.push({
      id: fields[idx("ID")] ?? "",
      status: fields[idx("Status")] ?? "",
      direction: fields[idx("Direction")] ?? "",
      createdOn: fields[idx("Created on")] ?? "",
      finishedOn: fields[idx("Finished on")] ?? "",
      sourceFeeAmount: parseFloat(fields[idx("Source fee amount")] || "0") || 0,
      sourceFeeCurrency: fields[idx("Source fee currency")] ?? "EUR",
      sourceAmount: parseFloat(fields[idx("Source amount (after fees)")] || "0") || 0,
      sourceCurrency: fields[idx("Source currency")] ?? "EUR",
      targetName: fields[idx("Target name")] ?? "",
      targetAmount: parseFloat(fields[idx("Target amount (after fees)")] || "0") || 0,
      targetCurrency: fields[idx("Target currency")] ?? "EUR",
      exchangeRate: parseFloat(fields[idx("Exchange rate")] || "1") || 1,
      reference: fields[idx("Reference")] ?? "",
      category: fields[idx("Category")] ?? "",
      note: fields[idx("Note")] ?? "",
    });
  }

  return rows;
}

function wiseDate(dateStr: string): string {
  // "2026-01-19 17:59:56" → "2026-01-19"
  return dateStr.split(" ")[0] ?? dateStr;
}

export function registerWiseImportTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "import_wise_transactions",
    "Parse a Wise transaction history CSV and create bank transactions in e-arveldaja. " +
    "Skips REFUNDED, NEUTRAL, and zero-amount entries. " +
    "All transactions use type C (e-arveldaja convention). " +
    "Wise fees are created as separate transactions (for correct VAT/expense treatment). " +
    "DRY RUN by default — set execute=true to actually create transactions.",
    {
      file_path: z.string().describe("Absolute path to Wise transaction-history.csv"),
      accounts_dimensions_id: z.number().describe("Bank account dimension ID for the Wise account in e-arveldaja"),
      fee_account_relation_id: z.number().describe("Relation ID for fee account distribution (e.g. accounts_dimensions_id for 8610 Muud finantskulud). Use list_account_dimensions to find the correct ID."),
      execute: z.boolean().optional().describe("Actually create transactions (default false = dry run)"),
      date_from: z.string().optional().describe("Only import transactions from this date (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Only import transactions up to this date (YYYY-MM-DD)"),
    },
    { ...batch, title: "Import Wise Transactions" },
    async ({ file_path, accounts_dimensions_id, fee_account_relation_id, execute, date_from, date_to }) => {
      const resolved = await validateFilePath(file_path, [".csv"], 10 * 1024 * 1024);
      const csv = await readFile(resolved, "utf-8");
      const rows = parseWiseCSV(csv);
      const dryRun = execute !== true;
      const feeRelationId = fee_account_relation_id;

      // Find Wise client for fee transactions
      let wiseClientId: number | undefined;
      if (!dryRun) {
        const allClients = await api.clients.listAll();
        const wiseClient = allClients.find(c =>
          c.name?.toUpperCase() === "WISE" || c.name?.toUpperCase() === "TRANSFERWISE"
        );
        wiseClientId = wiseClient?.id;
      }

      // Filter rows
      const eligible = rows.filter(r => {
        if (r.status !== "COMPLETED") return false;
        if (r.direction === "NEUTRAL") return false;
        if (r.sourceAmount === 0 && r.targetAmount === 0) return false;
        const date = wiseDate(r.finishedOn || r.createdOn);
        if (date_from && date < date_from) return false;
        if (date_to && date > date_to) return false;
        return true;
      });

      // Get existing transactions for duplicate detection
      const existingTx = await api.transactions.listAll();
      const existingDescs = new Set(
        existingTx.map(tx => `${tx.date}|${tx.amount}|${tx.description ?? ""}`)
      );
      // Also check by Wise ID in description
      const existingByWiseId = new Set(
        existingTx
          .filter(tx => tx.description?.startsWith("WISE:"))
          .map(tx => tx.description!.split(" ")[0])
      );

      const created: Array<{
        wise_id: string;
        date: string;
        type: string;
        amount: number;
        description: string;
        status: string;
        api_id?: number;
      }> = [];
      const skipped: Array<{ wise_id: string; reason: string }> = [];

      const totalEligible = eligible.length;
      for (let i = 0; i < eligible.length; i++) {
        const row = eligible[i]!;
        await reportProgress(i, totalEligible);
        const date = wiseDate(row.finishedOn || row.createdOn);
        const type = "C"; // e-arveldaja uses type C for all bank transactions
        const amount = row.sourceAmount;
        const fee = row.sourceFeeAmount;
        const wiseIdTag = `WISE:${row.id}`;

        // Build description
        let desc = wiseIdTag;
        if (row.targetName) desc += ` ${row.targetName}`;
        if (row.category && row.category !== "General") desc += ` (${row.category})`;
        if (row.targetCurrency !== "EUR" && row.targetCurrency !== row.sourceCurrency) {
          desc += ` [${row.targetAmount} ${row.targetCurrency} @ ${row.exchangeRate}]`;
        }

        // Duplicate check
        if (existingByWiseId.has(wiseIdTag)) {
          skipped.push({ wise_id: row.id, reason: "Already imported (Wise ID match)" });
          continue;
        }

        // Create the main transaction (net amount, without fee)
        if (dryRun) {
          created.push({
            wise_id: row.id,
            date,
            type,
            amount,
            description: desc,
            status: "would_create",
          });
        } else {
          try {
            const result = await api.transactions.create({
              accounts_dimensions_id,
              type,
              amount,
              cl_currencies_id: "EUR",
              date,
              description: desc,
              bank_account_name: row.targetName || undefined,
              ref_number: row.reference || undefined,
            });
            created.push({
              wise_id: row.id,
              date,
              type,
              amount,
              description: desc,
              status: "created",
              api_id: result.created_object_id,
            });
          } catch (err: any) {
            skipped.push({ wise_id: row.id, reason: err.message });
          }
        }

        // Create separate fee transaction if fee > 0
        if (fee > 0) {
          const feeDesc = `WISE:FEE:${row.id} Wise teenustasu`;
          if (dryRun) {
            created.push({
              wise_id: `FEE:${row.id}`,
              date,
              type,
              amount: fee,
              description: feeDesc,
              status: "would_create",
            });
          } else {
            try {
              const feeResult = await api.transactions.create({
                accounts_dimensions_id,
                type,
                amount: fee,
                cl_currencies_id: "EUR",
                date,
                description: feeDesc,
                bank_account_name: "Wise",
                clients_id: wiseClientId,
              });
              const feeId = feeResult.created_object_id;

              // Auto-confirm fee to expense account
              if (feeId && wiseClientId) {
                try {
                  await api.transactions.confirm(feeId, [
                    { related_table: "accounts", related_id: feeRelationId, amount: fee },
                  ]);
                  created.push({
                    wise_id: `FEE:${row.id}`,
                    date, type, amount: fee, description: feeDesc,
                    status: "created_and_confirmed",
                    api_id: feeId,
                  });
                } catch (confErr: unknown) {
                  created.push({
                    wise_id: `FEE:${row.id}`,
                    date, type, amount: fee, description: feeDesc,
                    status: "created (confirm failed: " + (confErr instanceof Error ? confErr.message : String(confErr)) + ")",
                    api_id: feeId,
                  });
                }
              } else {
                created.push({
                  wise_id: `FEE:${row.id}`,
                  date, type, amount: fee, description: feeDesc,
                  status: "created (needs manual confirm)",
                  api_id: feeId,
                });
              }
            } catch (err: any) {
              skipped.push({ wise_id: `FEE:${row.id}`, reason: err.message });
            }
          }
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            mode: dryRun ? "DRY_RUN" : "EXECUTED",
            total_csv_rows: rows.length,
            eligible: eligible.length,
            filtered_out: rows.length - eligible.length,
            created: created.length,
            skipped: skipped.length,
            results: created,
            skipped_details: skipped,
          }, null, 2),
        }],
      };
    }
  );
}
