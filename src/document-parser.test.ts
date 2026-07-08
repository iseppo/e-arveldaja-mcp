import { beforeEach, describe, expect, it, vi } from "vitest";

const parseMock = vi.fn();
const isComplexMock = vi.fn();
const liteParseConstructor = vi.fn(function LiteParseMock() {
  return {
    parse: parseMock,
    isComplex: isComplexMock,
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
    const defaultConfig = liteParseConstructor.mock.calls[0]?.[0];
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
    expect(liteParseConstructor.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
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
