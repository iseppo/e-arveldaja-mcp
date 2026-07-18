import { isAbsolute } from "node:path";

export const PROMPT_ARGUMENT_LIMITS = Object.freeze({
  /** Bounds decimal parsing work even when the value is mostly insignificant zeroes. */
  numberCharacters: 128,
  /** Fractional lexemes use at most 15 significant decimal digits to avoid Number rounding collapse. */
  numberSignificantDigits: 15,
  identifierCharacters: 512,
  pathCharacters: 4_096,
  jsonBytes: 20_000,
  jsonDepth: 8,
  jsonNodes: 512,
  jsonKeysPerObject: 128,
} as const);

interface NumericRange {
  min?: number;
  max?: number;
}

interface IdentifierOptions {
  maxCharacters?: number;
}

const CANONICAL_POSITIVE_INTEGER = /^[1-9]\d*$/;
const CANONICAL_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const DANGEROUS_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function invalid(kind: string): Error {
  return new Error(`Invalid ${kind} prompt argument`);
}

function requireString(value: string, kind: string): string {
  if (typeof value !== "string") {
    throw invalid(kind);
  }
  return value;
}

function requireRange(value: number, range: NumericRange, kind: string): number {
  if ((range.min !== undefined && value < range.min)
    || (range.max !== undefined && value > range.max)) {
    throw invalid(kind);
  }
  return value;
}

export function parsePositiveInteger(value: string, range: NumericRange = {}): number {
  const source = requireString(value, "positive integer");
  if (!CANONICAL_POSITIVE_INTEGER.test(source)) {
    throw invalid("positive integer");
  }

  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw invalid("positive integer");
  }
  return requireRange(parsed, range, "positive integer");
}

export function parseFiniteNumber(value: string, range: NumericRange = {}): number {
  const source = requireString(value, "finite number");
  if (source.length > PROMPT_ARGUMENT_LIMITS.numberCharacters
    || !CANONICAL_DECIMAL.test(source)
    || /^-0(?:\.0+)?$/.test(source)) {
    throw invalid("finite number");
  }

  const parsed = Number(source);
  if (!Number.isFinite(parsed)
    || Object.is(parsed, -0)
    || (parsed === 0 && /[1-9]/.test(source))) {
    throw invalid("finite number");
  }

  const unsigned = source.startsWith("-") ? source.slice(1) : source;
  const decimalIndex = unsigned.indexOf(".");
  if (decimalIndex === -1) {
    if (!Number.isSafeInteger(parsed)) {
      throw invalid("finite number");
    }
  } else {
    const significantDigits = unsigned.replace(".", "").replace(/^0+/, "");
    if (Math.abs(parsed) > Number.MAX_SAFE_INTEGER
      || significantDigits.length > PROMPT_ARGUMENT_LIMITS.numberSignificantDigits) {
      throw invalid("finite number");
    }
  }
  return requireRange(parsed, range, "finite number");
}

export function parseExactBoolean(value: string): boolean {
  const source = requireString(value, "boolean");
  if (source === "true") return true;
  if (source === "false") return false;
  throw invalid("boolean");
}

export function parseIsoDate(value: string): string {
  const source = requireString(value, "ISO date");
  if (!ISO_DATE.test(source)) {
    throw invalid("ISO date");
  }

  const parsed = new Date(`${source}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== source) {
    throw invalid("ISO date");
  }
  return source;
}

export function parseMonth(value: string): string {
  const source = requireString(value, "month");
  if (!MONTH.test(source)) {
    throw invalid("month");
  }
  return source;
}

export function parseAbsolutePath(value: string): string {
  const source = requireString(value, "absolute path");
  if (source.length === 0
    || source.length > PROMPT_ARGUMENT_LIMITS.pathCharacters
    || CONTROL_CHARACTER.test(source)
    || !isAbsolute(source)) {
    throw invalid("absolute path");
  }
  return source;
}

export function parseIdentifier(value: string, options: IdentifierOptions = {}): string {
  const source = requireString(value, "identifier");
  const maxCharacters = options.maxCharacters ?? PROMPT_ARGUMENT_LIMITS.identifierCharacters;
  if (!Number.isSafeInteger(maxCharacters)
    || maxCharacters <= 0
    || maxCharacters > PROMPT_ARGUMENT_LIMITS.identifierCharacters
    || source.trim().length === 0
    || source.length > maxCharacters
    || CONTROL_CHARACTER.test(source)) {
    throw invalid("identifier");
  }
  return source;
}

function validateJsonNode(value: unknown, depth: number, state: { nodes: number }): void {
  state.nodes += 1;
  if (state.nodes > PROMPT_ARGUMENT_LIMITS.jsonNodes) {
    throw invalid("JSON object");
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    throw invalid("JSON object");
  }
  if (value === null || typeof value !== "object") return;
  if (depth > PROMPT_ARGUMENT_LIMITS.jsonDepth) {
    throw invalid("JSON object");
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      validateJsonNode(item, depth + 1, state);
    }
    return;
  }

  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length > PROMPT_ARGUMENT_LIMITS.jsonKeysPerObject
    || keys.some(key => DANGEROUS_JSON_KEYS.has(key))) {
    throw invalid("JSON object");
  }
  for (const key of keys) {
    validateJsonNode(object[key], depth + 1, state);
  }
}

/**
 * JSON.parse intentionally keeps the final value for a duplicate object key.
 * Walk the already syntax-validated source so duplicates are rejected before
 * that information is lost. Strings are scanned as JSON tokens, so escaped
 * quotes/braces remain inert; decoded keys also catch aliases such as `id` and
 * `\u0069d` in the same object.
 */
function rejectDuplicateJsonKeys(source: string): void {
  let cursor = 0;

  const skipWhitespace = (): void => {
    while (cursor < source.length && /[\u0009\u000a\u000d\u0020]/.test(source[cursor]!)) {
      cursor += 1;
    }
  };

  const readString = (): string => {
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      const character = source[cursor]!;
      if (character === '"') {
        cursor += 1;
        return JSON.parse(source.slice(start, cursor)) as string;
      }
      if (character === "\\") {
        cursor += source[cursor + 1] === "u" ? 6 : 2;
      } else {
        cursor += 1;
      }
    }
    throw invalid("JSON object");
  };

  const readValue = (): void => {
    skipWhitespace();
    const character = source[cursor];
    if (character === "{") {
      readObject();
      return;
    }
    if (character === "[") {
      readArray();
      return;
    }
    if (character === '"') {
      readString();
      return;
    }
    while (cursor < source.length && !/[\u0009\u000a\u000d\u0020,\]}]/.test(source[cursor]!)) {
      cursor += 1;
    }
  };

  const readObject = (): void => {
    cursor += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (source[cursor] === "}") {
      cursor += 1;
      return;
    }
    while (cursor < source.length) {
      skipWhitespace();
      const key = readString();
      if (keys.has(key)) {
        throw invalid("JSON object");
      }
      keys.add(key);
      skipWhitespace();
      cursor += 1; // colon; JSON.parse already validated the grammar
      readValue();
      skipWhitespace();
      if (source[cursor] === "}") {
        cursor += 1;
        return;
      }
      cursor += 1; // comma
    }
  };

  const readArray = (): void => {
    cursor += 1;
    skipWhitespace();
    if (source[cursor] === "]") {
      cursor += 1;
      return;
    }
    while (cursor < source.length) {
      readValue();
      skipWhitespace();
      if (source[cursor] === "]") {
        cursor += 1;
        return;
      }
      cursor += 1; // comma
    }
  };

  readValue();
}

export function parseJsonObject(value: string): Record<string, unknown> {
  const source = requireString(value, "JSON object");
  if (Buffer.byteLength(source, "utf8") > PROMPT_ARGUMENT_LIMITS.jsonBytes) {
    throw invalid("JSON object");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw invalid("JSON object");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalid("JSON object");
  }
  validateJsonNode(parsed, 1, { nodes: 0 });
  rejectDuplicateJsonKeys(source);
  return parsed as Record<string, unknown>;
}
