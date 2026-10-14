import { describe, expect, it } from "vitest";
import { summarizeWiseSkippedEntries } from "./preflight.js";

describe("summarizeWiseSkippedEntries", () => {
  it("groups already-booked rows by reason with the ledger id templated out, keeping every row's record", () => {
    const groups = summarizeWiseSkippedEntries([
      { wise_id: "TRANSFER-1", reason: "Already journalized: inter-account journal 29443702 books this transfer; no Wise bank row created" },
      { wise_id: "TRANSFER-2", reason: "Already journalized: inter-account journal 29537438 books this transfer; no Wise bank row created" },
      { wise_id: "CARD-1", reason: "Already imported (wise_untagged_ledger_unique): confirmed transaction 13875420 without a WISE: tag is the only stored row" },
      { wise_id: "CARD-2", reason: "Already imported (Wise ID match)" },
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual({
      reason: "Already journalized: inter-account journal {record_id} books this transfer; no Wise bank row created",
      count: 2,
      sample_ids: ["TRANSFER-1", "TRANSFER-2"],
      records: [{ wise_id: "TRANSFER-1", record_id: 29443702 }, { wise_id: "TRANSFER-2", record_id: 29537438 }],
    });
    expect(groups[1]!.records).toEqual([{ wise_id: "CARD-1", record_id: 13875420 }]);
    expect(groups[2]).toEqual({ reason: "Already imported (Wise ID match)", count: 1, sample_ids: ["CARD-2"] });
  });

  it("keeps error reasons verbatim, even when they mention a transaction id", () => {
    const reason = "Inter-account confirmation failed: transaction 123 is locked";
    const groups = summarizeWiseSkippedEntries([{ wise_id: "T-1", reason }, { wise_id: "T-2", reason: "Inter-account confirmation failed: transaction 456 is locked" }]);
    expect(groups.map(g => g.reason)).toEqual([reason, "Inter-account confirmation failed: transaction 456 is locked"]);
    expect(groups[0]!.records).toBeUndefined();
  });
});
