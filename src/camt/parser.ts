import { XMLParser } from "fast-xml-parser";
import { roundMoney } from "../money.js";
import { capture, reject } from "./preflight.js";
import { normalizeOptionalReference } from "./duplicate-identity.js";
import type {
  CamtParseResult,
  CamtPreflightResult,
  ImportRejectedField,
  ParsedCamtEntry,
} from "./types.js";

// PURE CAMT.053 XML parser. Imports only fast-xml-parser, the pure ../money
// helper, and the pure preflight/identity helpers. No MCP, HTTP, filesystem,
// audit, or environment module.

const XML_DTD_PATTERN = /<!(?:DOCTYPE|ENTITY)/i;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
  trimValues: true,
  // Keep every tag value as raw text. The parser's built-in number coercion
  // rewrites the lexeme before it can be validated — it turns "1e2" into 100
  // and "0x10" into 16, so a statement could launder a hex or exponent literal
  // into a booked amount that strict validation never sees. It also silently
  // drops leading zeros from identifiers. M05 validates the bytes as sent.
  parseTagValue: false,
  // Strip XML namespace prefixes so a namespace-qualified statement
  // (<ns:Document>…) parses under the same unprefixed keys (Document, Stmt, …)
  // this code navigates by. Without it, valid prefixed CAMT files fail with
  // "Expected exactly one <Stmt>, found 0".
  removeNSPrefix: true,
});

const CAMT_MONEY_REGEX = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const CURRENCY_REGEX = /^[A-Z]{3}$/;
const CAMT_DATE_TIME_REGEX =
  /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/;

function parseCamtMoney(value: unknown, row: string, field: string): number {
  const text = String(value ?? "").trim();
  if (!CAMT_MONEY_REGEX.test(text)) {
    return reject(row, field, value, "CAMT amount must be a fully consumed finite decimal");
  }
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : reject(row, field, value, "CAMT amount must be finite");
}

/** Reject dates the calendar does not have (2026-02-30, 2026-13-01). */
function assertRealDate(date: string, row: string, field: string, original: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return reject(row, field, original, "Expected YYYY-MM-DD");
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = new Date(Date.UTC(year, month - 1, day));
  const roundTrips = utc.getUTCFullYear() === year
    && utc.getUTCMonth() === month - 1
    && utc.getUTCDate() === day;
  return roundTrips ? date : reject(row, field, original, "Impossible calendar date");
}

function parseCamtDate(value: unknown, row: string, field: string): string {
  const text = String(value ?? "").trim();
  const match = CAMT_DATE_TIME_REGEX.exec(text);
  if (!match) return reject(row, field, value, "Expected a complete CAMT YYYY-MM-DD or ISO date-time");

  // Retain the LEXICAL calendar prefix — converting through Date would shift the
  // day for offsets far from UTC.
  const date = assertRealDate(match[1]!, row, field, value);

  if (match[2] !== undefined && (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59)) {
    return reject(row, field, value, "Impossible CAMT clock time");
  }
  if (match[6] !== undefined) {
    const offsetHours = Number(match[6]);
    const offsetMinutes = Number(match[7]);
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) {
      return reject(row, field, value, "Invalid CAMT timezone offset");
    }
  }
  return date;
}

function parseCurrency(value: unknown, row: string, field: string): string {
  const text = String(value ?? "").trim().toUpperCase();
  return CURRENCY_REGEX.test(text)
    ? text
    : reject(row, field, value, "Expected a three-letter ISO currency code");
}

type XmlRecord = Record<string, unknown>;

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

function parseAmountNode(
  node: unknown,
  fallbackCurrency: string | undefined,
  sourceRowId: string,
  field = "amount",
): { amount: number; currency: string; text: string } | undefined {
  const amountText = textOf(node);
  if (!amountText) return undefined;

  const currencyText = textOf(asRecord(node)?.["@_Ccy"]);
  return {
    amount: parseCamtMoney(amountText, sourceRowId, field),
    currency: currencyText === undefined
      ? (fallbackCurrency ?? "EUR")
      : parseCurrency(currencyText, sourceRowId, `${field}_currency`),
    // The raw lexeme, so a later rule (positivity) can echo the bytes the file
    // actually carried rather than a reparsed number: `value` is the operator's
    // handle on the source document, and it is what the output boundary wraps.
    text: amountText,
  };
}

function parseOriginalAmountNode(
  txDetails: unknown,
  fallbackCurrency: string | undefined,
  sourceRowId: string,
): { amount: number; currency: string } | undefined {
  const amount =
    parseAmountNode(valueAt(txDetails, ["AmtDtls", "TxAmt", "Amt"]), fallbackCurrency, sourceRowId, "original_amount") ??
    parseAmountNode(valueAt(txDetails, ["AmtDtls", "InstdAmt", "Amt"]), fallbackCurrency, sourceRowId, "original_amount");
  // Direction is carried separately, so an original amount is positive.
  if (amount && !(amount.amount > 0)) {
    return reject(sourceRowId, "original_amount", amount.text, "CAMT original amount must be positive");
  }
  return amount;
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

export function summarizeEntries(entries: ParsedCamtEntry[]): CamtParseResult["summary"] {
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

function buildStatement(xml: string, rejected: ImportRejectedField[]): CamtParseResult {
  if (XML_DTD_PATTERN.test(xml)) {
    throw new Error("CAMT.053 files must not contain DOCTYPE or ENTITY declarations");
  }
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

  // Held to the same three-letter rule as every <Amt Ccy=""> attribute: this
  // value is the fallback currency for any amount that carries no attribute of
  // its own, so it reaches cl_currencies_id on the mutation payload, and it is
  // emitted in statement_metadata, which wraps only statement_id and bank_name.
  const rawAccountCurrency = textAt(statement, ["Acct", "Ccy"]);
  const accountCurrency = rawAccountCurrency === undefined
    ? "EUR"
    : capture(rejected, () => parseCurrency(rawAccountCurrency, "camt:statement:1", "account_currency")) ?? "EUR";

  // Statement period strings are validated but preserved verbatim on success.
  const periodFrom = textAt(statement, ["FrToDt", "FrDtTm"]) ?? textAt(statement, ["FrToDt", "FrDt"]);
  const periodTo = textAt(statement, ["FrToDt", "ToDtTm"]) ?? textAt(statement, ["FrToDt", "ToDt"]);
  if (periodFrom !== undefined) capture(rejected, () => parseCamtDate(periodFrom, "camt:statement:1", "period_from"));
  if (periodTo !== undefined) capture(rejected, () => parseCamtDate(periodTo, "camt:statement:1", "period_to"));

  const balances = asArray(valueAt(statement, ["Bal"])).map((balanceNode, balanceIndex) => {
    const rowId = `camt:balance:${balanceIndex + 1}`;
    const balanceCode = textAt(balanceNode, ["Tp", "CdOrPrtry", "Cd"]);
    // A balance amount may legitimately be zero; its sign is carried separately
    // by CdtDbtInd, so only the lexeme itself is validated here.
    const amount = capture(rejected, () => parseAmountNode(valueAt(balanceNode, ["Amt"]), accountCurrency, rowId));
    const rawDate = textAt(balanceNode, ["Dt", "Dt"]) ?? textAt(balanceNode, ["Dt", "DtTm"]);
    const date = rawDate === undefined
      ? undefined
      : capture(rejected, () => parseCamtDate(rawDate, rowId, "balance_date"));
    // Validated under the same row identity as the balance amount and date.
    // The direction decides the balance's sign, so an unvalidated value here
    // misstates the statement rather than merely echoing bad bytes. (This is a
    // local justification, not a completeness claim: statement_metadata still
    // emits bank_bic raw, an optional identifier nothing reads. The iban is
    // not in that set — it is required, and H08 validates it at the
    // statement-binding gate via assertStatementAccountMatchesDimension.)
    const rawDirection = textAt(balanceNode, ["CdtDbtInd"]);
    const direction = rawDirection === undefined
      ? undefined
      : capture(rejected, () => rawDirection === "CRDT" || rawDirection === "DBIT"
        ? rawDirection
        : reject(rowId, "balance_direction", rawDirection, "CAMT direction must be CRDT or DBIT"));
    return {
      code: balanceCode,
      balance: amount && {
        amount: amount.amount,
        currency: amount.currency,
        direction,
        date,
      },
    };
  });

  const openingBalance = balances.find(balance => balance.code === "OPBD")?.balance;
  const closingBalance = balances.find(balance => balance.code === "CLBD")?.balance;

  const entries: ParsedCamtEntry[] = [];
  for (const [entryIndex, entryNode] of asArray(valueAt(statement, ["Ntry"])).entries()) {
    // Positional identity only. The statement <Id> is attacker-controlled and
    // must never appear in a row identity.
    const entryRowId = `camt:ntry:${entryIndex + 1}`;

    const rawDirection = textAt(entryNode, ["CdtDbtInd"]);
    const direction = rawDirection === "CRDT" || rawDirection === "DBIT"
      ? rawDirection
      : capture(rejected, () => reject(entryRowId, "direction", rawDirection, "CAMT direction must be CRDT or DBIT"));

    const rawDate = textAt(entryNode, ["BookgDt", "Dt"]) ?? textAt(entryNode, ["BookgDt", "DtTm"]);
    const entryDate = rawDate === undefined
      ? capture(rejected, () => reject(entryRowId, "booking_date", rawDate, "CAMT entry is missing a booking date"))
      : capture(rejected, () => parseCamtDate(rawDate, entryRowId, "booking_date"));

    const entryAmount = capture(rejected, () => {
      const amount = parseAmountNode(valueAt(entryNode, ["Amt"]), accountCurrency, entryRowId);
      if (!amount) return reject(entryRowId, "amount", undefined, "CAMT entry is missing an amount");
      // Direction is carried separately, so a booked entry amount is positive.
      if (!(amount.amount > 0)) return reject(entryRowId, "amount", amount.text, "CAMT entry amount must be positive");
      return amount;
    });

    const detailNodes = collectTransactionDetails(entryNode);
    const originalAmounts = detailNodes.map((txDetails, detailIndex) => capture(rejected, () =>
      parseOriginalAmountNode(txDetails, accountCurrency, `${entryRowId}:tx:${detailIndex + 1}`)));

    // An invalid core field excludes this row from the successful value but
    // never stops validation of later entries or details.
    if (!direction || !entryDate || !entryAmount) continue;

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
      period: { from: periodFrom, to: periodTo },
      opening_balance: openingBalance,
      closing_balance: closingBalance,
    },
    entries,
    summary: summarizeEntries(entries),
  };
}

/**
 * Structured preflight used by the tool handlers: validates the whole file and
 * accumulates every invalid field. Structural failures (DTD/entity, malformed
 * XML, not exactly one statement) remain thrown.
 */
export function preflightCamt053Xml(xml: string): CamtPreflightResult {
  const rejected: ImportRejectedField[] = [];
  const value = buildStatement(xml, rejected);
  return rejected.length > 0
    ? { ok: false, source: "camt", rejected_fields: rejected }
    : { ok: true, source: "camt", value };
}

/**
 * Value-returning parser kept for callers that want an exception on any invalid
 * row. The thrown message is fixed and never echoes file content.
 */
export function parseCamt053Xml(xml: string): CamtParseResult {
  const rejected: ImportRejectedField[] = [];
  const value = buildStatement(xml, rejected);
  if (rejected.length > 0) {
    throw new Error(
      `CAMT.053 file contains ${rejected.length} invalid field(s). ` +
      "Use the import tool to see which rows and fields were rejected.",
    );
  }
  return value;
}
