import { describe, expect, it } from "vitest";
import { BookingGuard } from "../booking-guard.js";
import type { AccountDimension, BankAccount, Journal, Posting } from "../types/api.js";
import type { CamtSkipInterAccountLegs, ParsedCamtEntry, Transaction } from "./types.js";
import { computeCamtImportProjection } from "./projection.js";
import { summarizeEntries } from "./parser.js";
import { camtNormalizedArgs, interAccountSkipNote } from "./executor.js";
import { renderCamtImportCompact, renderCamtImportPayload, type CamtImportRenderData } from "./presenter.js";

// #11: LHV dim 7 (statement account) and Coop dim 9 are own bank dimensions on 1020.
const LHV = 7;
const COOP = 9;
const COOP_IBAN = "EE382200221020145685";
const bankAccounts = [
  { accounts_dimensions_id: LHV, account_name_est: "LHV", account_no: "EE637700771011212909", iban_code: "EE637700771011212909" },
  { accounts_dimensions_id: COOP, account_name_est: "Coop", account_no: COOP_IBAN, iban_code: COOP_IBAN },
] as BankAccount[];
const accountDimensions = [
  { id: LHV, accounts_id: 1020, title_est: "LHV", is_deleted: false },
  { id: COOP, accounts_id: 1020, title_est: "Coop", is_deleted: false },
] as AccountDimension[];

const DATE = "2026-09-20";
const entry = (o: Partial<ParsedCamtEntry> = {}): ParsedCamtEntry => ({
  date: DATE, amount: 50, currency: "EUR", direction: "DBIT", counterparty_name: "Näidis OÜ", counterparty_iban: COOP_IBAN,
  description: "coopi", bank_reference: "LHV-OUT-50", duplicate: false, duplicate_transaction_ids: [], ...o,
});
const external = entry({ counterparty_iban: "EE471000001020145685", counterparty_name: "Muu Pood OÜ", description: "ost", bank_reference: "LHV-EXT-1", amount: 12 });

const project = (entries: ParsedCamtEntry[], skip?: CamtSkipInterAccountLegs, journals: Journal[] = [], ledger: Transaction[] = []) => computeCamtImportProjection({
  loaded: { entries, summary: summarizeEntries(entries), statement_metadata: { iban: "EE637700771011212909", period: {} } },
  accountsDimensionsId: LHV, dateFrom: undefined, dateTo: undefined, ledgerTransactions: ledger,
  journalCoverage: { journals, accountId: 1020, bankAccounts, accountDimensions,
    interAccountResolver: (snapshot, own) => BookingGuard.fromSnapshot({} as never, snapshot, own) },
  resolveClient: async () => ({}), reportProgress: async () => {},
  ...(skip !== undefined ? { skipInterAccountLegs: skip } : {}),
});

describe("own-account transfer legs in a CAMT import (#11)", () => {
  it("a row to another own bank account's IBAN is tagged; an external payment is not", async () => {
    const projection = await project([entry(), external]);
    expect(projection.descriptors.map(descriptor => descriptor.inter_account_transfer)).toEqual([{ counterparty_dimension_id: COOP }, undefined]);
    const data: CamtImportRenderData = { projection, results: [], createdCount: 2, errorCount: 0, possibleDuplicates: [], workflowArgs: {} };
    expect(renderCamtImportPayload({ ...data, mode: "DRY_RUN" }).summary.inter_account_transfer_count).toBe(1);
    expect(renderCamtImportCompact({ mode: "DRY_RUN", data }).summary.counts).toMatchObject({ inter_account_transfers: 1 });
  });

  it("skip_inter_account_legs outgoing leaves the outgoing own-transfer leg out; incoming legs and external rows stay", async () => {
    const incoming = entry({ direction: "CRDT", bank_reference: "LHV-IN-30", amount: 30, description: "tagasi" });
    const projection = await project([entry(), incoming, external], "outgoing");
    expect(projection.descriptors.map(descriptor => descriptor.entry.bank_reference)).toEqual(["LHV-IN-30", "LHV-EXT-1"]);
    expect(projection.skipped).toEqual([expect.objectContaining({
      bank_reference: "LHV-OUT-50", skip_code: "inter_account_other_side_kept", inter_account_transfer: { counterparty_dimension_id: COOP },
    })]);
    expect(interAccountSkipNote(projection)).toContain("1 own-account transfer leg(s) totalling 50.00 EUR were left out");
  });

  it("skip_inter_account_legs incoming leaves only the incoming legs out", async () => {
    const incoming = entry({ direction: "CRDT", bank_reference: "LHV-IN-30", amount: 30, description: "tagasi" });
    const projection = await project([entry(), incoming], "incoming");
    expect(projection.descriptors.map(descriptor => descriptor.entry.bank_reference)).toEqual(["LHV-OUT-50"]);
    expect(projection.skipped.map(row => row.bank_reference)).toEqual(["LHV-IN-30"]);
  });

  it("default none creates every leg; the argument is bound into the plan only when set", async () => {
    expect((await project([entry()])).descriptors).toHaveLength(1);
    expect(camtNormalizedArgs(LHV, undefined, undefined)).toEqual({ accounts_dimensions_id: LHV });
    expect(camtNormalizedArgs(LHV, undefined, undefined, "none")).toEqual({ accounts_dimensions_id: LHV });
    expect(camtNormalizedArgs(LHV, undefined, undefined, "outgoing")).toEqual({ accounts_dimensions_id: LHV, skip_inter_account_legs: "outgoing" });
  });

  it("after the Coop leg is confirmed, re-importing the LHV leg is covered by that journal (Lane B), not a journal review", async () => {
    const p = (accounts_dimensions_id: number, type: "D" | "C"): Posting =>
      ({ accounts_id: 1020, accounts_dimensions_id, type, amount: 50, base_amount: 50, cl_currencies_id: "EUR", is_deleted: false });
    // The Coop incoming row confirmed against the LHV account: D Coop / C LHV.
    const coopJournal: Journal = { id: 880, effective_date: DATE, registered: true, is_deleted: false, operation_type: "TRANSACTION",
      operations_id: 5501, document_number: null, postings: [p(COOP, "D"), p(LHV, "C")] };
    const projection = await project([entry()], undefined, [coopJournal]);
    expect(projection.descriptors).toHaveLength(0);
    expect(projection.skipped).toEqual([expect.objectContaining({ reason: "Already booked by journal 880", journal_ids: [880] })]);
    expect(projection.skipped[0]!.review_code).toBeUndefined();
  });
});
