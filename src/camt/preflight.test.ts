import { describe, expect, it } from "vitest";
import { assertRealDate, capture, ImportFieldError, reject, type ImportRejectedField } from "./preflight.js";
import { preflightWiseCsv } from "../wise/preflight.js";

describe("shared import preflight scaffolding", () => {
  it("reject throws a positional ImportFieldError with the stringified value", () => {
    try {
      reject("camt:entry:1", "Amt", undefined, "bad amount");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ImportFieldError);
      expect((error as ImportFieldError).issue).toEqual({ source_row_id: "camt:entry:1", field: "Amt", value: "", reason: "bad amount" });
    }
  });

  it("capture records field errors and keeps going, but rethrows anything else", () => {
    const sink: ImportRejectedField[] = [];
    expect(capture(sink, () => 5)).toBe(5);
    expect(capture(sink, () => reject("r", "f", 7, "why"))).toBeUndefined();
    expect(sink).toEqual([{ source_row_id: "r", field: "f", value: "7", reason: "why" }]);
    expect(() => capture(sink, () => { throw new Error("structural"); })).toThrow("structural");
  });

  it("assertRealDate accepts real calendar days and rejects impossible or malformed ones", () => {
    expect(assertRealDate("2024-02-29", "r", "f", "raw")).toBe("2024-02-29");
    expect(() => assertRealDate("2026-02-29", "r", "f", "raw")).toThrow("Impossible calendar date");
    expect(() => assertRealDate("2026-13-01", "r", "f", "raw")).toThrow("Impossible calendar date");
    expect(() => assertRealDate("2026-1-01", "r", "f", "raw")).toThrow("Expected YYYY-MM-DD");
  });

  it("is what the Wise preflight uses for its date rejections", () => {
    const header = `ID,Status,Direction,"Created on","Finished on","Source fee amount","Source fee currency","Target fee amount","Target fee currency","Source name","Source amount (after fees)","Source currency","Target name","Target amount (after fees)","Target currency","Exchange rate",Reference,Category,Note`;
    const row = `W-1,COMPLETED,OUT,"2026-02-30 10:00:00","",0,EUR,0,EUR,"A",1,EUR,"B",1,EUR,1,,,`;
    const result = preflightWiseCsv(`${header}\n${row}\n`);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.rejected_fields).toEqual([
      { source_row_id: "wise:row:1", field: "Created on", value: "2026-02-30 10:00:00", reason: "Impossible calendar date" },
    ]);
  });
});
