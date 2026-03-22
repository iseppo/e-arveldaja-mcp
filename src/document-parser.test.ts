import { beforeEach, describe, expect, it, vi } from "vitest";

const parseMock = vi.fn();
const liteParseConstructor = vi.fn(function LiteParseMock() {
  return {
    parse: parseMock,
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
  });

  it("configures LiteParse for local invoice parsing by default", async () => {
    parseMock.mockResolvedValue({
      text: "Invoice text",
      pages: [{ pageNum: 1 }, { pageNum: 2 }],
    });

    const { parseDocument } = await import("./document-parser.js");
    const result = await parseDocument("/tmp/invoice.pdf");

    expect(liteParseConstructor).toHaveBeenCalledWith(expect.objectContaining({
      ocrEnabled: true,
      ocrLanguage: "eng+est",
      outputFormat: "text",
      preciseBoundingBox: false,
      preserveVerySmallText: true,
    }));
    const defaultConfig = liteParseConstructor.mock.calls[0]?.[0];
    expect(defaultConfig).not.toHaveProperty("numWorkers");
    expect(defaultConfig).not.toHaveProperty("maxPages");
    expect(parseMock).toHaveBeenCalledWith("/tmp/invoice.pdf", true);
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
});
