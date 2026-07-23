import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureFileInputSnapshot } from "../file-input-snapshot.js";
import { FILE_REFERENCE_OPERATIONS } from "../file-reference-store.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { fixtureCamtXml } from "../__fixtures__/accounting-workflow.js";
import { detectBankInputFormat } from "./input-format.js";

const BANK_CAPTURE = (runtimeSafetyContext: ReturnType<typeof createTestRuntimeSafetyContext>) => ({
  runtimeSafetyContext,
  operation: FILE_REFERENCE_OPERATIONS.bank,
  allowedExtensions: [".xml", ".csv"],
  maxSize: 10 * 1024 * 1024,
});

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
const inlineXml = (xml: string) => `base64:${b64(xml)}`;
const inlineCsv = (csv: string) => `base64:csv:${b64(csv)}`;

function validWiseCsv(): string {
  const header = [
    "ID", "Status", "Direction", "Created on", "Finished on",
    "Source fee amount", "Source fee currency", "Target fee amount", "Target fee currency",
    "Source name", "Source amount (after fees)", "Source currency",
    "Target name", "Target amount (after fees)", "Target currency",
    "Exchange rate", "Reference", "Category", "Note",
  ].join(",");
  const row = [
    "WISE-1", "COMPLETED", "OUT", "2026-01-10 10:00:00", "2026-01-10 10:00:00",
    "0", "EUR", "0", "EUR",
    "MyCo", "100", "EUR",
    "Acme", "100", "EUR",
    "1", "inv-1", "General", "note",
  ].join(",");
  return `${header}\n${row}\n`;
}

async function capture(source: string) {
  const runtime = createTestRuntimeSafetyContext();
  return captureFileInputSnapshot({ file_path: source }, BANK_CAPTURE(runtime));
}

describe("detectBankInputFormat", () => {
  it("routes a CAMT.053 XML to camt with its parsed statement", async () => {
    const snapshot = await capture(inlineXml(fixtureCamtXml()));
    const result = detectBankInputFormat(snapshot);
    expect(result.format).toBe("camt");
    if (result.format === "camt") {
      expect(result.preflight.value.statement_metadata.iban).toBe("EE637700771011212909");
    }
  });

  it("routes a Wise transaction CSV to wise with its parsed rows", async () => {
    const snapshot = await capture(inlineCsv(validWiseCsv()));
    const result = detectBankInputFormat(snapshot);
    expect(result.format).toBe("wise");
    if (result.format === "wise") {
      expect(result.preflight.rows).toHaveLength(1);
    }
  });

  it("prefers the content signature over the file extension (CAMT XML named .csv → camt)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bank-input-format-"));
    const csvPath = join(dir, "statement.csv");
    await writeFile(csvPath, fixtureCamtXml(), "utf8");
    const snapshot = await capture(csvPath);
    expect(snapshot.identity.extension).toBe(".csv");
    const result = detectBankInputFormat(snapshot);
    expect(result.format).toBe("camt");
  });

  it("rejects an unrecognized file as unsupported without echoing raw bytes", async () => {
    const snapshot = await capture(inlineCsv("not,a,bank\nfile,at,all\n"));
    const result = detectBankInputFormat(snapshot);
    expect(result.format).toBe("unsupported");
    // No raw file bytes leak into the discriminated result — only counts.
    expect(JSON.stringify(result)).not.toContain("not,a,bank");
  });
});
