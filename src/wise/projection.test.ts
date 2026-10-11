import { describe, it, expect } from "vitest";
import { preflightWiseCsv } from "./preflight.js";
import { projectWiseCommands } from "./projection.js";
import { BookingGuard } from "../booking-guard.js";
import type { AccountDimension, Journal, Transaction } from "../types/api.js";
import type { WiseRow, WiseTransferDecision } from "./types.js";

const HEADER = `ID,Status,Direction,"Created on","Finished on","Source fee amount","Source fee currency","Target fee amount","Target fee currency","Source name","Source amount (after fees)","Source currency","Target name","Target amount (after fees)","Target currency","Exchange rate",Reference,Batch,"Created by",Category,Note`;
const WISE = 100;
const FEE_DIM = 900;
const accountDimensions = [{ id: FEE_DIM, accounts_id: 8610, is_deleted: false }] as AccountDimension[];

function rowsOf(lines: string[]): WiseRow[] {
  const preflight = preflightWiseCsv(`${HEADER}\n${lines.join("\n")}\n`);
  if (!preflight.ok) throw new Error(JSON.stringify(preflight.rejected_fields));
  return preflight.rows;
}

function project(eligible: WiseRow[], existingTx: Transaction[], extra: Partial<Parameters<typeof projectWiseCommands>[0]> = {}) {
  return projectWiseCommands({
    eligible, accountsDimensionsId: WISE, accountDimensions, feeAccountDimensionsId: FEE_DIM, wiseClientId: 7,
    existingTx, transferDecisions: new Map(), postingDimensionsSnapshot: new Map(), journalSnapshot: [],
    createInterAccountGuard: () => { throw new Error("no guard expected"); },
    approvedTransferIds: new Set(), ownCompanyClientId: undefined, ownCompanyClientMatches: [], allPurchaseInvoices: [],
    ...extra,
  });
}

/** Stored ledger rows for the create commands, exactly as the payloads are written. */
function ledgerOf(commands: ReturnType<typeof project>["commands"], firstId = 1): Transaction[] {
  return commands.flatMap((command, index) => command.action === "inter_account" ? [] : [{
    id: firstId + index, status: "PROJECT", ...command.create_payload,
  } as Transaction]);
}

const created = (output: ReturnType<typeof project>) =>
  output.commands.map(command => `${command.action}:${command.booked_amount} ${command.booked_currency}`);

// A card payment of 50 USD funded from two balances: Wise exports it as two rows
// with the SAME ID — the USD balance leg first, then the converted EUR leg that
// carries the conversion fee.
const splitCard = [
  `CARD_TRANSACTION-9001,COMPLETED,OUT,"2026-07-05 10:00:00","2026-07-05 10:00:01",0.00,USD,,,"Test OÜ",12.00,USD,"Hoster",12.00,USD,1.0000000000000000,,,"Test Person","Software",`,
  `CARD_TRANSACTION-9001,COMPLETED,OUT,"2026-07-05 10:00:00","2026-07-05 10:00:01",0.16,EUR,,,"Test OÜ",33.23,EUR,"Hoster",38.00,USD,1.1437000000000000,,,"Test Person","Software",`,
];

describe("Wise card payment split across two balances (same ID)", () => {
  it("fresh import books both legs and the fee once", () => {
    const output = project(rowsOf(splitCard), []);
    expect(created(output)).toEqual([
      "main_create:12 USD",
      "main_create:33.23 EUR",
      "fee_create_and_confirm:0.16 EUR",
    ]);
    // The fee belongs to the EUR leg.
    expect(output.commands[2]!.depends_on).toBe(output.commands[1]!.row_key);
  });

  it("re-import against its own ledger creates nothing", () => {
    const rows = rowsOf(splitCard);
    const fresh = project(rows, []);
    expect(project(rows, ledgerOf(fresh.commands)).commands).toEqual([]);
  });

  it("re-import against the previous release's ledger books only the missing leg", () => {
    // The previous release booked the first leg as WISE:{id}, skipped the
    // second as "Already imported (Wise ID match)" and still booked the second
    // leg's fee as WISE:FEE:{id}.
    const oldLedger = [
      { id: 1, status: "PROJECT", accounts_dimensions_id: WISE, type: "C", amount: 12, cl_currencies_id: "USD", date: "2026-07-05",
        description: "WISE:CARD_TRANSACTION-9001 Hoster (Software) [source_direction=OUT]", bank_account_name: "Hoster" },
      { id: 2, status: "CONFIRMED", accounts_dimensions_id: WISE, type: "C", amount: 0.16, cl_currencies_id: "EUR", date: "2026-07-05",
        description: "WISE:FEE:CARD_TRANSACTION-9001 Wise teenustasu [source_direction=OUT]", bank_account_name: "Wise" },
    ] as Transaction[];
    const rows = rowsOf(splitCard);
    const output = project(rows, oldLedger);
    expect(created(output)).toEqual(["main_create:33.23 EUR"]);
    // And the upgraded ledger is then complete.
    expect(project(rows, [...oldLedger, ...ledgerOf(output.commands, 10)]).commands).toEqual([]);
  });

  it("keeps the leg identity stable when the export lists the legs in the other order", () => {
    const fresh = project(rowsOf(splitCard), []);
    expect(project(rowsOf([...splitCard].reverse()), ledgerOf(fresh.commands)).commands).toEqual([]);
  });

  it("an export holding only one leg of an already-imported split creates nothing", () => {
    const fresh = project(rowsOf(splitCard), []);
    const ledger = ledgerOf(fresh.commands);
    expect(project(rowsOf([splitCard[1]!]), ledger).commands).toEqual([]);
    expect(project(rowsOf([splitCard[0]!]), ledger).commands).toEqual([]);
    expect(project(rowsOf(splitCard), ledger).commands).toEqual([]);
  });

  const oldUsdLeg = {
    id: 1, status: "PROJECT", accounts_dimensions_id: WISE, type: "C", amount: 12, cl_currencies_id: "USD", date: "2026-07-05",
    description: "WISE:CARD_TRANSACTION-9001 Hoster (Software) [source_direction=OUT]", bank_account_name: "Hoster",
  } as Transaction;
  const oldFee = {
    id: 2, status: "CONFIRMED", accounts_dimensions_id: WISE, type: "C", amount: 0.16, cl_currencies_id: "EUR", date: "2026-07-05",
    description: "WISE:FEE:CARD_TRANSACTION-9001 Wise teenustasu [source_direction=OUT]", bank_account_name: "Wise",
  } as Transaction;

  it("an old plain-ID row of the other leg does not hide a missing leg in a one-leg export", () => {
    const output = project(rowsOf([splitCard[1]!]), [oldUsdLeg]);
    expect(created(output)).toEqual(["main_create:33.23 EUR", "fee_create_and_confirm:0.16 EUR"]);
    // A leg of a split ID is tagged by currency even when the export holds it alone.
    expect(output.commands.map(command => command.create_payload?.description?.split(" ")[0])).toEqual([
      "WISE:CARD_TRANSACTION-9001:EUR",
      "WISE:FEE:CARD_TRANSACTION-9001:EUR",
    ]);
    const withFee = project(rowsOf([splitCard[1]!]), [oldUsdLeg, oldFee]);
    expect(created(withFee)).toEqual(["main_create:33.23 EUR"]);
    // The upgraded ledger is complete for the full export and for each one-leg export.
    const upgraded = [oldUsdLeg, oldFee, ...ledgerOf(withFee.commands, 10)];
    expect(project(rowsOf(splitCard), upgraded).commands).toEqual([]);
    expect(project(rowsOf([splitCard[0]!]), upgraded).commands).toEqual([]);
    expect(project(rowsOf([splitCard[1]!]), upgraded).commands).toEqual([]);
  });

  it("an old plain-ID row of another explicit currency does not hide an equal-amount missing leg", () => {
    // The stored plain row is the USD12 leg; the EUR leg of the same nominal
    // amount is genuinely missing.
    const eurLeg = `CARD_TRANSACTION-9001,COMPLETED,OUT,"2026-07-05 10:00:00","2026-07-05 10:00:01",0.10,EUR,,,"Test OÜ",12.00,EUR,"Hoster",14.00,USD,1.1666666666666667,,,"Test Person","Software",`;
    expect(created(project(rowsOf([eurLeg]), [oldUsdLeg]))).toEqual(["main_create:12 EUR", "fee_create_and_confirm:0.1 EUR"]);
    expect(created(project(rowsOf([splitCard[0]!, eurLeg]), [oldUsdLeg]))).toEqual(["main_create:12 EUR", "fee_create_and_confirm:0.1 EUR"]);
  });

  it("an old plain-ID row still covers its own single-row transaction", () => {
    // Pre-currency-fix rows were stored as EUR at the nominal amount; incoming
    // rows are now booked gross. Either a currency or an amount match is the
    // same transaction.
    const usdAsEur = { ...oldUsdLeg, cl_currencies_id: "EUR" } as Transaction;
    expect(project(rowsOf([splitCard[0]!]), [usdAsEur]).commands).toEqual([]);
    const otherAmount = { ...oldUsdLeg, amount: 11.5 } as Transaction;
    expect(project(rowsOf([splitCard[0]!]), [otherAmount]).commands).toEqual([]);
  });
});

describe("Wise inter-account row matched to a journal that already books its fee", () => {
  const LHV = 200;
  const transfer = `TRANSFER-1,COMPLETED,IN,"2026-02-04 10:00:00","2026-02-04 10:00:01",0,EUR,0.50,EUR,"Firma OÜ",100.00,EUR,"Firma OÜ",99.50,EUR,1,,,,"Money added",`;
  const dims = [
    { id: WISE, accounts_id: 1020, is_deleted: false },
    { id: LHV, accounts_id: 1020, is_deleted: false },
    { id: FEE_DIM, accounts_id: 8610, is_deleted: false },
  ] as AccountDimension[];
  const run = (journals: Journal[], existingTx: Transaction[] = []) => {
    const rows = rowsOf([transfer]);
    const decision = { targetDimensionId: LHV, sourceVerified: true, targetVerified: true, ownershipBasis: "verified_endpoints" } as unknown as WiseTransferDecision;
    return project(rows, existingTx, {
      accountDimensions: dims,
      transferDecisions: new Map([[rows[0]!, decision]]),
      postingDimensionsSnapshot: new Map(dims.map(dim => [dim.id!, dim])),
      journalSnapshot: journals,
      createInterAccountGuard: own => BookingGuard.fromSnapshot({} as never, journals, own),
    });
  };
  const journal = (id: number, postings: Array<[number, "D" | "C", number, number?]>) => ({
    id, registered: true, is_deleted: false, effective_date: "2026-02-04", document_number: "",
    postings: postings.map(([dim, type, amount, accountsId]) => ({ accounts_dimensions_id: dim, accounts_id: accountsId ?? 1020, type, amount })),
  }) as unknown as Journal;

  it("drops the fee row too when the journal carries the fee leg", () => {
    const output = run([journal(8, [[LHV, "C", 100], [WISE, "D", 99.5], [FEE_DIM, "D", 0.5, 8610]])]);
    expect(output.commands.map(command => command.action)).toEqual(["inter_account"]);
    expect(output.skipped.map(entry => entry.wise_id)).toEqual(["TRANSFER-1", "FEE:TRANSFER-1"]);
  });

  it("still recognises the net-of-fee journal when the fee row is already stored", () => {
    // An interrupted earlier import stored the fee row, so no fee command survives.
    const storedFee = {
      id: 3, status: "PROJECT", accounts_dimensions_id: WISE, type: "C", amount: 0.5, cl_currencies_id: "EUR", date: "2026-02-04",
      description: "WISE:FEE:TRANSFER-1 Wise teenustasu [source_direction=OUT]", bank_account_name: "Wise",
    } as Transaction;
    const output = run([journal(8, [[LHV, "C", 100], [WISE, "D", 99.5], [FEE_DIM, "D", 0.5, 8610]])], [storedFee]);
    expect(output.commands).toEqual([expect.objectContaining({ action: "inter_account", existing_journal_id: 8 })]);
  });

  it("compares the journal in base EUR, like the guard that matched it", () => {
    // A registered USD journal: nominal amounts in USD, base amounts in EUR.
    const usdJournal = {
      id: 9, registered: true, is_deleted: false, effective_date: "2026-02-04", document_number: "",
      postings: [
        { accounts_dimensions_id: LHV, accounts_id: 1020, type: "C", amount: 110, base_amount: 100 },
        { accounts_dimensions_id: WISE, accounts_id: 1020, type: "D", amount: 109.45, base_amount: 99.5 },
        { accounts_dimensions_id: FEE_DIM, accounts_id: 8610, type: "D", amount: 0.55, base_amount: 0.5 },
      ],
    } as unknown as Journal;
    const output = run([usdJournal]);
    expect(output.commands.map(command => command.action)).toEqual(["inter_account"]);
    expect(output.skipped.map(entry => entry.wise_id)).toEqual(["TRANSFER-1", "FEE:TRANSFER-1"]);
  });

  it("still books the fee when the journal moved the gross amount only", () => {
    const output = run([journal(7, [[LHV, "C", 100], [WISE, "D", 100]])]);
    expect(output.commands.map(command => command.action)).toEqual(["fee_create_and_confirm", "inter_account"]);
  });
});
