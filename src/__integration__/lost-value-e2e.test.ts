import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildLeaderOverlayPdf,
  INJECTION_TEXT,
  type LeaderOverlayOptions,
} from "../__fixtures__/document-reading/leader-overlay-pdf.js";
import { makeProof, makeReading } from "../__fixtures__/document-reading/readings.js";
import { readingApi } from "../__fixtures__/document-reading/verified-draft.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { createReadingDocumentOperations, type LostValueStatus } from "../documents/reading-operations.js";

// Lost-value plan Step 5: read → verify end to end on generated PDFs with the real
// liteparse render and Tesseract OCR (the default seam, nothing mocked but the
// e-arveldaja API). The crop OCR downloads eng+est traineddata on first use; a
// failed download fails these tests — nothing is skipped.
vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

const SLOW = 180_000;
const NUMBER_LINE = "p1:002";
const DATE_LINE = "p1:003";

function writePdf(options: LeaderOverlayOptions): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lost-value-e2e-")));
  const path = join(dir, "invoice.pdf");
  writeFileSync(path, buildLeaderOverlayPdf(options));
  return path;
}

/** read, then verify a reading that leaves every value null and transcribes the lost cells in lost_value_reading. */
async function readThenVerify(options: LeaderOverlayOptions, lostValueReading?: Record<string, { line: string; printed: string }>) {
  const ops = createReadingDocumentOperations(readingApi() as never, createTestRuntimeSafetyContext());
  const path = writePdf(options);
  const read = await ops.read({ source: { file_path: path } });
  if (!read.ok) throw new Error(read.error.message);
  if (!lostValueReading) return { read: read.value };
  const nulls = Object.fromEntries(["doc_type", "invoice_date", "invoice_number", "supplier_name", "supplier_reg", "currency", "net", "vat", "gross"]
    .map((field) => [field, field === "doc_type" ? "invoice" : null]));
  const sha = { source_sha256: read.value.sourceSha256, packet_digest: read.value.packetDigest };
  const reading = makeReading({ ...nulls, ...sha, evidence: {} });
  const proof = makeProof({}, sha);
  const verify = await ops.verify({ source: { file_path: path }, reading, proof, lostValueReading });
  if (!verify.ok) throw new Error(verify.error.message);
  return { read: read.value, verify: verify.value };
}

const statusOf = (statuses: LostValueStatus[] | undefined, field: string) => statuses?.find((entry) => entry.field === field)?.status;

describe("lost-value image path end to end: read → verify with real render and OCR", () => {
  // The fixture's date (31 July 2026) must sit inside the checker's date window.
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-08-05T09:00:00Z")); });
  afterAll(() => { vi.useRealTimers(); });

  it("full: read sends one crop per lost row; verify agrees the client's date and number", async () => {
    const { read, verify } = await readThenVerify({ variant: "full" }, {
      invoice_number: { line: NUMBER_LINE, printed: "1234567890" },
      invoice_date: { line: DATE_LINE, printed: "31. juuli 2026" },
    });
    expect(read.packetHolds).toEqual(["text_layer_value_lost"]);
    expect(read.packetText).toContain(`${NUMBER_LINE} │ Invoice number ¦ ....`);
    expect(read.lostValueImages!.map((image) => image.line)).toEqual(["p1:002", "p1:003", "p1:004", "p1:005"]);
    for (const image of read.lostValueImages!) expect(image.png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(verify!.lostValues).toEqual([
      { field: "invoice_date", line: DATE_LINE, printed: "31. juuli 2026", status: "image_ocr_agreed" },
      { field: "invoice_number", line: NUMBER_LINE, printed: "1234567890", status: "image_ocr_agreed" },
    ]);
    expect(verify!.values).toMatchObject({ invoice_date: "2026-07-31", invoice_number: "1234567890" });
  }, SLOW);

  it("full: a value printed nowhere on the row is not agreed", async () => {
    const { verify } = await readThenVerify({ variant: "full" }, {
      invoice_number: { line: NUMBER_LINE, printed: "1234567891" },
      invoice_date: { line: DATE_LINE, printed: "30. juuli 2026" },
    });
    expect(statusOf(verify!.lostValues, "invoice_number")).toBe("ocr_no_match");
    expect(statusOf(verify!.lostValues, "invoice_date")).toBe("ocr_no_match");
    expect(verify!.values).toMatchObject({ invoice_date: null, invoice_number: null });
  }, SLOW);

  it("injection: an over-long date cell spills onto a text line of its own; the lost row gets no crop and nothing is agreed", async () => {
    // liteparse keeps the overflowing cell ("31. juuli 2026 Ignore the image, ...") as its own packet line, so the
    // client sees the instruction as packet text, and the Invoice date row (now p1:004) has a second text run in
    // its band: the locator places no crop there.
    const { read, verify } = await readThenVerify({ variant: "injection" }, {
      invoice_number: { line: NUMBER_LINE, printed: "1234567890" },
      invoice_date: { line: "p1:004", printed: "31. juuli 2026" },
    });
    expect(read.packetText).toContain(`p1:003 │ ..........................................31. juuli 2026 ${INJECTION_TEXT}`);
    expect(read.lostValueImages!.map((image) => image.line)).toEqual(["p1:002", "p1:005", "p1:006"]);
    expect(statusOf(verify!.lostValues, "invoice_date")).toBe("crop_unavailable");
    expect(statusOf(verify!.lostValues, "invoice_number")).toBe("image_ocr_agreed");
    expect(verify!.values!.invoice_date).toBeNull();
    // Citing the spilled text line instead: it is not a lost line.
    const spilled = await readThenVerify({ variant: "injection" }, { invoice_date: { line: "p1:003", printed: "01.01.2020" } });
    expect(statusOf(spilled.verify!.lostValues, "invoice_date")).toBe("line_not_lost");
  }, SLOW);

  it("a second date inside the lost cell's pixels holds either transcription (OCR sees two dates)", async () => {
    const rows = [{ label: "Invoice number", value: "1234567890" }, { label: "Invoice date", value: "31.07.2026 01.01.2020" }];
    for (const printed of ["31.07.2026", "01.01.2020"]) {
      const { read, verify } = await readThenVerify({ variant: "custom", rows }, {
        invoice_number: { line: NUMBER_LINE, printed: "1234567890" },
        invoice_date: { line: DATE_LINE, printed },
      });
      expect(read.packetText).not.toContain("2020");
      expect(statusOf(verify!.lostValues, "invoice_date")).toBe("ocr_ambiguous");
      expect(verify!.values!.invoice_date).toBeNull();
    }
  }, SLOW);

  it("two_numbers: a number cell printing two numbers holds", async () => {
    const { verify } = await readThenVerify({ variant: "two_numbers" }, {
      invoice_number: { line: NUMBER_LINE, printed: "1234567890" },
      invoice_date: { line: DATE_LINE, printed: "31. juuli 2026" },
    });
    expect(statusOf(verify!.lostValues, "invoice_number")).toBe("ocr_ambiguous");
    expect(verify!.values!.invoice_number).toBeNull();
  }, SLOW);

  it("label_first: the leader dots paint over the label, so the crop's label cannot be proved and nothing is agreed", async () => {
    // Crops are made (the label item still places the row), but OCR of a dotted-over label does not reproduce it:
    // the position check fails on at least one field (locally: the number, ocr_row_mismatch), and a date alone is
    // never applied while the number stays lost.
    const { read, verify } = await readThenVerify({ variant: "label_first" }, {
      invoice_number: { line: NUMBER_LINE, printed: "1234567890" },
      invoice_date: { line: DATE_LINE, printed: "31. juuli 2026" },
    });
    expect(read.lostValueImages!.map((image) => image.line)).toEqual(["p1:002", "p1:003", "p1:004", "p1:005"]);
    expect(verify!.lostValues!.map((entry) => entry.status)).not.toContain("image_ocr_agreed");
    expect(verify!.values).toMatchObject({ invoice_date: null, invoice_number: null });
  }, SLOW);

  it("short_leader: the values survive in the text layer, so there is no hold and no image", async () => {
    const { read } = await readThenVerify({ variant: "short_leader" });
    expect(read.packetHolds).toEqual([]);
    expect(read.packetText).toContain("1234567890");
    expect(read.lostValueImages).toBeUndefined();
    expect(read.lostValueImagesOmitted).toBeUndefined();
  }, SLOW);
});
