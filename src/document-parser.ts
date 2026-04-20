import { LiteParse, type LiteParseConfig, type ParseResult } from "@llamaindex/liteparse";

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function validateOcrUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(
        `EARVELDAJA_LITEPARSE_OCR_SERVER_URL must use https, or http only for a local loopback OCR server, got: ${parsed.protocol}`
      );
    }
    if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
      throw new Error(
        "EARVELDAJA_LITEPARSE_OCR_SERVER_URL must use https for remote OCR servers. " +
        "Plain http is only allowed for localhost / loopback OCR services."
      );
    }
    return url;
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`EARVELDAJA_LITEPARSE_OCR_SERVER_URL is not a valid URL: ${url}`);
    }
    throw err;
  }
}

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
  const config: Partial<LiteParseConfig> = {
    // Most invoices here are Estonian/English. LiteParse's built-in Tesseract
    // supports multi-language strings like "eng+est".
    ocrEnabled: readBooleanEnv("EARVELDAJA_LITEPARSE_OCR_ENABLED", true),
    ocrLanguage: process.env.EARVELDAJA_LITEPARSE_OCR_LANGUAGE ?? "eng+est",
    ocrServerUrl: validateOcrUrl(process.env.EARVELDAJA_LITEPARSE_OCR_SERVER_URL),
    outputFormat: "text",
    preciseBoundingBox: false,
    preserveVerySmallText: true,
  };

  const numWorkers = readNumberEnv("EARVELDAJA_LITEPARSE_NUM_WORKERS");
  if (numWorkers !== undefined) config.numWorkers = numWorkers;

  const maxPages = readNumberEnv("EARVELDAJA_LITEPARSE_MAX_PAGES");
  if (maxPages !== undefined) config.maxPages = maxPages;

  return config;
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
