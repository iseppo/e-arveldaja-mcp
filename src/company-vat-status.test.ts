import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  COMPANY_VAT_STATUS_LOOKUP_AMBIGUOUS,
  COMPANY_VAT_STATUS_LOOKUP_UNAVAILABLE,
  COMPANY_VAT_STATUS_UNKNOWN,
  CompanyVatStatusUnknownError,
  LIMITED_VAT_STORE_FILE,
  companyVatStatusFromInfo,
  isCompanyVatRegistered,
  limitedVatStore,
  readLimitedVatRecords,
  requireKnownCompanyVatStatus,
  resolveCompanyVatStatus,
  type CompanyVatLookupRecord,
  type CompanyVatStatusRecord,
  type LimitedVatStoreRecord,
} from "./company-vat-status.js";
import { EMTA_KMKR_QUERY_URL, resetEmtaKmkrCache } from "./emta-kmkr.js";
import { resolveBundleStorePath } from "./accounting-rules.js";
import { EMTA_HEADER_ROW, FULL_ROW, LIMITED_ROW, emtaAnswerHtml, emtaRow, fakeEmtaFetch } from "./__fixtures__/emta-kmkr.js";

const LIMITED_NUMBER = "EE103050067";
const FULL_NUMBER = "EE102809963";
const DAY = 86_400_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "company-vat-status-"));
  process.env.EARVELDAJA_RULES_DIR = join(dir, "rules");
  process.env.EARVELDAJA_LOCK_DIR = join(dir, "locks");
  limitedVatStore.reset();
  resetEmtaKmkrCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.EARVELDAJA_RULES_DIR;
  delete process.env.EARVELDAJA_RULES_FILE;
  delete process.env.EARVELDAJA_LOCK_DIR;
  limitedVatStore.reset();
  rmSync(dir, { recursive: true, force: true });
});

const api = (vatNumber?: string) => ({ readonly: { getVatInfo: async () => (vatNumber ? { vat_number: vatNumber } : {}) } });
const at = (ms: number) => () => new Date(Date.parse("2026-11-04T10:00:00Z") + ms);
const ownerRecord = (status: CompanyVatStatusRecord["status"], vatNumber?: string | null): CompanyVatStatusRecord => ({
  kind: "status", key: "company_vat_status", status, effective_from: "2026-01-01", set_at: "2026-11-01T00:00:00Z",
  ...(vatNumber !== undefined ? { vat_number: vatNumber } : {}),
});

describe("company VAT status from EMTA's KMKR query", () => {
  it("no VAT number is none, without asking EMTA", async () => {
    const fake = fakeEmtaFetch(emtaAnswerHtml([FULL_ROW]));
    expect(await companyVatStatusFromInfo({}, { emta: { fetch: fake.impl } })).toMatchObject({ status: "none", source: "derived" });
    expect(fake.calls).toEqual([]);
  });

  it("a limited registration is limited from its registration date, never VAT-registered", async () => {
    const fake = fakeEmtaFetch(emtaAnswerHtml([LIMITED_ROW]));
    const resolved = await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: fake.impl }, now: at(0) });
    expect(resolved).toMatchObject({
      status: "limited", source: "emta_lookup", effective_from: "2026-11-04",
      lookup: { registration: { limited: true, registered_on: "2026-11-04", vat_number: LIMITED_NUMBER }, looked_up_at: "2026-11-04T10:00:00.000Z", stale: false },
    });
    expect(await isCompanyVatRegistered(api(LIMITED_NUMBER), { emta: { fetch: fake.impl } })).toBe(false);
  });

  it("a full registration is full", async () => {
    const fake = fakeEmtaFetch(emtaAnswerHtml([FULL_ROW]));
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fake.impl } }))
      .toMatchObject({ status: "full", source: "emta_lookup", effective_from: "2024-12-16" });
    expect(await isCompanyVatRegistered(api(FULL_NUMBER), { emta: { fetch: fake.impl } })).toBe(true);
  });

  it("a network failure is unknown (lookup_unavailable) and a VAT decision refuses naming the reason and the fix", async () => {
    const fake = fakeEmtaFetch("network");
    const resolved = await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: fake.impl } });
    expect(resolved).toMatchObject({ status: "unknown", reason: COMPANY_VAT_STATUS_LOOKUP_UNAVAILABLE, lookup_error_code: "emta_lookup_unavailable" });
    const refusal = await isCompanyVatRegistered(api(LIMITED_NUMBER), { emta: { fetch: fake.impl } }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CompanyVatStatusUnknownError);
    expect((refusal as CompanyVatStatusUnknownError).code).toBe(COMPANY_VAT_STATUS_LOOKUP_UNAVAILABLE);
    expect((refusal as Error).message).toMatch(/^company_vat_status_lookup_unavailable: /);
    expect((refusal as Error).message).toContain("limited_vat mode \"set_status\"");
    expect((refusal as Error).message).toContain("Omanikule:");
  });

  it("a deleted registration or two active rows are unknown (lookup_ambiguous)", async () => {
    const deleted = fakeEmtaFetch(emtaAnswerHtml([{ ...LIMITED_ROW, deleted: "04.11.2026" }]));
    expect(await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: deleted.impl } }))
      .toMatchObject({ status: "unknown", reason: COMPANY_VAT_STATUS_LOOKUP_AMBIGUOUS, lookup_error_code: "emta_registration_deleted" });
    resetEmtaKmkrCache();
    const two = fakeEmtaFetch(emtaAnswerHtml([LIMITED_ROW, LIMITED_ROW]));
    expect(await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: two.impl } }))
      .toMatchObject({ status: "unknown", reason: COMPANY_VAT_STATUS_LOOKUP_AMBIGUOUS, lookup_error_code: "emta_registration_ambiguous" });
  });

  it("malformed HTML is unknown (lookup_unavailable)", async () => {
    const fake = fakeEmtaFetch("<table class=\"grid\"><tr><td>?</td></tr></table>");
    expect(await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: fake.impl } }))
      .toMatchObject({ status: "unknown", reason: COMPANY_VAT_STATUS_LOOKUP_UNAVAILABLE, lookup_error_code: "emta_response_invalid" });
  });
});

describe("EMTA lookup cache", () => {
  it("stores the lookup per VAT number and reuses it for 7 days without asking EMTA again", async () => {
    const fake = fakeEmtaFetch(emtaAnswerHtml([LIMITED_ROW]));
    await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: fake.impl }, now: at(0) });
    const stored = readLimitedVatRecords()!.find(record => record.kind === "emta_lookup");
    expect(stored).toMatchObject({ key: `emta_lookup:${LIMITED_NUMBER}`, vat_number: LIMITED_NUMBER, looked_up_at: "2026-11-04T10:00:00.000Z" });
    resetEmtaKmkrCache(); // a new process: only the store remains
    expect(await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: fake.impl }, now: at(6 * DAY) }))
      .toMatchObject({ status: "limited", lookup: { stale: false, looked_up_at: "2026-11-04T10:00:00.000Z" } });
    expect(fake.queries()).toHaveLength(1);
  });

  it("re-checks after 7 days; when the re-check fails the stored answer is used and reported stale", async () => {
    await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: fakeEmtaFetch(emtaAnswerHtml([LIMITED_ROW])).impl }, now: at(0) });
    resetEmtaKmkrCache();
    const failing = fakeEmtaFetch("network");
    const resolved = await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: failing.impl }, now: at(8 * DAY) });
    expect(failing.queries()).toHaveLength(1);
    expect(resolved).toMatchObject({ status: "limited", source: "emta_lookup", lookup: { stale: true, looked_up_at: "2026-11-04T10:00:00.000Z" } });
    expect(resolved.lookup!.refresh_error).toBe("EMTA could not be reached");

    resetEmtaKmkrCache();
    const refreshed = fakeEmtaFetch(emtaAnswerHtml([{ ...LIMITED_ROW, limited: false }]));
    expect(await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: refreshed.impl }, now: at(9 * DAY) }))
      .toMatchObject({ status: "full", lookup: { stale: false } });
  });

  it("a changed VAT number is looked up again", async () => {
    const fake = fakeEmtaFetch(vatNumber => emtaAnswerHtml([vatNumber === LIMITED_NUMBER ? LIMITED_ROW : FULL_ROW]));
    expect((await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fake.impl } })).status).toBe("full");
    expect((await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: fake.impl } })).status).toBe("limited");
    expect(fake.queries().map(call => new URLSearchParams(call.body).get("personCode"))).toEqual([FULL_NUMBER, LIMITED_NUMBER]);
  });

  it("single-file rules mode (no store) still looks up, cached in-process", async () => {
    delete process.env.EARVELDAJA_RULES_DIR;
    process.env.EARVELDAJA_RULES_FILE = join(dir, "accounting-rules.md");
    const fake = fakeEmtaFetch(emtaAnswerHtml([LIMITED_ROW]));
    expect(await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: fake.impl } })).toMatchObject({ status: "limited", store_available: false });
    await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: fake.impl } });
    expect(fake.queries()).toHaveLength(1);
    resetEmtaKmkrCache();
    const failed = await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: fakeEmtaFetch("network").impl } });
    expect(failed).toMatchObject({ status: "unknown", reason: COMPANY_VAT_STATUS_LOOKUP_UNAVAILABLE });
    expect(new CompanyVatStatusUnknownError(failed).message).toContain("single-file rules mode");
  });
});

describe("owner decision precedence", () => {
  it("an owner decision for the current number wins over EMTA, without a lookup", async () => {
    limitedVatStore.upsert([ownerRecord("full", LIMITED_NUMBER)]);
    const fake = fakeEmtaFetch(emtaAnswerHtml([LIMITED_ROW]));
    expect(await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: fake.impl } }))
      .toMatchObject({ status: "full", source: "setting", decision_vat_number: LIMITED_NUMBER });
    expect(fake.calls).toEqual([]);
  });

  it("a decision made for another number (or for no number) no longer applies: the new number is looked up", async () => {
    limitedVatStore.upsert([ownerRecord("none", null)]);
    const fake = fakeEmtaFetch(emtaAnswerHtml([LIMITED_ROW]));
    expect(await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: fake.impl } }))
      .toMatchObject({ status: "limited", source: "emta_lookup", decision_status: "none", decision_vat_number: null });
  });

  it("a decision for another number with a failed lookup is unknown and the message names the earlier decision", async () => {
    limitedVatStore.upsert([ownerRecord("full", FULL_NUMBER)]);
    const resolved = await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: fakeEmtaFetch("network").impl } });
    expect(resolved).toMatchObject({ status: "unknown", reason: COMPANY_VAT_STATUS_LOOKUP_UNAVAILABLE, decision_status: "full", decision_vat_number: FULL_NUMBER });
    expect(new CompanyVatStatusUnknownError(resolved).message).toContain(`The earlier owner decision "full" was made for VAT number ${FULL_NUMBER}`);
  });

  it("migration: a record saved without a number applies to the current number and is bound to it on first read", async () => {
    limitedVatStore.upsert([ownerRecord("limited")]);
    const fake = fakeEmtaFetch(emtaAnswerHtml([FULL_ROW]));
    expect(await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: fake.impl } }))
      .toMatchObject({ status: "limited", source: "setting", decision_vat_number: LIMITED_NUMBER });
    expect(fake.calls).toEqual([]);
    const persisted = JSON.parse(readFileSync(resolveBundleStorePath(LIMITED_VAT_STORE_FILE)!, "utf8")) as LimitedVatStoreRecord[];
    expect(persisted.find(record => record.kind === "status")).toMatchObject({ status: "limited", vat_number: LIMITED_NUMBER });
    // Bound: a later number is no longer covered by it.
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fake.impl } }))
      .toMatchObject({ status: "full", source: "emta_lookup", decision_status: "limited" });
  });
});

const storePath = () => resolveBundleStorePath(LIMITED_VAT_STORE_FILE)!;
const lookupRecord = (vatNumber: string, limited: boolean, lookedUpAt: string): LimitedVatStoreRecord => ({
  kind: "emta_lookup", key: `emta_lookup:${vatNumber}`, vat_number: vatNumber, looked_up_at: lookedUpAt,
  evidence: { kind: "success", registration: { vat_number: vatNumber, limited, registered_on: "2024-12-16", decision_on: "2024-12-14" } },
});
const storedEvidence = () => (readLimitedVatRecords()!.find(record => record.kind === "emta_lookup") as CompanyVatLookupRecord | undefined);
/** A fetch whose query answer waits for `release()`. */
const heldAnswer = (html: string) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fake = fakeEmtaFetch(html);
  const impl: typeof fake.impl = async (input, init) => {
    if (String(input) === EMTA_KMKR_QUERY_URL) await gate;
    return fake.impl(input, init);
  };
  return { impl, release };
};
/** A second process sharing the store: fresh module instances (own in-process caches). */
const otherProcess = async () => {
  vi.resetModules();
  return import("./company-vat-status.js");
};
/** The malformed page of review r2: a full row, then a limited row of the same number without its </tr>. */
const contradictoryPage = `<table class="grid">${EMTA_HEADER_ROW}${emtaRow(FULL_ROW)}${emtaRow({ ...LIMITED_ROW, vatNumber: FULL_ROW.vatNumber }, 2).replace(/<\/tr>$/, "")}</table>`;
/** A fetch that runs `during` while EMTA's answer is pending, then answers `html`. */
const answerAfter = (html: string, during: () => void) =>
  fakeEmtaFetch(() => {
    during();
    return html;
  });

describe("review fixes: contradicting EMTA evidence (finding 2)", () => {
  it.each([
    ["deleted", emtaAnswerHtml([{ ...FULL_ROW, deleted: "01.11.2026" }]), "emta_registration_deleted", "deleted"],
    ["not found", emtaAnswerHtml([LIMITED_ROW]), "emta_registration_not_found", "not_found"],
    ["ambiguous", emtaAnswerHtml([FULL_ROW, FULL_ROW]), "emta_registration_ambiguous", "ambiguous"],
    ["a contradictory page", contradictoryPage, "emta_response_contradictory", "contradictory_page"],
  ])("an expired full answer is not used when EMTA now says %s, and no later failure falls back to it", async (_label, html, code, reason) => {
    limitedVatStore.upsert([lookupRecord(FULL_NUMBER, false, "2026-11-04T10:00:00.000Z")]);
    const resolved = await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fakeEmtaFetch(html).impl }, now: at(8 * DAY) });
    expect(resolved).toMatchObject({ status: "unknown", reason: COMPANY_VAT_STATUS_LOOKUP_AMBIGUOUS, lookup_error_code: code });
    expect(storedEvidence()).toMatchObject({ looked_up_at: new Date(at(8 * DAY)()).toISOString(), evidence: { kind: "contradiction", reason } });
    // Same process after the retry window, and a new process: EMTA unreachable → still unknown.
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fakeEmtaFetch("network").impl }, now: at(8 * DAY + 120_000) }))
      .toMatchObject({ status: "unknown", lookup_error_code: code });
    resetEmtaKmkrCache();
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fakeEmtaFetch("network").impl }, now: at(8 * DAY + 240_000) }))
      .toMatchObject({ status: "unknown", lookup_error_code: code });
    // EMTA settling the number again replaces the contradiction.
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fakeEmtaFetch(emtaAnswerHtml([FULL_ROW])).impl }, now: at(8 * DAY + 360_000) }))
      .toMatchObject({ status: "full", lookup: { stale: false } });
  });

  it("a contradiction that cannot be stored is unknown naming the store, not a lookup failure", async () => {
    limitedVatStore.upsert([lookupRecord(FULL_NUMBER, false, "2026-11-04T10:00:00.000Z")]);
    vi.spyOn(limitedVatStore, "upsertIf").mockImplementation(() => { throw new Error("EACCES"); });
    const deleted = fakeEmtaFetch(emtaAnswerHtml([{ ...FULL_ROW, deleted: "01.11.2026" }]));
    const resolved = await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: deleted.impl }, now: at(8 * DAY) });
    expect(resolved).toMatchObject({ status: "unknown", source: "store_error", reason: COMPANY_VAT_STATUS_UNKNOWN });
    expect(resolved.store_error).toContain("EACCES");
  });

  it("an unavailable answer or a malformed page without registration content falls back to the expired stored answer (stale)", async () => {
    limitedVatStore.upsert([lookupRecord(FULL_NUMBER, false, "2026-11-04T10:00:00.000Z")]);
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fakeEmtaFetch("<table class=\"grid\"></table>").impl }, now: at(8 * DAY) }))
      .toMatchObject({ status: "full", lookup: { stale: true } });
    expect(storedEvidence()).toMatchObject({ looked_up_at: "2026-11-04T10:00:00.000Z", evidence: { kind: "success" } });
  });
});

describe("review r2: the newest stored evidence wins after every outcome", () => {
  it("r2 #1: a malformed page with a limited row after an expired full record is unknown, never stale full", async () => {
    limitedVatStore.upsert([lookupRecord(FULL_NUMBER, false, "2026-11-04T10:00:00.000Z")]);
    const resolved = await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fakeEmtaFetch(contradictoryPage).impl }, now: at(8 * DAY) });
    expect(resolved).toMatchObject({ status: "unknown", lookup_error_code: "emta_response_contradictory" });
    expect(() => requireKnownCompanyVatStatus(resolved)).toThrow(CompanyVatStatusUnknownError);
  });

  it("r2 #2: a failing refresh returns the newer limited evidence another writer stored meanwhile", async () => {
    limitedVatStore.upsert([lookupRecord(FULL_NUMBER, false, "2026-10-20T10:00:00.000Z")]);
    const failing = fakeEmtaFetch(() => {
      limitedVatStore.upsert([lookupRecord(FULL_NUMBER, true, "2026-11-04T10:00:01.000Z")]);
      throw new TypeError("fetch failed");
    });
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: failing.impl }, now: at(0) }))
      .toMatchObject({ status: "limited", source: "emta_lookup", lookup: { stale: false, looked_up_at: "2026-11-04T10:00:01.000Z" } });
  });

  it("r2 #3: an older full lookup finishing after a newer contradiction (another process) never resurrects full", async () => {
    limitedVatStore.upsert([lookupRecord(FULL_NUMBER, false, "2026-10-20T10:00:00.000Z")]);
    const older = heldAnswer(emtaAnswerHtml([FULL_ROW]));
    const pending = companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: older.impl }, now: at(0) });
    const second = await otherProcess();
    const deleted = fakeEmtaFetch(emtaAnswerHtml([{ ...FULL_ROW, deleted: "01.11.2026" }]));
    expect(await second.companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: deleted.impl }, now: at(1_000) }))
      .toMatchObject({ status: "unknown", lookup_error_code: "emta_registration_deleted" });
    older.release();
    expect(await pending).toMatchObject({ status: "unknown", lookup_error_code: "emta_registration_deleted" });
    expect(storedEvidence()).toMatchObject({ looked_up_at: "2026-11-04T10:00:01.000Z", evidence: { kind: "contradiction" } });
    // Neither process reuses full afterwards: not from the store, nor from its in-process cache.
    expect(await second.companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fakeEmtaFetch("network").impl }, now: at(2_000) }))
      .toMatchObject({ status: "unknown" });
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fakeEmtaFetch("network").impl }, now: at(3_000) }))
      .toMatchObject({ status: "unknown" });
  });

  it("r2 #3: a contradiction with an empty initial snapshot overrides an older full stored meanwhile", async () => {
    const deleted = fakeEmtaFetch(() => {
      limitedVatStore.upsert([lookupRecord(FULL_NUMBER, false, "2026-11-04T09:59:59.000Z")]);
      return emtaAnswerHtml([{ ...FULL_ROW, deleted: "01.11.2026" }]);
    });
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: deleted.impl }, now: at(0) }))
      .toMatchObject({ status: "unknown", lookup_error_code: "emta_registration_deleted" });
    expect(storedEvidence()).toMatchObject({ looked_up_at: "2026-11-04T10:00:00.000Z", evidence: { kind: "contradiction" } });
    resetEmtaKmkrCache();
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fakeEmtaFetch("network").impl }, now: at(120_000) }))
      .toMatchObject({ status: "unknown" });
  });

  it("a newer contradiction stored by another process is honoured even while this process holds a fresh full answer", async () => {
    await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fakeEmtaFetch(emtaAnswerHtml([FULL_ROW])).impl }, now: at(0) });
    // Another process saw EMTA show no registration a day later.
    limitedVatStore.upsert([{
      kind: "emta_lookup", key: `emta_lookup:${FULL_NUMBER}`, vat_number: FULL_NUMBER, looked_up_at: "2026-11-05T10:00:00.000Z",
      evidence: { kind: "contradiction", reason: "not_found", detail: `EMTA shows no registration for ${FULL_NUMBER}` },
    }]);
    const unreachable = fakeEmtaFetch("network");
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: unreachable.impl }, now: at(DAY + 1_000) }))
      .toMatchObject({ status: "unknown", lookup_error_code: "emta_registration_not_found" });
    expect(unreachable.queries()).toHaveLength(1);
  });
});

describe("review fixes: the store as it is after the lookup (finding 3)", () => {
  it("an owner decision saved while EMTA was asked wins over EMTA's answer", async () => {
    const fake = answerAfter(emtaAnswerHtml([FULL_ROW]), () => {
      limitedVatStore.upsert([ownerRecord("limited", FULL_NUMBER)]);
    });
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fake.impl }, now: at(0) }))
      .toMatchObject({ status: "limited", source: "setting", decision_vat_number: FULL_NUMBER });
    expect(fake.queries()).toHaveLength(1);
  });

  it("a store that cannot be re-read after the lookup is unknown, never EMTA's full", async () => {
    const fake = answerAfter(emtaAnswerHtml([FULL_ROW]), () => {
      limitedVatStore.upsert([ownerRecord("none", null)]);
      writeFileSync(storePath(), "{ not json");
    });
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fake.impl }, now: at(0) }))
      .toMatchObject({ status: "unknown", source: "store_error", reason: COMPANY_VAT_STATUS_UNKNOWN });
  });
});

describe("review fixes: newer lookup evidence wins (finding 4)", () => {
  it("an older full answer finishing after a newer limited one does not replace it; the winner is returned", async () => {
    const fake = answerAfter(emtaAnswerHtml([FULL_ROW]), () => {
      // Another process stored a later lookup (10:00:01, limited) meanwhile.
      limitedVatStore.upsert([lookupRecord(FULL_NUMBER, true, "2026-11-04T10:00:01.000Z")]);
    });
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fake.impl }, now: at(0) }))
      .toMatchObject({ status: "limited", source: "emta_lookup", lookup: { looked_up_at: "2026-11-04T10:00:01.000Z" } });
    expect(storedEvidence()).toMatchObject({ looked_up_at: "2026-11-04T10:00:01.000Z", evidence: { registration: { limited: true } } });
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fake.impl }, now: at(2_000) }))
      .toMatchObject({ status: "limited" });
  });

  it("a newer answer replaces an older stored one", async () => {
    limitedVatStore.upsert([lookupRecord(FULL_NUMBER, true, "2026-10-01T10:00:00.000Z")]);
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, { emta: { fetch: fakeEmtaFetch(emtaAnswerHtml([FULL_ROW])).impl }, now: at(0) }))
      .toMatchObject({ status: "full", lookup: { looked_up_at: "2026-11-04T10:00:00.000Z" } });
    expect(storedEvidence()).toMatchObject({ evidence: { registration: { limited: false } } });
  });
});

describe("review fixes: legacy decision binding must hold (finding 5)", () => {
  it("a legacy decision that cannot be bound (store not writable) is unknown, for this number and the next", async () => {
    limitedVatStore.upsert([ownerRecord("full")]);
    vi.spyOn(limitedVatStore, "upsertIf").mockImplementation(() => { throw new Error("EACCES: permission denied"); });
    const fake = fakeEmtaFetch(emtaAnswerHtml([LIMITED_ROW]));
    for (const vatNumber of [FULL_NUMBER, LIMITED_NUMBER]) {
      const resolved = await companyVatStatusFromInfo({ vat_number: vatNumber }, { emta: { fetch: fake.impl } });
      expect(resolved).toMatchObject({ status: "unknown", source: "store_error", reason: COMPANY_VAT_STATUS_UNKNOWN });
      expect(resolved.store_error).toContain("EACCES");
    }
    expect(fake.calls).toEqual([]);
  });

  it("a rejected binding (another writer was first) derives from the winning record", async () => {
    limitedVatStore.upsert([ownerRecord("full")]);
    const real = limitedVatStore.upsertIf.bind(limitedVatStore);
    vi.spyOn(limitedVatStore, "upsertIf").mockImplementationOnce(() => {
      limitedVatStore.upsert([ownerRecord("full", FULL_NUMBER)]);
      return false;
    }).mockImplementation(real);
    const fake = fakeEmtaFetch(emtaAnswerHtml([LIMITED_ROW]));
    expect(await companyVatStatusFromInfo({ vat_number: LIMITED_NUMBER }, { emta: { fetch: fake.impl } }))
      .toMatchObject({ status: "limited", source: "emta_lookup", decision_status: "full", decision_vat_number: FULL_NUMBER });
  });

  it("a binding that keeps being rejected is unknown", async () => {
    limitedVatStore.upsert([ownerRecord("full")]);
    vi.spyOn(limitedVatStore, "upsertIf").mockReturnValue(false);
    expect(await companyVatStatusFromInfo({ vat_number: FULL_NUMBER }, {}))
      .toMatchObject({ status: "unknown", source: "store_error", reason: COMPANY_VAT_STATUS_UNKNOWN });
  });
});

describe("review fixes: fresh /vat_info for a decision bound to the number (finding 6)", () => {
  it("freshVatInfo reads /vat_info past its cache", async () => {
    const getVatInfo = vi.fn(async (_options?: { fresh?: boolean }) => ({ vat_number: FULL_NUMBER }));
    await isCompanyVatRegistered({ readonly: { getVatInfo } });
    expect(getVatInfo).toHaveBeenLastCalledWith();
    await resolveCompanyVatStatus({ readonly: { getVatInfo } }, { freshVatInfo: true });
    expect(getVatInfo).toHaveBeenLastCalledWith({ fresh: true });
  });
});
