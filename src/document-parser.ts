import {
  LiteParse,
  type ImageMode,
  type LiteParseConfig,
  type PageComplexityStats,
  type ParseResult,
} from "@llamaindex/liteparse";

const HIGH_IMAGE_COVERAGE_FOR_PARTIAL_OCR = 0.5;

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

export interface ParsedDocumentComplexity {
  pages: PageComplexityStats[];
  anyNeedsOcr: boolean;
  anyFullPageImage: boolean;
  anyGarbled: boolean;
}

export interface ParsedDocument {
  text: string;
  pageCount: number;
  result: ParseResult;
  complexity?: ParsedDocumentComplexity;
  ocrPartialFailure?: boolean;
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

function readNumberListEnv(name: string): number[] | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const tokens = value.split(",");
  const parsed: number[] = [];
  for (const token of tokens) {
    const trimmed = token.trim();
    const number = Number(trimmed);
    if (!Number.isFinite(number) || number < 0) {
      throw new Error(
        `${name} contains invalid value "${trimmed}" — expected comma-separated non-negative numbers (e.g. "0,5000,10000")`,
      );
    }
    parsed.push(number);
  }
  return parsed;
}

function readJsonStringRecordEnv(name: string): Record<string, string> | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object with string values`);
  }
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(parsed)) {
    if (typeof headerValue !== "string") {
      throw new Error(`${name} must be a JSON object with string values`);
    }
    headers[key] = headerValue;
  }
  return headers;
}

function readImageModeEnv(name: string, defaultValue: ImageMode): ImageMode {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  if (value === "off" || value === "placeholder" || value === "embed") return value;
  throw new Error(`${name} must be one of: off, placeholder, embed`);
}

export function buildDocumentParserConfig(): Partial<LiteParseConfig> {
  const config: Partial<LiteParseConfig> = {
    // Most invoices here are Estonian/English. LiteParse's built-in Tesseract
    // supports multi-language strings like "eng+est".
    ocrEnabled: readBooleanEnv("EARVELDAJA_LITEPARSE_OCR_ENABLED", true),
    ocrLanguage: process.env.EARVELDAJA_LITEPARSE_OCR_LANGUAGE ?? "eng+est",
    ocrServerUrl: validateOcrUrl(process.env.EARVELDAJA_LITEPARSE_OCR_SERVER_URL),
    ocrFailureFatal: readBooleanEnv("EARVELDAJA_LITEPARSE_OCR_FAILURE_FATAL", false),
    emitWordBoxes: readBooleanEnv("EARVELDAJA_LITEPARSE_EMIT_WORD_BOXES", false),
    extractLinks: readBooleanEnv("EARVELDAJA_LITEPARSE_EXTRACT_LINKS", false),
    imageMode: readImageModeEnv("EARVELDAJA_LITEPARSE_IMAGE_MODE", "off"),
    skipDiagonalText: readBooleanEnv("EARVELDAJA_LITEPARSE_SKIP_DIAGONAL_TEXT", false),
    outputFormat: "text",
    preserveVerySmallText: true,
  };

  const numWorkers = readNumberEnv("EARVELDAJA_LITEPARSE_NUM_WORKERS");
  if (numWorkers !== undefined) config.numWorkers = numWorkers;

  const maxPages = readNumberEnv("EARVELDAJA_LITEPARSE_MAX_PAGES");
  if (maxPages !== undefined) config.maxPages = maxPages;

  const dpi = readNumberEnv("EARVELDAJA_LITEPARSE_DPI");
  if (dpi !== undefined) config.dpi = dpi;

  const ocrHedgeDelaysMs = readNumberListEnv("EARVELDAJA_LITEPARSE_OCR_HEDGE_DELAYS_MS");
  if (ocrHedgeDelaysMs !== undefined) config.ocrHedgeDelaysMs = ocrHedgeDelaysMs;

  const ocrServerHeaders = readJsonStringRecordEnv("EARVELDAJA_LITEPARSE_OCR_SERVER_HEADERS");
  if (ocrServerHeaders !== undefined) config.ocrServerHeaders = ocrServerHeaders;

  if (process.env.EARVELDAJA_LITEPARSE_TARGET_PAGES) {
    config.targetPages = process.env.EARVELDAJA_LITEPARSE_TARGET_PAGES;
  }

  if (process.env.EARVELDAJA_LITEPARSE_PASSWORD) {
    config.password = process.env.EARVELDAJA_LITEPARSE_PASSWORD;
  }

  return config;
}

let parser: LiteParse | undefined;
let ocrDisabledParser: LiteParse | undefined;

/**
 * Methods this module calls on LiteParse. `isComplex` only exists from
 * @llamaindex/liteparse 2.2.0 — the declared range used to start at ^2.0.4, so
 * an install that resolved below 2.2.0 (a cached npx tree, a lockfile pinning
 * an older 2.x) crashed with a bare "isComplex is not a function" the moment a
 * PDF was parsed, while this repo's own lockfile pinned a version that worked.
 * The range now starts at the version we test against; this check turns any
 * remaining mismatch into an error that names the cause.
 */
const REQUIRED_PARSER_METHODS = ["isComplex", "parse"] as const;

function assertParserApi(candidate: LiteParse): LiteParse {
  const missing = REQUIRED_PARSER_METHODS.filter(
    method => typeof (candidate as unknown as Record<string, unknown>)[method] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(
      `The installed @llamaindex/liteparse is missing ${missing.join(", ")}. ` +
      "This build needs @llamaindex/liteparse >= 2.9.0. Reinstall the server so the " +
      "dependency resolves to a supported version (for an npx install, clear its cache first).",
    );
  }
  return candidate;
}

export function getDocumentParser(): LiteParse {
  parser ??= assertParserApi(new LiteParse(buildDocumentParserConfig()));
  return parser;
}

/**
 * Singleton parser with OCR disabled, used for documents whose preflight found
 * no OCR-needed page. Cached like the OCR-enabled parser so a batch of native
 * PDFs doesn't reconstruct a fresh LiteParse per file.
 */
function getOcrDisabledDocumentParser(): LiteParse {
  ocrDisabledParser ??= assertParserApi(
    new LiteParse({ ...buildDocumentParserConfig(), ocrEnabled: false }),
  );
  return ocrDisabledParser;
}

export async function analyzeDocumentComplexity(filePath: string): Promise<PageComplexityStats[]> {
  return getDocumentParser().isComplex(filePath);
}

function summarizeComplexity(pages: PageComplexityStats[]): ParsedDocumentComplexity {
  return {
    pages,
    anyNeedsOcr: pages.some(page => page.needsOcr),
    anyFullPageImage: pages.some(page => page.fullPageImage),
    anyGarbled: pages.some(page => page.isGarbled),
  };
}

function pageTextLength(result: ParseResult, pageNumber: number): number {
  const page = result.pages.find(candidate => candidate.pageNum === pageNumber);
  return page?.text?.trim().length ?? 0;
}

// Intended trigger (#17): only a page that (a) the preflight said needs OCR AND
// (b) is image-dominant — a full-page raster, or ≥50% image coverage — AND
// (c) came back with essentially no text beyond the native overlay. The
// image-dominance gate (b) is what keeps a *garbled-native-text* page (bad
// font/ToUnicode mapping but text-dominant, low image coverage, not a
// full-page image) from being flagged here: such a page fails (b) and returns
// early, so it is never routed to review by this heuristic. The check
// deliberately errs toward review — a false positive costs a manual look,
// while a false negative would silently book a document whose OCR text is
// missing. Do not loosen it into silently accepting an image page whose OCR
// produced nothing.
function detectOcrPartialFailure(complexity: ParsedDocumentComplexity, result: ParseResult): boolean {
  return complexity.pages.some(page => {
    if (!page.needsOcr) return false;
    if (!page.fullPageImage && page.imageCoverage < HIGH_IMAGE_COVERAGE_FOR_PARTIAL_OCR) return false;
    const parsedLength = pageTextLength(result, page.pageNumber);
    // Primary heuristic: compare parsed text length against the preflight
    // native textLength. If OCR didn't add meaningful text beyond the native
    // overlay (watermark, footer, page label), it's a partial failure. This
    // catches a complete OCR miss where native text survived.
    if (parsedLength <= page.textLength + 10) return true;
    // Secondary heuristic: very short parsed text (< 10 chars) on a page that
    // needed OCR — covers the case where textLength was 0 (no native text at
    // all) and OCR produced almost nothing.
    return parsedLength < 10;
  });
}

export async function parseDocument(filePath: string): Promise<ParsedDocument> {
  const complexity = summarizeComplexity(await analyzeDocumentComplexity(filePath));
  const parserForParse = !complexity.anyNeedsOcr
    ? getOcrDisabledDocumentParser()
    : getDocumentParser();
  const result = await parserForParse.parse(filePath);
  return {
    text: result.text,
    pageCount: result.pages.length,
    result,
    complexity,
    ocrPartialFailure: detectOcrPartialFailure(complexity, result),
  };
}

// ---------------------------------------------------------------------------
// Lost-value image path (plan lost-value-image-ocr): page render + crop OCR.
// ---------------------------------------------------------------------------

export const LOST_VALUE_RENDER_DPI = 300;
export const LOST_VALUE_OCR_TIMEOUT_MS = 30_000;

/** A text item OCR read from a crop, in the crop's own coordinates. */
export interface OcrTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
}

export type OcrPngResult = { ok: true; items: OcrTextItem[] } | { ok: false };

/** False when OCR is disabled or the kill switch EARVELDAJA_READING_LOST_VALUE_IMAGES=0 is set. */
export function lostValueImagesAvailable(): boolean {
  if (!readBooleanEnv("EARVELDAJA_READING_LOST_VALUE_IMAGES", true)) return false;
  try {
    return buildDocumentParserConfig().ocrEnabled !== false;
  } catch {
    return false;
  }
}

let lostValueParser: LiteParse | undefined;

/**
 * Dedicated instance: 300 dpi, OCR on, OCR failure fatal (a failed OCR is a
 * hold, never an empty read). Only the OCR language and server settings come
 * from the configuration; a configured OCR server receives the crops.
 */
function getLostValueParser(): LiteParse {
  if (lostValueParser) return lostValueParser;
  const base = buildDocumentParserConfig();
  lostValueParser = new LiteParse({
    ocrEnabled: true,
    ocrFailureFatal: true,
    dpi: LOST_VALUE_RENDER_DPI,
    outputFormat: "text",
    quiet: true,
    ...(base.ocrLanguage !== undefined ? { ocrLanguage: base.ocrLanguage } : {}),
    ...(base.ocrServerUrl !== undefined ? { ocrServerUrl: base.ocrServerUrl } : {}),
    ...(base.ocrServerHeaders !== undefined ? { ocrServerHeaders: base.ocrServerHeaders } : {}),
  });
  return lostValueParser;
}

/** One page rendered to an RGBA PNG at 300 dpi (full page; liteparse ignores cropBox for screenshots). */
export async function renderPagePng(filePath: string, page: number): Promise<{ png: Buffer; width: number; height: number }> {
  const [shot] = await getLostValueParser().screenshot(filePath, [page]);
  if (!shot || shot.pageNum !== page) throw new Error("page render unavailable");
  return { png: shot.imageBuffer, width: shot.width, height: shot.height };
}

let ocrQueue: Promise<unknown> = Promise.resolve();

/**
 * OCR of one PNG crop. Single-flight: one OCR at a time, the next waits for the
 * previous native work to settle (a timed-out OCR keeps running natively).
 * Every failure and the 30 s timeout resolve to { ok: false }.
 */
export function ocrPng(png: Buffer, timeoutMs = LOST_VALUE_OCR_TIMEOUT_MS): Promise<OcrPngResult> {
  const work = ocrQueue.then(() => getLostValueParser().parse(png));
  ocrQueue = work.catch(() => undefined);
  const outcome = work.then(
    (result): OcrPngResult => ({
      ok: true,
      items: (result.pages[0]?.textItems ?? []).map(({ text, x, y, width, height, confidence }) =>
        ({ text, x, y, width, height, ...(confidence !== undefined ? { confidence } : {}) })),
    }),
    (): OcrPngResult => ({ ok: false }),
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<OcrPngResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([outcome, timeout]).finally(() => clearTimeout(timer));
}
