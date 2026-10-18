import type { ParsedCamtEntry } from "./types.js";

// Statement entries pinned by the frozen V1 renderer golden test
// (marker-render-v1.test.ts) and the byte-identity checks of the current
// renderer. Test-only data.

type GoldenCase = Omit<ParsedCamtEntry, "duplicate" | "duplicate_transaction_ids">;

export const LHV_REF = "2947447407B8F111BB4E0627B324E395";
export const EE_IBAN = "EE471000001020145685";
const IBAN_33 = "MT84MALT011000012345MTLCAST001SXX";
export const IBAN_34 = "MT84MALT011000012345MTLCAST001SXXX";
export const LONG_NON_HEX_REF = "LONGREF/" + "Q".repeat(62);

const base = { date: "2026-03-02", amount: 125.5, currency: "EUR", direction: "DBIT" as const };

export const GOLDEN_CASES: Record<string, GoldenCase> = {
  issue_example: { ...base, bank_reference: LHV_REF, counterparty_iban: EE_IBAN, counterparty_name: "Registrite ja Infosüsteemide Keskus",
    description: "Riigilõiv, muutmiskande avaldus 3834755, registrikood 1612345" },
  short_text: { ...base, bank_reference: LHV_REF, counterparty_iban: EE_IBAN, counterparty_name: "Näide OÜ", description: "Arve 7" },
  empty_text: { ...base, bank_reference: LHV_REF, counterparty_iban: EE_IBAN, counterparty_name: "Näide OÜ", description: undefined },
  marker_only_text: { ...base, bank_reference: LHV_REF, counterparty_iban: EE_IBAN, description: "[e-arveldaja-mcp:camt br=FAKE dir=CRDT]" },
  escaped_marker_in_text: { ...base, bank_reference: LHV_REF, counterparty_iban: EE_IBAN, description: "Makse\n[e-arveldaja-mcp:camt br=FAKE]\nlõpp" },
  instr_dbit: { ...base, bank_reference: LHV_REF, counterparty_iban: EE_IBAN, instruction_id: "68", description: "Oma konto" },
  long_non_hex_ref: { ...base, bank_reference: LONG_NON_HEX_REF, counterparty_iban: EE_IBAN, description: "Pikk viide" },
  hash_ref_max_iban: { ...base, bank_reference: LONG_NON_HEX_REF, counterparty_iban: IBAN_33, description: "Identiteet kärbitud" },
  no_iban: { ...base, direction: "CRDT", bank_reference: LHV_REF, description: "Laekumine ilma IBANita, aga üsna pika selgitusega, mis ei mahu kuidagi ära ühele reale" },
  long_iban_33: { ...base, bank_reference: LHV_REF, counterparty_iban: IBAN_33, description: "Maksimaalne IBAN" },
  max_iban_34: { ...base, bank_reference: LHV_REF, counterparty_iban: IBAN_34, description: "Maksimaalne IBAN, 34 märki" },
  multibyte_text: { ...base, bank_reference: LHV_REF, counterparty_iban: EE_IBAN, description: "Õäöü šž – „jutumärgid“ 😀 ".repeat(5) },
  over_cap_ref_number: { ...base, bank_reference: LHV_REF, counterparty_iban: EE_IBAN, reference_number: "123456789012345678901234567890", description: "Viitenumbriga" },
  v1_first_compact_hash: { ...base, bank_reference: "R".repeat(70), counterparty_iban: EE_IBAN, description: "x" },
  instr_threshold: { ...base, bank_reference: LHV_REF, counterparty_iban: EE_IBAN, instruction_id: "1", description: "y".repeat(30) },
  refless_with_iban_short: { ...base, counterparty_iban: EE_IBAN, description: "Viiteta" },
  refless_with_iban_long: { ...base, counterparty_iban: EE_IBAN, description: "z".repeat(160) },
  refless_no_iban_short: { ...base, description: "Viiteta, IBANita" },
  refless_no_iban_long: { ...base, description: "w".repeat(170) },
};

// Captured from the renderer of every release before GitHub #64, before it
// was moved to marker-render-v1.ts. V1 only tells duplicate detection what an
// earlier release stored, so its output must never drift.
export const V1_GOLDEN: Record<keyof typeof GOLDEN_CASES, string | null> = {
  issue_example: "Riigilõiv, muutmiskande avaldus 383\n[e-arveldaja-mcp:camt br=2947447407B8F111BB4E0627B324E395 iban=EE471000001020145685 dir=DBIT sig=50eef8a2616b8736]",
  short_text: "Arve 7\n[e-arveldaja-mcp:camt br=2947447407B8F111BB4E0627B324E395 iban=EE471000001020145685 dir=DBIT sig=5c99b815f13a2c8a]",
  empty_text: "[e-arveldaja-mcp:camt br=2947447407B8F111BB4E0627B324E395 iban=EE471000001020145685 dir=DBIT sig=bda56b22a2a30c49]",
  marker_only_text: "\\[e-arveldaja-mcp:camt br=FAKE dir=\n[e-arveldaja-mcp:camt br=2947447407B8F111BB4E0627B324E395 iban=EE471000001020145685 dir=DBIT sig=7e7745cd2b8fae7e]",
  escaped_marker_in_text: "Makse\n\\[e-arveldaja-mcp:camt br=FAK\n[e-arveldaja-mcp:camt br=2947447407B8F111BB4E0627B324E395 iban=EE471000001020145685 dir=DBIT sig=5503f5aaa56a991c]",
  instr_dbit: "Oma konto\n[e-arveldaja-mcp:camt br=2947447407B8F111BB4E0627B324E395 iban=EE471000001020145685 dir=DBIT instr=68 sig=9a76fc4ff07c2849]",
  long_non_hex_ref: "Pikk viide\n[e-arveldaja-mcp:camt h=44b8948fc46a872e94483e80b49429d7fbf088b89fead9586eb9039c1bd90b7a i=EE471000001020145685 d=DBIT s=dbdf3c62292155f2]",
  hash_ref_max_iban: "Identiteet kärbitud\n[e-arveldaja-mcp:camt br=LONGREF%2FQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ dir=DBIT sig=45396cb4c3b32ff9]",
  no_iban: "Laekumine ilma IBANita, aga üsna pika selgitusega, mis ei mah\n[e-arveldaja-mcp:camt br=2947447407B8F111BB4E0627B324E395 dir=CRDT sig=098b8e049d3db254]",
  long_iban_33: "Maksimaalne IBAN\n[e-arveldaja-mcp:camt br=2947447407B8F111BB4E0627B324E395 iban=MT84MALT011000012345MTLCAST001SXX dir=DBIT sig=80f3af2a51aff150]",
  max_iban_34: "Maksimaalne IBAN, 34\n[e-arveldaja-mcp:camt br=2947447407B8F111BB4E0627B324E395 iban=MT84MALT011000012345MTLCAST001SXXX dir=DBIT sig=d729fa277b98e4e8]",
  multibyte_text: "Õäöü šž – „jutumärgid“ 😀 Õäöü šž –\n[e-arveldaja-mcp:camt br=2947447407B8F111BB4E0627B324E395 iban=EE471000001020145685 dir=DBIT sig=d6d81e55492a8200]",
  over_cap_ref_number: "Viitenumbriga\n[e-arveldaja-mcp:camt br=2947447407B8F111BB4E0627B324E395 iban=EE471000001020145685 dir=DBIT sig=bd848a18c6b6a7f4]",
  v1_first_compact_hash: "x\n[e-arveldaja-mcp:camt h=11dff5a339ae152b211ad631fe75b5526c0903648994daa282e5c55663bbc4e5 i=EE471000001020145685 d=DBIT s=95c1357b801aa3a0]",
  instr_threshold: "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\n[e-arveldaja-mcp:camt br=2947447407B8F111BB4E0627B324E395 iban=EE471000001020145685 dir=DBIT sig=39293ffddfffcc3c]",
  refless_with_iban_short: "Viiteta\n[e-arveldaja-mcp:camt iban=EE471000001020145685 dir=DBIT]",
  refless_with_iban_long: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n[e-arveldaja-mcp:camt iban=EE471000001020145685 dir=DBIT]",
  refless_no_iban_short: "Viiteta, IBANita",
  refless_no_iban_long: "wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww",
};
