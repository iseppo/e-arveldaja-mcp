import { readFile } from "fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson } from "../mcp-json.js";
import type { Client, Transaction } from "../types/api.js";
import { type ApiContext, coerceId } from "./crud-tools.js";
import { validateFilePath } from "../file-validation.js";
import { readOnly, batch } from "../annotations.js";
import { logAudit } from "../audit-log.js";
import { roundMoney } from "../money.js";
import { reportProgress } from "../progress.js";
import { isNonVoidTransaction } from "../transaction-status.js";

const CAMT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
  trimValues: true,
});

type XmlRecord = Record<string, unknown>;

export interface CamtBalance {
  amount: number;
  currency: string;
  direction?: string;
  date?: string;
}

export interface CamtStatementMetadata {
  statement_id?: string;
  iban: string;
  currency?: string;
  bank_bic?: string;
  bank_name?: string;
  period: {
    from?: string;
    to?: string;
  };
  opening_balance?: CamtBalance;
  closing_balance?: CamtBalance;
}

export interface ParsedCamtEntry {
  date: string;
  amount: number;
  currency: string;
  direction: "CRDT" | "DBIT";
  original_amount?: number;
  original_currency?: string;
  counterparty_name?: string;
  counterparty_iban?: string;
  counterparty_reg_code?: string;
  description?: string;
  reference_number?: string;
  end_to_end_id?: string;
  bank_reference?: string;
  duplicate: boolean;
  duplicate_transaction_ids: number[];
}

export interface CamtParseResult {
  statement_metadata: CamtStatementMetadata;
  entries: ParsedCamtEntry[];
  summary: {
    entry_count: number;
    credit_count: number;
    credit_total: number;
    debit_count: number;
    debit_total: number;
    duplicate_count: number;
  };
}

interface DuplicateLookup {
  byBankRef: Map<string, number[]>;
}

interface ClientResolution {
  clients_id?: number;
  match_type?: "reg_code" | "exact_name" | "single_name_match";
  matched_client_name?: string;
}

interface ClientResolutionCache {
  byCode: Map<string, ClientResolution>;
  byName: Map<string, ClientResolution>;
}

type CreateTransactionPayload = Pick<Transaction,
  "accounts_dimensions_id" |
  "type" |
  "amount" |
  "cl_currencies_id" |
  "date"
> & Partial<Pick<Transaction,
  "description" |
  "bank_account_name" |
  "bank_account_no" |
  "clients_id" |
  "ref_number" |
  "bank_ref_number"
>>;

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): XmlRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as XmlRecord
    : undefined;
}

function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized || undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = textOf(item);
      if (text) return text;
    }
    return undefined;
  }

  const record = asRecord(value);
  if (!record) return undefined;
  const directText = record["#text"];
  if (typeof directText === "string" || typeof directText === "number" || typeof directText === "boolean") {
    const normalized = String(directText).trim();
    return normalized || undefined;
  }

  return undefined;
}

function valueAt(node: unknown, path: string[]): unknown {
  let current = node;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function textAt(node: unknown, path: string[]): string | undefined {
  return textOf(valueAt(node, path));
}

function textArrayAt(node: unknown, path: string[]): string[] {
  return asArray(valueAt(node, path))
    .map(item => textOf(item))
    .filter((item): item is string => !!item);
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.split("T")[0] ?? value;
}

function normalizeOptionalReference(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.toUpperCase() === "NOTPROVIDED") return undefined;
  return normalized;
}

function parseAmountNode(node: unknown, fallbackCurrency?: string): { amount: number; currency: string } | undefined {
  const amountText = textOf(node);
  if (!amountText) return undefined;

  const amount = Number.parseFloat(amountText);
  if (!Number.isFinite(amount)) {
    throw new Error(`Invalid amount value "${amountText}" in CAMT file`);
  }

  const record = asRecord(node);
  const currency = textOf(record?.["@_Ccy"]) ?? fallbackCurrency ?? "EUR";
  return { amount, currency };
}

function parseOriginalAmountNode(
  txDetails: unknown,
  fallbackCurrency?: string,
): { amount: number; currency: string } | undefined {
  return (
    parseAmountNode(valueAt(txDetails, ["AmtDtls", "TxAmt", "Amt"]), fallbackCurrency) ??
    parseAmountNode(valueAt(txDetails, ["AmtDtls", "InstdAmt", "Amt"]), fallbackCurrency)
  );
}

function collectTransactionDetails(entryNode: unknown): Array<unknown | undefined> {
  const detailNodes = asArray(valueAt(entryNode, ["NtryDtls"]))
    .flatMap((detailBlock) => asArray(valueAt(detailBlock, ["TxDtls"])));

  return detailNodes.length > 0 ? detailNodes : [undefined];
}

function splitBookedAmounts(totalAmount: number, txOriginalAmounts: Array<number | undefined>): number[] {
  if (txOriginalAmounts.length <= 1) return [totalAmount];

  const canSplitProportionally = txOriginalAmounts.every((amount) => amount !== undefined && amount > 0);
  const weights = canSplitProportionally
    ? txOriginalAmounts.map((amount) => amount!)
    : txOriginalAmounts.map(() => 1);
  const totalWeight = weights.reduce((sum, amount) => sum + amount, 0);

  if (totalWeight <= 0) {
    return txOriginalAmounts.map((_, index) =>
      index === txOriginalAmounts.length - 1
        ? roundMoney(totalAmount)
        : 0,
    );
  }

  const allocated: number[] = [];
  let allocatedTotal = 0;

  for (let index = 0; index < weights.length; index++) {
    if (index === weights.length - 1) {
      allocated.push(roundMoney(totalAmount - allocatedTotal));
      continue;
    }

    const amount = roundMoney(totalAmount * (weights[index]! / totalWeight));
    allocated.push(amount);
    allocatedTotal = roundMoney(allocatedTotal + amount);
  }

  return allocated;
}

function extractOrgIdByScheme(party: unknown, schemeCode: string): string | undefined {
  const others = asArray(valueAt(party, ["Id", "OrgId", "Othr"]));
  for (const other of others) {
    if (textAt(other, ["SchmeNm", "Cd"]) === schemeCode) {
      return textAt(other, ["Id"]);
    }
  }
  return undefined;
}

function extractIban(account: unknown): string | undefined {
  return textAt(account, ["Id", "IBAN"]);
}

function pickCounterparty(txDetails: unknown, direction: "CRDT" | "DBIT"): { party?: unknown; account?: unknown } {
  const parties = valueAt(txDetails, ["RltdPties"]);
  if (direction === "CRDT") {
    return {
      party: valueAt(parties, ["Dbtr"]),
      account: valueAt(parties, ["DbtrAcct"]),
    };
  }

  return {
    party: valueAt(parties, ["Cdtr"]),
    account: valueAt(parties, ["CdtrAcct"]),
  };
}

function buildDuplicateLookup(transactions: Transaction[]): DuplicateLookup {
  const byBankRef = new Map<string, number[]>();

  for (const transaction of transactions) {
    if (!transaction.id) continue;
    const key = transaction.bank_ref_number?.trim();
    if (!key) continue;
    const existing = byBankRef.get(key) ?? [];
    existing.push(transaction.id);
    byBankRef.set(key, existing);
  }

  return { byBankRef };
}

function findDuplicateTransactionIds(
  bankReference: string | undefined,
  lookup: DuplicateLookup,
): number[] {
  if (!bankReference) return [];

  const matches = new Set<number>();

  for (const id of lookup.byBankRef.get(bankReference) ?? []) {
    matches.add(id);
  }

  return [...matches].sort((left, right) => left - right);
}

function summarizeEntries(entries: ParsedCamtEntry[]): CamtParseResult["summary"] {
  const summary = {
    entry_count: entries.length,
    credit_count: 0,
    credit_total: 0,
    debit_count: 0,
    debit_total: 0,
    duplicate_count: 0,
  };

  for (const entry of entries) {
    if (entry.direction === "CRDT") {
      summary.credit_count += 1;
      summary.credit_total += entry.amount;
    } else {
      summary.debit_count += 1;
      summary.debit_total += entry.amount;
    }
    if (entry.duplicate) {
      summary.duplicate_count += 1;
    }
  }

  summary.credit_total = roundMoney(summary.credit_total);
  summary.debit_total = roundMoney(summary.debit_total);
  return summary;
}

export function parseCamt053Xml(xml: string): CamtParseResult {
  const parsed = xmlParser.parse(xml);
  const statements = asArray(valueAt(parsed, ["Document", "BkToCstmrStmt", "Stmt"]));

  if (statements.length !== 1) {
    throw new Error(
      `Expected exactly one <Stmt> in CAMT.053 file, found ${statements.length}. ` +
      "Split multi-statement CAMT exports into separate XML files and import them one statement at a time.",
    );
  }

  const statement = statements[0];
  const accountIban = textAt(statement, ["Acct", "Id", "IBAN"]);
  if (!accountIban) {
    throw new Error("CAMT.053 file is missing statement account IBAN");
  }

  const accountCurrency = textAt(statement, ["Acct", "Ccy"]) ?? "EUR";

  const balances = asArray(valueAt(statement, ["Bal"])).map(balanceNode => {
    const balanceCode = textAt(balanceNode, ["Tp", "CdOrPrtry", "Cd"]);
    const amount = parseAmountNode(valueAt(balanceNode, ["Amt"]), accountCurrency);
    return {
      code: balanceCode,
      balance: amount && {
        amount: amount.amount,
        currency: amount.currency,
        direction: textAt(balanceNode, ["CdtDbtInd"]),
        date: normalizeDate(textAt(balanceNode, ["Dt", "Dt"]) ?? textAt(balanceNode, ["Dt", "DtTm"])),
      },
    };
  });

  const openingBalance = balances.find(balance => balance.code === "OPBD")?.balance;
  const closingBalance = balances.find(balance => balance.code === "CLBD")?.balance;

  const entries: ParsedCamtEntry[] = [];
  for (const entryNode of asArray(valueAt(statement, ["Ntry"]))) {
    const direction = textAt(entryNode, ["CdtDbtInd"]);
    if (direction !== "CRDT" && direction !== "DBIT") {
      throw new Error(`Unsupported CdtDbtInd "${direction ?? "missing"}" in CAMT.053 file`);
    }

    const entryDate = normalizeDate(textAt(entryNode, ["BookgDt", "Dt"]) ?? textAt(entryNode, ["BookgDt", "DtTm"]));
    if (!entryDate) {
      throw new Error("CAMT.053 entry is missing booking date");
    }

    const entryAmount = parseAmountNode(valueAt(entryNode, ["Amt"]), accountCurrency);
    if (!entryAmount) {
      throw new Error("CAMT.053 entry is missing amount");
    }

    const detailNodes = collectTransactionDetails(entryNode);
    const originalAmounts = detailNodes.map((txDetails) => parseOriginalAmountNode(txDetails, accountCurrency));
    const bookedAmounts = splitBookedAmounts(
      entryAmount.amount,
      originalAmounts.map((amount) => amount?.amount),
    );

    for (const [detailIndex, txDetails] of detailNodes.entries()) {
      const { party, account } = pickCounterparty(txDetails, direction);
      const structuredRef = asArray(valueAt(txDetails, ["RmtInf", "Strd"]))
        .map(node => textAt(node, ["CdtrRefInf", "Ref"]))
        .find((value): value is string => !!value);
      const originalAmount = originalAmounts[detailIndex];

      entries.push({
        date: entryDate,
        amount: bookedAmounts[detailIndex] ?? entryAmount.amount,
        currency: entryAmount.currency,
        direction,
        original_amount: originalAmount?.amount,
        original_currency: originalAmount?.currency,
        counterparty_name: textAt(party, ["Nm"]),
        counterparty_iban: extractIban(account),
        counterparty_reg_code: extractOrgIdByScheme(party, "COID"),
        description: textArrayAt(txDetails, ["RmtInf", "Ustrd"]).join(" | ") || undefined,
        reference_number: normalizeOptionalReference(structuredRef) ??
          normalizeOptionalReference(textAt(txDetails, ["Refs", "EndToEndId"])),
        end_to_end_id: normalizeOptionalReference(textAt(txDetails, ["Refs", "EndToEndId"])),
        bank_reference: normalizeOptionalReference(textAt(txDetails, ["Refs", "AcctSvcrRef"]) ?? textAt(entryNode, ["AcctSvcrRef"])),
        duplicate: false,
        duplicate_transaction_ids: [],
      });
    }
  }

  const MAX_CAMT_ENTRIES = 50_000;
  if (entries.length > MAX_CAMT_ENTRIES) {
    throw new Error(`CAMT file contains ${entries.length} entries, exceeding the ${MAX_CAMT_ENTRIES} limit. Split the file into smaller date ranges.`);
  }

  return {
    statement_metadata: {
      statement_id: textAt(statement, ["Id"]),
      iban: accountIban,
      currency: accountCurrency,
      bank_bic: textAt(statement, ["Acct", "Svcr", "FinInstnId", "BIC"]),
      bank_name: textAt(statement, ["Acct", "Svcr", "FinInstnId", "Nm"]),
      period: {
        from: textAt(statement, ["FrToDt", "FrDtTm"]) ?? textAt(statement, ["FrToDt", "FrDt"]),
        to: textAt(statement, ["FrToDt", "ToDtTm"]) ?? textAt(statement, ["FrToDt", "ToDt"]),
      },
      opening_balance: openingBalance,
      closing_balance: closingBalance,
    },
    entries,
    summary: summarizeEntries(entries),
  };
}

async function loadParsedCamt053(filePath: string): Promise<CamtParseResult> {
  const resolved = await validateFilePath(filePath, [".xml"], CAMT_MAX_FILE_SIZE);
  const xml = await readFile(resolved, "utf-8");
  return parseCamt053Xml(xml);
}

async function enrichWithDuplicates(parsed: CamtParseResult, api: ApiContext): Promise<CamtParseResult> {
  const existingTransactions = (await api.transactions.listAll()).filter(isNonVoidTransaction);
  const duplicateLookup = buildDuplicateLookup(existingTransactions);
  const entries = parsed.entries.map(entry => {
    const duplicateIds = findDuplicateTransactionIds(entry.bank_reference, duplicateLookup);
    return {
      ...entry,
      duplicate: duplicateIds.length > 0,
      duplicate_transaction_ids: duplicateIds,
    };
  });

  return {
    ...parsed,
    entries,
    summary: summarizeEntries(entries),
  };
}

async function ensureAccountDimensionExists(api: ApiContext, accountsDimensionsId: number): Promise<void> {
  const dimensions = await api.readonly.getAccountDimensions();
  if (!dimensions.some(dimension => dimension.id === accountsDimensionsId && !dimension.is_deleted)) {
    throw new Error(
      `Account dimension ${accountsDimensionsId} not found. Use list_account_dimensions to find the bank account dimension ID.`
    );
  }
}

async function resolveClientForEntry(
  api: ApiContext,
  entry: ParsedCamtEntry,
  cache: ClientResolutionCache,
): Promise<ClientResolution> {
  if (entry.counterparty_reg_code) {
    const cached = cache.byCode.get(entry.counterparty_reg_code);
    if (cached) return cached;

    const match = await api.clients.findByCode(entry.counterparty_reg_code);
    const resolution: ClientResolution = match?.id
      ? {
          clients_id: match.id,
          match_type: "reg_code",
          matched_client_name: match.name,
        }
      : {};

    cache.byCode.set(entry.counterparty_reg_code, resolution);
    if (resolution.clients_id) return resolution;
  }

  const normalizedName = entry.counterparty_name?.trim().toLowerCase();
  if (!normalizedName) return {};

  const cached = cache.byName.get(normalizedName);
  if (cached) return cached;

  const matches = await api.clients.findByName(entry.counterparty_name!);
  const exactMatches = matches.filter(client => client.name.trim().toLowerCase() === normalizedName);

  let selected: Client | undefined;
  let matchType: ClientResolution["match_type"];
  if (exactMatches.length === 1) {
    selected = exactMatches[0];
    matchType = "exact_name";
  } else if (matches.length === 1) {
    selected = matches[0];
    matchType = "single_name_match";
  }

  const resolution: ClientResolution = selected?.id
    ? {
        clients_id: selected.id,
        match_type: matchType,
        matched_client_name: selected.name,
      }
    : {};

  cache.byName.set(normalizedName, resolution);
  return resolution;
}

function transactionTypeForDirection(direction: ParsedCamtEntry["direction"]): "C" | "D" {
  return direction === "CRDT" ? "D" : "C";
}

const isoDateString = (description: string) =>
  z.string().regex(ISO_DATE_REGEX, "Expected YYYY-MM-DD").describe(description);

export function registerCamtImportTools(server: McpServer, api: ApiContext): void {
  registerTool(server, 
    "parse_camt053",
    "Parse a CAMT.053 bank statement XML file and preview statement metadata, entries, summary, and duplicate matches against existing transactions.",
    {
      file_path: z.string().describe("Absolute path to the CAMT.053 XML file"),
    },
    { ...readOnly, openWorldHint: true, title: "Parse CAMT.053" },
    async ({ file_path }) => {
      const parsed = await enrichWithDuplicates(await loadParsedCamt053(file_path), api);
      return {
        content: [{
          type: "text",
          text: toMcpJson({
            ...parsed,
            entries: parsed.entries.map(entry => ({
              ...entry,
              ...(entry.duplicate ? { duplicate: true } : { duplicate: undefined }),
              ...(entry.duplicate_transaction_ids.length > 0 ? { duplicate_transaction_ids: entry.duplicate_transaction_ids } : { duplicate_transaction_ids: undefined }),
            })),
          }),
        }],
      };
    }
  );

  registerTool(server, 
    "import_camt053",
    "Parse a CAMT.053 bank statement XML file and create bank transactions in e-arveldaja. Skips duplicates by AcctSvcrRef bank reference. DRY RUN by default.",
    {
      file_path: z.string().describe("Absolute path to the CAMT.053 XML file"),
      accounts_dimensions_id: coerceId.describe("Bank account dimension ID in e-arveldaja. Use list_account_dimensions to find it."),
      execute: z.boolean().optional().describe("Actually create transactions (default false = dry run)"),
      date_from: isoDateString("Only import entries from this date (YYYY-MM-DD)").optional(),
      date_to: isoDateString("Only import entries up to this date (YYYY-MM-DD)").optional(),
    },
    { ...batch, openWorldHint: true, title: "Import CAMT.053" },
    async ({ file_path, accounts_dimensions_id, execute, date_from, date_to }) => {
      if (date_from && date_to && date_from > date_to) {
        throw new Error(`date_from ${date_from} must be on or before date_to ${date_to}`);
      }

      await ensureAccountDimensionExists(api, accounts_dimensions_id);

      const parsed = await enrichWithDuplicates(await loadParsedCamt053(file_path), api);
      const filteredEntries = parsed.entries.filter(entry => {
        if (date_from && entry.date < date_from) return false;
        if (date_to && entry.date > date_to) return false;
        return true;
      });

      const dryRun = execute !== true;
      const seenBankReferences = new Set(
        filteredEntries
          .filter(entry => entry.duplicate && entry.bank_reference)
          .map(entry => entry.bank_reference!)
      );
      const clientCache: ClientResolutionCache = {
        byCode: new Map<string, ClientResolution>(),
        byName: new Map<string, ClientResolution>(),
      };

      const results: Array<{
        status: "would_create" | "created";
        date: string;
        amount: number;
        currency: string;
        type: "C" | "D";
        description?: string;
        counterparty?: string;
        bank_reference?: string;
        ref_number?: string;
        clients_id?: number;
        client_match?: string;
        api_id?: number;
      }> = [];
      const skippedDuplicates: Array<{
        date: string;
        amount: number;
        bank_reference?: string;
        duplicate_transaction_ids: number[];
        reason: string;
      }> = [];
      const errors: Array<{
        date: string;
        amount: number;
        bank_reference?: string;
        message: string;
      }> = [];

      for (let index = 0; index < filteredEntries.length; index++) {
        const entry = filteredEntries[index]!;
        await reportProgress(index, filteredEntries.length);

        if (entry.duplicate) {
          skippedDuplicates.push({
            date: entry.date,
            amount: entry.amount,
            bank_reference: entry.bank_reference,
            duplicate_transaction_ids: entry.duplicate_transaction_ids,
            reason: "Existing transaction matched by bank reference",
          });
          continue;
        }

        if (entry.bank_reference && seenBankReferences.has(entry.bank_reference)) {
          skippedDuplicates.push({
            date: entry.date,
            amount: entry.amount,
            bank_reference: entry.bank_reference,
            duplicate_transaction_ids: [],
            reason: "Duplicate bank reference inside current import batch",
          });
          continue;
        }

        const clientResolution = await resolveClientForEntry(api, entry, clientCache);
        const transactionType = transactionTypeForDirection(entry.direction);
        const payload: CreateTransactionPayload = {
          accounts_dimensions_id,
          type: transactionType,
          amount: entry.amount,
          cl_currencies_id: entry.currency || "EUR",
          date: entry.date,
          description: entry.description,
          bank_account_name: entry.counterparty_name,
          bank_account_no: entry.counterparty_iban,
          clients_id: clientResolution.clients_id,
          ref_number: entry.reference_number,
          bank_ref_number: entry.bank_reference,
        };

        if (dryRun) {
          results.push({
            status: "would_create",
            date: entry.date,
            amount: entry.amount,
            currency: entry.currency,
            type: transactionType,
            description: entry.description,
            counterparty: entry.counterparty_name,
            bank_reference: entry.bank_reference,
            ref_number: entry.reference_number,
            clients_id: clientResolution.clients_id,
            client_match: clientResolution.match_type,
          });
          if (entry.bank_reference) seenBankReferences.add(entry.bank_reference);
          continue;
        }

        try {
          const response = await api.transactions.create(payload);
          logAudit({
            tool: "import_camt053", action: "IMPORTED", entity_type: "transaction",
            entity_id: response.created_object_id,
            summary: `Imported CAMT transaction ${entry.amount} ${entry.currency} on ${entry.date}`,
            details: { date: entry.date, amount: entry.amount, description: entry.description, counterparty: entry.counterparty_name, bank_reference: entry.bank_reference },
          });
          results.push({
            status: "created",
            date: entry.date,
            amount: entry.amount,
            currency: entry.currency,
            type: transactionType,
            description: entry.description,
            counterparty: entry.counterparty_name,
            bank_reference: entry.bank_reference,
            ref_number: entry.reference_number,
            clients_id: clientResolution.clients_id,
            client_match: clientResolution.match_type,
            api_id: response.created_object_id,
          });
          if (entry.bank_reference) seenBankReferences.add(entry.bank_reference);
        } catch (error) {
          errors.push({
            date: entry.date,
            amount: entry.amount,
            bank_reference: entry.bank_reference,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            mode: dryRun ? "DRY_RUN" : "EXECUTED",
            statement_metadata: parsed.statement_metadata,
            total_statement_entries: parsed.entries.length,
            eligible_entries: filteredEntries.length,
            filtered_out: parsed.entries.length - filteredEntries.length,
            created_count: results.length,
            skipped_count: skippedDuplicates.length,
            error_count: errors.length,
            sample: results.slice(0, 10),
            ...(errors.length > 0 && { errors }),
            ...(skippedDuplicates.length > 0 && {
              skipped_summary: {
                count: skippedDuplicates.length,
                sample_refs: skippedDuplicates.slice(0, 10).map(s => s.bank_reference),
              },
            }),
          }),
        }],
      };
    }
  );
}
