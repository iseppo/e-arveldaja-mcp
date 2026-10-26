import { describe, expect, it } from "vitest";
import { GOLDEN_CASES, EE_IBAN, IBAN_34, LHV_REF, LONG_NON_HEX_REF } from "../__fixtures__/camt-marker-golden.js";
import { buildCamtDescriptionWithMetadataV1 } from "./marker-render-v1.js";
import {
  buildCamtDescriptionWithMetadata, extractCamtDescriptionMetadata, isTrustedCamtDescriptionMetadata,
  isCamtCounterpartyIbanOmitted, renderCamtDescriptionDetailed, stripCamtDescriptionMetadata,
  buildDuplicateLookup, findDuplicateTransactionIds, findLossyIdentityConflicts, findPoisonedMarkerHolds,
  findRepeatedBankReferences, buildBatchDuplicateKey,
} from "./duplicate-identity.js";
import { camtIbanOmissionEvidence, isCamtIbanOmissionEligible } from "./iban-omission.js";
import { computeCamtImportProjection } from "./projection.js";
import type { ParsedCamtEntry, Transaction, CamtParseResult } from "./types.js";
import type { BankAccount } from "../types/api.js";

const DIM = 55;
const OWN = "EE637700771011212909";
const entry = (overrides: Partial<ParsedCamtEntry> = {}): ParsedCamtEntry => ({
  ...GOLDEN_CASES.issue_example!, duplicate: false, duplicate_transaction_ids: [], ...overrides,
});
const stored = (e: ParsedCamtEntry, description: string | undefined, id = 1): Transaction => ({
  id, status: "PROJECT", accounts_dimensions_id: DIM, type: "C", amount: e.amount, date: e.date,
  cl_currencies_id: e.currency, bank_ref_number: null, bank_account_no: null,
  bank_account_name: e.counterparty_name ?? null, ref_number: e.reference_number ?? null, description,
} as Transaction);
const bank = (iban_code: string | null, account_no: string | null = iban_code) => ({ iban_code, account_no }) as BankAccount;
async function project(entries: ParsedCamtEntry[], ledger: Transaction[], banks: BankAccount[] = [bank(OWN)]) {
  return computeCamtImportProjection({
    loaded: { entries, statement_metadata: { iban: OWN }, summary: {} } as CamtParseResult,
    accountsDimensionsId: DIM, dateFrom: undefined, dateTo: undefined, ledgerTransactions: ledger,
    journalCoverage: { journals: [], accountId: 1020, bankAccounts: banks, accountDimensions: [],
      interAccountResolver: () => ({ resolveInterAccount: () => ({ status: "none" }), hasOtherLabelledInterAccount: () => false }) },
    resolveClient: async () => ({}), reportProgress: async () => {},
  });
}

describe("CAMT marker selection and signed identity", () => {
  it.each(Object.keys(GOLDEN_CASES))("keeps every full, verifiable V1 form byte-identical: %s", name => {
    const e = entry(GOLDEN_CASES[name]);
    const v1 = buildCamtDescriptionWithMetadataV1(e.description, e);
    const metadata = extractCamtDescriptionMetadata(v1);
    if (!e.bank_reference || (stripCamtDescriptionMetadata(v1) === e.description &&
      metadata.bank_account_no === e.counterparty_iban && isTrustedCamtDescriptionMetadata(stored(e, v1)))) {
      expect(buildCamtDescriptionWithMetadata(e.description, e, { omitCounterpartyIban: true })).toBe(v1);
    }
  });

  it.each([[40, "br=", "i="], [50, "b=", "i="], [60, "b=", "x=i"]] as const)(
    "selects a full-text form for %i characters", (length, referenceField, ibanField) => {
      const e = entry({ description: "a".repeat(length) });
      const result = renderCamtDescriptionDetailed(e.description, e, { omitCounterpartyIban: true });
      expect(stripCamtDescriptionMetadata(result.description)).toBe(e.description);
      expect(result.description).toContain(` ${referenceField}`);
      expect(result.description).toContain(` ${ibanField}`);
      expect(isTrustedCamtDescriptionMetadata(stored(e, result.description))).toBe(true);
      expect(result.description!.length).toBeLessThanOrEqual(150);
    });

  it("reports truncation, keeps complete identity, and rejects unsigned omission tampering", () => {
    const e = entry({ description: "a".repeat(100) });
    const result = renderCamtDescriptionDetailed(e.description, e, { omitCounterpartyIban: true });
    expect(result.truncated).toEqual({ stored_length: 53, full_length: 100 });
    expect(result.ibanOmitted).toBeUndefined();
    expect(extractCamtDescriptionMetadata(result.description).bank_account_no).toBe(EE_IBAN);
    expect(isTrustedCamtDescriptionMetadata(stored(e, result.description))).toBe(true);
    const c3 = entry({ description: "a".repeat(60) });
    const description = buildCamtDescriptionWithMetadata(c3.description, c3, { omitCounterpartyIban: true })!;
    expect(isCamtCounterpartyIbanOmitted(stored(c3, description))).toBe(true);
    expect(isTrustedCamtDescriptionMetadata(stored(c3, description.replace(" x=i", "")))).toBe(false);
  });

  it("holds an unfit full identity and only allows full-text C3 at the hash boundary", () => {
    for (const length of [30, 31]) {
      const e = entry({ bank_reference: LONG_NON_HEX_REF, counterparty_iban: IBAN_34, description: "a".repeat(length) });
      expect(renderCamtDescriptionDetailed(e.description, e).held).toBe(true);
      const c3 = renderCamtDescriptionDetailed(e.description, e, { omitCounterpartyIban: true });
      expect(c3.held).toBe(length === 31 ? true : undefined);
      if (length === 30) expect(isTrustedCamtDescriptionMetadata(stored(e, c3.description))).toBe(true);
    }
  });

  it("roundtrips bounded signed identity across references, identifiers and text lengths", () => {
    for (const ref of [LHV_REF, LHV_REF.toLowerCase(), "R".repeat(70), undefined]) {
      for (const iban of [EE_IBAN, IBAN_34, "õ".repeat(34), undefined]) {
        for (const length of [0, 1, 35, 40, 53, 60, 100, 170]) {
          const e = entry({ bank_reference: ref, counterparty_iban: iban, description: "õ".repeat(length) || undefined });
          const result = renderCamtDescriptionDetailed(e.description, e, { omitCounterpartyIban: true });
          if (!ref) {
            // Exactly V1, except that an unmarked (ref-less, IBAN-less) text is capped like a marked row's.
            const v1 = buildCamtDescriptionWithMetadataV1(e.description, e);
            expect(result.description).toBe(iban || length <= 150 ? v1 : v1!.slice(0, 150).trimEnd());
            expect(result.description?.length ?? 0).toBeLessThanOrEqual(150);
            continue;
          }
          if (result.held) continue;
          expect(result.description!.length).toBeLessThanOrEqual(150);
          expect(isTrustedCamtDescriptionMetadata(stored(e, result.description))).toBe(true);
          const meta = extractCamtDescriptionMetadata(result.description);
          if (!meta.iban_omitted) expect(meta.bank_account_no).toBe(iban);
        }
      }
    }
  });

  it.each(["br=OTHER", "b=bad", "x=bad", `h=${"0".repeat(64)}`])("poisons contradictory identity %s before direct bank reference", extra => {
    const e = entry({ description: "a" });
    const description = buildCamtDescriptionWithMetadata(e.description, e)!.replace(/\]$/, ` ${extra}]`);
    const row = { ...stored(e, description), bank_ref_number: e.bank_reference } as Transaction;
    expect(extractCamtDescriptionMetadata(description).poisoned).toBe(true);
    expect(isTrustedCamtDescriptionMetadata(row)).toBe(false);
    const lookup = buildDuplicateLookup([row], DIM);
    expect(findDuplicateTransactionIds(e, lookup, new Set(), DIM)).toEqual([]);
    expect(findPoisonedMarkerHolds(e, lookup)).toEqual([row]);
  });

  it.each(["i", "iban", "bank_account_no"])("poisons x=i beside every IBAN alias: %s", alias => {
    const e = entry({ description: "a".repeat(60) });
    for (const value of ["X", "", "%ZZ"]) {
      const description = buildCamtDescriptionWithMetadata(e.description, e, { omitCounterpartyIban: true })!.replace(/\]$/, ` ${alias}=${value}]`);
      expect(extractCamtDescriptionMetadata(description).poisoned).toBe(true);
    }
  });
});

describe("C3 requires positive ownership evidence", () => {
  it("uses both identifier fields, all dimensions, statement IBAN and BBAN suffixes", () => {
    const evidence = camtIbanOmissionEvidence([bank("", OWN), bank(EE_IBAN, "12345678901")], "DE89370400440532013000");
    expect(evidence.kind).toBe("complete");
    for (const own of [OWN, EE_IBAN, "DE89370400440532013000", "EE0012345678901"]) {
      expect(isCamtIbanOmissionEligible(evidence, own)).toBe(false);
    }
    expect(isCamtIbanOmissionEligible(evidence, "GB82WEST12345698765432")).toBe(true);
  });
  it.each([undefined, [], [bank(null, null)], [bank(OWN), bank(null, "local")]])("fails closed with incomplete evidence %j", banks => {
    const evidence = camtIbanOmissionEvidence(banks, OWN);
    expect(evidence.kind).toBe("unknown");
    expect(isCamtIbanOmissionEligible(evidence, EE_IBAN)).toBe(false);
  });
  it("recognises a historical C3 row even when the IBAN becomes own or evidence is unknown", async () => {
    const e = entry({ description: "a".repeat(60) });
    const row = stored(e, buildCamtDescriptionWithMetadata(e.description, e, { omitCounterpartyIban: true }));
    for (const banks of [[bank(EE_IBAN)], [bank(null, null)]]) {
      const result = await project([e], [row], banks);
      expect(result.descriptors).toHaveLength(0);
      expect(result.skipped[0]!.duplicate_transaction_ids).toEqual([1]);
    }
  });
});

describe("projection holds ambiguous or poisoned stored identities", () => {
  it.each([false, true])("holds poisoned C3 with direct reference=%s", async direct => {
    const e = entry({ description: "a".repeat(60) });
    const description = buildCamtDescriptionWithMetadata(e.description, e, { omitCounterpartyIban: true })!.replace(/\]$/, " bank_account_no=X]");
    const row = stored(e, description);
    if (direct) row.bank_ref_number = e.bank_reference!;
    const result = await project([e], [row]);
    expect(result.descriptors).toHaveLength(0);
    expect(result.skipped[0]!.skip_code).toBe("camt_marker_conflict_review");
  });

  it.each([false, true])("holds competing C3 claims in either order: reverse=%s", async reverse => {
    const a = entry({ description: "a".repeat(60) });
    const b = entry({ description: a.description, counterparty_iban: "GB82WEST12345698765432" });
    const row = stored(a, buildCamtDescriptionWithMetadata(a.description, a, { omitCounterpartyIban: true }));
    const result = await project(reverse ? [b, a] : [a, b], [row]);
    expect(result.descriptors).toHaveLength(0);
    expect(result.skipped.map(s => s.skip_code)).toEqual(["camt_lossy_identity_ambiguous", "camt_lossy_identity_ambiguous"]);
    const lookup = buildDuplicateLookup([row, { ...row, id: 2 }], DIM);
    expect(findLossyIdentityConflicts([a], lookup, DIM).has(buildBatchDuplicateKey(a))).toBe(true);
  });

  it.each([false, true])("holds competing V1 truncated claims in either order: reverse=%s", async reverse => {
    const a = entry({ description: "a".repeat(35) + "A" });
    const b = entry({ description: "a".repeat(35) + "B" });
    for (const imported of [a, b]) {
      const row = stored(imported, buildCamtDescriptionWithMetadataV1(imported.description, imported));
      const result = await project(reverse ? [b, a] : [a, b], [row]);
      expect(result.descriptors).toHaveLength(0);
      expect(result.skipped.every(s => s.skip_code === "camt_lossy_identity_ambiguous")).toBe(true);
    }
  });
});
