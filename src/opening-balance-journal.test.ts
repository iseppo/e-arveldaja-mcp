import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isOpeningBalanceJournal, loadJournalsWithOpeningBalance } from "./opening-balance-journal.js";
import { createAccountingWorkflowApi } from "./__fixtures__/accounting-workflow.js";
import type { Journal } from "./types/api.js";

const ordinary: Journal = { id: 7, effective_date: "2025-02-01", registered: true, is_deleted: false, postings: [] };
const initial: Journal = { ...ordinary, id: 88, operation_type: "INITIAL", effective_date: "2025-01-01", clients_id: 9,
  postings: [{ accounts_id: 1020, accounts_dimensions_id: 101, type: "D", amount: 1000, base_amount: 1000 },
    { accounts_id: 2900, type: "C", amount: 1000, base_amount: 1000 }] };
function api(journals: Journal[]) {
  return createAccountingWorkflowApi({ journals: { listAllWithPostings: vi.fn().mockResolvedValue(journals) } });
}
describe("API-only opening journals", () => {
  let dir: string;
  const oldDir = process.env.EARVELDAJA_RULES_DIR;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "api-opening-only-")); process.env.EARVELDAJA_RULES_DIR = dir; });
  afterEach(() => { if (oldDir === undefined) delete process.env.EARVELDAJA_RULES_DIR; else process.env.EARVELDAJA_RULES_DIR = oldDir; rmSync(dir, { recursive: true, force: true }); });

  it("retains API identity, client, dimensions and amounts exactly once", async () => {
    const context = api([initial, ordinary]);
    const result = await loadJournalsWithOpeningBalance(context);
    expect(result.journals).toEqual([initial, ordinary]);
    expect(result.journalsFromApi).toEqual([initial, ordinary]);
    expect(result.opening).toEqual({ source: "api", openingDate: "2025-01-01", journal: initial });
    expect(result.opening!.journal).toBe(initial);
    expect(context.readonly.getAccounts).not.toHaveBeenCalled();
    expect(context.readonly.getAccountDimensions).not.toHaveBeenCalled();
  });
  it.each(["broken JSON", JSON.stringify({ openingDate: "2025-01-01", accounts: [{ code: "1020", debit: 9000, credit: 0 }] })])(
    "ignores a legacy file even when the API contains no INITIAL: %s", async contents => {
      writeFileSync(join(dir, "opening-balances.json"), contents);
      const result = await loadJournalsWithOpeningBalance(api([ordinary]));
      expect(result.opening).toBeNull();
      expect(result.journals).toEqual([ordinary]);
      expect(result.journalsFromApi).toEqual([ordinary]);
    });
  it("ignores a corrupt local register when an API opening exists too", async () => {
    writeFileSync(join(dir, "opening-balances.json"), "broken JSON");
    expect((await loadJournalsWithOpeningBalance(api([initial]))).journals).toEqual([initial]);
  });
  it.each([{ registered: false }, { is_deleted: true }, { postings: [] }])("retains incomplete API metadata: %j", async state => {
    const entry = { ...initial, ...state };
    const result = await loadJournalsWithOpeningBalance(api([entry, ordinary]));
    expect(result.opening!.journal).toEqual(entry);
    expect(result.journals).toEqual([entry, ordinary]);
  });
  it("refuses multiple active INITIAL journals", async () => {
    await expect(loadJournalsWithOpeningBalance(api([initial, { ...initial, id: 89 }]))).rejects.toThrow(/multiple.*INITIAL/i);
  });
  it("allows deleted history alongside one active INITIAL", async () => {
    const deleted = { ...initial, id: 89, is_deleted: true };
    const result = await loadJournalsWithOpeningBalance(api([deleted, initial]));
    expect(result.opening!.journal).toEqual(initial);
    expect(result.journals).toEqual([deleted, initial]);
  });
  it.each([{ type: "I", amount: 1 }, { type: "D", amount: -1 }, { type: "C", amount: NaN }])("refuses malformed INITIAL postings: %j", posting => {
    return expect(loadJournalsWithOpeningBalance(api([{ ...initial, postings: [{ accounts_id: 1020, ...posting }] } as Journal]))).rejects.toThrow(/Malformed INITIAL/);
  });
  it("propagates API failures rather than loading a local file", async () => {
    writeFileSync(join(dir, "opening-balances.json"), "broken JSON");
    const context = api([]);
    vi.mocked(context.journals.listAllWithPostings).mockRejectedValue(new Error("API unavailable"));
    await expect(loadJournalsWithOpeningBalance(context)).rejects.toThrow("API unavailable");
  });
  it("recognizes INITIAL rather than the retired synthetic ID", () => {
    expect(isOpeningBalanceJournal(initial)).toBe(true);
    expect(isOpeningBalanceJournal({ ...ordinary, id: -1 })).toBe(false);
  });
});
