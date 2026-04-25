import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "fs/promises";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import type { AccountDimension } from "../types/api.js";
import { type ApiContext, coerceId } from "./crud-tools.js";
import { resolveFileInput } from "../file-validation.js";
import { batch } from "../annotations.js";
import { logAudit } from "../audit-log.js";
import { buildBatchExecutionContract } from "../batch-execution.js";
import { reportProgress } from "../progress.js";
import { isNonVoidTransaction } from "../transaction-status.js";
import { parseCSV } from "../csv.js";
import { roundMoney } from "../money.js";
import { normalizeCompanyName } from "../company-name.js";
import { buildInterAccountJournalIndex, findMatchingJournal } from "./inter-account-utils.js";
import { DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT } from "../accounting-defaults.js";
import { approvalPreviewsFromDryRunSteps, buildWorkflowEnvelope } from "../workflow-response.js";

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

function parseWiseNumber(value: string | undefined | null, fieldName: string, defaultValue: number): number {
  if (value === undefined || value === null || value.trim() === "") return defaultValue;
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value in Wise CSV column "${fieldName}": "${value}"`);
  }
  return parsed;
}

function parseWiseCSV(csv: string): WiseRow[] {
  const records = parseCSV(csv, ",", 10 * 1024 * 1024).filter(record => record.some(field => field.trim() !== ""));
  if (records.length < 2) throw new Error("CSV has no data rows");

  const headers = records[0]!.map(header => header.replace(/^\uFEFF/, "").trim());
  // Validate required headers exist
  const requiredHeaders = [
    "ID", "Status", "Direction",
    "Source amount (after fees)", "Target amount (after fees)",
    "Exchange rate",
  ];
  for (const expected of requiredHeaders) {
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
      sourceFeeAmount: parseWiseNumber(fields[idx("Source fee amount")], "Source fee amount", 0),
      sourceFeeCurrency: fields[idx("Source fee currency")] ?? "EUR",
      targetFeeAmount: parseWiseNumber(fields[idx("Target fee amount")], "Target fee amount", 0),
      targetFeeCurrency: fields[idx("Target fee currency")] ?? "EUR",
      sourceName: fields[idx("Source name")] ?? "",
      sourceAmount: parseWiseNumber(fields[idx("Source amount (after fees)")], "Source amount (after fees)", 0),
      sourceCurrency: fields[idx("Source currency")] ?? "EUR",
      targetName: fields[idx("Target name")] ?? "",
      targetAmount: parseWiseNumber(fields[idx("Target amount (after fees)")], "Target amount (after fees)", 0),
      targetCurrency: fields[idx("Target currency")] ?? "EUR",
      exchangeRate: parseWiseNumber(fields[idx("Exchange rate")], "Exchange rate", 1),
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

function isNonErrorWiseSkipReason(reason: string): boolean {
  return reason.startsWith("Already imported") ||
    reason.startsWith("Fee already imported") ||
    reason.startsWith("Unsupported Wise direction") ||
    reason === "Skipped because main transaction was not created";
}

function summarizeWiseSkippedEntries(skipped: Array<{ wise_id: string; reason: string }>) {
  const groups = new Map<string, { reason: string; count: number; sample_ids: string[] }>();
  for (const entry of skipped) {
    const existing = groups.get(entry.reason);
    if (existing) {
      existing.count++;
      if (existing.sample_ids.length < 5) existing.sample_ids.push(entry.wise_id);
    } else {
      groups.set(entry.reason, { reason: entry.reason, count: 1, sample_ids: [entry.wise_id] });
    }
  }
  return [...groups.values()];
}

function normalizeWiseText(value?: string | null): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeWiseCompanyName(value?: string | null): string {
  return normalizeCompanyName(value);
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

/** Detect Wise Jar (savings pot) transfers — internal movements, not real payments.
 * Checks explicit Jar indicators and self-transfer heuristic (same name, currency, zero fee).
 * The self-transfer heuristic works because real inter-account transfers (e.g. LHV→Wise)
 * typically have slightly different names (e.g. "OÜ" vs "OU" from bank registration).
 * If this incorrectly filters legitimate transfers, set skip_jar_transfers=false. */
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
  accountDimensions: AccountDimension[],
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
  if (resolved !== undefined) {
    return resolved;
  }

  const defaultFeeDimensions = accountDimensions.filter((item) =>
    !item.is_deleted &&
    item.accounts_id === DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT &&
    item.id !== undefined,
  );
  if (defaultFeeDimensions.length === 1) {
    return defaultFeeDimensions[0]!.id!;
  }

  if (defaultFeeDimensions.length > 1) {
    const candidateIds = defaultFeeDimensions.map((item) => item.id).join(", ");
    throw new Error(
      `Wise fee rows require fee_account_dimensions_id because account ${DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT} has multiple active dimensions (${candidateIds}).`
    );
  }

  throw new Error(
    `Wise fee rows require fee_account_dimensions_id. No unique active dimension for account ${DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT} was found. Use list_account_dimensions to find it.`
  );
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

function resolveOwnCompanyClientId(
  companyName: string | undefined,
  matches: Array<{ id?: number; name?: string | null }>,
): number | undefined {
  const normalizedTarget = normalizeWiseCompanyName(companyName);
  if (!normalizedTarget) return undefined;

  const exactMatches = matches.filter(
    (client) => client.id !== undefined && normalizeWiseCompanyName(client.name) === normalizedTarget,
  );

  if (exactMatches.length === 1) {
    return exactMatches[0]!.id;
  }

  return undefined;
}

export function registerWiseImportTools(server: McpServer, api: ApiContext): void {

  registerTool(server, "import_wise_transactions",
    "Parse the regular Wise transactions CSV export and create bank transactions in e-arveldaja. " +
    "Does not support the special statement/report CSV exports. " +
    "Skips REFUNDED, NEUTRAL, and zero-amount entries. " +
    "Uses type D for incoming rows and type C for outgoing rows. " +
    "Wise fees are created as separate transactions (for correct VAT/expense treatment). " +
    "Inter-account transfers (TRANSFER-*, BANK_DETAILS_PAYMENT_RETURN-*) are auto-reconciled: " +
    "if the other bank account already has a confirmed journal entry, the Wise transaction is left " +
    "unconfirmed to avoid double-counting. Otherwise it is confirmed against the other bank account. " +
    "DRY RUN by default — set execute=true to actually create transactions.",
    {
      file_path: z.string().describe("Absolute path to the regular Wise transaction-history.csv export from Transactions. Also accepts a base64 payload (\"base64:csv:<data>\") for cross-system file transfer from remote MCP clients."),
      accounts_dimensions_id: coerceId.describe("Bank account dimension ID for the Wise account in e-arveldaja"),
      fee_account_dimensions_id: z.number().optional().describe("Account dimension ID for the Wise fee expense account. Use list_account_dimensions to find it."),
      fee_account_relation_id: z.number().optional().describe("Deprecated alias for fee_account_dimensions_id."),
      inter_account_dimension_id: z.number().optional().describe(
        "Bank account dimension ID for the other bank account (e.g. LHV) used for inter-account transfers. " +
        "Auto-detected if only one other bank account exists. Required when there are 3+ bank accounts."
      ),
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
      inter_account_dimension_id,
      execute,
      date_from,
      date_to,
      skip_jar_transfers,
    }) => {
      const skipJars = skip_jar_transfers !== false;
      const { path: resolved, cleanup } = await resolveFileInput(file_path, [".csv"], 10 * 1024 * 1024);
      let csv: string;
      try {
        csv = await readFile(resolved, "utf-8");
      } finally {
        if (cleanup) await cleanup();
      }
      const rows = parseWiseCSV(csv);
      const dryRun = execute !== true;

      // Filter rows
      let skippedJarCount = 0;
      // Jar-filtered rows used to be counted but invisible in the response.
      // Surface them as full skip records so a user auditing why a known
      // transfer wasn't imported can see it landed in the Jar branch.
      const skippedJarRows: Array<{ wise_id: string; reason: string; amount: number; date: string }> = [];
      const eligible = rows.filter(r => {
        if (r.status !== "COMPLETED") return false;
        if (normalizeWiseDirection(r.direction) === "NEUTRAL") return false;
        if (r.sourceAmount === 0 && r.targetAmount === 0) return false;
        if (skipJars && isJarTransfer(r)) {
          skippedJarCount++;
          skippedJarRows.push({
            wise_id: r.id,
            reason: "Jar / self-transfer detected (pass skip_jar_transfers=false to include)",
            amount: r.sourceAmount !== 0 ? r.sourceAmount : r.targetAmount,
            date: wiseDate(r.finishedOn || r.createdOn),
          });
          return false;
        }
        const date = wiseDate(r.finishedOn || r.createdOn);
        if (date_from && date < date_from) return false;
        if (date_to && date > date_to) return false;
        return true;
      });
      const hasFeeRows = eligible.some(row => bookedFeeAmountForWiseRow(row) > 0);
      const accountDimensions = hasFeeRows
        ? await api.readonly.getAccountDimensions()
        : [];
      const feeAccountDimensionsId = hasFeeRows
        ? resolveWiseFeeAccountDimensionId(accountDimensions, fee_account_dimensions_id, fee_account_relation_id)
        : undefined;

      // Find Wise client for fee transactions
      let wiseClientId: number | undefined;
      if (!dryRun && hasFeeRows) {
        const allClients = await api.clients.listAll();
        const wiseClient = allClients.find(c =>
          c.name?.toUpperCase() === "WISE" || c.name?.toUpperCase() === "TRANSFERWISE"
        );
        wiseClientId = wiseClient?.id;
        // Without a Wise client the fee rows can be created but never confirmed;
        // refuse the whole import up-front instead of leaving stray PROJECT rows.
        if (!wiseClientId) {
          throw new Error(
            "Wise client not found — create a client named 'Wise' (or 'TransferWise') before importing with fee rows, " +
            "otherwise every fee transaction is left unconfirmed and must be cleaned up manually.",
          );
        }
      }

      // Get existing transactions for duplicate detection
      const existingTx = (await api.transactions.listAll()).filter(isNonVoidTransaction);
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
              logAudit({
                tool: "import_wise_transactions", action: "IMPORTED", entity_type: "transaction",
                entity_id: result.created_object_id,
                summary: `Imported Wise transaction ${amount} ${transactionCurrency} on ${date}`,
                details: { date, amount, description: desc, counterparty: counterpartyName, wise_id: row.id },
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
              logAudit({
                tool: "import_wise_transactions", action: "IMPORTED", entity_type: "transaction",
                entity_id: feeResult.created_object_id,
                summary: `Imported Wise fee ${fee} ${feeCurrency} on ${date}`,
                details: { date, amount: fee, description: feeDesc, wise_id: `FEE:${row.id}` },
              });
              const feeId = feeResult.created_object_id;

              // Auto-confirm fee to expense account
              if (feeId && wiseClientId) {
                try {
                  if (!feeAccountDimensionsId) throw new Error("Fee account dimension ID is undefined — should not happen when hasFeeRows is true");
                  await api.transactions.confirm(feeId, [
                    buildAccountDistributionFromDimension(accountDimensions, feeAccountDimensionsId, fee),
                  ]);
                  logAudit({
                    tool: "import_wise_transactions", action: "CONFIRMED", entity_type: "transaction",
                    entity_id: feeId,
                    summary: `Auto-confirmed Wise fee transaction ${feeId}: ${fee} ${feeCurrency} on ${date}`,
                    details: { amount: fee, currency: feeCurrency, date, description: feeDesc },
                  });
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

      // --- Post-import: auto-reconcile inter-account transfers ---
      const interAccountResults: Array<{
        api_id: number;
        wise_id: string;
        amount: number;
        status: string;
        journal_id?: number;
        orphan_project_transaction_id?: number;
        orphan_action_hint?: string;
      }> = [];

      // Identify created transfer transactions (not fees, not card payments)
      const transferEntries = created.filter(c =>
        c.api_id &&
        c.status === "created" &&
        /^WISE:(TRANSFER|BANK_DETAILS_PAYMENT_RETURN)-/.test(c.description)
      );

      let autoDetectedInterAccountDimId: number | undefined;
      if (transferEntries.length > 0 && !inter_account_dimension_id) {
        // Pre-compute auto-detection for dry-run visibility
        const bankAccounts = await api.readonly.getBankAccounts();
        const otherBankDims = bankAccounts
          .filter(ba => ba.accounts_dimensions_id && ba.accounts_dimensions_id !== accounts_dimensions_id)
          .map(ba => ba.accounts_dimensions_id!);
        if (otherBankDims.length === 1) {
          autoDetectedInterAccountDimId = otherBankDims[0]!;
        }
      }

      if (transferEntries.length > 0 && !dryRun) {
        // Resolve the target bank account dimension for inter-account transfers
        const allAccountDimensions = accountDimensions.length > 0
          ? accountDimensions
          : await api.readonly.getAccountDimensions();

        const bankAccounts = await api.readonly.getBankAccounts();
        const bankDimensionIds = new Set(
          bankAccounts
            .filter(ba => ba.accounts_dimensions_id)
            .map(ba => ba.accounts_dimensions_id!)
        );

        let targetDimensionId = inter_account_dimension_id;
        if (!targetDimensionId) {
          // Auto-detect: find other bank account dimensions (not the Wise account)
          const otherBankDims = [...bankDimensionIds].filter(d => d !== accounts_dimensions_id);
          if (otherBankDims.length === 1) {
            targetDimensionId = otherBankDims[0]!;
          }
          // If 0 or 2+ other bank accounts, skip auto-reconciliation
        }

        if (targetDimensionId) {
          const targetDim = allAccountDimensions.find(d => d.id === targetDimensionId && !d.is_deleted);

          if (targetDim) {
            // Build index of existing inter-account journals to detect duplicates
            const ownDimensionIds = new Set([accounts_dimensions_id, targetDimensionId]);
            const allJournals = await api.journals.listAllWithPostings();
            const existingInterAccountKeys = buildInterAccountJournalIndex(allJournals, ownDimensionIds);

            // Resolve company client for setting clients_id
            let companyClientId: number | undefined;
            const invoiceInfo = await api.readonly.getInvoiceInfo();
            const companyName = invoiceInfo.invoice_company_name;
            if (companyName) {
              const clients = await api.clients.findByName(companyName);
              companyClientId = resolveOwnCompanyClientId(companyName, clients);
            }

            for (const entry of transferEntries) {
              const roundedAmount = roundMoney(entry.amount);
              // Check both directions for existing journal. The Wise ID acts
              // as a per-transfer reference — findMatchingJournal will only
              // suppress the confirmation when an existing journal's
              // document_number carries the same reference (or no reference
              // at all, preserving pre-disambiguation behaviour).
              const key1 = `${accounts_dimensions_id}|${targetDimensionId}|${roundedAmount}|${entry.date}`;
              const key2 = `${targetDimensionId}|${accounts_dimensions_id}|${roundedAmount}|${entry.date}`;
              const existingJournal = findMatchingJournal(
                existingInterAccountKeys.get(key1) ?? existingInterAccountKeys.get(key2),
                entry.wise_id,
              );

              if (existingJournal) {
                interAccountResults.push({
                  api_id: entry.api_id!,
                  wise_id: entry.wise_id,
                  amount: entry.amount,
                  status: "already_journalized",
                  journal_id: existingJournal,
                });
              } else {
                // Confirm against the target bank account
                try {
                  if (companyClientId) {
                    await api.transactions.update(entry.api_id!, { clients_id: companyClientId });
                  }
                  await api.transactions.confirm(entry.api_id!, [{
                    related_table: "accounts",
                    related_id: targetDim.accounts_id,
                    related_sub_id: targetDim.id!,
                    amount: entry.amount,
                  }]);
                  logAudit({
                    tool: "import_wise_transactions", action: "CONFIRMED", entity_type: "transaction",
                    entity_id: entry.api_id!,
                    summary: `Confirmed Wise inter-account transfer ${entry.amount} EUR`,
                    details: { amount: entry.amount, wise_id: entry.wise_id, target_dimension_id: targetDim.id },
                  });
                  interAccountResults.push({
                    api_id: entry.api_id!,
                    wise_id: entry.wise_id,
                    amount: entry.amount,
                    status: "confirmed_inter_account",
                  });
                  // Update the created entry status
                  entry.status = "created_and_confirmed_inter_account";
                } catch (err: unknown) {
                  // Orphan-PROJECT warning: the transaction was created in the
                  // API (api_id assigned) but confirmation failed. A retry
                  // would hit the wise-ID dedup and skip, leaving the row
                  // permanently in PROJECT status. Surface api_id explicitly
                  // as `orphan_project_transaction_id` so the user can
                  // invalidate/retry manually.
                  const errorMessage = err instanceof Error ? err.message : String(err);
                  interAccountResults.push({
                    api_id: entry.api_id!,
                    wise_id: entry.wise_id,
                    amount: entry.amount,
                    status: "confirm_failed: " + errorMessage,
                    orphan_project_transaction_id: entry.api_id!,
                    orphan_action_hint: `Transaction ${entry.api_id} was created but left in PROJECT status. Rerunning the import will skip it via wise_id dedup. To retry confirmation: invalidate_transaction(${entry.api_id}), then delete_transaction(${entry.api_id}) and rerun — or confirm_transaction(${entry.api_id}) manually against the target bank account.`,
                  });
                }
              }
            }
          }
        }
      } else if (transferEntries.length > 0 && dryRun) {
        for (const entry of transferEntries) {
          interAccountResults.push({
            api_id: 0,
            wise_id: entry.wise_id,
            amount: entry.amount,
            status: "would_check_inter_account",
          });
        }
      }

      const mode = dryRun ? "DRY_RUN" : "EXECUTED";
      const executionSkipped = skipped.filter(entry => isNonErrorWiseSkipReason(entry.reason));
      const executionErrors = skipped.filter(entry => !isNonErrorWiseSkipReason(entry.reason));
      const summary = {
        total_csv_rows: rows.length,
        eligible: eligible.length,
        filtered_out: rows.length - eligible.length,
        skipped_jar_transfers: skippedJarCount,
        created: created.length,
        skipped: executionSkipped.length,
        error_count: executionErrors.length,
        inter_account_total: interAccountResults.length,
      };

      // `reason` is built from raw exception text (err.message) which can
      // echo upstream API content. Wrap at MCP output so any CSV-origin
      // bytes echoed through an error reach the LLM sandboxed.
      const sanitizeReason = (entry: { wise_id: string; reason: string }) => ({
        ...entry,
        reason: wrapUntrustedOcr(entry.reason) ?? entry.reason,
      });
      const sanitizedSkippedDetails = summarizeWiseSkippedEntries(skipped).map(group => ({
        ...group,
        reason: wrapUntrustedOcr(group.reason) ?? group.reason,
      }));
      const sanitizedExecutionSkipped = executionSkipped.map(sanitizeReason);
      const sanitizedExecutionErrors = executionErrors.map(sanitizeReason);
      const workflowArgs = {
        file_path,
        accounts_dimensions_id,
        ...(feeAccountDimensionsId !== undefined ? { fee_account_dimensions_id: feeAccountDimensionsId } : {}),
        ...((inter_account_dimension_id ?? autoDetectedInterAccountDimId) !== undefined
          ? { inter_account_dimension_id: inter_account_dimension_id ?? autoDetectedInterAccountDimId }
          : {}),
        ...(date_from ? { date_from } : {}),
        ...(date_to ? { date_to } : {}),
        ...(skip_jar_transfers !== undefined ? { skip_jar_transfers } : {}),
        execute: false,
      };
      const workflowSummary = dryRun
        ? `Wise dry run would create ${summary.created} bank transaction(s), skip ${summary.skipped}, and report ${summary.error_count} error(s).`
        : `Wise import created ${summary.created} bank transaction(s), skipped ${summary.skipped}, and reported ${summary.error_count} error(s).`;
      const workflow = buildWorkflowEnvelope({
        summary: workflowSummary,
        approval_previews: dryRun
          ? approvalPreviewsFromDryRunSteps([{
              tool: "import_wise_transactions",
              summary: workflowSummary,
              suggested_args: workflowArgs,
              preview: summary,
            }])
          : [],
      });

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            mode,
            summary,
            workflow,
            total_csv_rows: summary.total_csv_rows,
            eligible: summary.eligible,
            filtered_out: summary.filtered_out,
            ...(skippedJarCount > 0 ? {
              skipped_jar_transfers: skippedJarCount,
              skipped_jar_transfer_details: skippedJarRows,
            } : {}),
            created: summary.created,
            skipped: skipped.length,
            ...(autoDetectedInterAccountDimId && transferEntries.length > 0 && dryRun ? {
              inter_account_auto_detected_dimension_id: autoDetectedInterAccountDimId,
            } : {}),
            ...(interAccountResults.length > 0 ? {
              inter_account_reconciliation: {
                total: interAccountResults.length,
                already_journalized: interAccountResults.filter(r => r.status === "already_journalized").length,
                confirmed: interAccountResults.filter(r => r.status === "confirmed_inter_account").length,
                details: interAccountResults,
              },
            } : {}),
            results: created.map(({ description: _desc, ...rest }) => rest),
            skipped_details: sanitizedSkippedDetails,
            execution: buildBatchExecutionContract({
              mode,
              summary,
              results: created.map(({ description: _desc, ...rest }) => rest),
              skipped: sanitizedExecutionSkipped,
              errors: sanitizedExecutionErrors,
            }),
          }),
        }],
      };
    }
  );
}
