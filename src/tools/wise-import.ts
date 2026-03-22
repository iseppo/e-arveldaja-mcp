import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "fs/promises";
import { registerTool } from "../mcp-compat.js";
import type { AccountDimension } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { validateFilePath } from "../file-validation.js";
import { batch } from "../annotations.js";
import { reportProgress } from "../progress.js";
import { parseCSV } from "../csv.js";

interface WiseRow {
  id: string;
  status: string;
  direction: string;
  createdOn: string;
  finishedOn: string;
  sourceFeeAmount: number;
  sourceFeeCurrency: string;
  targetFeeAmount: number;
  targetFeeCurrency: string;
  sourceName: string;
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
  const records = parseCSV(csv).filter(record => record.some(field => field.trim() !== ""));
  if (records.length < 2) throw new Error("CSV has no data rows");

  const headers = records[0]!.map(header => header.replace(/^\uFEFF/, "").trim());
  // Validate key headers exist
  for (const expected of ["ID", "Status", "Direction", "Source amount (after fees)"]) {
    if (!headers.includes(expected)) {
      throw new Error(`Missing expected header "${expected}". Found: ${headers.slice(0, 10).join(", ")}`);
    }
  }

  const idx = (name: string) => headers.indexOf(name);

  const rows: WiseRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const fields = records[i]!;
    if (fields.length < headers.length - 2) continue; // allow slightly short rows

    rows.push({
      id: fields[idx("ID")] ?? "",
      status: fields[idx("Status")] ?? "",
      direction: fields[idx("Direction")] ?? "",
      createdOn: fields[idx("Created on")] ?? "",
      finishedOn: fields[idx("Finished on")] ?? "",
      sourceFeeAmount: parseFloat(fields[idx("Source fee amount")] || "0") || 0,
      sourceFeeCurrency: fields[idx("Source fee currency")] ?? "EUR",
      targetFeeAmount: parseFloat(fields[idx("Target fee amount")] || "0") || 0,
      targetFeeCurrency: fields[idx("Target fee currency")] ?? "EUR",
      sourceName: fields[idx("Source name")] ?? "",
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

function normalizeWiseDirection(direction: string): "IN" | "OUT" | "NEUTRAL" | undefined {
  const normalized = direction.trim().toUpperCase();
  if (normalized === "IN" || normalized === "OUT" || normalized === "NEUTRAL") {
    return normalized;
  }
  return undefined;
}

function transactionTypeForWiseDirection(direction: string): "C" | "D" | undefined {
  const normalized = normalizeWiseDirection(direction);
  if (normalized === "IN") return "D";
  if (normalized === "OUT") return "C";
  return undefined;
}

function counterpartyNameForWiseRow(row: WiseRow): string | undefined {
  const txType = transactionTypeForWiseDirection(row.direction);
  if (txType === "D") {
    return row.sourceName || row.targetName || undefined;
  }
  if (txType === "C") {
    return row.targetName || row.sourceName || undefined;
  }
  return row.targetName || row.sourceName || undefined;
}

function normalizeWiseText(value?: string | null): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeWiseCurrency(value?: string | null, fallback = "EUR"): string {
  const normalized = value?.trim().toUpperCase();
  return normalized || fallback;
}

function ownAccountSideForWiseRow(row: WiseRow): "source" | "target" | undefined {
  const txType = transactionTypeForWiseDirection(row.direction);
  if (txType === "C") return "source";
  if (txType === "D") return "target";
  return undefined;
}

function bookedAmountForWiseRow(row: WiseRow): number {
  return ownAccountSideForWiseRow(row) === "target" ? row.targetAmount : row.sourceAmount;
}

function bookedCurrencyForWiseRow(row: WiseRow): string {
  return ownAccountSideForWiseRow(row) === "target"
    ? normalizeWiseCurrency(row.targetCurrency)
    : normalizeWiseCurrency(row.sourceCurrency);
}

function bookedFeeAmountForWiseRow(row: WiseRow): number {
  return ownAccountSideForWiseRow(row) === "target" ? row.targetFeeAmount : row.sourceFeeAmount;
}

function bookedFeeCurrencyForWiseRow(row: WiseRow, fallbackCurrency: string): string {
  return ownAccountSideForWiseRow(row) === "target"
    ? normalizeWiseCurrency(row.targetFeeCurrency, fallbackCurrency)
    : normalizeWiseCurrency(row.sourceFeeCurrency, fallbackCurrency);
}

function oppositeSideForWiseRow(row: WiseRow): { amount: number; currency: string } {
  return ownAccountSideForWiseRow(row) === "target"
    ? { amount: row.sourceAmount, currency: normalizeWiseCurrency(row.sourceCurrency) }
    : { amount: row.targetAmount, currency: normalizeWiseCurrency(row.targetCurrency) };
}

/** Detect Wise Jar (savings pot) transfers — internal movements, not real payments */
function isJarTransfer(row: WiseRow): boolean {
  const catLower = row.category.toLowerCase();
  const noteLower = row.note.toLowerCase();
  const refLower = row.reference.toLowerCase();

  // Explicit Jar indicators
  if (catLower.includes("jar")) return true;
  if (noteLower.includes("jar")) return true;
  if (refLower.includes("jar")) return true;

  // Self-transfer: source and target are the same person/company,
  // same currency, zero fee (to avoid false-positives on owner payments)
  const src = normalizeWiseText(row.sourceName);
  const tgt = normalizeWiseText(row.targetName);
  if (src && tgt && src === tgt && row.sourceCurrency === row.targetCurrency && row.sourceFeeAmount === 0) return true;

  return false;
}

function stripWisePrefix(description?: string | null): string {
  return (description ?? "").replace(/^WISE:(?:FEE:)?\S+\s*/i, "").trim();
}

function formatWiseAmount(amount: number): string {
  return amount.toFixed(2);
}

function buildWiseTransactionSignature(
  date: string,
  amount: number,
  currency: string,
  bankAccountName?: string | null,
  refNumber?: string | null,
  description?: string | null,
): string {
  return [
    date,
    formatWiseAmount(amount),
    normalizeWiseCurrency(currency),
    normalizeWiseText(bankAccountName),
    normalizeWiseText(refNumber),
    normalizeWiseText(description),
  ].join("|");
}

function resolveWiseFeeAccountDimensionId(
  feeAccountDimensionId: number | undefined,
  deprecatedFeeAccountRelationId: number | undefined,
): number {
  if (
    feeAccountDimensionId !== undefined &&
    deprecatedFeeAccountRelationId !== undefined &&
    feeAccountDimensionId !== deprecatedFeeAccountRelationId
  ) {
    throw new Error("fee_account_dimensions_id and fee_account_relation_id must match when both are provided");
  }

  const resolved = feeAccountDimensionId ?? deprecatedFeeAccountRelationId;
  if (resolved === undefined) {
    throw new Error("Wise fee rows require fee_account_dimensions_id. Use list_account_dimensions to find it.");
  }

  return resolved;
}

function buildAccountDistributionFromDimension(
  accountDimensions: AccountDimension[],
  accountsDimensionsId: number,
  amount: number,
) {
  const dimension = accountDimensions.find(item => item.id === accountsDimensionsId && !item.is_deleted);
  if (!dimension?.id) {
    throw new Error(
      `Account dimension ${accountsDimensionsId} not found. Use list_account_dimensions to find a valid fee account dimension ID.`
    );
  }

  return {
    related_table: "accounts" as const,
    related_id: dimension.accounts_id,
    related_sub_id: dimension.id,
    amount,
  };
}

export function registerWiseImportTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "import_wise_transactions",
    "Parse the regular Wise transactions CSV export and create bank transactions in e-arveldaja. " +
    "Does not support the special statement/report CSV exports. " +
    "Skips REFUNDED, NEUTRAL, and zero-amount entries. " +
    "Uses type D for incoming rows and type C for outgoing rows. " +
    "Wise fees are created as separate transactions (for correct VAT/expense treatment). " +
    "DRY RUN by default — set execute=true to actually create transactions.",
    {
      file_path: z.string().describe("Absolute path to the regular Wise transaction-history.csv export from Transactions"),
      accounts_dimensions_id: z.number().describe("Bank account dimension ID for the Wise account in e-arveldaja"),
      fee_account_dimensions_id: z.number().optional().describe("Account dimension ID for the Wise fee expense account. Use list_account_dimensions to find it."),
      fee_account_relation_id: z.number().optional().describe("Deprecated alias for fee_account_dimensions_id."),
      execute: z.boolean().optional().describe("Actually create transactions (default false = dry run)"),
      date_from: z.string().optional().describe("Only import transactions from this date (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("Only import transactions up to this date (YYYY-MM-DD)"),
      skip_jar_transfers: z.boolean().optional().describe("Skip Jar (savings pot) transfers — internal movements within Wise (default true)"),
    },
    { ...batch, openWorldHint: true, title: "Import Wise Transactions" },
    async ({
      file_path,
      accounts_dimensions_id,
      fee_account_dimensions_id,
      fee_account_relation_id,
      execute,
      date_from,
      date_to,
      skip_jar_transfers,
    }) => {
      const skipJars = skip_jar_transfers !== false;
      const resolved = await validateFilePath(file_path, [".csv"], 10 * 1024 * 1024);
      const csv = await readFile(resolved, "utf-8");
      const rows = parseWiseCSV(csv);
      const dryRun = execute !== true;
      const hasFeeRows = rows.some(row => row.sourceFeeAmount > 0);
      const feeAccountDimensionsId = hasFeeRows
        ? resolveWiseFeeAccountDimensionId(fee_account_dimensions_id, fee_account_relation_id)
        : undefined;
      const accountDimensions = hasFeeRows
        ? await api.readonly.getAccountDimensions()
        : [];

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
      let skippedJarCount = 0;
      const eligible = rows.filter(r => {
        if (r.status !== "COMPLETED") return false;
        if (normalizeWiseDirection(r.direction) === "NEUTRAL") return false;
        if (r.sourceAmount === 0 && r.targetAmount === 0) return false;
        if (skipJars && isJarTransfer(r)) { skippedJarCount++; return false; }
        const date = wiseDate(r.finishedOn || r.createdOn);
        if (date_from && date < date_from) return false;
        if (date_to && date > date_to) return false;
        return true;
      });

      // Get existing transactions for duplicate detection
      const existingTx = await api.transactions.listAll();
      const existingSignatures = new Set(
        existingTx.map(tx => buildWiseTransactionSignature(
          tx.date,
          tx.amount,
          tx.cl_currencies_id ?? "EUR",
          tx.bank_account_name,
          tx.ref_number,
          stripWisePrefix(tx.description),
        ))
      );
      // Also check by Wise ID in description
      const seenWiseIds = new Set(
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
        const type = transactionTypeForWiseDirection(row.direction);
        if (!type) {
          skipped.push({ wise_id: row.id, reason: `Unsupported Wise direction "${row.direction}"` });
          continue;
        }
        const amount = bookedAmountForWiseRow(row);
        const fee = bookedFeeAmountForWiseRow(row);
        const transactionCurrency = bookedCurrencyForWiseRow(row);
        const wiseIdTag = `WISE:${row.id}`;
        const counterpartyName = counterpartyNameForWiseRow(row);
        const oppositeSide = oppositeSideForWiseRow(row);

        // Build description
        let desc = wiseIdTag;
        if (counterpartyName) desc += ` ${counterpartyName}`;
        if (row.category && row.category !== "General") desc += ` (${row.category})`;
        if (oppositeSide.currency !== transactionCurrency) {
          desc += ` [${oppositeSide.amount} ${oppositeSide.currency} @ ${row.exchangeRate}]`;
        }
        const legacyDesc = stripWisePrefix(desc);
        const mainSignatureCandidates = new Set(
          [counterpartyName, row.targetName || undefined, row.sourceName || undefined]
            .filter((name): name is string => Boolean(name))
            .map((name) => buildWiseTransactionSignature(
              date,
              amount,
              transactionCurrency,
              name,
              row.reference || undefined,
              legacyDesc,
            ))
        );
        const mainAlreadyImported = seenWiseIds.has(wiseIdTag) ||
          [...mainSignatureCandidates].some(signature => existingSignatures.has(signature));
        let mainAvailableForFee = false;

        if (mainAlreadyImported) {
          skipped.push({
            wise_id: row.id,
            reason: seenWiseIds.has(wiseIdTag)
              ? "Already imported (Wise ID match)"
              : "Already imported (date/amount/counterparty/reference match)",
          });
          mainAvailableForFee = true;
        } else {
          if (dryRun) {
            created.push({
              wise_id: row.id,
              date,
              type,
              amount,
              description: desc,
              status: "would_create",
            });
            seenWiseIds.add(wiseIdTag);
            for (const signature of mainSignatureCandidates) {
              existingSignatures.add(signature);
            }
            mainAvailableForFee = true;
          } else {
            try {
              const result = await api.transactions.create({
                accounts_dimensions_id,
                type,
                amount,
                cl_currencies_id: transactionCurrency,
                date,
                description: desc,
                bank_account_name: counterpartyName,
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
              seenWiseIds.add(wiseIdTag);
              for (const signature of mainSignatureCandidates) {
                existingSignatures.add(signature);
              }
              mainAvailableForFee = true;
            } catch (err: unknown) {
              skipped.push({ wise_id: row.id, reason: err instanceof Error ? err.message : String(err) });
            }
          }
        }

        if (fee > 0) {
          if (!mainAvailableForFee) {
            skipped.push({
              wise_id: `FEE:${row.id}`,
              reason: "Skipped because main transaction was not created",
            });
            continue;
          }

          const feeWiseIdTag = `WISE:FEE:${row.id}`;
          const feeDesc = `WISE:FEE:${row.id} Wise teenustasu`;
          const feeCurrency = bookedFeeCurrencyForWiseRow(row, transactionCurrency);
          const feeSignature = buildWiseTransactionSignature(
            date,
            fee,
            feeCurrency,
            "Wise",
            undefined,
            stripWisePrefix(feeDesc),
          );
          if (seenWiseIds.has(feeWiseIdTag) || existingSignatures.has(feeSignature)) {
            skipped.push({
              wise_id: `FEE:${row.id}`,
              reason: seenWiseIds.has(feeWiseIdTag)
                ? "Fee already imported (Wise ID match)"
                : "Fee already imported (date/amount/counterparty match)",
            });
            continue;
          }

          const feeType = "C" as const; // Fees are always outgoing regardless of main transaction direction

          if (dryRun) {
            created.push({
              wise_id: `FEE:${row.id}`,
              date,
              type: feeType,
              amount: fee,
              description: feeDesc,
              status: "would_create",
            });
            seenWiseIds.add(feeWiseIdTag);
            existingSignatures.add(feeSignature);
          } else {
            try {
              const feeResult = await api.transactions.create({
                accounts_dimensions_id,
                type: feeType,
                amount: fee,
                cl_currencies_id: feeCurrency,
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
                    buildAccountDistributionFromDimension(accountDimensions, feeAccountDimensionsId!, fee),
                  ]);
                  created.push({
                    wise_id: `FEE:${row.id}`,
                    date, type: feeType, amount: fee, description: feeDesc,
                    status: "created_and_confirmed",
                    api_id: feeId,
                  });
                  seenWiseIds.add(feeWiseIdTag);
                  existingSignatures.add(feeSignature);
                } catch (confErr: unknown) {
                  created.push({
                    wise_id: `FEE:${row.id}`,
                    date, type: feeType, amount: fee, description: feeDesc,
                    status: "created (confirm failed: " + (confErr instanceof Error ? confErr.message : String(confErr)) + ")",
                    api_id: feeId,
                  });
                  seenWiseIds.add(feeWiseIdTag);
                  existingSignatures.add(feeSignature);
                }
              } else {
                created.push({
                  wise_id: `FEE:${row.id}`,
                  date, type: feeType, amount: fee, description: feeDesc,
                  status: "created (needs manual confirm)",
                  api_id: feeId,
                });
                seenWiseIds.add(feeWiseIdTag);
                existingSignatures.add(feeSignature);
              }
            } catch (err: unknown) {
              skipped.push({ wise_id: `FEE:${row.id}`, reason: err instanceof Error ? err.message : String(err) });
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
            ...(skippedJarCount > 0 ? { skipped_jar_transfers: skippedJarCount } : {}),
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
