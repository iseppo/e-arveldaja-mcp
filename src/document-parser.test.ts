import { beforeEach, describe, expect, it, vi } from "vitest";

const parseMock = vi.fn();
const isComplexMock = vi.fn();
const screenshotMock = vi.fn();
const liteParseConstructor = vi.fn(function LiteParseMock() {
  return {
    parse: parseMock,
    isComplex: isComplexMock,
    screenshot: screenshotMock,
  };
});

vi.mock("@llamaindex/liteparse", () => ({
  LiteParse: liteParseConstructor,
}));

describe("document parser", () => {
  beforeEach(() => {
    vi.resetModules();
    parseMock.mockReset();
    liteParseConstructor.mockClear();
    delete process.env.EARVELDAJA_LITEPARSE_OCR_LANGUAGE;
    delete process.env.EARVELDAJA_LITEPARSE_OCR_SERVER_URL;
    delete process.env.EARVELDAJA_LITEPARSE_OCR_ENABLED;
    delete process.env.EARVELDAJA_LITEPARSE_NUM_WORKERS;
    delete process.env.EARVELDAJA_LITEPARSE_MAX_PAGES;
    delete process.env.EARVELDAJA_LITEPARSE_OCR_FAILURE_FATAL;
    delete process.env.EARVELDAJA_LITEPARSE_OCR_HEDGE_DELAYS_MS;
    delete process.env.EARVELDAJA_LITEPARSE_OCR_SERVER_HEADERS;
    delete process.env.EARVELDAJA_LITEPARSE_EMIT_WORD_BOXES;
    delete process.env.EARVELDAJA_LITEPARSE_EXTRACT_LINKS;
    delete process.env.EARVELDAJA_LITEPARSE_IMAGE_MODE;
    delete process.env.EARVELDAJA_LITEPARSE_SKIP_DIAGONAL_TEXT;
    delete process.env.EARVELDAJA_LITEPARSE_DPI;
    delete process.env.EARVELDAJA_LITEPARSE_TARGET_PAGES;
    delete process.env.EARVELDAJA_LITEPARSE_PASSWORD;
    isComplexMock.mockReset();
  });

  it("configures LiteParse for local invoice parsing by default", async () => {
    parseMock.mockResolvedValue({
      text: "Invoice text",
      pages: [{ pageNum: 1 }, { pageNum: 2 }],
    });
    isComplexMock.mockResolvedValue([
      complexityPage({ pageNumber: 1, needsOcr: true, fullPageImage: true }),
      complexityPage({ pageNumber: 2, needsOcr: true, fullPageImage: true }),
    ]);

    const { parseDocument } = await import("./document-parser.js");
    const result = await parseDocument("/tmp/invoice.pdf");

    expect(liteParseConstructor).toHaveBeenCalledWith(expect.objectContaining({
      ocrEnabled: true,
      ocrLanguage: "eng+est",
      ocrFailureFatal: false,
      emitWordBoxes: false,
      extractLinks: false,
      imageMode: "off",
      skipDiagonalText: false,
      outputFormat: "text",
      preserveVerySmallText: true,
    }));
    const defaultConfig = (liteParseConstructor.mock.calls[0] as unknown[] | undefined)?.[0];
    expect(defaultConfig).not.toHaveProperty("numWorkers");
    expect(defaultConfig).not.toHaveProperty("maxPages");
    expect(parseMock).toHaveBeenCalledWith("/tmp/invoice.pdf");
    expect(result).toEqual(expect.objectContaining({
      text: "Invoice text",
      pageCount: 2,
    }));
  });

  it("supports environment overrides for OCR configuration", async () => {
    process.env.EARVELDAJA_LITEPARSE_OCR_LANGUAGE = "est";
    process.env.EARVELDAJA_LITEPARSE_OCR_SERVER_URL = "http://localhost:9999/ocr";
    process.env.EARVELDAJA_LITEPARSE_OCR_ENABLED = "false";
    process.env.EARVELDAJA_LITEPARSE_NUM_WORKERS = "2";
    process.env.EARVELDAJA_LITEPARSE_MAX_PAGES = "50";
    parseMock.mockResolvedValue({
      text: "",
      pages: [],
    });
    isComplexMock.mockResolvedValue([]);

    const { parseDocument } = await import("./document-parser.js");
    await parseDocument("/tmp/invoice.pdf");

    expect(liteParseConstructor).toHaveBeenCalledWith(expect.objectContaining({
      ocrEnabled: false,
      ocrLanguage: "est",
      ocrServerUrl: "http://localhost:9999/ocr",
      numWorkers: 2,
      maxPages: 50,
    }));
  });

  it("supports environment overrides for LiteParse parser quality controls", async () => {
    process.env.EARVELDAJA_LITEPARSE_OCR_FAILURE_FATAL = "true";
    process.env.EARVELDAJA_LITEPARSE_OCR_HEDGE_DELAYS_MS = "0,500,1000";
    process.env.EARVELDAJA_LITEPARSE_OCR_SERVER_HEADERS = "{\"x-api-key\":\"secret\"}";
    process.env.EARVELDAJA_LITEPARSE_EMIT_WORD_BOXES = "true";
    process.env.EARVELDAJA_LITEPARSE_EXTRACT_LINKS = "true";
    process.env.EARVELDAJA_LITEPARSE_IMAGE_MODE = "placeholder";
    process.env.EARVELDAJA_LITEPARSE_SKIP_DIAGONAL_TEXT = "true";
    process.env.EARVELDAJA_LITEPARSE_DPI = "192";
    process.env.EARVELDAJA_LITEPARSE_TARGET_PAGES = "1,3-4";
    process.env.EARVELDAJA_LITEPARSE_PASSWORD = "pdf-password";

    const { buildDocumentParserConfig } = await import("./document-parser.js");

    expect(buildDocumentParserConfig()).toEqual(expect.objectContaining({
      ocrFailureFatal: true,
      ocrHedgeDelaysMs: [0, 500, 1000],
      ocrServerHeaders: { "x-api-key": "secret" },
      emitWordBoxes: true,
      extractLinks: true,
      imageMode: "placeholder",
      skipDiagonalText: true,
      dpi: 192,
      targetPages: "1,3-4",
      password: "pdf-password",
    }));
  });

  it("routes text-native documents through a no-OCR parser after complexity preflight", async () => {
    isComplexMock.mockResolvedValue([
      complexityPage({ pageNumber: 1, needsOcr: false }),
      complexityPage({ pageNumber: 2, needsOcr: false }),
    ]);
    parseMock.mockResolvedValue({
      text: "Native PDF text",
      pages: [{ pageNum: 1, text: "Native PDF text" }],
    });

    const { parseDocument } = await import("./document-parser.js");
    const result = await parseDocument("/tmp/native.pdf");

    expect(isComplexMock).toHaveBeenCalledWith("/tmp/native.pdf");
    expect(liteParseConstructor).toHaveBeenCalledTimes(2);
    expect((liteParseConstructor.mock.calls[1] as unknown[] | undefined)?.[0]).toEqual(expect.objectContaining({
      ocrEnabled: false,
    }));
    expect(result.complexity).toMatchObject({
      anyNeedsOcr: false,
      anyFullPageImage: false,
      anyGarbled: false,
    });
    expect(result.ocrPartialFailure).toBe(false);
  });

  it("keeps OCR enabled when all pages need OCR", async () => {
    isComplexMock.mockResolvedValue([
      complexityPage({ pageNumber: 1, needsOcr: true, fullPageImage: true }),
    ]);
    parseMock.mockResolvedValue({
      text: "OCR text",
      pages: [{ pageNum: 1, text: "OCR text" }],
    });

    const { parseDocument } = await import("./document-parser.js");
    await parseDocument("/tmp/scanned.pdf");

    expect(liteParseConstructor).toHaveBeenCalledTimes(1);
    expect(parseMock).toHaveBeenCalledWith("/tmp/scanned.pdf");
  });

  it("detects likely partial OCR failure when OCR-needed image pages return very short text", async () => {
    isComplexMock.mockResolvedValue([
      complexityPage({
        pageNumber: 1,
        needsOcr: true,
        fullPageImage: true,
        imageCoverage: 0.95,
      }),
    ]);
    parseMock.mockResolvedValue({
      text: "",
      pages: [{ pageNum: 1, text: "   " }],
    });

    const { parseDocument } = await import("./document-parser.js");
    const result = await parseDocument("/tmp/scanned.pdf");

    expect(result.ocrPartialFailure).toBe(true);
  });

  it("detects partial OCR failure when parsed text barely exceeds native textLength (OCR added nothing)", async () => {
    isComplexMock.mockResolvedValue([
      complexityPage({
        pageNumber: 1,
        needsOcr: true,
        fullPageImage: true,
        imageCoverage: 0.95,
        textLength: 50,
      }),
    ]);
    parseMock.mockResolvedValue({
      text: "watermark footer label",
      pages: [{ pageNum: 1, text: "watermark footer label" }],
    });

    const { parseDocument } = await import("./document-parser.js");
    const result = await parseDocument("/tmp/scanned.pdf");

    expect(result.ocrPartialFailure).toBe(true);
  });

  it("does not flag partial OCR failure when OCR added meaningful text beyond native overlay", async () => {
    isComplexMock.mockResolvedValue([
      complexityPage({
        pageNumber: 1,
        needsOcr: true,
        fullPageImage: true,
        imageCoverage: 0.95,
        textLength: 20,
      }),
    ]);
    parseMock.mockResolvedValue({
      text: "watermark\nInvoice 123\nTotal 120.00 EUR\nAcme OÜ\nReg nr 12345678",
      pages: [{ pageNum: 1, text: "watermark\nInvoice 123\nTotal 120.00 EUR\nAcme OÜ\nReg nr 12345678" }],
    });

    const { parseDocument } = await import("./document-parser.js");
    const result = await parseDocument("/tmp/scanned.pdf");

    expect(result.ocrPartialFailure).toBe(false);
  });

  it("reuses a single cached no-OCR parser across multiple text-native parses (#13)", async () => {
    isComplexMock.mockResolvedValue([
      complexityPage({ pageNumber: 1, needsOcr: false }),
    ]);
    parseMock.mockResolvedValue({
      text: "Native PDF text",
      pages: [{ pageNum: 1, text: "Native PDF text" }],
    });

    const { parseDocument } = await import("./document-parser.js");
    await parseDocument("/tmp/native-1.pdf");
    await parseDocument("/tmp/native-2.pdf");

    // Two parses must not build two no-OCR parsers: exactly one OCR-enabled
    // singleton (from the complexity preflight) and one cached no-OCR singleton.
    expect(liteParseConstructor).toHaveBeenCalledTimes(2);
    const noOcrConstructions = liteParseConstructor.mock.calls.filter(
      call => ((call as unknown[])[0] as { ocrEnabled?: boolean } | undefined)?.ocrEnabled === false,
    );
    expect(noOcrConstructions).toHaveLength(1);
  });

  it("does not over-flag a garbled-native-text page (text-dominant, low image coverage) (#17)", async () => {
    // A bad-font / ToUnicode-mapping page is flagged needsOcr + isGarbled but is
    // text-dominant: low image coverage and not a full-page raster. Even though
    // the parsed text barely exceeds native textLength, the image-dominance gate
    // must keep it out of partial-OCR-failure review.
    isComplexMock.mockResolvedValue([
      complexityPage({
        pageNumber: 1,
        needsOcr: true,
        isGarbled: true,
        fullPageImage: false,
        imageCoverage: 0.05,
        textCoverage: 0.6,
        textLength: 40,
      }),
    ]);
    parseMock.mockResolvedValue({
      text: "garbled overlay text",
      pages: [{ pageNum: 1, text: "garbled overlay text" }],
    });

    const { parseDocument } = await import("./document-parser.js");
    const result = await parseDocument("/tmp/garbled-font.pdf");

    expect(result.ocrPartialFailure).toBe(false);
  });

  it("rejects non-loopback http OCR endpoints", async () => {
    process.env.EARVELDAJA_LITEPARSE_OCR_SERVER_URL = "http://ocr.example.com/parse";

    const { buildDocumentParserConfig } = await import("./document-parser.js");

    expect(() => buildDocumentParserConfig()).toThrow(
      "EARVELDAJA_LITEPARSE_OCR_SERVER_URL must use https for remote OCR servers."
    );
  });

  it("accepts https OCR endpoints", async () => {
    process.env.EARVELDAJA_LITEPARSE_OCR_SERVER_URL = "https://ocr.example.com/parse";

    const { buildDocumentParserConfig } = await import("./document-parser.js");

    expect(buildDocumentParserConfig()).toEqual(expect.objectContaining({
      ocrServerUrl: "https://ocr.example.com/parse",
    }));
  });

  it("accepts IPv6 loopback http OCR endpoints", async () => {
    process.env.EARVELDAJA_LITEPARSE_OCR_SERVER_URL = "http://[::1]:9999/ocr";

    const { buildDocumentParserConfig } = await import("./document-parser.js");

    expect(buildDocumentParserConfig()).toEqual(expect.objectContaining({
      ocrServerUrl: "http://[::1]:9999/ocr",
    }));
  });

  it("rejects malformed tokens in EARVELDAJA_LITEPARSE_OCR_HEDGE_DELAYS_MS", async () => {
    process.env.EARVELDAJA_LITEPARSE_OCR_HEDGE_DELAYS_MS = "500,typo,1000";

    const { buildDocumentParserConfig } = await import("./document-parser.js");

    expect(() => buildDocumentParserConfig()).toThrow(
      /EARVELDAJA_LITEPARSE_OCR_HEDGE_DELAYS_MS contains invalid value "typo"/,
    );
  });

  it("rejects negative numbers in EARVELDAJA_LITEPARSE_OCR_HEDGE_DELAYS_MS", async () => {
    process.env.EARVELDAJA_LITEPARSE_OCR_HEDGE_DELAYS_MS = "0,-500,1000";

    const { buildDocumentParserConfig } = await import("./document-parser.js");

    expect(() => buildDocumentParserConfig()).toThrow(
      /EARVELDAJA_LITEPARSE_OCR_HEDGE_DELAYS_MS contains invalid value "-500"/,
    );
  });

  it("returns undefined for unset EARVELDAJA_LITEPARSE_OCR_HEDGE_DELAYS_MS", async () => {
    const { buildDocumentParserConfig } = await import("./document-parser.js");
    const config = buildDocumentParserConfig();
    expect(config.ocrHedgeDelaysMs).toBeUndefined();
  });

  it("names the cause when the installed LiteParse predates isComplex", async () => {
    // @llamaindex/liteparse gained isComplex in 2.2.0. The declared range once
    // started at ^2.0.4, so a tree that resolved below that — a cached npx
    // install, most often — reached a bare "isComplex is not a function" on the
    // first PDF, with nothing pointing at the dependency.
    // @ts-expect-error a LiteParse build without isComplex (pre-2.2.0) must be named as the cause
    liteParseConstructor.mockImplementationOnce(function OldLiteParse() {
      return { parse: parseMock };
    });

    const { analyzeDocumentComplexity } = await import("./document-parser.js");

    await expect(analyzeDocumentComplexity("/tmp/invoice.pdf")).rejects.toThrow(
      /missing isComplex.*@llamaindex\/liteparse >= 2\.9\.0/s,
    );
  });

  it("declares a LiteParse floor that actually has the methods it calls", async () => {
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    const range = manifest.dependencies["@llamaindex/liteparse"]!;

    // Pinning the floor, not the range syntax: anything below 2.2.0 lacks
    // isComplex, and 2.9.0 is the version the suite is exercised against.
    const [, major, minor] = /^\^(\d+)\.(\d+)\./.exec(range) ?? [];
    expect(Number(major)).toBe(2);
    expect(Number(minor)).toBeGreaterThanOrEqual(9);
  });
});

describe("lost-value render/OCR seam", () => {
  beforeEach(() => {
    vi.resetModules();
    parseMock.mockReset();
    screenshotMock.mockReset();
    liteParseConstructor.mockClear();
    delete process.env.EARVELDAJA_LITEPARSE_OCR_ENABLED;
    delete process.env.EARVELDAJA_READING_LOST_VALUE_IMAGES;
    delete process.env.EARVELDAJA_LITEPARSE_OCR_LANGUAGE;
    delete process.env.EARVELDAJA_LITEPARSE_OCR_SERVER_URL;
    delete process.env.EARVELDAJA_LITEPARSE_DPI;
  });

  it("is available unless OCR is disabled or the kill switch is set", async () => {
    const { lostValueImagesAvailable } = await import("./document-parser.js");
    expect(lostValueImagesAvailable()).toBe(true);
    process.env.EARVELDAJA_READING_LOST_VALUE_IMAGES = "0";
    expect(lostValueImagesAvailable()).toBe(false);
    process.env.EARVELDAJA_READING_LOST_VALUE_IMAGES = "1";
    process.env.EARVELDAJA_LITEPARSE_OCR_ENABLED = "false";
    expect(lostValueImagesAvailable()).toBe(false);
    delete process.env.EARVELDAJA_LITEPARSE_OCR_ENABLED;
    expect(lostValueImagesAvailable()).toBe(true);
  });

  it("renders and OCRs on a dedicated 300-dpi instance with OCR failure fatal; only language and server come from config", async () => {
    process.env.EARVELDAJA_LITEPARSE_OCR_LANGUAGE = "est";
    process.env.EARVELDAJA_LITEPARSE_OCR_SERVER_URL = "https://ocr.example.test/ocr";
    process.env.EARVELDAJA_LITEPARSE_DPI = "150";
    screenshotMock.mockResolvedValue([{ pageNum: 2, width: 10, height: 20, imageBuffer: Buffer.from("png") }]);
    parseMock.mockResolvedValue({ pages: [{ textItems: [{ text: "x", x: 1, y: 2, width: 3, height: 4, confidence: 0.9, fontName: "f" }] }] });
    const { renderPagePng, ocrPng } = await import("./document-parser.js");
    expect(await renderPagePng("/tmp/a.pdf", 2)).toEqual({ png: Buffer.from("png"), width: 10, height: 20 });
    expect(screenshotMock).toHaveBeenCalledWith("/tmp/a.pdf", [2]);
    expect(await ocrPng(Buffer.from("crop"))).toEqual({ ok: true, items: [{ text: "x", x: 1, y: 2, width: 3, height: 4, confidence: 0.9 }] });
    expect(liteParseConstructor).toHaveBeenCalledTimes(1);
    expect((liteParseConstructor.mock.calls[0] as unknown[] | undefined)?.[0]).toEqual({
      ocrEnabled: true, ocrFailureFatal: true, dpi: 300, outputFormat: "text", quiet: true,
      ocrLanguage: "est", ocrServerUrl: "https://ocr.example.test/ocr",
    });
  });

  it("refuses a render of another page", async () => {
    screenshotMock.mockResolvedValue([{ pageNum: 1, width: 10, height: 20, imageBuffer: Buffer.from("png") }]);
    const { renderPagePng } = await import("./document-parser.js");
    await expect(renderPagePng("/tmp/a.pdf", 2)).rejects.toThrow("page render unavailable");
  });

  it("resolves an OCR failure or timeout to unavailable and runs one OCR at a time", async () => {
    const { ocrPng } = await import("./document-parser.js");
    parseMock.mockRejectedValueOnce(new Error("failed to download tessdata"));
    expect(await ocrPng(Buffer.from("a"))).toEqual({ ok: false });

    let release: (value: unknown) => void = () => {};
    parseMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    parseMock.mockResolvedValueOnce({ pages: [{ textItems: [] }] });
    const slow = ocrPng(Buffer.from("b"), 20);
    const next = ocrPng(Buffer.from("c"));
    expect(await slow).toEqual({ ok: false });
    // The timed-out OCR is still running natively, so the next one has not started.
    expect(parseMock).toHaveBeenCalledTimes(2);
    release({ pages: [{ textItems: [] }] });
    expect(await next).toEqual({ ok: true, items: [] });
    expect(parseMock).toHaveBeenCalledTimes(3);
  });

  // Review MAJOR-3: timed-out jobs stayed queued with their crops and still ran later.
  it("drops a queued OCR whose caller already timed out, and never runs it", async () => {
    const { ocrPng } = await import("./document-parser.js");
    let release: (value: unknown) => void = () => {};
    parseMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    parseMock.mockResolvedValue({ pages: [{ textItems: [] }] });
    const first = ocrPng(Buffer.from("a"), 10);
    const second = ocrPng(Buffer.from("b"), 10);
    expect(await first).toEqual({ ok: false });
    expect(await second).toEqual({ ok: false });
    release({ pages: [{ textItems: [] }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(await ocrPng(Buffer.from("c"))).toEqual({ ok: true, items: [] });
    expect(parseMock).toHaveBeenCalledTimes(2);
  });

  it("answers unavailable at once past the queue cap while an OCR stalls", async () => {
    const { ocrPng, LOST_VALUE_OCR_QUEUE_MAX } = await import("./document-parser.js");
    let release: (value: unknown) => void = () => {};
    parseMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    parseMock.mockResolvedValue({ pages: [{ textItems: [] }] });
    const queued = Array.from({ length: LOST_VALUE_OCR_QUEUE_MAX }, (_, i) => ocrPng(Buffer.from(`q${i}`), 10));
    expect(await Promise.all(queued)).toEqual(queued.map(() => ({ ok: false })));
    // The stalled OCR still holds the queue: a call with a 60 s timeout must not wait for it.
    const started = Date.now();
    expect(await ocrPng(Buffer.from("over"), 60_000)).toEqual({ ok: false });
    expect(Date.now() - started).toBeLessThan(1000);
    release({ pages: [{ textItems: [] }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(await ocrPng(Buffer.from("after"))).toEqual({ ok: true, items: [] });
  });
});

function complexityPage(overrides: Partial<{
  pageNumber: number;
  textLength: number;
  textCoverage: number;
  hasSubstantialImages: boolean;
  imageBlockCount: number;
  imageCoverage: number;
  largestImageCoverage: number;
  fullPageImage: boolean;
  isGarbled: boolean;
  pageArea: number;
  needsOcr: boolean;
  reasons: string[];
}>) {
  return {
    pageNumber: 1,
    textLength: 100,
    textCoverage: 0.1,
    hasSubstantialImages: false,
    imageBlockCount: 0,
    imageCoverage: 0,
    largestImageCoverage: 0,
    fullPageImage: false,
    isGarbled: false,
    pageArea: 10000,
    needsOcr: false,
    reasons: [],
    ...overrides,
  };
}
