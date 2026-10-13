import { describe, expect, it } from "vitest";
import { buildWorkflowRunData } from "./workflow-prompt-source.js";

describe("buildWorkflowRunData month derivation", () => {
  it("derives the month's real last day, leap-year aware", () => {
    expect(buildWorkflowRunData({ month: "2024-02" }).derived).toEqual({
      date_from: "2024-02-01",
      date_to: "2024-02-29",
      fiscal_year_date_from: "2024-01-01",
    });
    expect(buildWorkflowRunData({ month: "2026-02" }).derived.date_to).toBe("2026-02-28");
  });

  it("keeps years 0000-0099 in their own century", () => {
    expect(buildWorkflowRunData({ month: "0050-02" }).derived.date_to).toBe("0050-02-28");
    expect(buildWorkflowRunData({ month: "0048-02" }).derived.date_to).toBe("0048-02-29");
  });

  it("derives nothing for a non-existent month", () => {
    expect(buildWorkflowRunData({ month: "2026-13" }).derived).toEqual({});
    expect(buildWorkflowRunData({ month: "2026-00" }).derived).toEqual({});
  });
});
