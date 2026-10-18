import { createHash } from "node:crypto";
import { roundMoney } from "../money.js";
import { centsKey } from "../money-cents.js";
import { canonicalRefNumber } from "../ref-number.js";
import { normalizeCompanyName } from "../company-name.js";
import { TRANSACTION_DESCRIPTION_MAX_LENGTH } from "../bank-transaction-create.js";
import { buildCamtDescriptionWithMetadataV1, renderCamtDescriptionV1 } from "./marker-render-v1.js";
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

export const CAMT_DESCRIPTION_METADATA_PREFIX = "[e-arveldaja-mcp:camt";

export function normalizeOptionalReference(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.toUpperCase() === "NOTPROVIDED") return undefined;
  return normalized;
}

export function encodeCamtMetadataValue(value: string): string {
  return encodeURIComponent(value);
}

export function bankReferenceHash(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

export function bankReferenceLookupKey(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalReference(value);
  return normalized ? bankReferenceHash(normalized) : undefined;
}

/** Bank-reference lookup keys a journal document number can carry, with and without the "BANK:" prefix. */
export function journalDocumentReferenceKeys(documentNumber: string | null | undefined): string[] {
  const trimmed = documentNumber?.trim() ?? "";
  const bare = trimmed.startsWith("BANK:") ? trimmed.slice("BANK:".length).trim() : trimmed;
  if (!bare) return [];
  const keys = [bankReferenceLookupKey(trimmed), bankReferenceLookupKey(bare)]
    .filter((key): key is string => key !== undefined);
  return [...new Set(keys)];
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

export function markerSafeDescription(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const escaped = normalizeCamtDescriptionLineBreaks(description)
    .replace(/(^|\n)(\[e-arveldaja-mcp:camt\s+[^\]\r\n]+\])/g, "$1\\$2")
    .trim();
  return escaped || undefined;
}

export function stripCamtDescriptionMetadata(description: string | undefined): string | undefined {
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
  instructionId?: string;
  /** `x=i`: the counterparty IBAN was left out of the marker (bankAccountNo is then absent). */
  ibanOmitted?: boolean;
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
  // Appended only when present, so every marker written without `instr=`
  // keeps its signature byte-for-byte.
  if (parts.instructionId) signatureParts.push(`instr:${parts.instructionId}`);
  // Likewise for `x=i`: removing the flag, or adding it to a row that had no
  // IBAN, breaks the sig.
  if (parts.ibanOmitted) signatureParts.push("omit:iban");
  return shortStableHash(JSON.stringify(signatureParts));
}

/** The fields of a CAMT marker line. */
export interface CamtDescriptionMetadata {
  bank_ref_number?: string;
  bank_ref_hash?: string;
  bank_account_no?: string;
  entry_sig?: string;
  source_direction?: ParsedCamtEntry["direction"];
  instruction_id?: string;
  /** `x=i`: the counterparty IBAN was left out on purpose (signed). */
  iban_omitted?: true;
  /**
   * Contradictory or malformed identity fields (two references or hashes that
   * differ, a hash that is not the reference's, a bad `b=`, an unknown `x=`,
   * `x=i` beside an IBAN). No identity field is returned: the row is never
   * trusted and never duplicate evidence, only hold evidence.
   */
  poisoned?: true;
  /** Poisoned markers only: the lookup key of every reference and hash the marker claims. */
  claimed_reference_keys?: string[];
}

// A field starts at the start of the marker body or after whitespace, so a
// value containing `i=` (or `x=i`) is never read as a field of its own.
const CAMT_MARKER_FIELD = /(?<=^|\s)(bank_ref_number|bank_ref_hash|bank_account_no|entry_sig|source_direction|instr|br|brh|iban|sig|dir|b|h|i|s|d|x)=([^\s\]]*)/g;

/** A bank reference `b=` can carry: UPPERCASE hex of even length, 16..64 characters. */
function isCompactHexReference(reference: string): boolean {
  return reference.length >= 16 && reference.length <= 64 && reference.length % 2 === 0 && /^[0-9A-F]+$/.test(reference);
}

function encodeCompactHexReference(reference: string): string {
  return Buffer.from(reference, "hex").toString("base64url");
}

/** The UPPERCASE hex reference of a canonical `b=` value, else undefined. */
function decodeCompactHexReference(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{11,43}$/.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < 8 || bytes.length > 32 || bytes.toString("base64url") !== value) return undefined;
  return bytes.toString("hex").toUpperCase();
}

export function extractCamtDescriptionMetadata(description: string | null | undefined): CamtDescriptionMetadata {
  if (!description) return {};
  const normalizedDescription = normalizeCamtDescriptionLineBreaks(description).trimEnd();
  const match = normalizedDescription.match(/(?:^|\n)\[e-arveldaja-mcp:camt\s+([^\]\r\n]+)\]$/);
  if (!match) return {};

  const metadata: CamtDescriptionMetadata = {};
  const references = new Set<string>();
  const hashes = new Set<string>();
  let ibanPresent = false;
  let poisoned = false;
  for (const [, key, value] of match[1]!.matchAll(CAMT_MARKER_FIELD)) {
    // Presence is significant even when the value is empty: an `x=i` row
    // cannot also claim an IBAN under any spelling.
    if (key === "bank_account_no" || key === "iban" || key === "i") ibanPresent = true;
    if (key === "b") {
      const reference = decodeCompactHexReference(value!);
      if (reference === undefined) poisoned = true;
      else {
        metadata.bank_ref_number = reference;
        references.add(reference);
      }
      continue;
    }
    if (key === "x") {
      if (value === "i") metadata.iban_omitted = true;
      else poisoned = true;
      continue;
    }
    const decoded = decodeCamtMetadataValue(value!);
    if (!decoded) {
      if (["bank_ref_number", "br", "bank_ref_hash", "brh", "h"].includes(key!)) poisoned = true;
      continue;
    }
    if (key === "bank_ref_number" || key === "br") {
      metadata.bank_ref_number = decoded;
      references.add(decoded);
    }
    if (key === "bank_ref_hash" || key === "brh" || key === "h") {
      metadata.bank_ref_hash = normalizeStoredBankReferenceHash(key === "h" ? `sha256:${decoded}` : decoded);
      if (metadata.bank_ref_hash) hashes.add(metadata.bank_ref_hash);
      else poisoned = true;
    }
    if (key === "bank_account_no" || key === "iban" || key === "i") {
      metadata.bank_account_no = decoded;
      ibanPresent = true;
    }
    if (key === "entry_sig" || key === "sig" || key === "s") metadata.entry_sig = normalizeStoredEntrySignature(decoded);
    if ((key === "source_direction" || key === "dir" || key === "d") && (decoded === "CRDT" || decoded === "DBIT")) metadata.source_direction = decoded;
    if (key === "instr" && MARKER_INSTRUCTION_ID.test(decoded)) metadata.instruction_id = decoded;
  }
  const referenceKeys = [...references]
    .map((reference) => bankReferenceLookupKey(reference))
    .filter((key): key is string => key !== undefined);
  // Same-value repeats are fine; no released renderer writes any of these.
  if (
    poisoned ||
    references.size > 1 ||
    hashes.size > 1 ||
    (referenceKeys.length === 1 && hashes.size === 1 && !hashes.has(referenceKeys[0]!)) ||
    (metadata.iban_omitted && ibanPresent)
  ) {
    return { poisoned: true, claimed_reference_keys: [...new Set([...referenceKeys, ...hashes])] };
  }
  return metadata;
}

/** A Refs/InstrId the marker persists: numeric, on an outgoing (DBIT) row. */
const MARKER_INSTRUCTION_ID = /^\d{1,10}$/;

export function markerInstructionId(entry: ParsedCamtEntry): string | undefined {
  const id = normalizeOptionalReference(entry.instruction_id);
  return entry.direction === "DBIT" && id !== undefined && MARKER_INSTRUCTION_ID.test(id) ? id : undefined;
}

/**
 * `legacy`: the dir-less signature an earlier release wrote (stored type, no direction).
 * `ibanOmitted`: the `x=i` signature (no IBAN, `omit:iban` appended).
 */
export function buildCamtEntrySignatureForParsedEntry(
  entry: ParsedCamtEntry,
  cleanDescription: string | undefined,
  legacy = false,
  instructionId?: string,
  ibanOmitted = false,
): string | undefined {
  const bankReferenceKey = bankReferenceLookupKey(entry.bank_reference);
  return buildCamtEntrySignature({
    bankReferenceKey,
    date: entry.date,
    type: legacy ? legacyTransactionTypeForDirection(entry.direction) : "C",
    currency: entry.currency,
    amount: entry.amount,
    refNumber: canonicalRefNumber(entry.reference_number).value,
    bankAccountNo: ibanOmitted ? undefined : entry.counterparty_iban,
    bankAccountName: entry.counterparty_name,
    description: cleanDescription,
    sourceDirection: legacy ? undefined : entry.direction,
    instructionId: legacy ? undefined : instructionId,
    ibanOmitted: !legacy && ibanOmitted,
  });
}

// --- Marker selection (GitHub #64) -------------------------------------------
//
// V1 (marker-render-v1.ts) put the marker first and cut the text to whatever
// was left. The forms below are tried in order instead, so the full text is
// stored whenever any complete-identity form leaves room for it:
//   C0 `br= iban= dir= sig=` (V1's first form), C1 `br= i= d= s=`,
//   C2 `b= i= d= s=` (UPPERCASE hex refs), H `brh=`/`h=` with the IBAN, and,
//   only on positive proof that the counterparty is not an own account, C3
//   `b=/br=/h= x=i d= s=` (IBAN left out, signed).

interface CamtMarkerForm {
  /** The encoded bank-reference field (`br=`, `b=`, `brh=` or `h=`). */
  readonly reference: string;
  /** The encoded counterparty field (`iban=`, `i=` or `x=i`), if any. */
  readonly counterparty?: string;
  /** `d=`/`s=` instead of `dir=`/`sig=`. */
  readonly compact: boolean;
  readonly ibanOmitted: boolean;
}

/** Every sig is a 16-hex shortStableHash, so a form's length does not depend on the text. */
const SIGNATURE_PLACEHOLDER = "0".repeat(16);

function camtMarkerForms(entry: ParsedCamtEntry, reference: string): { complete: CamtMarkerForm[]; ibanOmitted: CamtMarkerForm[] } {
  const fullReference = `br=${encodeCamtMetadataValue(reference)}`;
  const compactReference = isCompactHexReference(reference) ? `b=${encodeCompactHexReference(reference)}` : undefined;
  const hash = bankReferenceHash(reference);
  const iban = entry.counterparty_iban ? encodeCamtMetadataValue(entry.counterparty_iban) : undefined;
  const long = (field: string): CamtMarkerForm =>
    ({ reference: field, counterparty: iban ? `iban=${iban}` : undefined, compact: false, ibanOmitted: false });
  const compact = (field: string): CamtMarkerForm =>
    ({ reference: field, counterparty: iban ? `i=${iban}` : undefined, compact: true, ibanOmitted: false });
  const compactHash = `h=${hash.replace(/^sha256:/, "")}`;
  return {
    complete: [
      long(fullReference),
      compact(fullReference),
      ...(compactReference ? [compact(compactReference)] : []),
      long(`brh=${hash}`),
      compact(compactHash),
    ],
    ibanOmitted: iban
      ? [compactReference, fullReference, compactHash]
          .filter((field): field is string => field !== undefined)
          .map((field) => ({ reference: field, counterparty: "x=i", compact: true, ibanOmitted: true }))
      : [],
  };
}

function camtMarkerFromForm(form: CamtMarkerForm, direction: ParsedCamtEntry["direction"], signature: string, instructionId?: string): string {
  const parts = [
    form.reference,
    form.counterparty,
    `${form.compact ? "d" : "dir"}=${direction}`,
    instructionId ? `instr=${instructionId}` : undefined,
    `${form.compact ? "s" : "sig"}=${signature}`,
  ].filter((part): part is string => part !== undefined);
  return `${CAMT_DESCRIPTION_METADATA_PREFIX} ${parts.join(" ")}]`;
}

function camtMarkerFormLength(form: CamtMarkerForm, entry: ParsedCamtEntry, instructionId?: string): number {
  return camtMarkerFromForm(form, entry.direction, SIGNATURE_PLACEHOLDER, instructionId).length;
}

/** The form signed over the text it stores. */
function renderCamtMarkerForm(entry: ParsedCamtEntry, form: CamtMarkerForm, storedText: string | undefined, instructionId?: string): string {
  const signature = buildCamtEntrySignatureForParsedEntry(entry, storedText, false, instructionId, form.ibanOmitted)!;
  const marker = camtMarkerFromForm(form, entry.direction, signature, instructionId);
  return storedText ? `${storedText}\n${marker}` : marker;
}

/** The row the CAMT import creates for this entry, as a trust check reads it back (no direct bank fields). */
function renderedCamtRow(entry: ParsedCamtEntry, description: string): Parameters<typeof isTrustedCamtDescriptionMetadata>[0] {
  return {
    bank_ref_number: null,
    date: entry.date,
    type: "C",
    amount: entry.amount,
    cl_currencies_id: entry.currency || "EUR",
    ref_number: canonicalRefNumber(entry.reference_number).value ?? null,
    bank_account_no: null,
    bank_account_name: entry.counterparty_name ?? null,
    description,
  };
}

/** V1's output stores the full text with a complete, verifiable identity. */
function v1KeepsFullIdentity(v1: string | undefined, entry: ParsedCamtEntry, cleanDescription: string | undefined): v1 is string {
  if (v1 === undefined || stripCamtDescriptionMetadata(v1) !== cleanDescription) return false;
  const metadata = extractCamtDescriptionMetadata(v1);
  if (metadata.poisoned || (metadata.bank_ref_number === undefined && metadata.bank_ref_hash === undefined)) return false;
  if (entry.counterparty_iban && metadata.bank_account_no === undefined) return false;
  return isTrustedCamtDescriptionMetadata(renderedCamtRow(entry, v1), metadata);
}

function camtMarkerIdentity(stored: string): string {
  const metadata = extractCamtDescriptionMetadata(stored);
  return JSON.stringify([
    metadata.poisoned, metadata.bank_ref_number, metadata.bank_ref_hash, metadata.bank_account_no,
    metadata.source_direction, metadata.entry_sig !== undefined, metadata.iban_omitted,
  ]);
}

export interface CamtDescriptionRendering {
  /** The description to store; undefined when held (or when there is nothing to store). */
  readonly description?: string;
  /** No complete-identity marker fits: the row must not be created (`camt_marker_identity_unfit`). */
  readonly held?: true;
  /** The stored text is shorter than the statement text. */
  readonly truncated?: { readonly stored_length: number; readonly full_length: number };
  /** The marker carries `x=i` instead of the counterparty IBAN. */
  readonly ibanOmitted?: true;
}

function withTruncationReport(rendered: string | undefined, cleanDescription: string | undefined): CamtDescriptionRendering {
  const storedLength = stripCamtDescriptionMetadata(rendered)?.length ?? 0;
  const fullLength = cleanDescription?.length ?? 0;
  return {
    ...(rendered !== undefined ? { description: rendered } : {}),
    ...(storedLength < fullLength ? { truncated: { stored_length: storedLength, full_length: fullLength } } : {}),
  };
}

/**
 * The description the CAMT import stores for an entry, with what it had to
 * give up. `omitCounterpartyIban` is set only by the import projection, after
 * positive proof that the counterparty IBAN is not an own account
 * (camtIbanOmissionEvidence); every other caller gets the IBAN kept.
 */
export function renderCamtDescriptionDetailed(
  description: string | undefined,
  entry: ParsedCamtEntry,
  options: { readonly omitCounterpartyIban?: boolean } = {},
): CamtDescriptionRendering {
  const cleanDescription = markerSafeDescription(description);
  const v1 = buildCamtDescriptionWithMetadataV1(description, entry);
  const reference = normalizeOptionalReference(entry.bank_reference);
  // A reference-less entry has no sig to verify: exactly as V1 rendered it.
  if (!reference || buildCamtEntrySignatureForParsedEntry(entry, cleanDescription) === undefined) {
    return withTruncationReport(v1, cleanDescription);
  }
  // Every row V1 already stored whole and verifiable stays byte-identical
  // (`instr=` included as V1 decided).
  if (v1KeepsFullIdentity(v1, entry, cleanDescription)) return { description: v1 };

  const forms = camtMarkerForms(entry, reference);
  const fullTextFits = (form: CamtMarkerForm, instructionId?: string) =>
    camtMarkerFormLength(form, entry, instructionId) + (cleanDescription ? cleanDescription.length + 1 : 0) <= TRANSACTION_DESCRIPTION_MAX_LENGTH;
  const fullTextForm = forms.complete.find((form) => fullTextFits(form)) ??
    (options.omitCounterpartyIban ? forms.ibanOmitted.find((form) => fullTextFits(form)) : undefined);
  if (fullTextForm) {
    const baseline = renderCamtMarkerForm(entry, fullTextForm, cleanDescription);
    // `instr=` only on the same form and only while the full text still fits,
    // so it never moves the choice to another form.
    const instructionId = markerInstructionId(entry);
    const withInstruction = instructionId && fullTextFits(fullTextForm, instructionId)
      ? renderCamtMarkerForm(entry, fullTextForm, cleanDescription, instructionId)
      : undefined;
    const keepInstruction = withInstruction !== undefined &&
      extractCamtDescriptionMetadata(withInstruction).instruction_id === instructionId &&
      camtMarkerIdentity(withInstruction) === camtMarkerIdentity(baseline) &&
      stripCamtDescriptionMetadata(withInstruction) === stripCamtDescriptionMetadata(baseline);
    return {
      description: keepInstruction ? withInstruction : baseline,
      ...(fullTextForm.ibanOmitted ? { ibanOmitted: true as const } : {}),
    };
  }

  // No form stores the full text: the shortest complete-identity form keeps
  // the most of it (re-signed over the stored text). The IBAN is never dropped
  // to save a cut it cannot avoid.
  const shortest = forms.complete.reduce((best, form) =>
    camtMarkerFormLength(form, entry) < camtMarkerFormLength(best, entry) ? form : best);
  const markerLength = camtMarkerFormLength(shortest, entry);
  // Not even the marker alone fits: hold rather than write a form that drops
  // an identity field the sig covers.
  if (markerLength > TRANSACTION_DESCRIPTION_MAX_LENGTH) return { held: true };
  const budget = TRANSACTION_DESCRIPTION_MAX_LENGTH - markerLength - 1;
  const storedText = budget > 0 && cleanDescription ? cleanDescription.slice(0, budget).trimEnd() || undefined : undefined;
  return withTruncationReport(renderCamtMarkerForm(entry, shortest, storedText), cleanDescription);
}

/** The full-text C3 (`x=i`) rendering of this entry, whether or not it is eligible today. */
function renderCamtDescriptionIbanOmitted(description: string | undefined, entry: ParsedCamtEntry): string | undefined {
  const reference = normalizeOptionalReference(entry.bank_reference);
  if (!reference || !entry.counterparty_iban) return undefined;
  const cleanDescription = markerSafeDescription(description);
  if (buildCamtEntrySignatureForParsedEntry(entry, cleanDescription) === undefined) return undefined;
  const form = camtMarkerForms(entry, reference).ibanOmitted.find((candidate) =>
    camtMarkerFormLength(candidate, entry) + (cleanDescription ? cleanDescription.length + 1 : 0) <= TRANSACTION_DESCRIPTION_MAX_LENGTH);
  return form ? renderCamtMarkerForm(entry, form, cleanDescription) : undefined;
}

export function buildCamtDescriptionWithMetadata(
  description: string | undefined,
  entry: ParsedCamtEntry,
  options: { readonly omitCounterpartyIban?: boolean } = {},
): string | undefined {
  return renderCamtDescriptionDetailed(description, entry, options).description;
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
  // Before the direct reference: a poisoned marker never verifies.
  if (metadata.poisoned || !metadata.entry_sig) return false;
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
    // An `x=i` marker was signed without the IBAN, even if a direct one appears.
    bankAccountNo: metadata.iban_omitted
      ? undefined
      : normalizeOptionalReference(transaction.bank_account_no ?? undefined) ?? metadata.bank_account_no,
    bankAccountName: transaction.bank_account_name ?? undefined,
    description: stripCamtDescriptionMetadata(transaction.description ?? undefined),
    sourceDirection: metadata.source_direction,
    instructionId: metadata.instruction_id,
    ibanOmitted: metadata.iban_omitted === true,
  });
  return expectedSignature !== undefined && expectedSignature === metadata.entry_sig;
}

/**
 * A row whose trusted CAMT marker says the counterparty IBAN was left out on
 * purpose (`x=i`, written only after proof that it is not an own account) and
 * that has no direct IBAN. Such a row is a KNOWN EXTERNAL counterparty, never
 * "no IBAN": no name-based own-origin or own-transfer fallback may use it.
 */
export function isCamtCounterpartyIbanOmitted(
  transaction: Parameters<typeof isTrustedCamtDescriptionMetadata>[0],
): boolean {
  if (normalizeOptionalReference(transaction.bank_account_no ?? undefined)) return false;
  const metadata = extractCamtDescriptionMetadata(transaction.description);
  return metadata.iban_omitted === true && isTrustedCamtDescriptionMetadata(transaction, metadata);
}

/**
 * Review text for a stored row whose signed CAMT marker fails its checksum and
 * whose text before the marker fills the 150-character cap (up to 3 trailing
 * whitespace characters may have been trimmed at the cut): the shape an
 * earlier release left when it signed the full description and then cut it.
 * `undefined` otherwise.
 *
 * Explanation only, never evidence. Such a sig can be recomputed only from the
 * full statement text (`findMarkerSignatureMatches` on re-import), which is no
 * longer stored, so a tampered marker on a cap-filling row looks the same.
 */
export function legacyTruncatedCamtMarkerHint(
  transaction: Parameters<typeof isTrustedCamtDescriptionMetadata>[0],
): string | undefined {
  const metadata = extractCamtDescriptionMetadata(transaction.description);
  if (!metadata.entry_sig || isTrustedCamtDescriptionMetadata(transaction, metadata)) return undefined;
  const marker = normalizeCamtDescriptionLineBreaks(transaction.description ?? "").trimEnd()
    .match(/(?:^|\n)(\[e-arveldaja-mcp:camt\s+[^\]\r\n]+\])$/)?.[1];
  const text = stripCamtDescriptionMetadata(transaction.description ?? undefined);
  if (!marker || !text) return undefined;
  const budget = TRANSACTION_DESCRIPTION_MAX_LENGTH - marker.length - 1;
  if (text.length > budget || text.length < budget - 3) return undefined;
  return "legacy_truncated_camt_marker: the description fills the 150-character cap, as rows from releases " +
    "before the stored-text signing fix do (the sig was taken over the full statement text, then the text was cut), " +
    "so this checksum can never verify. Re-importing the statement recognises the row but does not re-sign it. " +
    "Check the row against the bank statement and confirm it manually; for a PROJECT row you may instead delete it " +
    "and re-import the statement (after owner approval) to get a verifiable marker.";
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
  const metadata = extractCamtDescriptionMetadata(transaction.description);
  // A poisoned marker withdraws the row's identity, direct fields included.
  if (metadata.poisoned) return undefined;
  const directBankReferenceKey = bankReferenceLookupKey(transaction.bank_ref_number ?? undefined);
  if (directBankReferenceKey) return directBankReferenceKey;

  if (!isTrustedCamtDescriptionMetadata(transaction, metadata)) return undefined;
  return bankReferenceLookupKey(metadata.bank_ref_number) ?? metadata.bank_ref_hash;
}

export function storedBankAccountNo(transaction: Pick<Transaction,
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
  const metadata = extractCamtDescriptionMetadata(transaction.description);
  if (metadata.poisoned) return undefined;
  const directBankAccountNo = normalizeOptionalReference(transaction.bank_account_no ?? undefined);
  if (directBankAccountNo) return directBankAccountNo;

  return isTrustedCamtDescriptionMetadata(transaction, metadata)
    ? metadata.bank_account_no
    : undefined;
}

export function buildDuplicateLookup(transactions: Transaction[], selectedDimensionId: number): DuplicateLookup {
  const lookup: DuplicateLookup = { byBankRef: new Map(), byEntryKey: new Map(), bySignature: new Map(), byMarkerReference: new Map(), byPoisonedMarker: [] };
  for (const transaction of transactions) {
    addToDuplicateLookup(lookup, transaction, selectedDimensionId);
  }
  return lookup;
}

/** Index one more ledger row (e.g. one just created) into an existing lookup. */
export function addToDuplicateLookup(
  lookup: DuplicateLookup,
  transaction: Transaction,
  selectedDimensionId: number,
): void {
  const { byBankRef, byEntryKey } = lookup;
  if (!transaction.id) return;
  if (
    typeof transaction.accounts_dimensions_id !== "number" ||
    !Number.isSafeInteger(transaction.accounts_dimensions_id) ||
    transaction.accounts_dimensions_id <= 0 ||
    transaction.accounts_dimensions_id !== selectedDimensionId
  ) {
    return;
  }

  const metadata = extractCamtDescriptionMetadata(transaction.description);
  // A poisoned row is never duplicate evidence, not even through its direct
  // bank reference; it only holds the entries it may be (findPoisonedMarkerHolds).
  if (metadata.poisoned) {
    lookup.byPoisonedMarker.push(transaction);
    return;
  }

  const entryKey = buildExistingTransactionDuplicateKey(transaction, selectedDimensionId);
  if (entryKey) {
    const exactExisting = byEntryKey.get(entryKey) ?? [];
    exactExisting.push(transaction.id);
    byEntryKey.set(entryKey, exactExisting);
  }

  if (metadata.entry_sig) pushToMap(lookup.bySignature, metadata.entry_sig, transaction);
  const markerReferenceKey = dimensionScopedBankReferenceLookupKey(markerBankReferenceLookupKey(metadata), selectedDimensionId);
  if (markerReferenceKey) pushToMap(lookup.byMarkerReference, markerReferenceKey, transaction);

  const directBankRefKey = dimensionScopedBankReferenceLookupKey(
    directBankReferenceLookupKey(transaction),
    selectedDimensionId,
  );
  if (!directBankRefKey) return;

  const existing = byBankRef.get(directBankRefKey) ?? [];
  existing.push(transaction.id);
  byBankRef.set(directBankRefKey, existing);
}

/**
 * Stored rows with a poisoned CAMT marker that may be this entry: they claim
 * its bank reference (in the marker or directly), or carry its date, amount
 * and currency. Such an entry is held for review, neither created nor skipped
 * as a duplicate.
 */
export function findPoisonedMarkerHolds(entry: ParsedCamtEntry, lookup: DuplicateLookup): Transaction[] {
  const entryReferenceKey = bankReferenceLookupKey(entry.bank_reference);
  return lookup.byPoisonedMarker.filter((row) => {
    const claims = [
      ...(extractCamtDescriptionMetadata(row.description).claimed_reference_keys ?? []),
      directBankReferenceLookupKey(row),
    ];
    if (entryReferenceKey !== undefined && claims.includes(entryReferenceKey)) return true;
    return row.date === entry.date &&
      Number.isFinite(row.amount) && centsKey(row.amount) === centsKey(entry.amount) &&
      (row.cl_currencies_id || "EUR") === (entry.currency || "EUR");
  });
}

function pushToMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key) ?? [];
  existing.push(value);
  map.set(key, existing);
}

function markerBankReferenceLookupKey(metadata: ReturnType<typeof extractCamtDescriptionMetadata>): string | undefined {
  return bankReferenceLookupKey(metadata.bank_ref_number) ?? metadata.bank_ref_hash;
}

/**
 * True when `stored` is exactly what the CAMT renderer writes for this
 * description beside the stored marker: the full text, or the text cut to the
 * budget that marker leaves and then trimEnd()-ed. Anything else (edited text,
 * a shorter cut) is not proof of truncation.
 */
function storedTextIsRenderedDescription(stored: string | null | undefined, cleanDescription: string | undefined): boolean {
  if (!stored) return false;
  const marker = normalizeCamtDescriptionLineBreaks(stored).trimEnd()
    .match(/(?:^|\n)(\[e-arveldaja-mcp:camt\s+[^\]\r\n]+\])$/)?.[1];
  if (!marker) return false;
  const text = stripCamtDescriptionMetadata(stored);
  if (!cleanDescription) return text === undefined;
  if (text === cleanDescription) return true;
  const budget = TRANSACTION_DESCRIPTION_MAX_LENGTH - marker.length - 1;
  if (budget <= 0 || cleanDescription.length <= budget) return false;
  const rendered = cleanDescription.slice(0, budget).trimEnd();
  return rendered.length > 0 && text === rendered;
}

/**
 * Stored rows on this dimension whose CAMT marker `sig` is the one this entry
 * produces (over the stored text, over the full text as releases before
 * stored-text signing wrote it, or the dir-less legacy variant) although the
 * marker fails its checksum: an older sig was taken over the full description
 * before the stored text was cut to the cap, and read-back drops
 * bank_ref_number/bank_account_no.
 * The sig is only a hint; every surviving field must corroborate it. Only
 * `clients_id` is ignored (legitimately reassigned on confirm).
 */
export function findMarkerSignatureMatches(
  entry: ParsedCamtEntry,
  lookup: DuplicateLookup,
  selectedDimensionId: number,
): number[] {
  const entryReferenceKey = bankReferenceLookupKey(entry.bank_reference);
  if (!entryReferenceKey) return [];
  const cleanDescription = markerSafeDescription(entry.description);
  const signatures = new Set([
    extractCamtDescriptionMetadata(buildCamtDescriptionWithMetadata(entry.description, entry)).entry_sig,
    // What a release before #64 stored for this entry, with and without `instr=`.
    extractCamtDescriptionMetadata(buildCamtDescriptionWithMetadataV1(entry.description, entry)).entry_sig,
    extractCamtDescriptionMetadata(renderCamtDescriptionV1(entry.description, entry)).entry_sig,
    // The `x=i` rendering, whatever today's ownership evidence says.
    extractCamtDescriptionMetadata(renderCamtDescriptionIbanOmitted(entry.description, entry)).entry_sig,
    buildCamtEntrySignatureForParsedEntry(entry, cleanDescription),
    buildCamtEntrySignatureForParsedEntry(entry, cleanDescription, true),
  ].filter((signature): signature is string => signature !== undefined));
  const entryIban = normalizePossibleDuplicateIban(entry.counterparty_iban);
  const entryName = normalizeBatchDuplicateKeyPart(entry.counterparty_name);
  const entryRef = normalizeBatchDuplicateKeyPart(canonicalRefNumber(entry.reference_number).value);
  const present = (value: string | null | undefined) => normalizeOptionalReference(value ?? undefined) !== undefined;

  const matches = new Set<number>();
  for (const signature of signatures) {
    for (const row of lookup.bySignature.get(signature) ?? []) {
      const metadata = extractCamtDescriptionMetadata(row.description);
      const corroborated =
        row.accounts_dimensions_id === selectedDimensionId &&
        row.date === entry.date &&
        Number.isFinite(row.amount) && centsKey(row.amount) === centsKey(entry.amount) &&
        (row.cl_currencies_id || "EUR") === (entry.currency || "EUR") &&
        markerBankReferenceLookupKey(metadata) === entryReferenceKey &&
        (!metadata.source_direction || metadata.source_direction === entry.direction) &&
        storedTextIsRenderedDescription(row.description, cleanDescription) &&
        (!present(row.bank_account_name) || normalizeBatchDuplicateKeyPart(row.bank_account_name ?? undefined) === entryName) &&
        (!present(row.ref_number) || normalizeBatchDuplicateKeyPart(row.ref_number ?? undefined) === entryRef) &&
        (!present(row.bank_ref_number) || directBankReferenceLookupKey(row) === entryReferenceKey) &&
        (!present(row.bank_account_no) || normalizePossibleDuplicateIban(normalizeOptionalReference(row.bank_account_no ?? undefined)) === entryIban) &&
        (metadata.bank_account_no === undefined || normalizePossibleDuplicateIban(metadata.bank_account_no) === entryIban);
      if (corroborated && row.id) matches.add(row.id);
    }
  }
  return [...matches];
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
  const { current, alias } = existingDuplicateKeysByKind(entry, selectedDimensionId);
  return [...current, ...alias];
}

/**
 * Current-identity keys, then legacy alias keys (what an earlier release stored
 * for this same leg) not already current. `lossy`: keys whose rendering lost
 * part of the entry's identity (IBAN left out, or text cut), so two different
 * entries can share them (findLossyIdentityConflicts).
 */
function existingDuplicateKeysByKind(
  entry: ParsedCamtEntry,
  selectedDimensionId: number,
): { current: string[]; alias: string[]; lossy: Set<string> } {
  const bankReference = normalizeOptionalReference(entry.bank_reference);
  const bankReferenceKey = dimensionScopedBankReferenceLookupKey(
    bankReferenceLookupKey(bankReference),
    selectedDimensionId,
  );
  const variants = bankReference && bankReferenceKey ? currentExistingDuplicateKeys(entry, bankReferenceKey) : [];
  const current = [...new Set(variants.map((variant) => variant.key))];
  const lossy = new Set<string>();
  const exact = new Set<string>();
  for (const variant of variants) (variant.lossy ? lossy : exact).add(variant.key);
  const alias = new Set<string>();
  for (const legacy of entry.legacy_identities ?? []) {
    const legacyEntry = { ...entry, ...legacy, legacy_identities: undefined };
    const legacyKeys = existingDuplicateKeysByKind(legacyEntry, selectedDimensionId);
    for (const key of [...legacyKeys.current, ...legacyKeys.alias]) {
      if (!current.includes(key)) alias.add(key);
      (legacyKeys.lossy.has(key) ? lossy : exact).add(key);
    }
  }
  return { current, alias: [...alias], lossy: new Set([...lossy].filter((key) => !exact.has(key))) };
}

/**
 * One exact key per rendering this entry could have been stored as,
 * independent of today's ownership evidence: the current rendering, the V1
 * rendering (a release before #64), and the full-text `x=i` rendering, whose
 * row reads back without an IBAN.
 */
function currentExistingDuplicateKeys(entry: ParsedCamtEntry, bankReferenceKey: string): Array<{ key: string; lossy: boolean }> {
  const cleanDescription = markerSafeDescription(entry.description);
  const current = renderCamtDescriptionDetailed(entry.description, entry);
  const ibanOmitted = renderCamtDescriptionIbanOmitted(entry.description, entry);
  const renderings = [
    ...(current.held ? [] : [{ description: current.description, ibanOmitted: false }]),
    { description: buildCamtDescriptionWithMetadataV1(entry.description, entry), ibanOmitted: false },
    ...(ibanOmitted !== undefined ? [{ description: ibanOmitted, ibanOmitted: true }] : []),
  ];
  const lossyByKey = new Map<string, boolean>();
  for (const rendering of renderings) {
    const lossy = rendering.ibanOmitted ||
      (stripCamtDescriptionMetadata(rendering.description)?.length ?? 0) < (cleanDescription?.length ?? 0);
    for (const type of transactionTypesForDuplicateCompatibility(entry)) {
      const key = [
        bankReferenceKey,
        entry.date,
        type,
        entry.currency,
        centsKey(entry.amount),
        normalizeBatchDuplicateKeyPart(canonicalRefNumber(entry.reference_number).value),
        normalizeBatchDuplicateKeyPart(rendering.ibanOmitted ? undefined : entry.counterparty_iban),
        normalizeBatchDuplicateKeyPart(entry.counterparty_name),
        normalizeBatchDuplicateKeyPart(rendering.description),
      ].join("|");
      lossyByKey.set(key, (lossyByKey.get(key) ?? true) && lossy);
    }
  }
  return [...lossyByKey].map(([key, lossy]) => ({ key, lossy }));
}

/**
 * Batch keys of entries a lossy exact key cannot tell apart: two entries that
 * differ only in the IBAN an `x=i` row left out, or only after the point a
 * stored text was cut, share such a key, and occurrence counting could let one
 * consume the other's stored row while the other is created again. Per lossy
 * key with stored rows: claimants with the same untruncated identity (IBAN +
 * full text, e.g. identical legs) form one group and keep today's counting;
 * two or more groups, or more stored rows than claimants, hold every claimant
 * that no non-lossy key matches.
 */
export function findLossyIdentityConflicts(
  entries: ParsedCamtEntry[],
  lookup: DuplicateLookup,
  selectedDimensionId: number,
): Set<string> {
  const keysByBatchKey = new Map<string, { entry: ParsedCamtEntry; keys: ReturnType<typeof existingDuplicateKeysByKind> }>();
  for (const entry of entries) {
    const batchKey = buildBatchDuplicateKey(entry);
    if (!keysByBatchKey.has(batchKey)) keysByBatchKey.set(batchKey, { entry, keys: existingDuplicateKeysByKind(entry, selectedDimensionId) });
  }
  const claimantsByKey = new Map<string, string[]>();
  for (const [batchKey, { keys }] of keysByBatchKey) {
    for (const key of keys.lossy) pushToMap(claimantsByKey, key, batchKey);
  }
  const occurrences = findExactKeyOccurrences(entries, selectedDimensionId);
  const untruncatedIdentity = (entry: ParsedCamtEntry) => JSON.stringify([
    normalizeBatchDuplicateKeyPart(entry.counterparty_iban),
    normalizeBatchDuplicateKeyPart(markerSafeDescription(entry.description)),
  ]);
  const held = new Set<string>();
  for (const [key, claimants] of claimantsByKey) {
    const storedCount = lookup.byEntryKey.get(key)?.length ?? 0;
    if (storedCount === 0) continue;
    const groups = new Set(claimants.map((batchKey) => untruncatedIdentity(keysByBatchKey.get(batchKey)!.entry)));
    if (groups.size < 2 && storedCount <= claimants.length) continue;
    for (const batchKey of claimants) {
      const { keys } = keysByBatchKey.get(batchKey)!;
      const entryOccurrences = occurrences.get(batchKey);
      const nonLossyMatch = [...keys.current, ...keys.alias].some((candidate) => !keys.lossy.has(candidate) &&
        (lookup.byEntryKey.get(candidate)?.length ?? 0) >= Math.max(1, entryOccurrences?.get(candidate) ?? 1));
      if (!nonLossyMatch) held.add(batchKey);
    }
  }
  return held;
}

/**
 * 1-based occurrence of each entry (by batch key), PER exact ledger key, among
 * the DISTINCT in-file entries that carry that key. Identical legs of one batch
 * <Ntry> (same bank reference, amount, counterparty, description) differ only by
 * leg_index, which the stored row does not carry: leg n is already imported only
 * when at least n stored rows match the key. Counting per key (not per key set)
 * keeps a legacy alias key shared by several entries from being satisfied by
 * fewer stored rows than entries that claim it. Current-key claims are ranked
 * before alias-key claims: an entry whose CURRENT key equals another entry's
 * legacy alias needs only as many rows as current claims before it (a
 * new-version ledger stores just its own row), while the alias claimant needs
 * one row more (an old-release ledger stores one row per alias claim).
 */
export function findExactKeyOccurrences(
  entries: ParsedCamtEntry[],
  selectedDimensionId: number,
): Map<string, Map<string, number>> {
  const occurrences = new Map<string, Map<string, number>>();
  const keysByBatchKey = new Map<string, { current: string[]; alias: string[] }>();
  for (const entry of entries) {
    const batchKey = buildBatchDuplicateKey(entry);
    if (keysByBatchKey.has(batchKey)) continue;
    keysByBatchKey.set(batchKey, existingDuplicateKeysByKind(entry, selectedDimensionId));
    occurrences.set(batchKey, new Map<string, number>());
  }
  const countsByExactKey = new Map<string, number>();
  for (const kind of ["current", "alias"] as const) {
    for (const [batchKey, keys] of keysByBatchKey) {
      const entryOccurrences = occurrences.get(batchKey)!;
      for (const exactKey of keys[kind]) {
        const occurrence = (countsByExactKey.get(exactKey) ?? 0) + 1;
        countsByExactKey.set(exactKey, occurrence);
        entryOccurrences.set(exactKey, occurrence);
      }
    }
  }
  return occurrences;
}

/**
 * Statement entries an earlier release imported only in part. It stored one
 * row per leg (`legacy_identities`, or the leg's own identity where unchanged),
 * so a multi-leg entry is fully imported only when EVERY old leg row is in the
 * ledger. When a definitely-old row (a legacy alias key no current leg carries)
 * is present but some old leg is not, the per-leg key match would skip an
 * aggregate entry whole, or book the new allocation beside the old one (e.g.
 * 92.50 stored + 95.00 new for a 185.00 entry). Returns the entries that must
 * go to review instead: legs not matched, and legs whose own old rows are
 * incomplete. Legs of one <Ntry> are consecutive and start at leg_index 0.
 */
export function findPartialLegacyEntries(
  entries: ParsedCamtEntry[],
  lookup: DuplicateLookup,
  selectedDimensionId: number,
): Set<ParsedCamtEntry> {
  const partial = new Set<ParsedCamtEntry>();
  const groups: ParsedCamtEntry[][] = [];
  for (const entry of entries) {
    if ((entry.leg_index ?? 0) === 0 || groups.length === 0) groups.push([entry]);
    else groups[groups.length - 1]!.push(entry);
  }
  for (const group of groups) {
    if (!group.some((entry) => entry.legacy_identities)) continue;
    const currentKeys = new Set(group.flatMap((entry) => existingDuplicateKeysByKind(entry, selectedDimensionId).current));
    const legacyLegs = group.flatMap((entry) => entry.legacy_identities
      ? entry.legacy_identities.map((legacy) => ({
          entry,
          alias: true,
          keys: buildExistingDuplicateKeysForEntry({ ...entry, ...legacy, legacy_identities: undefined }, selectedDimensionId),
        }))
      : [{ entry, alias: false, keys: existingDuplicateKeysByKind(entry, selectedDimensionId).current }]);
    if (legacyLegs.length < 2) continue;
    const oldRowPresent = legacyLegs.some((leg) => leg.alias &&
      leg.keys.some((key) => !currentKeys.has(key) && (lookup.byEntryKey.get(key)?.length ?? 0) > 0));
    if (!oldRowPresent) continue;
    const used = new Set<number>();
    const uncovered = new Set<ParsedCamtEntry>();
    for (const leg of legacyLegs) {
      const id = leg.keys.flatMap((key) => lookup.byEntryKey.get(key) ?? []).find((candidate) => !used.has(candidate));
      if (id === undefined) uncovered.add(leg.entry);
      else used.add(id);
    }
    if (uncovered.size === 0) continue;
    for (const entry of group) {
      if (!entry.duplicate || uncovered.has(entry)) partial.add(entry);
    }
  }
  // Entries sharing a repeated bank reference never take the signature path
  // (findDuplicateTransactionIds refuses it), so a stored row whose CAMT marker
  // carries that reference, trusted or not, and that no entry's exact match
  // accounts for may be an old aggregate or truncated leg. Neither create nor
  // skip: review all.
  const byReference = new Map<string, ParsedCamtEntry[]>();
  for (const entry of entries) {
    const reference = normalizeOptionalReference(entry.bank_reference);
    if (reference) pushToMap(byReference, reference, entry);
  }
  for (const [reference, sharing] of byReference) {
    if (sharing.length < 2) continue;
    const key = dimensionScopedBankReferenceLookupKey(bankReferenceLookupKey(reference), selectedDimensionId);
    const explained = new Set(sharing.flatMap((entry) => entry.duplicate_transaction_ids));
    const dates = new Set(sharing.map((entry) => entry.date));
    const unexplained = (key ? lookup.byMarkerReference.get(key) ?? [] : [])
      .some((row) => dates.has(row.date) && !explained.has(row.id!));
    if (unexplained) for (const entry of sharing) partial.add(entry);
  }
  return partial;
}

export function findDuplicateTransactionIds(
  entry: ParsedCamtEntry,
  lookup: DuplicateLookup,
  repeatedBankReferences: ReadonlySet<string>,
  selectedDimensionId: number,
  exactKeyOccurrences?: ReadonlyMap<string, number>,
): number[] {
  for (const exactKey of buildExistingDuplicateKeysForEntry(entry, selectedDimensionId)) {
    const exactMatches = lookup.byEntryKey.get(exactKey) ?? [];
    if (exactMatches.length >= (exactKeyOccurrences?.get(exactKey) ?? 1) && exactMatches.length > 0) {
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
  for (const id of findMarkerSignatureMatches(entry, lookup, selectedDimensionId)) {
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

/** The normalized identity parts of one CAMT leg, as used by the import's
 * batch dedup. Exposed so other consumers can hash them with a structured
 * encoding (the `|`-joined key below is ambiguous when a part contains `|`). */
export function batchDuplicateIdentityParts(entry: ParsedCamtEntry): string[] {
  return [
    normalizeOptionalReference(entry.bank_reference) ?? "",
    // Legs of one <Ntry> are parts of a split total, not repeats of each other:
    // an aggregated 150.00 payment carrying three ref-less 50.00 legs must book
    // 150.00, not 50.00. The ordinal keeps them apart. Separate entries are all
    // leg 0, so identical standalone rows still dedup exactly as before.
    String(entry.leg_index ?? 0),
    entry.date,
    entry.direction,
    entry.currency,
    centsKey(entry.amount),
    normalizeBatchDuplicateKeyPart(canonicalRefNumber(entry.reference_number).value),
    normalizeBatchDuplicateKeyPart(entry.end_to_end_id),
    normalizeBatchDuplicateKeyPart(entry.counterparty_iban),
    normalizeBatchDuplicateKeyPart(entry.counterparty_name),
    normalizeBatchDuplicateKeyPart(entry.description),
  ];
}

export function buildBatchDuplicateKey(entry: ParsedCamtEntry): string {
  return batchDuplicateIdentityParts(entry).join("|");
}

/** Opaque, collision-safe identity of one CAMT leg: sha256 of the JSON-encoded
 * batch-duplicate identity parts. Carries no statement text. */
export function camtMovementIdentity(entry: ParsedCamtEntry): string {
  return createHash("sha256").update(JSON.stringify(batchDuplicateIdentityParts(entry))).digest("hex");
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
