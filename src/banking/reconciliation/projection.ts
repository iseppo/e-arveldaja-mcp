import {
  canonicalPlanJson,
  reconClientUpdateCommandId,
  reconInvoiceConfirmCommandId,
  reconTransferConfirmCommandId,
  reconDeleteDuplicateCommandId,
  RECON_UPDATE_CLIENT_CATEGORY,
  RECON_CONFIRM_TRANSFER_CATEGORY,
  RECON_DELETE_DUPLICATE_CATEGORY,
} from "../../tools/bank-reconciliation-plan.js";
import type {
  ExactMatchProjection,
  InterAccountConfirmAction,
  AmbiguousPairResult,
  AmbiguousReflessRow,
  CrossCurrencyRow,
  SkippedAlreadyHandledRow,
} from "./types.js";

// ---------------------------------------------------------------------------
// Byte-stable plan/approval digests + command identity/fingerprint. PURE: this
// module NEVER sandboxes (wrapUntrustedOcr stays in the presenter). The digest
// version, plan-domain constant, and digest inputs are preserved EXACTLY.
// ---------------------------------------------------------------------------

export function exactMatchFingerprint(projection: ExactMatchProjection, threshold: number): string {
  return canonicalPlanJson({
    kind: "exact_match_confirm",
    min_confidence: threshold,
    commands: projection.confirms.flatMap(descriptor => [
      ...(descriptor.needsClientUpdate
        ? [{
            id: reconClientUpdateCommandId(descriptor.transactionId),
            transaction_id: descriptor.transactionId,
            set_clients_id: descriptor.invoiceClientsId,
          }]
        : []),
      {
        id: reconInvoiceConfirmCommandId(descriptor.transactionId),
        transaction_id: descriptor.transactionId,
        table: descriptor.invoiceTable,
        invoice_id: descriptor.invoiceId,
        amount: descriptor.amount,
        currency: descriptor.currency,
        expected_clients_id: descriptor.clientsId,
      },
    ]),
    skipped: projection.skipped.map(row => ({ transaction_id: row.transaction_id, reason: row.reason })),
  });
}

/** Command projections shared by the inter-account fingerprint, plan-review
 * commands, and the executor's frozen command build. Category-tagged; the
 * fingerprint strips the category (see interAccountFingerprint). */
export interface InterAccountPlanCommandProjection {
  readonly id: string;
  readonly category: string;
  readonly transaction_id: number;
  readonly set_clients_id?: number;
  readonly target_dimension_id?: number;
  readonly amount?: number;
  readonly currency?: string;
}

export function buildInterAccountPlanCommandProjections(
  confirmActions: readonly InterAccountConfirmAction[],
  companyClientsId: number | null,
): InterAccountPlanCommandProjection[] {
  return confirmActions.flatMap(action => {
    const needsClientUpdate = action.confirmedClientsId == null && companyClientsId != null;
    return [
      ...(needsClientUpdate
        ? [{ id: reconClientUpdateCommandId(action.confirmedTxId), category: RECON_UPDATE_CLIENT_CATEGORY, transaction_id: action.confirmedTxId, set_clients_id: companyClientsId }]
        : []),
      { id: reconTransferConfirmCommandId(action.confirmedTxId), category: RECON_CONFIRM_TRANSFER_CATEGORY, transaction_id: action.confirmedTxId, target_dimension_id: action.targetDimensionId, amount: action.distributionAmount, currency: action.confirmedCurrency },
      ...(action.deleteTxId !== undefined
        ? [{ id: reconDeleteDuplicateCommandId(action.deleteTxId), category: RECON_DELETE_DUPLICATE_CATEGORY, transaction_id: action.deleteTxId }]
        : []),
    ];
  });
}

export function interAccountFingerprint(input: {
  normalizedArgs: Record<string, unknown>;
  planCommandProjections: readonly InterAccountPlanCommandProjection[];
  skippedAlreadyHandled: readonly SkippedAlreadyHandledRow[];
  ambiguousPairs: readonly AmbiguousPairResult[];
  ambiguousRefless: readonly AmbiguousReflessRow[];
  crossCurrencyPairs: readonly CrossCurrencyRow[];
}): string {
  return canonicalPlanJson({
    kind: "inter_account",
    normalized_args: input.normalizedArgs,
    commands: input.planCommandProjections.map(command => ({ ...command, category: undefined })),
    already_handled: input.skippedAlreadyHandled.map(row => ({ transaction_id: row.transaction_id, journal: row.existing_journal_id })),
    ambiguous_pairs: input.ambiguousPairs.map(row => ({ outgoing: row.outgoing_transaction_id, candidates: row.candidate_incoming_transaction_ids })),
    ambiguous_refless: input.ambiguousRefless.map(row => ({ transaction_ids: row.transaction_ids })),
    cross_currency: input.crossCurrencyPairs.map(row => ({ transaction_ids: row.transaction_ids })),
  });
}
