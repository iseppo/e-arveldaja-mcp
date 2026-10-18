import {
  CAMT_DESCRIPTION_METADATA_PREFIX,
  bankReferenceHash,
  buildCamtEntrySignatureForParsedEntry,
  encodeCamtMetadataValue,
  extractCamtDescriptionMetadata,
  markerInstructionId,
  markerSafeDescription,
  normalizeOptionalReference,
  stripCamtDescriptionMetadata,
} from "./duplicate-identity.js";
import { TRANSACTION_DESCRIPTION_MAX_LENGTH } from "../bank-transaction-create.js";
import type { ParsedCamtEntry } from "./types.js";

// FROZEN: the CAMT description renderer of every release before GitHub #64
// (the marker first, then whatever text still fits). It is never written to
// the ledger again; it only tells duplicate detection what an earlier release
// stored for an entry (exact-key and sig aliases), and lets the current
// renderer keep a row byte-identical where this one already stored the full
// text with a verifiable identity. Pinned by marker-render-v1.test.ts: do not
// change its output.

function buildCamtDescriptionMarkerV1(
  entry: ParsedCamtEntry,
  cleanDescription: string | undefined,
  instructionId?: string,
): string | undefined {
  const bankReference = normalizeOptionalReference(entry.bank_reference);
  if (!bankReference && !entry.counterparty_iban) return undefined;

  const entrySignature = buildCamtEntrySignatureForParsedEntry(entry, cleanDescription, false, instructionId);
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
  const directionPart = instructionId ? `dir=${entry.direction} instr=${instructionId}` : `dir=${entry.direction}`;
  const compactBankAccountPart = entry.counterparty_iban
    ? `i=${encodeCamtMetadataValue(entry.counterparty_iban)}`
    : undefined;
  const compactDirectionPart = instructionId ? `d=${entry.direction} instr=${instructionId}` : `d=${entry.direction}`;
  const compactSignaturePart = entrySignature ? `s=${entrySignature}` : undefined;
  const fromParts = (parts: Array<string | undefined>) => {
    const present = parts.filter((part): part is string => Boolean(part));
    return present.length > 0 ? `${CAMT_DESCRIPTION_METADATA_PREFIX} ${present.join(" ")}]` : undefined;
  };

  const markerCandidates = [
    fromParts([bankReferencePart, bankAccountPart, directionPart, signaturePart]),
    fromParts([bankReferenceHashPart, bankAccountPart, directionPart, signaturePart]),
    fromParts([compactBankReferenceHashPart, compactBankAccountPart, compactDirectionPart, compactSignaturePart]),
    fromParts([bankReferencePart, directionPart, signaturePart]),
    fromParts([bankReferenceHashPart, directionPart, signaturePart]),
    fromParts([bankAccountPart, directionPart, signaturePart]),
    fromParts([bankReferencePart, directionPart]),
    fromParts([bankReferenceHashPart, directionPart]),
    fromParts([bankAccountPart, directionPart]),
  ];

  return markerCandidates.find((marker) => marker !== undefined && marker.length <= TRANSACTION_DESCRIPTION_MAX_LENGTH);
}

/** What a release before #64 stored for this entry, `instr=` included as it decided. */
export function buildCamtDescriptionWithMetadataV1(description: string | undefined, entry: ParsedCamtEntry): string | undefined {
  const withoutInstruction = renderCamtDescriptionV1(description, entry);
  const instructionId = markerInstructionId(entry);
  if (!instructionId) return withoutInstruction;
  // The instruction id is persisted only when it costs no description text:
  // the stored text must stay exactly what a release without `instr=` stored,
  // so exact duplicate keys and rendered-text checks are unchanged.
  const withInstruction = renderCamtDescriptionV1(description, entry, instructionId);
  const text = (stored: string | undefined) => stripCamtDescriptionMetadata(stored);
  // ...and it must not cost an identity field either: a longer marker can fall
  // back to a shorter form that drops the IBAN or bank reference the sig
  // still covers, which would leave the row unverifiable.
  const identity = (stored: string | undefined) => {
    const { bank_ref_number, bank_ref_hash, bank_account_no, source_direction, entry_sig } = extractCamtDescriptionMetadata(stored);
    return JSON.stringify([bank_ref_number, bank_ref_hash, bank_account_no, source_direction, entry_sig !== undefined]);
  };
  return withInstruction !== undefined &&
    extractCamtDescriptionMetadata(withInstruction).instruction_id === instructionId &&
    identity(withInstruction) === identity(withoutInstruction) &&
    text(withInstruction) === text(withoutInstruction) &&
    text(withInstruction) === markerSafeDescription(description)
    ? withInstruction
    : withoutInstruction;
}

/** What a release without the `instr=` marker field stored for this entry. */
export function renderCamtDescriptionV1(
  description: string | undefined,
  entry: ParsedCamtEntry,
  instructionId?: string,
): string | undefined {
  const cleanDescription = markerSafeDescription(description);
  const marker = buildCamtDescriptionMarkerV1(entry, cleanDescription, instructionId);
  if (!marker) return cleanDescription;

  const separatorLength = cleanDescription ? 1 : 0;
  const descriptionBudget = TRANSACTION_DESCRIPTION_MAX_LENGTH - marker.length - separatorLength;
  if (!cleanDescription || descriptionBudget <= 0) return marker.slice(0, TRANSACTION_DESCRIPTION_MAX_LENGTH);

  const trimmedDescription = cleanDescription.length > descriptionBudget
    ? cleanDescription.slice(0, descriptionBudget).trimEnd()
    : cleanDescription;
  // The sig covers the text actually stored, so a truncated row still passes
  // its checksum. The sig has a fixed width, so re-signing keeps the marker's
  // length and the budget computed above.
  const storedMarker = trimmedDescription === cleanDescription
    ? marker
    : buildCamtDescriptionMarkerV1(entry, trimmedDescription || undefined, instructionId) ?? marker;
  return trimmedDescription ? `${trimmedDescription}\n${storedMarker}` : storedMarker;
}
