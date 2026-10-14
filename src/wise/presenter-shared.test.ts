import { describe, expect, it, vi } from "vitest";
import {
  digestMismatch,
  issueWiseResultHandle,
  simpleWiseFailureFromCode,
  wiseDigestInputRejection,
  wisePreflightFailure,
  type WiseImportRenderData,
} from "./presenter.js";
import { importPreflightFailurePayload, issueCamtResultHandle, type CamtImportExecution } from "../camt/presenter.js";
import { parseMcpResponse } from "../mcp-json.js";
import { WISE_PLAN_DOMAIN } from "./projection.js";
import { CAMT_PLAN_DOMAIN } from "../tools/camt-plan.js";

const DIGEST = "a".repeat(64);

describe("Wise preflight failure envelope", () => {
  it("is the shared CAMT/Wise payload with source=wise, bounded and sandboxed", () => {
    const rejected = Array.from({ length: 101 }, (_, i) => ({ source_row_id: `wise:row:${i}`, field: "ID", value: "x".repeat(300), reason: "bad" }));
    const result = wisePreflightFailure(rejected);
    expect(result.isError).toBe(true);
    const payload = parseMcpResponse(result.content[0]!.text as string) as any;
    const shared = importPreflightFailurePayload("wise", rejected) as any;
    expect(Object.keys(payload)).toEqual(Object.keys(shared));
    expect(payload).toMatchObject({ category: "import_preflight_failed", source: "wise", rejected_field_count: 101, rejected_fields_truncated: true, retry: "never" });
    expect(payload.rejected_fields).toHaveLength(100);
    expect(payload.rejected_fields[0].value).toContain("UNTRUSTED_OCR_START");
    expect(payload.rejected_fields[0].value).toContain("x".repeat(256));
    expect(payload.rejected_fields[0].value).not.toContain("x".repeat(257));
  });
});

describe("wiseDigestInputRejection", () => {
  it("passes an absent digest on a dry run and a well-formed one on execute", () => {
    expect(wiseDigestInputRejection(undefined, false)).toBeUndefined();
    expect(wiseDigestInputRejection(DIGEST, true)).toBeUndefined();
  });

  it("rejects a malformed digest, and a missing one on execute, with the digest-mismatch envelope", () => {
    const expected = digestMismatch();
    expect(wiseDigestInputRejection("ABC", false)).toEqual(expected);
    expect(wiseDigestInputRejection(42, false)).toEqual(expected);
    expect(wiseDigestInputRejection(DIGEST.toUpperCase(), true)).toEqual(expected);
    expect(wiseDigestInputRejection(undefined, true)).toEqual(expected);
  });
});

describe("simpleWiseFailureFromCode", () => {
  it("reprojects the simple operation error codes and refuses anything else", () => {
    for (const kind of ["plan_handle_required", "digest_mismatch", "ownership_reapproval_required", "wise_client_not_found", "wise_dimension_not_bank_account"] as const) {
      expect(simpleWiseFailureFromCode(kind)).toEqual({ kind });
    }
    expect(() => simpleWiseFailureFromCode("plan_drift")).toThrow("Unexpected Wise operation error code: plan_drift");
  });
});

describe("operation-result handles", () => {
  const wiseData = (reasons: string[]) => ({
    created: [{ status: "created", date: "2026-01-01", amount: 5, api_id: 9 }],
    skipped: reasons.map(reason => ({ reason })),
  }) as unknown as WiseImportRenderData;

  it("issues a Wise handle only with a plan handle, with status from the error skips", () => {
    const store = { issue: vi.fn().mockReturnValue("H") };
    expect(issueWiseResultHandle(store, wiseData([]), undefined)).toBeUndefined();
    expect(issueWiseResultHandle(store, wiseData([]), "")).toBeUndefined();
    expect(store.issue).not.toHaveBeenCalled();
    expect(issueWiseResultHandle(store, wiseData([]), "plan")).toBe("H");
    expect(store.issue.mock.calls[0]![0]).toMatchObject({ operation: WISE_PLAN_DOMAIN, status: "completed", plan_handle: "plan" });
    issueWiseResultHandle(store, wiseData(["some upstream error"]), "plan");
    expect(store.issue.mock.calls[1]![0].status).toBe("partial");
  });

  it("issues a CAMT handle with indeterminate status after an indeterminate stop", () => {
    const store = { issue: vi.fn().mockReturnValue("H") };
    const execution = (errorCount: number, category?: string) => ({
      results: [], errorCount, executionReport: category ? { stop_reason: { category } } : undefined,
    }) as unknown as CamtImportExecution;
    expect(issueCamtResultHandle(store, execution(0), "plan")).toBe("H");
    issueCamtResultHandle(store, execution(1, "mutation_indeterminate"), "plan");
    issueCamtResultHandle(store, execution(1, "mutation_failed"), "plan");
    expect(store.issue.mock.calls.map(call => [call[0].operation, call[0].status])).toEqual([
      [CAMT_PLAN_DOMAIN, "completed"], [CAMT_PLAN_DOMAIN, "indeterminate"], [CAMT_PLAN_DOMAIN, "partial"],
    ]);
  });

  it("degrades to no handle when the store refuses", () => {
    const store = { issue: vi.fn(() => { throw new Error("store full"); }) };
    expect(issueWiseResultHandle(store, wiseData([]), "plan")).toBeUndefined();
    expect(issueCamtResultHandle(store, { results: [], errorCount: 0 } as unknown as CamtImportExecution, "plan")).toBeUndefined();
  });
});
