import { createConnectionScopedBundleStore } from "../connection-scoped-bundle-store.js";
import type { ApiContext } from "../tools/crud-tools.js";
import type { Journal } from "../types/api.js";
import {
  camtReviewAcknowledgementKey,
  type CamtReviewAcknowledgementCandidate,
  type CamtReviewAcknowledgementRecord,
} from "./review-acknowledgement.js";

const cents = (value: number) => Math.round(value * 100);

export const CAMT_REVIEW_ACKNOWLEDGEMENT_FILE = "camt-review-acknowledgements.json";

export const camtReviewAcknowledgementStore = createConnectionScopedBundleStore<CamtReviewAcknowledgementRecord>({
  fileName: CAMT_REVIEW_ACKNOWLEDGEMENT_FILE,
  label: "CAMT review acknowledgements (camt-review-acknowledgements.json)",
  maxEntries: 5000,
  keyOf: camtReviewAcknowledgementKey,
});

/** This connection's acknowledgements; an unavailable or unreadable store is none (every review stays). */
export function readCamtReviewAcknowledgements(): CamtReviewAcknowledgementRecord[] {
  try {
    return camtReviewAcknowledgementStore.read() ?? [];
  } catch {
    return [];
  }
}

export type CamtAckVerification =
  | { ok: true; fingerprint: Record<string, unknown> }
  | { ok: false; code: string; message: string };

/**
 * Fresh proof for an acknowledgement: the one journal is re-read past the
 * cache and must be registered, not deleted, and move exactly the row's
 * signed EUR cents on the row's bank account + dimension.
 */
export async function verifyCamtAcknowledgementJournal(
  api: ApiContext,
  candidate: CamtReviewAcknowledgementCandidate,
): Promise<CamtAckVerification> {
  const journalId = candidate.journal_ids[0]!;
  let journal: Journal;
  let accountId: unknown;
  try {
    api.journals.invalidateListCache();
    const [fresh, dimensions] = await Promise.all([api.journals.get(journalId), api.readonly.getAccountDimensions()]);
    journal = fresh;
    accountId = dimensions.find(dimension => dimension.id === candidate.accounts_dimensions_id && !dimension.is_deleted)?.accounts_id;
  } catch (error) {
    return { ok: false, code: "camt_ack_journal_unavailable", message: `Journal ${journalId} could not be read (${(error as Error).message}); nothing was recorded.` };
  }
  if (typeof accountId !== "number") {
    return { ok: false, code: "camt_ack_journal_mismatch", message: `The bank account of dimension ${candidate.accounts_dimensions_id} could not be resolved; nothing was recorded.` };
  }
  if (journal.is_deleted || journal.registered !== true) {
    return { ok: false, code: "camt_ack_journal_mismatch", message: `Journal ${journalId} is deleted or not registered; nothing was recorded.` };
  }
  let net = 0;
  for (const posting of journal.postings ?? []) {
    if (posting.is_deleted || posting.accounts_id !== accountId || posting.accounts_dimensions_id !== candidate.accounts_dimensions_id) continue;
    const base = posting.base_amount ?? posting.amount;
    if ((posting.cl_currencies_id ?? "EUR") !== "EUR" || cents(base) !== cents(posting.amount) || (posting.type !== "D" && posting.type !== "C")) {
      return { ok: false, code: "camt_ack_journal_mismatch", message: `Journal ${journalId} has a non-EUR or inconsistent bank posting; nothing was recorded.` };
    }
    net += posting.type === "D" ? cents(base) : -cents(base);
  }
  const expected = (candidate.direction === "CRDT" ? 1 : -1) * cents(candidate.amount);
  if (net !== expected) {
    return { ok: false, code: "camt_ack_journal_mismatch", message: `Journal ${journalId} does not move ${candidate.amount} EUR ${candidate.direction === "CRDT" ? "into" : "out of"} this bank account; nothing was recorded.` };
  }
  return {
    ok: true,
    fingerprint: {
      accounts_dimensions_id: candidate.accounts_dimensions_id,
      movement_identity: candidate.movement_identity,
      review_code: candidate.review_code,
      journal_ids: candidate.journal_ids,
      date: candidate.date,
      amount_cents: cents(candidate.amount),
      direction: candidate.direction,
      journal: { id: journalId, effective_date: journal.effective_date ?? null, bank_net_cents: net },
    },
  };
}

