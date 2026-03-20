import { LiteParse, type LiteParseConfig, type ParseResult } from "@llamaindex/liteparse";

interface ParsedDocument {
  text: string;
  pageCount: number;
  result: ParseResult;
}

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return value !== "0" && value.toLowerCase() !== "false";
}

function readNumberEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function buildDocumentParserConfig(): Partial<LiteParseConfig> {
  return {
    // Most invoices here are Estonian/English. LiteParse's built-in Tesseract
    // supports multi-language strings like "eng+est".
    ocrEnabled: readBooleanEnv("EARVELDAJA_LITEPARSE_OCR_ENABLED", true),
    ocrLanguage: process.env.EARVELDAJA_LITEPARSE_OCR_LANGUAGE ?? "eng+est",
    ocrServerUrl: process.env.EARVELDAJA_LITEPARSE_OCR_SERVER_URL || undefined,
    numWorkers: readNumberEnv("EARVELDAJA_LITEPARSE_NUM_WORKERS"),
    maxPages: readNumberEnv("EARVELDAJA_LITEPARSE_MAX_PAGES"),
    outputFormat: "text",
    preciseBoundingBox: false,
    preserveVerySmallText: true,
  };
}

let parser: LiteParse | undefined;

export function getDocumentParser(): LiteParse {
  parser ??= new LiteParse(buildDocumentParserConfig());
  return parser;
}

export async function parseDocument(filePath: string): Promise<ParsedDocument> {
  const result = await getDocumentParser().parse(filePath, true);
  return {
    text: result.text,
    pageCount: result.pages.length,
    result,
  };
}

export function resetDocumentParserForTests(): void {
  parser = undefined;
}
