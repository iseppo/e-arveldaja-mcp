/**
 * #10(b): a CAMT journal review the owner has checked ("journal N books this
 * row"). A record only quiets the review while its full key still matches and
 * the movement is still unique with an unclaimed journal (see the projection);
 * it never creates or skips a booking, so the ledger effect is nil.
 */

/** Only "may already be booked" reviews; wrong bookings need a correction, not an acknowledgement. */
export const ACKNOWLEDGEABLE_CAMT_REVIEW_CODES = ["camt_journal_posting_review", "camt_journal_identity_stale"] as const;
export type CamtAcknowledgeableReviewCode = typeof ACKNOWLEDGEABLE_CAMT_REVIEW_CODES[number];

export type CamtAckRefusalCode =
  | "camt_ack_nonunique_movement"
  | "camt_ack_multiple_candidates"
  | "camt_ack_journal_already_claimed"
  | "camt_ack_journal_mismatch"
  | "camt_ack_needs_inbox_scan";

export const CAMT_REVIEW_ACKNOWLEDGED = "camt_review_acknowledged";

export interface CamtReviewAcknowledgementRecord {
  accounts_dimensions_id: number;
  /** camtMovementIdentity of the statement leg. */
  movement_identity: string;
  review_code: CamtAcknowledgeableReviewCode;
  /** Sorted; exactly one journal. */
  journal_ids: number[];
  acknowledged_at: string;
}

/** Carried by an acknowledgeable review row: what `prepare_action` needs. */
export interface CamtReviewAcknowledgementCandidate {
  accounts_dimensions_id: number;
  movement_identity: string;
  review_code: CamtAcknowledgeableReviewCode;
  journal_ids: number[];
  date: string;
  amount: number;
  direction: "CRDT" | "DBIT";
  /** Present when the row cannot be acknowledged as it stands. */
  refused?: CamtAckRefusalCode;
}

export function isAcknowledgeableCamtReviewCode(code: unknown): code is CamtAcknowledgeableReviewCode {
  return (ACKNOWLEDGEABLE_CAMT_REVIEW_CODES as readonly unknown[]).includes(code);
}

export function camtReviewAcknowledgementKey(
  record: Pick<CamtReviewAcknowledgementRecord, "accounts_dimensions_id" | "movement_identity" | "review_code" | "journal_ids">,
): string {
  const journals = [...record.journal_ids].sort((left, right) => left - right).join(",");
  return `${record.accounts_dimensions_id}|${record.movement_identity}|${record.review_code}|${journals}`;
}

/** A stored acknowledgement of another movement that already binds one of these journals. */
export function findClaimingAcknowledgement(
  records: readonly CamtReviewAcknowledgementRecord[],
  candidate: Pick<CamtReviewAcknowledgementRecord, "accounts_dimensions_id" | "movement_identity" | "review_code" | "journal_ids">,
): CamtReviewAcknowledgementRecord | undefined {
  const key = camtReviewAcknowledgementKey(candidate);
  return records.find(record => camtReviewAcknowledgementKey(record) !== key &&
    record.journal_ids.some(id => candidate.journal_ids.includes(id)));
}

/** Parse a caller-supplied candidate strictly; undefined when any field is malformed. */
export function parseCamtReviewAcknowledgementCandidate(value: unknown): CamtReviewAcknowledgementCandidate | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const dimension = record.accounts_dimensions_id;
  const journals = record.journal_ids;
  if (typeof dimension !== "number" || !Number.isSafeInteger(dimension) || dimension <= 0) return undefined;
  if (typeof record.movement_identity !== "string" || !/^[0-9a-f]{64}$/.test(record.movement_identity)) return undefined;
  if (typeof record.review_code !== "string") return undefined;
  if (!Array.isArray(journals) || !journals.every(id => typeof id === "number" && Number.isSafeInteger(id) && id > 0)) return undefined;
  if (typeof record.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) return undefined;
  if (typeof record.amount !== "number" || !Number.isFinite(record.amount) || record.amount <= 0) return undefined;
  if (record.direction !== "CRDT" && record.direction !== "DBIT") return undefined;
  const refused = typeof record.refused === "string" ? record.refused as CamtAckRefusalCode : undefined;
  return {
    accounts_dimensions_id: dimension,
    movement_identity: record.movement_identity,
    review_code: record.review_code as CamtAcknowledgeableReviewCode,
    journal_ids: [...journals as number[]].sort((left, right) => left - right),
    date: record.date,
    amount: record.amount,
    direction: record.direction,
    ...(refused !== undefined ? { refused } : {}),
  };
}

/** Pre-checks shared by prepare and execute that need no API call. */
export function checkCamtAcknowledgementCandidate(
  candidate: CamtReviewAcknowledgementCandidate,
  records: readonly CamtReviewAcknowledgementRecord[],
): { code: string; message: string } | undefined {
  if (!isAcknowledgeableCamtReviewCode(candidate.review_code)) {
    return {
      code: "camt_ack_code_not_acknowledgeable",
      message: "Only camt_journal_posting_review and camt_journal_identity_stale reviews can be acknowledged; the other journal reviews mean an existing booking is wrong and needs a correction.",
    };
  }
  if (candidate.refused !== undefined) {
    return { code: candidate.refused, message: refusalMessage(candidate.refused) };
  }
  if (candidate.journal_ids.length !== 1) {
    return { code: "camt_ack_multiple_candidates", message: refusalMessage("camt_ack_multiple_candidates") };
  }
  const claim = findClaimingAcknowledgement(records, candidate);
  if (claim) {
    return { code: "camt_ack_journal_already_claimed", message: refusalMessage("camt_ack_journal_already_claimed") };
  }
  return undefined;
}

export function refusalMessage(code: CamtAckRefusalCode): string {
  switch (code) {
    case "camt_ack_nonunique_movement":
      return "The statement, or the statements kept in the inbox together, hold more than one identical movement, so one journal cannot be shown to book this one; the review stays.";
    case "camt_ack_multiple_candidates":
      return "More than one journal may book this movement (a possible double booking); the review stays until it is resolved.";
    case "camt_ack_journal_already_claimed":
      return "The journal is already bound to another statement row; one journal books one movement, so the review stays.";
    case "camt_ack_journal_mismatch":
      return "The journal does not move exactly this row's amount in its direction on this bank account; the review stays.";
    case "camt_ack_needs_inbox_scan":
      return "This statement has not been checked against the other statements in the inbox since the server started, so one journal cannot be shown to book this movement only once; run an inbox scan first. The review stays.";
  }
}
