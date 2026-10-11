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

  it("an old EUR-stored plain row still covers its foreign leg when the EUR leg is already tagged", () => {
    // The GBP12 leg was stored by the pre-currency-fix release as plain EUR12;
    // the EUR leg is stored under its own leg tag.
    const gbpLeg = splitCard[0]!.replaceAll("USD", "GBP");
    const ledger = [
      { ...oldUsdLeg, cl_currencies_id: "EUR" },
      { ...oldUsdLeg, id: 3, amount: 33.23, cl_currencies_id: "EUR", description: "WISE:CARD_TRANSACTION-9001:EUR Hoster (Software) [source_direction=OUT]" },
      { ...oldFee, description: "WISE:FEE:CARD_TRANSACTION-9001:EUR Wise teenustasu [source_direction=OUT]" },
    ] as Transaction[];
    expect(project(rowsOf([gbpLeg, splitCard[1]!]), ledger).commands).toEqual([]);
  });

  const permutations = <T,>(items: readonly T[]): T[][] => items.length <= 1
    ? [[...items]]
    : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]));
  const leg = (amount: string, currency: string, target = `${amount},${currency}`) =>
    `CARD_TRANSACTION-9001,COMPLETED,OUT,"2026-07-05 10:00:00","2026-07-05 10:00:01",0.10,${currency},,,"Test OÜ",${amount},${currency},"Hoster",${target},1,,,"Test Person","Software",`;
  const stored = (id: number, tag: string, amount: number, currency = "EUR") => ({
    id, status: "PROJECT", accounts_dimensions_id: WISE, type: "C", amount, cl_currencies_id: currency, date: "2026-07-05",
    description: `${tag} Hoster (Software) [source_direction=OUT]`, bank_account_name: "Hoster",
  }) as Transaction;

  // The GBP12 leg and its fee were stored by the pre-currency-fix release as
  // plain EUR rows; the EUR leg and its fee carry their own leg tags.
  const caseA = {
    csv: [leg("12.00", "GBP"), leg("12.00", "EUR", "14.00,USD")],
    ledger: [
      stored(1, "WISE:CARD_TRANSACTION-9001", 12),
      stored(2, "WISE:CARD_TRANSACTION-9001:EUR", 12),
      stored(3, "WISE:FEE:CARD_TRANSACTION-9001", 0.1),
      stored(4, "WISE:FEE:CARD_TRANSACTION-9001:EUR", 0.1),
    ],
  };
  it.each(permutations(caseA.csv).flatMap(csv => permutations(caseA.ledger).map(ledger => [csv, ledger] as const)))(
    "leg-tagged rows claim first: a plain EUR-stored row still covers its foreign leg in any order (%#)",
    (csv, ledger) => {
      const output = project(rowsOf(csv), ledger);
      expect(output.commands).toEqual([]);
      expect(output.ownershipReviews).toEqual([]);
    },
  );

  // Same plain EUR12 row, but USD12 and GBP12 legs both fit it: the stored row
  // cannot say which one is missing.
  const caseB = {
    csv: [leg("12.00", "USD"), leg("12.00", "GBP"), leg("33.23", "EUR", "38.00,USD")],
    ledger: [
      stored(1, "WISE:CARD_TRANSACTION-9001", 12),
      stored(2, "WISE:CARD_TRANSACTION-9001:EUR", 33.23),
      stored(3, "WISE:FEE:CARD_TRANSACTION-9001", 0.1),
      stored(4, "WISE:FEE:CARD_TRANSACTION-9001:EUR", 0.1),
    ],
  };
  it.each(permutations(caseB.csv).flatMap(csv => permutations(caseB.ledger).map(ledger => [csv, ledger] as const)))(
    "a plain legacy row fitting several legs routes the unclaimed legs to review, never a guess (%#)",
    (csv, ledger) => {
      const output = project(rowsOf(csv), ledger);
      expect(output.commands).toEqual([]);
      expect(output.ownershipReviews.map(review => `${review.code}:${review.wise_id}`).sort()).toEqual([
        "wise_legacy_leg_ambiguous:CARD_TRANSACTION-9001:GBP",
        "wise_legacy_leg_ambiguous:CARD_TRANSACTION-9001:USD",
      ]);
    },
  );

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

describe("Wise transfer next to a journal labelled with the counterpart bank reference (F2a)", () => {
  const LHV = 200;
  const BANK_REF = "861769266426F111B46B001DD8D11D14";
  const dims = [
    { id: WISE, accounts_id: 1020, is_deleted: false },
    { id: LHV, accounts_id: 1020, is_deleted: false },
    { id: FEE_DIM, accounts_id: 8610, is_deleted: false },
  ] as AccountDimension[];
  const transferIn = (id: string, date = "2026-03-23", amount = "100.00") =>
    `${id},COMPLETED,IN,"${date} 10:00:00","${date} 10:00:01",0,EUR,,,"Firma OÜ",${amount},EUR,"Firma OÜ",${amount},EUR,1,,,,"Money added",`;
  // The LHV-side bank row, natively confirmed: its journal carries the LHV
  // bank_ref_number as document_number.
  const counterpartTx = {
    id: 5001, status: "CONFIRMED", accounts_dimensions_id: LHV, type: "C", amount: 100, cl_currencies_id: "EUR",
    date: "2026-03-23", description: "SEPPO AI OU", bank_account_name: "Seppo AI OÜ", bank_ref_number: BANK_REF,
  } as Transaction;
  const labelledJournal = (overrides: Record<string, unknown> = {}, wiseType: "D" | "C" = "D", amount = 100) => ({
    id: 701, registered: true, is_deleted: false, effective_date: "2026-03-23",
    operation_type: "TRANSACTION", operations_id: 5001, document_number: BANK_REF,
    postings: [
      { accounts_dimensions_id: LHV, accounts_id: 1020, type: wiseType === "D" ? "C" : "D", amount },
      { accounts_dimensions_id: WISE, accounts_id: 1020, type: wiseType, amount },
    ],
    ...overrides,
  }) as unknown as Journal;
  const run = (
    lines: string[],
    journals: Journal[],
    extra: Partial<Parameters<typeof projectWiseCommands>[0]> = {},
  ) => {
    const rows = rowsOf(lines);
    const decision = { targetDimensionId: LHV, sourceVerified: true, targetVerified: true, ownershipBasis: "verified_endpoints" } as WiseTransferDecision;
    return project(rows, [counterpartTx], {
      accountDimensions: dims,
      transferDecisions: new Map(rows.map(row => [row, decision])),
      postingDimensionsSnapshot: new Map(dims.map(dim => [dim.id!, dim])),
      journalSnapshot: journals,
      createInterAccountGuard: own => BookingGuard.fromSnapshot({} as never, journals, own),
      ...extra,
    });
  };
  const actions = (output: ReturnType<typeof project>) =>
    output.commands.map(command => `${command.action}:${command.wise_id}${command.action === "inter_account" ? `:${command.mutation_mode}:${command.existing_journal_id}` : ""}`);

  it("without a mapping the row is still created, and the review names the candidate journal and its counterpart bank row", () => {
    const output = run([transferIn("TRANSFER-1001")], [labelledJournal()]);
    expect(actions(output)).toEqual(["main_create:TRANSFER-1001"]);
    expect(output.ownershipReviews).toEqual([expect.objectContaining({
      wise_id: "TRANSFER-1001",
      code: "wise_transfer_journal_ambiguous",
      candidate_journal_ids: [701],
      candidates: [{ journal_id: 701, counterpart_transaction_id: 5001, label_source: "counterpart_bank_ref" }],
    })]);
    expect(output.ownershipReviews[0]!.reason).toContain("journalized_transfer_ids");
  });

  it("a BANK:-prefixed label still reads as the counterpart bank reference; an unrelated label does not", () => {
    const prefixed = run([transferIn("TRANSFER-1001")], [labelledJournal({ document_number: `BANK:${BANK_REF}` })]);
    expect(prefixed.ownershipReviews[0]!.candidates).toEqual([
      { journal_id: 701, counterpart_transaction_id: 5001, label_source: "counterpart_bank_ref" },
    ]);
    const other = run([transferIn("TRANSFER-1001")], [labelledJournal({ document_number: "BANK:abc" })]);
    expect(other.ownershipReviews[0]!.candidates).toEqual([
      { journal_id: 701, counterpart_transaction_id: 5001, label_source: "other" },
    ]);
    const manual = run([transferIn("TRANSFER-1001")], [labelledJournal({ operation_type: "JOURNAL", operations_id: undefined, document_number: "X-1" })]);
    expect(manual.ownershipReviews[0]!.candidates).toEqual([{ journal_id: 701, label_source: "other" }]);
  });

  it("a distinct Wise ID with the same key is never absorbed by the labelled journal (Codex counterexample)", () => {
    const output = run([transferIn("TRANSFER-1001"), transferIn("TRANSFER-9999")], [labelledJournal()]);
    expect(actions(output)).toEqual(["main_create:TRANSFER-1001", "main_create:TRANSFER-9999"]);
    expect(output.ownershipReviews.map(review => `${review.wise_id}:${review.code}`)).toEqual([
      "TRANSFER-1001:wise_transfer_journal_ambiguous",
      "TRANSFER-9999:wise_transfer_journal_ambiguous",
    ]);
  });

  const mapped = (...pairs: Array<[string, number]>) => ({
    journalizedTransferIds: pairs.map(([wise_id, journal_id]) => ({ wise_id, journal_id })),
  });
  const reviewCodes = (output: ReturnType<typeof project>) =>
    output.ownershipReviews.map(review => `${review.wise_id}:${review.code}${review.journal_id !== undefined ? `:${review.journal_id}` : ""}`);

  it("an operator mapping records the row as already journalized by that journal, with no create", () => {
    const output = run([transferIn("TRANSFER-1001")], [labelledJournal()], mapped(["TRANSFER-1001", 701]));
    expect(actions(output)).toEqual(["inter_account:TRANSFER-1001:create_only_already_journalized:701"]);
    expect(output.ownershipReviews).toEqual([]);
    expect(output.created).toEqual([]);
  });

  it("the mapped journal still never absorbs a distinct same-key Wise ID", () => {
    const output = run([transferIn("TRANSFER-1001"), transferIn("TRANSFER-9999")], [labelledJournal()], mapped(["TRANSFER-1001", 701]));
    expect(actions(output)).toEqual([
      "main_create:TRANSFER-9999",
      "inter_account:TRANSFER-1001:create_only_already_journalized:701",
    ]);
    expect(reviewCodes(output)).toEqual(["TRANSFER-9999:wise_transfer_journal_ambiguous"]);
  });

  it.each([
    ["the journal moves the money the other way", [labelledJournal({}, "C")]],
    ["the journal amount differs", [labelledJournal({}, "D", 100.01)]],
    ["the journal is more than one day away", [labelledJournal({ effective_date: "2026-03-25" })]],
    ["the journal is not registered", [labelledJournal({ registered: false })]],
    ["the journal is deleted", [labelledJournal({ is_deleted: true })]],
    ["the journal is not in the ledger", []],
    ["the journal does not move money between the two bank accounts", [labelledJournal({
      postings: [
        { accounts_dimensions_id: WISE, accounts_id: 1020, type: "D", amount: 100 },
        { accounts_dimensions_id: FEE_DIM, accounts_id: 8610, type: "C", amount: 100 },
      ],
    })]],
    ["the journal carries no reference (ref-less journals are matched automatically)", [labelledJournal({ document_number: "" })]],
  ] as Array<[string, Journal[]]>)("a mapping is rejected when %s: the row is still created, with a review", (_case, journals) => {
    const output = run([transferIn("TRANSFER-1001")], journals, mapped(["TRANSFER-1001", 701]));
    expect(actions(output)).toEqual(["main_create:TRANSFER-1001"]);
    expect(reviewCodes(output)).toEqual(["TRANSFER-1001:wise_transfer_mapping_rejected:701"]);
  });

  it("two Wise IDs mapped to one journal: both mappings are rejected and both rows created", () => {
    const output = run([transferIn("TRANSFER-1001"), transferIn("TRANSFER-1002")], [labelledJournal()],
      mapped(["TRANSFER-1001", 701], ["TRANSFER-1002", 701]));
    expect(actions(output)).toEqual(["main_create:TRANSFER-1001", "main_create:TRANSFER-1002"]);
    expect(reviewCodes(output)).toEqual([
      "TRANSFER-1001:wise_transfer_mapping_rejected:701",
      "TRANSFER-1002:wise_transfer_mapping_rejected:701",
    ]);
  });

  it("a Wise ID listed twice in the mapping is rejected, even with the same journal", () => {
    const output = run([transferIn("TRANSFER-1001")], [labelledJournal()], mapped(["TRANSFER-1001", 701], ["TRANSFER-1001", 701]));
    expect(actions(output)).toEqual(["main_create:TRANSFER-1001"]);
    expect(reviewCodes(output)).toEqual(["TRANSFER-1001:wise_transfer_mapping_rejected:701"]);
  });

  it("a mapped Wise ID shared by several statement rows is ambiguous: rejected, every row created", () => {
    const output = run([transferIn("TRANSFER-1001"), transferIn("TRANSFER-1001")], [labelledJournal()], mapped(["TRANSFER-1001", 701]));
    expect(output.commands.map(command => command.action)).toEqual(["main_create", "main_create"]);
    expect(output.ownershipReviews.filter(review => review.code === "wise_transfer_mapping_rejected")).toHaveLength(2);
  });

  it("a mapped row that is not an approved own transfer is rejected and created", () => {
    const rows = rowsOf([transferIn("TRANSFER-1001")]);
    const output = project(rows, [counterpartTx], {
      accountDimensions: dims, journalSnapshot: [labelledJournal()], ...mapped(["TRANSFER-1001", 701]),
    });
    expect(output.commands.map(command => command.action)).toEqual(["main_create"]);
    expect(reviewCodes(output)).toEqual(["TRANSFER-1001:wise_transfer_mapping_rejected:701"]);
  });

  it("a mapping for a Wise ID that is not in the statement, or already imported, is reported as unused", () => {
    const absent = run([transferIn("TRANSFER-1001")], [labelledJournal()], mapped(["TRANSFER-5555", 701]));
    expect(actions(absent)).toEqual(["main_create:TRANSFER-1001"]);
    expect(reviewCodes(absent)).toEqual([
      "TRANSFER-1001:wise_transfer_journal_ambiguous",
      "TRANSFER-5555:unused_mapping:701",
    ]);
    const storedRow = {
      id: 9, status: "PROJECT", accounts_dimensions_id: WISE, type: "D", amount: 100, cl_currencies_id: "EUR", date: "2026-03-23",
      description: "WISE:TRANSFER-1001 Firma OÜ [source_direction=IN]",
    } as Transaction;
    const imported = run([transferIn("TRANSFER-1001")], [labelledJournal()], { ...mapped(["TRANSFER-1001", 701]), existingTx: [counterpartTx, storedRow] });
    expect(imported.commands).toEqual([]);
    expect(reviewCodes(imported)).toEqual(["TRANSFER-1001:unused_mapping:701"]);
  });

  // A2: exact-reference claims are reserved across the whole run before any
  // mapping is accepted, whatever the CSV order.
  it.each([["A first", ["TRANSFER-A", "TRANSFER-B"]], ["B first", ["TRANSFER-B", "TRANSFER-A"]]])(
    "a journal labelled with another statement row's Wise ID belongs to that row; the mapping is rejected (%s)",
    (_order, ids) => {
      const journal = labelledJournal({ id: 801, document_number: "TRANSFER-B", operation_type: "JOURNAL", operations_id: undefined });
      const output = run(ids.map(id => transferIn(id)), [journal], mapped(["TRANSFER-A", 801]));
      expect(actions(output).sort()).toEqual([
        "inter_account:TRANSFER-B:create_only_already_journalized:801",
        "main_create:TRANSFER-A",
      ]);
      expect(reviewCodes(output)).toEqual(["TRANSFER-A:wise_transfer_mapping_rejected:801"]);
    },
  );

  it("a row whose own exact-reference journal exists cannot be mapped to a different journal", () => {
    const own = labelledJournal({ id: 802, document_number: "TRANSFER-1001", operation_type: "JOURNAL", operations_id: undefined });
    const output = run([transferIn("TRANSFER-1001")], [labelledJournal(), own], mapped(["TRANSFER-1001", 701]));
    expect(actions(output)).toEqual(["main_create:TRANSFER-1001"]);
    expect(reviewCodes(output)).toEqual(["TRANSFER-1001:wise_transfer_mapping_rejected:701"]);
  });

});

describe("Wise row next to an untagged stored row of the same movement (F2b)", () => {
  const card = (id: string) =>
    `${id},COMPLETED,OUT,"2026-06-25 17:48:24","2026-06-25 17:48:24",0.00,EUR,,,"Seppo AI OÜ",226.80,EUR,Booking.com,226.80,EUR,1,,,"Test Person",Travel,`;
  // Entered by hand on the Wise account, without a WISE: identity tag.
  const manual = (overrides: Record<string, unknown> = {}) => ({
    id: 13875420, status: "CONFIRMED", is_deleted: false, accounts_dimensions_id: WISE, type: "C", amount: 226.8,
    cl_currencies_id: "EUR", date: "2026-06-25", bank_account_name: "ROYAL APARTMENTS OÜ", ref_number: "3970533149",
    description: "WISE kaardimakse — Tartu majutus (Royal Apartments OÜ), Booking.com kaudu",
    ...overrides,
  }) as Transaction;
  const advisories = (output: ReturnType<typeof project>) => output.ownershipReviews
    .filter(review => review.code === "wise_untagged_ledger_match")
    .map(review => `${review.wise_id}:${review.ledger_transaction_ids?.join(",")}`);

  it("creates the row and names the stored untagged row in an advisory", () => {
    const output = project(rowsOf([card("CARD_TRANSACTION-3970533149")]), [manual()]);
    expect(created(output)).toEqual(["main_create:226.8 EUR"]);
    expect(advisories(output)).toEqual(["CARD_TRANSACTION-3970533149:13875420"]);
    expect(output.ownershipReviews[0]).toMatchObject({ approval_required: false });
  });

  it.each([
    ["the stored row is marked as the opposite direction", { description: "Booking.com tagasimakse [source_direction=IN]" }],
    ["the stored row is in another currency", { cl_currencies_id: "USD" }],
    ["the stored row is deleted", { is_deleted: true }],
    ["the stored row is VOID", { status: "VOID" }],
    ["the stored row is on another bank account", { accounts_dimensions_id: 200 }],
    ["the stored row is on another date", { date: "2026-06-26" }],
    ["the stored row differs by more than half a cent", { amount: 226.81 }],
    ["the stored row carries a WISE: identity of another movement", { description: "WISE:CARD_TRANSACTION-1 Booking.com [source_direction=OUT]" }],
  ])("no advisory when %s", (_case, overrides) => {
    const output = project(rowsOf([card("CARD_TRANSACTION-3970533149")]), [manual(overrides)]);
    expect(created(output)).toEqual(["main_create:226.8 EUR"]);
    expect(advisories(output)).toEqual([]);
  });

  it("an agreeing direction marker still matches", () => {
    const output = project(rowsOf([card("CARD_TRANSACTION-3970533149")]), [manual({ description: "Booking.com käsitsi [source_direction=OUT]" })]);
    expect(advisories(output)).toEqual(["CARD_TRANSACTION-3970533149:13875420"]);
  });

  it("an untagged row matching date, currency, counterparty and narrative is advisory too, never a silent skip (Codex r2)", () => {
    const lookalike = manual({ id: 77, bank_account_name: "Booking.com", ref_number: null, description: "Booking.com (Travel)" });
    const output = project(rowsOf([card("CARD_TRANSACTION-NEW")]), [lookalike]);
    expect(created(output)).toEqual(["main_create:226.8 EUR"]);
    expect(advisories(output)).toEqual(["CARD_TRANSACTION-NEW:77"]);
  });

  it("an untagged stored fee lookalike does not hide the row's fee; the fee gets the advisory", () => {
    const feeCard = `CARD_TRANSACTION-NEW,COMPLETED,OUT,"2026-06-25 17:48:24","2026-06-25 17:48:24",1.20,EUR,,,"Seppo AI OÜ",226.80,EUR,Booking.com,226.80,EUR,1,,,"Test Person",Travel,`;
    const storedFee = manual({ id: 78, amount: 1.2, bank_account_name: "Wise", ref_number: null, description: "Wise teenustasu [source_direction=OUT]" });
    const output = project(rowsOf([feeCard]), [storedFee]);
    expect(created(output)).toEqual(["main_create:226.8 EUR", "fee_create_and_confirm:1.2 EUR"]);
    expect(advisories(output)).toEqual(["FEE:CARD_TRANSACTION-NEW:78"]);
  });

  it("a genuinely new same-key payment is still created: both rows carry the advisory, nothing is claimed", () => {
    const output = project(rowsOf([card("CARD_TRANSACTION-1"), card("CARD_TRANSACTION-2")]), [manual()]);
    expect(created(output)).toEqual(["main_create:226.8 EUR", "main_create:226.8 EUR"]);
    expect(advisories(output)).toEqual(["CARD_TRANSACTION-1:13875420", "CARD_TRANSACTION-2:13875420"]);
  });
});
