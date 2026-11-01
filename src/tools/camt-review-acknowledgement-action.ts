import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toMcpJson } from "../mcp-json.js";
import { logAudit } from "../audit-log.js";
import { recordAt, stringAt } from "../record-utils.js";
import type { ExecutionPlanInput, PlanRecord } from "../plan-store.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import type { ApiContext } from "./crud-tools.js";
import { canonicalPlanJson } from "./camt-plan.js";
import {
  checkCamtAcknowledgementCandidate,
  parseCamtReviewAcknowledgementCandidate,
  refusalMessage,
  type CamtReviewAcknowledgementCandidate,
  type CamtReviewAcknowledgementRecord,
} from "../camt/review-acknowledgement.js";
import { camtReviewAcknowledgementStore, verifyCamtAcknowledgementJournal } from "../camt/review-acknowledgement-store.js";
import { hasRetainedCamtStatement, retainedCamtMovementOccurrences } from "../camt/statement-context.js";

export const CAMT_REVIEW_ACKNOWLEDGEMENT_DOMAIN = "camt_review_acknowledgement";

/** The prepare_action / execute_review_action payloads of a CAMT journal-review acknowledgement (#10b). */
export type CamtReviewAcknowledgementPayload =
  | { status: "error"; error_code: string; error: string }
  | { status: "already_acknowledged"; acknowledgement: CamtReviewAcknowledgementCandidate; note: string }
  | {
      status: "ready_for_approval";
      plan_handle: string;
      proposed_action: {
        type: "acknowledge_camt_journal_review";
        server_executable: true;
        execute_via: { tool: "continue_accounting_workflow"; action: "execute_review_action" };
        acknowledgement: CamtReviewAcknowledgementCandidate;
        approval_required: true;
      };
      next_step_summary: string;
    }
  | { status: "acknowledged"; acknowledgement: CamtReviewAcknowledgementRecord; note: string };

function respond(payload: CamtReviewAcknowledgementPayload): CallToolResult {
  return { content: [{ type: "text", text: toMcpJson(payload) }] };
}

function error(code: string, message: string): CallToolResult {
  return respond({ status: "error", error_code: code, error: message });
}

/** A `camt_journal_review` item (inbox resolver_input or a direct CAMT needs_review item). */
export function isCamtJournalReviewItem(reviewItem: Record<string, unknown>): boolean {
  const item = recordAt(reviewItem, "item") ?? reviewItem;
  return stringAt(reviewItem, "review_type") === "camt_journal_review" || stringAt(item, "code") === "camt_journal_review";
}

function candidateOf(reviewItem: Record<string, unknown>): CamtReviewAcknowledgementCandidate | undefined {
  const item = recordAt(reviewItem, "item") ?? reviewItem;
  return parseCamtReviewAcknowledgementCandidate(recordAt(item, "acknowledgement"));
}

type Prepared =
  | { ok: true; candidate: CamtReviewAcknowledgementCandidate; records: CamtReviewAcknowledgementRecord[]; fingerprint: Record<string, unknown> }
  | { ok: false; result: CallToolResult };

/** Checks shared by prepare and execute: the item, the stored claims and a fresh journal read. */
async function prepareCandidate(reviewItem: Record<string, unknown>, api: ApiContext): Promise<Prepared> {
  const candidate = candidateOf(reviewItem);
  if (!candidate) {
    return {
      ok: false,
      result: error("camt_ack_not_acknowledgeable", "This journal review carries no acknowledgement candidate (only an existing-journal review naming one journal can be acknowledged). Pass the item exactly as the CAMT preview returned it."),
    };
  }
  let records: CamtReviewAcknowledgementRecord[] | null;
  try {
    camtReviewAcknowledgementStore.reset(); // another process may have written since
    records = camtReviewAcknowledgementStore.read();
  } catch (readError) {
    return { ok: false, result: error("camt_ack_store_unavailable", `The acknowledgement store could not be read (${(readError as Error).message}); nothing was recorded.`) };
  }
  if (records === null) {
    return { ok: false, result: error("camt_ack_store_unavailable", "Single-file rules mode (EARVELDAJA_RULES_FILE) has no bundle store, so acknowledgements cannot be recorded; the review stays.") };
  }
  const refusal = checkCamtAcknowledgementCandidate(candidate, records);
  if (refusal) return { ok: false, result: error(refusal.code, refusal.message) };
  // B3b: only a statement an inbox scan in this process kept for this connection (also for a candidate saved before a restart).
  if (!hasRetainedCamtStatement(candidate.statement_digest)) {
    return { ok: false, result: error("camt_ack_needs_inbox_scan", refusalMessage("camt_ack_needs_inbox_scan")) };
  }
  // B3b: the movement must also be unique across the statements the inbox retained.
  if (retainedCamtMovementOccurrences(candidate.movement_identity) > 1) {
    return { ok: false, result: error("camt_ack_nonunique_movement", refusalMessage("camt_ack_nonunique_movement")) };
  }
  const verified = await verifyCamtAcknowledgementJournal(api, candidate);
  if (!verified.ok) return { ok: false, result: error(verified.code, verified.message) };
  return { ok: true, candidate, records, fingerprint: verified.fingerprint };
}

function recordOf(candidate: CamtReviewAcknowledgementCandidate): CamtReviewAcknowledgementRecord {
  return {
    accounts_dimensions_id: candidate.accounts_dimensions_id,
    movement_identity: candidate.movement_identity,
    review_code: candidate.review_code,
    journal_ids: candidate.journal_ids,
    acknowledged_at: new Date().toISOString(),
  };
}

const sameKey = (record: CamtReviewAcknowledgementRecord, candidate: CamtReviewAcknowledgementCandidate) =>
  record.accounts_dimensions_id === candidate.accounts_dimensions_id && record.movement_identity === candidate.movement_identity &&
  record.review_code === candidate.review_code && record.journal_ids.join(",") === candidate.journal_ids.join(",");

/** prepare_action: verify and mint a consume-once plan handle; writes nothing. */
export async function buildCamtReviewAcknowledgementPrepareResponse(
  reviewItem: Record<string, unknown>,
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
): Promise<CallToolResult> {
  const prepared = await prepareCandidate(reviewItem, api);
  if (!prepared.ok) return prepared.result;
  const { candidate, records, fingerprint } = prepared;
  if (records.some(record => sameKey(record, candidate))) {
    return respond({
      status: "already_acknowledged",
      acknowledgement: candidate,
      note: "This review is already acknowledged; a re-import reports it under acknowledged_review only while the journal and the statement row stay unchanged.",
    });
  }
  const normalizedArgs = fingerprint as PlanRecord;
  const planInput: ExecutionPlanInput = {
    normalizedArgs,
    sourceIdentities: [],
    liveSnapshot: { ...normalizedArgs, destructive: false },
    commands: [{ id: "camt-review-acknowledgement", category: "acknowledge_camt_journal_review", reviewProjection: normalizedArgs }],
    counts: {},
    totals: {},
    exclusions: [],
    reviews: [],
    privatePayload: normalizedArgs,
  };
  const planHandle = runtimeSafetyContext.planStore.issue(CAMT_REVIEW_ACKNOWLEDGEMENT_DOMAIN, planInput);
  return respond({
    status: "ready_for_approval",
    plan_handle: planHandle,
    proposed_action: {
      type: "acknowledge_camt_journal_review",
      server_executable: true,
      execute_via: { tool: "continue_accounting_workflow", action: "execute_review_action" },
      acknowledgement: candidate,
      approval_required: true,
    },
    next_step_summary: `Only if the owner confirms journal ${candidate.journal_ids[0]} books this ${candidate.amount} EUR row of ${candidate.date}, call continue_accounting_workflow action='execute_review_action' with this item and plan_handle. Nothing is booked or changed in e-arveldaja; later statement imports stop raising this review while the journal and row stay unchanged.`,
  });
}

/** execute_review_action: consume the handle, re-verify from fresh state, then record. */
export async function buildCamtReviewAcknowledgementExecuteResponse(
  reviewItem: Record<string, unknown>,
  planHandle: string | undefined,
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
): Promise<CallToolResult> {
  if (planHandle === undefined) {
    return error("plan_handle_required", "action='execute_review_action' requires a plan_handle from a prior action='prepare_action'.");
  }
  let storedPlan;
  try {
    storedPlan = runtimeSafetyContext.planStore.consume(planHandle, CAMT_REVIEW_ACKNOWLEDGEMENT_DOMAIN);
  } catch (consumeError) {
    const code = (consumeError as { code?: string }).code ?? "plan_handle_invalid";
    return error(code, "The reviewed acknowledgement plan could not be consumed.");
  }
  const prepared = await prepareCandidate(reviewItem, api);
  if (!prepared.ok) return prepared.result;
  if (canonicalPlanJson(storedPlan.normalizedArgs) !== canonicalPlanJson(prepared.fingerprint as PlanRecord)) {
    return error("plan_drift", "The journal or the review item changed after the acknowledgement was prepared; nothing was recorded. Re-run the statement preview.");
  }
  const record = recordOf(prepared.candidate);
  try {
    camtReviewAcknowledgementStore.upsert([record]);
  } catch (writeError) {
    return error("camt_ack_store_unavailable", `The acknowledgement could not be recorded (${(writeError as Error).message}).`);
  }
  logAudit({
    tool: "continue_accounting_workflow",
    action: "ACKNOWLEDGED",
    entity_type: "camt_journal_review",
    entity_id: record.journal_ids[0],
    summary: `Acknowledged CAMT journal review ${record.review_code} for journal ${record.journal_ids[0]}`,
    details: { accounts_dimensions_id: record.accounts_dimensions_id, movement_identity: record.movement_identity, review_code: record.review_code, journal_ids: record.journal_ids },
  });
  return respond({
    status: "acknowledged",
    acknowledgement: record,
    note: "Recorded. Nothing was booked or changed in e-arveldaja. A re-import of the statement reports this row under acknowledged_review instead of a journal review, until the journal set or the row changes.",
  });
}
