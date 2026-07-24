import { createHash } from "node:crypto";
import { roundMoney } from "../money.js";
import { centsKey } from "../money-cents.js";
import { canonicalRefNumber } from "../ref-number.js";
import { normalizeCompanyName } from "../company-name.js";
import type {
  CamtPossibleDuplicateMatch,
  DuplicateLookup,
  ParsedCamtEntry,
  PossibleDuplicateAction,
  PossibleDuplicateLookup,
  Transaction,
} from "./types.js";

// Identity, fingerprint, and duplicate-lookup algorithms for CAMT import.
//
// PURE module: imports only crypto and the pure ../money / ../ref-number /
// ../company-name helpers. Identity/fingerprint output MUST stay byte-compatible
// with the baseline fixtures (the refnumber-dedup test proves this).

const CAMT_DESCRIPTION_METADATA_PREFIX = "[e-arveldaja-mcp:camt";
const TRANSACTION_DESCRIPTION_MAX_LENGTH = 150;

export function normalizeOptionalReference(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.toUpperCase() === "NOTPROVIDED") return undefined;
  return normalized;
}

function encodeCamtMetadataValue(value: string): string {
  return encodeURIComponent(value);
}

function bankReferenceHash(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function bankReferenceLookupKey(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalReference(value);
  return normalized ? bankReferenceHash(normalized) : undefined;
}

function dimensionScopedBankReferenceLookupKey(
  unscopedReferenceKey: string | undefined,
  dimensionId: unknown,
): string | undefined {
  if (
    !unscopedReferenceKey ||
    typeof dimensionId !== "number" ||
    !Number.isSafeInteger(dimensionId) ||
    dimensionId <= 0
  ) {
    return undefined;
  }
  return `${dimensionId}\0${unscopedReferenceKey}`;
}

function decodeCamtMetadataValue(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.trim() || undefined;
  } catch {
    return value.trim() || undefined;
  }
}

function normalizeCamtDescriptionLineBreaks(description: string): string {
  return description.replace(/&#(?:10|x0*a);/gi, "\n");
}

function markerSafeDescription(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const escaped = normalizeCamtDescriptionLineBreaks(description)
    .replace(/(^|\n)(\[e-arveldaja-mcp:camt\s+[^\]\r\n]+\])/g, "$1\\$2")
    .trim();
  return escaped || undefined;
}

function stripCamtDescriptionMetadata(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const stripped = normalizeCamtDescriptionLineBreaks(description)
    .replace(/(?:^|\n)\[e-arveldaja-mcp:camt\s+[^\]\r\n]+\]\s*$/g, "")
    .trim();
  return stripped || undefined;
}

function normalizeStoredBankReferenceHash(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^sha256:[a-f0-9]{64}$/i.test(normalized)
    ? normalized.toLowerCase()
    : undefined;
}

function normalizeStoredEntrySignature(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-f0-9]{16,64}$/.test(normalized)
    ? normalized
    : undefined;
}

function shortStableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function buildCamtEntrySignature(parts: {
  bankReferenceKey?: string;
  date?: string;
  type?: string;
  currency?: string;
  amount?: number;
  refNumber?: string;
  bankAccountNo?: string;
  bankAccountName?: string;
  description?: string;
  sourceDirection?: ParsedCamtEntry["direction"];
}): string | undefined {
  if (!parts.bankReferenceKey || !parts.date || !parts.type || !Number.isFinite(parts.amount)) {
    return undefined;
  }
  const signatureParts = [
    parts.bankReferenceKey,
    parts.date,
    parts.type,
    parts.currency ?? "",
    roundMoney(parts.amount!).toFixed(2),
    normalizeBatchDuplicateKeyPart(parts.refNumber),
    normalizeBatchDuplicateKeyPart(parts.bankAccountNo),
    normalizeBatchDuplicateKeyPart(parts.bankAccountName),
    normalizeBatchDuplicateKeyPart(parts.description),
  ];
  if (parts.sourceDirection) signatureParts.push(parts.sourceDirection);
  return shortStableHash(JSON.stringify(signatureParts));
}

export function extractCamtDescriptionMetadata(description: string | null | undefined): {
  bank_ref_number?: string;
  bank_ref_hash?: string;
  bank_account_no?: string;
  entry_sig?: string;
  source_direction?: ParsedCamtEntry["direction"];
} {
  if (!description) return {};
  const normalizedDescription = normalizeCamtDescriptionLineBreaks(description).trimEnd();
  const match = normalizedDescription.match(/(?:^|\n)\[e-arveldaja-mcp:camt\s+([^\]\r\n]+)\]$/);
  if (!match) return {};

  const metadata: { bank_ref_number?: string; bank_ref_hash?: string; bank_account_no?: string; entry_sig?: string; source_direction?: ParsedCamtEntry["direction"] } = {};
  for (const [, key, value] of match[1]!.matchAll(/(bank_ref_number|bank_ref_hash|bank_account_no|entry_sig|source_direction|br|brh|iban|sig|dir|h|i|s|d)=([^\s\]]+)/g)) {
    const decoded = decodeCamtMetadataValue(value);
    if (!decoded) continue;
    if (key === "bank_ref_number" || key === "br") metadata.bank_ref_number = decoded;
    if (key === "bank_ref_hash" || key === "brh" || key === "h") metadata.bank_ref_hash = normalizeStoredBankReferenceHash(key === "h" ? `sha256:${decoded}` : decoded);
    if (key === "bank_account_no" || key === "iban" || key === "i") metadata.bank_account_no = decoded;
    if (key === "entry_sig" || key === "sig" || key === "s") metadata.entry_sig = normalizeStoredEntrySignature(decoded);
    if ((key === "source_direction" || key === "dir" || key === "d") && (decoded === "CRDT" || decoded === "DBIT")) metadata.source_direction = decoded;
  }
  return metadata;
}

function buildCamtDescriptionMarkerFromParts(parts: string[]): string | undefined {
  return parts.length > 0
    ? `${CAMT_DESCRIPTION_METADATA_PREFIX} ${parts.join(" ")}]`
    : undefined;
}

function buildCamtEntrySignatureForParsedEntry(entry: ParsedCamtEntry, cleanDescription: string | undefined): string | undefined {
  const bankReferenceKey = bankReferenceLookupKey(entry.bank_reference);
  return buildCamtEntrySignature({
    bankReferenceKey,
    date: entry.date,
    type: "C",
    currency: entry.currency,
    amount: entry.amount,
    refNumber: canonicalRefNumber(entry.reference_number).value,
    bankAccountNo: entry.counterparty_iban,
    bankAccountName: entry.counterparty_name,
    description: cleanDescription,
    sourceDirection: entry.direction,
  });
}

function buildCamtDescriptionMarker(entry: ParsedCamtEntry, cleanDescription: string | undefined): string | undefined {
  const bankReference = normalizeOptionalReference(entry.bank_reference);
  if (!bankReference && !entry.counterparty_iban) return undefined;

  const entrySignature = buildCamtEntrySignatureForParsedEntry(entry, cleanDescription);
  const bankReferencePart = bankReference
    ? `br=${encodeCamtMetadataValue(bankReference)}`
    : undefined;
  const bankReferenceHashPart = bankReference
    ? `brh=${bankReferenceHash(bankReference)}`
    : undefined;
  const compactBankReferenceHashPart = bankReference
    ? `h=${bankReferenceHash(bankReference).replace(/^sha256:/, "")}`
    : undefined;
  const bankAccountPart = entry.counterparty_iban
    ? `iban=${encodeCamtMetadataValue(entry.counterparty_iban)}`
    : undefined;
  const signaturePart = entrySignature ? `sig=${entrySignature}` : undefined;
  const directionPart = `dir=${entry.direction}`;
  const compactBankAccountPart = entry.counterparty_iban
    ? `i=${encodeCamtMetadataValue(entry.counterparty_iban)}`
    : undefined;
  const compactDirectionPart = `d=${entry.direction}`;
  const compactSignaturePart = entrySignature ? `s=${entrySignature}` : undefined;

  const markerCandidates = [
    buildCamtDescriptionMarkerFromParts([bankReferencePart, bankAccountPart, directionPart, signaturePart].filter((part): part is string => Boolean(part))),
    buildCamtDescriptionMarkerFromParts([bankReferenceHashPart, bankAccountPart, directionPart, signaturePart].filter((part): part is string => Boolean(part))),
    buildCamtDescriptionMarkerFromParts([compactBankReferenceHashPart, compactBankAccountPart, compactDirectionPart, compactSignaturePart].filter((part): part is string => Boolean(part))),
    buildCamtDescriptionMarkerFromParts([bankReferencePart, directionPart, signaturePart].filter((part): part is string => Boolean(part))),
    buildCamtDescriptionMarkerFromParts([bankReferenceHashPart, directionPart, signaturePart].filter((part): part is string => Boolean(part))),
    buildCamtDescriptionMarkerFromParts([bankAccountPart, directionPart, signaturePart].filter((part): part is string => Boolean(part))),
    buildCamtDescriptionMarkerFromParts([bankReferencePart, directionPart].filter((part): part is string => Boolean(part))),
    buildCamtDescriptionMarkerFromParts([bankReferenceHashPart, directionPart].filter((part): part is string => Boolean(part))),
    buildCamtDescriptionMarkerFromParts([bankAccountPart, directionPart].filter((part): part is string => Boolean(part))),
  ];

  return markerCandidates.find((marker) => marker !== undefined && marker.length <= TRANSACTION_DESCRIPTION_MAX_LENGTH);
}

export function buildCamtDescriptionWithMetadata(description: string | undefined, entry: ParsedCamtEntry): string | undefined {
  const cleanDescription = markerSafeDescription(description);
  const marker = buildCamtDescriptionMarker(entry, cleanDescription);
  if (!marker) return cleanDescription;

  const separatorLength = cleanDescription ? 1 : 0;
  const descriptionBudget = TRANSACTION_DESCRIPTION_MAX_LENGTH - marker.length - separatorLength;
  if (!cleanDescription || descriptionBudget <= 0) return marker.slice(0, TRANSACTION_DESCRIPTION_MAX_LENGTH);

  const trimmedDescription = cleanDescription.length > descriptionBudget
    ? cleanDescription.slice(0, descriptionBudget).trimEnd()
    : cleanDescription;
  return trimmedDescription ? `${trimmedDescription}\n${marker}` : marker;
}

export function isTrustedCamtDescriptionMetadata(
  transaction: Pick<Transaction,
    "bank_ref_number" |
    "date" |
    "type" |
    "amount" |
    "cl_currencies_id" |
    "ref_number" |
    "bank_account_no" |
    "bank_account_name" |
    "description"
  >,
  metadata = extractCamtDescriptionMetadata(transaction.description),
): boolean {
  if (!metadata.entry_sig) return false;
  const bankReferenceKey = bankReferenceLookupKey(transaction.bank_ref_number ?? undefined) ??
    bankReferenceLookupKey(metadata.bank_ref_number) ??
    metadata.bank_ref_hash;
  const expectedSignature = buildCamtEntrySignature({
    bankReferenceKey,
    date: transaction.date,
    type: metadata.source_direction ? "C" : transaction.type,
    currency: transaction.cl_currencies_id ?? "",
    amount: transaction.amount,
    refNumber: transaction.ref_number ?? undefined,
    bankAccountNo: normalizeOptionalReference(transaction.bank_account_no ?? undefined) ?? metadata.bank_account_no,
    bankAccountName: transaction.bank_account_name ?? undefined,
    description: stripCamtDescriptionMetadata(transaction.description ?? undefined),
    sourceDirection: metadata.source_direction,
  });
  return expectedSignature !== undefined && expectedSignature === metadata.entry_sig;
}

function directBankReferenceLookupKey(transaction: Pick<Transaction, "bank_ref_number">): string | undefined {
  return bankReferenceLookupKey(transaction.bank_ref_number ?? undefined);
}

export function storedBankReferenceLookupKey(transaction: Pick<Transaction,
  "bank_ref_number" |
  "date" |
  "type" |
  "amount" |
  "cl_currencies_id" |
  "ref_number" |
  "bank_account_no" |
  "bank_account_name" |
  "description"
>): string | undefined {
  const directBankReferenceKey = bankReferenceLookupKey(transaction.bank_ref_number ?? undefined);
  if (directBankReferenceKey) return directBankReferenceKey;

  const metadata = extractCamtDescriptionMetadata(transaction.description);
  if (!isTrustedCamtDescriptionMetadata(transaction, metadata)) return undefined;
  return bankReferenceLookupKey(metadata.bank_ref_number) ?? metadata.bank_ref_hash;
}

function storedBankAccountNo(transaction: Pick<Transaction,
  "bank_account_no" |
  "bank_ref_number" |
  "date" |
  "type" |
  "amount" |
  "cl_currencies_id" |
  "ref_number" |
  "bank_account_name" |
  "description"
>): string | undefined {
  const directBankAccountNo = normalizeOptionalReference(transaction.bank_account_no ?? undefined);
  if (directBankAccountNo) return directBankAccountNo;

  const metadata = extractCamtDescriptionMetadata(transaction.description);
  return isTrustedCamtDescriptionMetadata(transaction, metadata)
    ? metadata.bank_account_no
    : undefined;
}

export function buildDuplicateLookup(transactions: Transaction[], selectedDimensionId: number): DuplicateLookup {
  const byBankRef = new Map<string, number[]>();
  const byEntryKey = new Map<string, number[]>();

  for (const transaction of transactions) {
    if (!transaction.id) continue;
    if (
      typeof transaction.accounts_dimensions_id !== "number" ||
      !Number.isSafeInteger(transaction.accounts_dimensions_id) ||
      transaction.accounts_dimensions_id <= 0 ||
      transaction.accounts_dimensions_id !== selectedDimensionId
    ) {
      continue;
    }

    const entryKey = buildExistingTransactionDuplicateKey(transaction, selectedDimensionId);
    if (entryKey) {
      const exactExisting = byEntryKey.get(entryKey) ?? [];
      exactExisting.push(transaction.id);
      byEntryKey.set(entryKey, exactExisting);
    }

    const directBankRefKey = dimensionScopedBankReferenceLookupKey(
      directBankReferenceLookupKey(transaction),
      selectedDimensionId,
    );
    if (!directBankRefKey) continue;

    const existing = byBankRef.get(directBankRefKey) ?? [];
    existing.push(transaction.id);
    byBankRef.set(directBankRefKey, existing);
  }

  return { byBankRef, byEntryKey };
}

export function buildPossibleDuplicateLookup(
  transactions: Transaction[],
  accountsDimensionsId: number,
): PossibleDuplicateLookup {
  const byCandidateKey = new Map<string, Transaction[]>();

  for (const transaction of transactions) {
    if (transaction.accounts_dimensions_id !== accountsDimensionsId) continue;
    const candidateKey = buildPossibleDuplicateCandidateKey(
      transaction.date,
      transaction.type,
      transaction.cl_currencies_id ?? "EUR",
      transaction.amount,
    );
    const existing = byCandidateKey.get(candidateKey) ?? [];
    existing.push(transaction);
    byCandidateKey.set(candidateKey, existing);
  }

  return { byCandidateKey };
}

export function buildExistingTransactionDuplicateKey(
  transaction: Pick<Transaction,
    "bank_ref_number" |
    "date" |
    "type" |
    "amount" |
    "cl_currencies_id" |
    "ref_number" |
    "bank_account_no" |
    "bank_account_name" |
    "description"
  >,
  selectedDimensionId: number,
  bankReferenceKey = storedBankReferenceLookupKey(transaction),
): string | undefined {
  const scopedBankReferenceKey = dimensionScopedBankReferenceLookupKey(bankReferenceKey, selectedDimensionId);
  if (!scopedBankReferenceKey || !transaction.date || !transaction.type || !Number.isFinite(transaction.amount)) {
    return undefined;
  }

  return [
    scopedBankReferenceKey,
    transaction.date,
    transaction.type,
    transaction.cl_currencies_id ?? "",
    centsKey(transaction.amount),
    normalizeBatchDuplicateKeyPart(transaction.ref_number ?? undefined),
    normalizeBatchDuplicateKeyPart(storedBankAccountNo(transaction)),
    normalizeBatchDuplicateKeyPart(transaction.bank_account_name ?? undefined),
    normalizeBatchDuplicateKeyPart(transaction.description ?? undefined),
  ].join("|");
}

function transactionTypesForDuplicateCompatibility(entry: ParsedCamtEntry): Array<"C" | "D"> {
  const legacyType = legacyTransactionTypeForDirection(entry.direction);
  return legacyType === "C" ? ["C"] : ["C", legacyType];
}

export function buildExistingDuplicateKeysForEntry(entry: ParsedCamtEntry, selectedDimensionId: number): string[] {
  const bankReference = normalizeOptionalReference(entry.bank_reference);
  const bankReferenceKey = dimensionScopedBankReferenceLookupKey(
    bankReferenceLookupKey(bankReference),
    selectedDimensionId,
  );
  if (!bankReference || !bankReferenceKey) return [];

  return transactionTypesForDuplicateCompatibility(entry).map((type) => [
      bankReferenceKey,
      entry.date,
      type,
      entry.currency,
      centsKey(entry.amount),
      normalizeBatchDuplicateKeyPart(canonicalRefNumber(entry.reference_number).value),
      normalizeBatchDuplicateKeyPart(entry.counterparty_iban),
      normalizeBatchDuplicateKeyPart(entry.counterparty_name),
      normalizeBatchDuplicateKeyPart(buildCamtDescriptionWithMetadata(entry.description, entry)),
    ].join("|"));
}

export function findDuplicateTransactionIds(
  entry: ParsedCamtEntry,
  lookup: DuplicateLookup,
  repeatedBankReferences: ReadonlySet<string>,
  selectedDimensionId: number,
): number[] {
  for (const exactKey of buildExistingDuplicateKeysForEntry(entry, selectedDimensionId)) {
    const exactMatches = lookup.byEntryKey.get(exactKey) ?? [];
    if (exactMatches.length > 0) {
      return [...new Set(exactMatches)].sort((left, right) => left - right);
    }
  }

  const bankReference = normalizeOptionalReference(entry.bank_reference);
  const bankReferenceKey = dimensionScopedBankReferenceLookupKey(
    bankReferenceLookupKey(bankReference),
    selectedDimensionId,
  );
  if (!bankReference || !bankReferenceKey || repeatedBankReferences.has(bankReference)) return [];

  const matches = new Set<number>();

  for (const id of lookup.byBankRef.get(bankReferenceKey) ?? []) {
    matches.add(id);
  }

  return [...matches].sort((left, right) => left - right);
}

function normalizeBatchDuplicateKeyPart(value: string | undefined): string {
  return stripCamtDescriptionMetadata(value)?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
}

function normalizePossibleDuplicateIban(value: string | undefined): string {
  return value?.replace(/\s+/g, "").toUpperCase() ?? "";
}

function normalizedCounterpartyName(value: string | undefined): string {
  return normalizeCompanyName(value) || normalizeBatchDuplicateKeyPart(value);
}

function buildPossibleDuplicateCandidateKey(
  date: string,
  type: string,
  currency: string,
  amount: number,
): string {
  return [
    date,
    type,
    currency,
    centsKey(amount),
  ].join("|");
}

/**
 * Structured counterparty evidence that two stored transactions are the SAME
 * bank entry — beyond the coarse candidate key (date/type/currency/amount/
 * dimension), which alone collides for e.g. two same-day, same-amount card
 * purchases from different merchants. Returns the matching corroborators among
 * reference number, counterparty IBAN, and counterparty name, reusing the exact
 * normalizers `findPossibleDuplicateMatches` uses for those three fields.
 *
 * This is the DESTRUCTIVE-gate subset of the proposer's `match_reasons` rule: it
 * deliberately EXCLUDES the proposer's `description` corroborator. The stored
 * description is metadata-wrapped and length-capped by
 * `buildCamtDescriptionWithMetadata`, so a persisted description is not a
 * faithful equivalent of the full `entry.description` the proposer compares —
 * and free-text description is the lowest-entropy, most attacker-influenced
 * signal. Requiring one of the three structured identifiers makes the cleanup
 * gate strictly MORE conservative than the proposer (it can only ever accept a
 * subset of what the proposer surfaces). The bank reference is intentionally not
 * a corroborator here, exactly as in the proposal logic, because the kept row
 * routinely lacks it (that is what the cleanup enriches); the gate uses the bank
 * reference only as a divergence check when BOTH rows carry one.
 */
export function camtDuplicateStructuredCorroborators(
  a: Pick<Transaction, "ref_number" | "bank_account_no" | "bank_account_name">,
  b: Pick<Transaction, "ref_number" | "bank_account_no" | "bank_account_name">,
): string[] {
  const reasons: string[] = [];

  const aRef = normalizeBatchDuplicateKeyPart(a.ref_number ?? undefined);
  const bRef = normalizeBatchDuplicateKeyPart(b.ref_number ?? undefined);
  if (aRef && aRef === bRef) reasons.push("reference_number");

  const aIban = normalizePossibleDuplicateIban(normalizeOptionalReference(a.bank_account_no ?? undefined));
  const bIban = normalizePossibleDuplicateIban(normalizeOptionalReference(b.bank_account_no ?? undefined));
  if (aIban && aIban === bIban) reasons.push("counterparty_iban");

  const aName = normalizedCounterpartyName(a.bank_account_name ?? undefined);
  const bName = normalizedCounterpartyName(b.bank_account_name ?? undefined);
  if (aName && aName === bName) reasons.push("counterparty_name");

  return reasons;
}

export function findPossibleDuplicateMatches(
  entry: ParsedCamtEntry,
  lookup: PossibleDuplicateLookup,
): CamtPossibleDuplicateMatch[] {
  const candidates = transactionTypesForDuplicateCompatibility(entry)
    .flatMap((type) => lookup.byCandidateKey.get(buildPossibleDuplicateCandidateKey(
      entry.date,
      type,
      entry.currency,
      entry.amount,
    )) ?? [])
    .filter((transaction, index, all) => all.findIndex((candidate) => candidate.id === transaction.id) === index);
  const entryCounterparty = normalizedCounterpartyName(entry.counterparty_name);
  const entryDescription = normalizeBatchDuplicateKeyPart(entry.description);
  // Compare/enrich against the canonical (cap-enforced) reference the write
  // boundary actually persists, so an over-cap reference still matches its
  // stored truncated counterpart instead of silently missing.
  const canonicalEntryReference = canonicalRefNumber(entry.reference_number).value;
  const entryReference = normalizeBatchDuplicateKeyPart(canonicalEntryReference);
  const entryIban = normalizePossibleDuplicateIban(entry.counterparty_iban);
  // Every candidate is considered. This function is only ever reached for an
  // entry that is NOT an exact duplicate — the caller skips those before
  // calling — so no candidate here can be double-reported, and a candidate's
  // bank reference is not grounds to drop it. Excluding candidates that merely
  // HAVE a reference used to hide two silent-rebooking paths: a reference
  // whose stored bytes were coerced by the base parser ("007" written as "7"),
  // and a reference repeated across an entry's legs, which makes
  // findDuplicateTransactionIds refuse the byBankRef fallback and leaves this
  // review the only remaining net. Output is still bounded downstream by the
  // requirement of at least one concrete match_reason.
  return candidates
    .map((transaction) => {
      const existingBankAccountNo = normalizeOptionalReference(transaction.bank_account_no ?? undefined);
      const matchReasons: string[] = [];
      if (entryReference && entryReference === normalizeBatchDuplicateKeyPart(transaction.ref_number ?? undefined)) {
        matchReasons.push("reference_number");
      }
      if (entryIban && entryIban === normalizePossibleDuplicateIban(existingBankAccountNo)) {
        matchReasons.push("counterparty_iban");
      }
      if (entryCounterparty && entryCounterparty === normalizedCounterpartyName(transaction.bank_account_name ?? undefined)) {
        matchReasons.push("counterparty_name");
      }
      if (entryDescription && entryDescription === normalizeBatchDuplicateKeyPart(transaction.description ?? undefined)) {
        matchReasons.push("description");
      }
      return {
        id: transaction.id ?? 0,
        status: transaction.status,
        counterparty: transaction.bank_account_name,
        description: transaction.description,
        ref_number: transaction.ref_number,
        match_reasons: matchReasons,
        suggested_patch_missing_fields: {
          ...(!directBankReferenceLookupKey(transaction) && entry.bank_reference
            ? { bank_ref_number: entry.bank_reference }
            : {}),
          ...(!normalizeOptionalReference(transaction.ref_number ?? undefined) && canonicalEntryReference
            ? { ref_number: canonicalEntryReference }
            : {}),
          ...(!normalizePossibleDuplicateIban(existingBankAccountNo) && entry.counterparty_iban
            ? { bank_account_no: entry.counterparty_iban }
            : {}),
          ...(!normalizedCounterpartyName(transaction.bank_account_name ?? undefined) && entry.counterparty_name
            ? { bank_account_name: entry.counterparty_name }
            : {}),
          ...(!normalizeBatchDuplicateKeyPart(transaction.description ?? undefined) && entry.description
            ? { description: entry.description }
            : {}),
        },
      };
    })
    .filter((match) => match.id > 0 && match.match_reasons.length > 0)
    .sort((left, right) => left.id - right.id);
}

function hasConfirmedPossibleDuplicate(
  matches: Array<{ status?: string }>,
): boolean {
  return matches.some((match) => match.status === "CONFIRMED");
}

export function determinePossibleDuplicateAction(
  matches: Array<{ status?: string }>,
): PossibleDuplicateAction {
  return hasConfirmedPossibleDuplicate(matches)
    ? "link_confirmed_transaction_then_delete_new_project_transaction"
    : "review_status_before_cleanup";
}

export function buildPossibleDuplicateRecommendationNote(
  action: PossibleDuplicateAction,
): string {
  if (action === "link_confirmed_transaction_then_delete_new_project_transaction") {
    return "Default cleanup is to enrich the older confirmed transaction with the CAMT bank reference and any other missing metadata, then delete the new PROJECT transaction.";
  }
  return "A likely duplicate was found, but the older match is not confirmed. Review both transaction statuses before deciding whether to keep the old row or the newly imported PROJECT transaction.";
}

export function buildBatchDuplicateKey(entry: ParsedCamtEntry): string {
  return [
    normalizeOptionalReference(entry.bank_reference) ?? "",
    entry.date,
    entry.direction,
    entry.currency,
    centsKey(entry.amount),
    normalizeBatchDuplicateKeyPart(canonicalRefNumber(entry.reference_number).value),
    normalizeBatchDuplicateKeyPart(entry.end_to_end_id),
    normalizeBatchDuplicateKeyPart(entry.counterparty_iban),
    normalizeBatchDuplicateKeyPart(entry.counterparty_name),
    normalizeBatchDuplicateKeyPart(entry.description),
  ].join("|");
}

export function findRepeatedBankReferences(entries: ParsedCamtEntry[]): Set<string> {
  const counts = new Map<string, number>();

  for (const entry of entries) {
    const bankReference = normalizeOptionalReference(entry.bank_reference);
    if (!bankReference) continue;
    counts.set(bankReference, (counts.get(bankReference) ?? 0) + 1);
  }

  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([bankReference]) => bankReference),
  );
}

export function legacyTransactionTypeForDirection(direction: ParsedCamtEntry["direction"]): "C" | "D" {
  return direction === "CRDT" ? "D" : "C";
}
