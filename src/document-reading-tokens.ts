// PURE module (P1 reading checker): one token definition for every check.
// Tokens are line-scoped and never cross the column mark ` ¦ `.
// Plan: .omc/plans/p1-reading-checker.md §2.0.

import {
  isForeignVatShape,
  isValidEeRegistryCode,
  isValidEeVatNumber,
  isValidIban,
  normalizeVatValue,
} from "./document-identifiers.js";
import { isStrictDate } from "./strict-date.js";
import { COLUMN_MARK } from "./document-reading-packet.js";

/** Hyphen and minus/dash variants; the same set as the credit-word normalisation. */
export const DASHES = "-\u2212\u2013\u2010\u2011\u2012\u2014";
const DASH_CLASS = "\\-\u2212\u2013\u2010\u2011\u2012\u2014";

export interface Span { start: number; end: number }
export interface TokenLine { id: string; text: string }

export interface Cell extends Span { index: number; text: string }
export interface Word extends Span { cell: number; text: string }
export type MoneyKind = "decimal" | "integer" | "ambiguous" | "ambiguous_join";
export interface MoneyToken extends Span {
  cell: number;
  text: string;
  kind: MoneyKind;
  /** Every reading; one entry for decimal / integer tokens. */
  values: number[];
  signed: boolean;
}
export interface DateToken extends Span {
  cell: number;
  text: string;
  /** Canonical YYYY-MM-DD readings (two for an ambiguous slash date). */
  values: string[];
  ambiguousSlash: boolean;
}
export interface WordToken extends Span { cell: number; text: string }
export interface LineTokens {
  cells: Cell[];
  words: Word[];
  money: MoneyToken[];
  dates: DateToken[];
  wordTokens: WordToken[];
}

// ---------------------------------------------------------------------------
// Cells and words
// ---------------------------------------------------------------------------

export function lineCells(text: string): Cell[] {
  const cells: Cell[] = [];
  let start = 0;
  for (;;) {
    const at = text.indexOf(COLUMN_MARK, start);
    const end = at < 0 ? text.length : at;
    cells.push({ index: cells.length, start, end, text: text.slice(start, end) });
    if (at < 0) break;
    start = at + COLUMN_MARK.length;
  }
  return cells;
}

function cellWords(cell: Cell): Word[] {
  const words: Word[] = [];
  for (const match of cell.text.matchAll(/[^ ]+/g)) {
    const start = cell.start + match.index!;
    words.push({ cell: cell.index, start, end: start + match[0].length, text: match[0] });
  }
  return words;
}

const LEAD_STRIP_RE = new RegExp(`^[(\\[{"'«„“${DASH_CLASS}\\p{Sc}]+`, "u");
const TRAIL_STRIP_RE = new RegExp(`[)\\]}"'»”.,;:!?${DASH_CLASS}\\p{Sc}]+$`, "u");

interface WordCore { core: string; offset: number; lead: string; trail: string }

function wordCore(word: Word): WordCore {
  const lead = LEAD_STRIP_RE.exec(word.text)?.[0] ?? "";
  const rest = word.text.slice(lead.length);
  const trail = TRAIL_STRIP_RE.exec(rest)?.[0] ?? "";
  return { core: rest.slice(0, rest.length - trail.length), offset: lead.length, lead, trail };
}

function isCurrencyWord(word: Word | undefined): boolean {
  if (!word) return false;
  const bare = word.text.replace(/^[(\[]+|[)\],.;:]+$/g, "");
  return bare === "\u20AC" || bare === "EUR" || bare === "eur";
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Readonly<Record<string, number>> = {
  jaanuar: 1, veebruar: 2, "m\u00E4rts": 3, aprill: 4, mai: 5, juuni: 6, juuli: 7,
  august: 8, september: 9, oktoober: 10, november: 11, detsember: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  october: 10, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
};

function isoDate(year: number, month: number, day: number): string | undefined {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isStrictDate(value) ? value : undefined;
}

interface DatePattern {
  re: RegExp;
  read: (m: RegExpExecArray) => { values: string[]; ambiguousSlash: boolean };
}

const single = (value: string | undefined) => ({ values: value ? [value] : [], ambiguousSlash: false });

const DATE_PATTERNS: DatePattern[] = [
  {
    re: /(?<![\p{L}\p{N}])(\d{4})-(\d{2})-(\d{2})(?![\p{L}\p{N}])/gu,
    read: (m) => single(isoDate(+m[1]!, +m[2]!, +m[3]!)),
  },
  {
    re: /(?<![\p{L}\p{N}.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\p{N})/gu,
    read: (m) => single(isoDate(+m[3]!, +m[2]!, +m[1]!)),
  },
  {
    re: /(?<![\p{L}\p{N}.])(\d{1,2})\.(\d{1,2})\.(\d{2})(?!\p{N}|\.\p{N})/gu,
    read: (m) => single(isoDate(2000 + +m[3]!, +m[2]!, +m[1]!)),
  },
  {
    re: /(?<![\p{L}\p{N}/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\p{N})/gu,
    read: (m) => {
      const dayFirst = isoDate(+m[3]!, +m[2]!, +m[1]!);
      const monthFirst = isoDate(+m[3]!, +m[1]!, +m[2]!);
      const values = [...new Set([dayFirst, monthFirst].filter((v): v is string => v !== undefined))];
      return { values, ambiguousSlash: values.length > 1 };
    },
  },
  {
    // "31. juuli 2026", "14 August 2026", "22nd February 2021", "06 September, 2026"
    re: /(?<![\p{L}\p{N}])(\d{1,2})(?:st|nd|rd|th)?\.? (\p{L}+)\.?,? (\d{4})(?!\p{N})/giu,
    read: (m) => {
      const month = MONTHS[m[2]!.toLowerCase()];
      return single(month ? isoDate(+m[3]!, month, +m[1]!) : undefined);
    },
  },
  {
    // "July 20, 2026"
    re: /(?<![\p{L}\p{N}])(\p{L}+)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})(?!\p{N})/giu,
    read: (m) => {
      const month = MONTHS[m[1]!.toLowerCase()];
      return single(month ? isoDate(+m[3]!, month, +m[2]!) : undefined);
    },
  },
];

function cellDates(cell: Cell): DateToken[] {
  const dates: DateToken[] = [];
  for (const pattern of DATE_PATTERNS) {
    pattern.re.lastIndex = 0;
    for (const match of cell.text.matchAll(pattern.re)) {
      const { values, ambiguousSlash } = pattern.read(match as RegExpExecArray);
      if (values.length === 0) continue;
      const start = cell.start + match.index!;
      dates.push({ cell: cell.index, start, end: start + match[0].length, text: match[0], values, ambiguousSlash });
    }
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const DEC_PLAIN_RE = /^\d+[.,]\d{2}$/;
const DEC_DOT_GROUPED_RE = /^\d{1,3}(?:\.\d{3})+,\d{2}$/;
const DEC_COMMA_GROUPED_RE = /^\d{1,3}(?:,\d{3})+\.\d{2}$/;
const AMBIGUOUS_RE = /^\d{1,3}[.,]\d{3}$/;
const INTEGER_RE = /^\d+$/;
const LETTER_RE = /\p{L}/u;

function decimalValue(core: string): number | undefined {
  if (DEC_PLAIN_RE.test(core)) return Number(core.replace(",", "."));
  if (DEC_DOT_GROUPED_RE.test(core)) return Number(core.replace(/\./g, "").replace(",", "."));
  if (DEC_COMMA_GROUPED_RE.test(core)) return Number(core.replace(/,/g, ""));
  return undefined;
}

function ambiguousValues(core: string): number[] | undefined {
  if (!AMBIGUOUS_RE.test(core)) return undefined;
  const [whole, fraction] = core.split(/[.,]/) as [string, string];
  return [Number(`${whole}.${fraction}`), Number(`${whole}${fraction}`)];
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

const SIGN_BEFORE_RE = new RegExp(`[${DASH_CLASS}] ?$`);
const SIGN_AFTER_RE = new RegExp(`^[${DASH_CLASS}]`);

function isSigned(lineText: string, cell: Cell, span: Span): boolean {
  const before = lineText.slice(cell.start, span.start);
  const after = lineText.slice(span.end, cell.end);
  return SIGN_BEFORE_RE.test(before) ||
    SIGN_AFTER_RE.test(after) ||
    (/\( *$/.test(before) && /^ *\)/.test(after));
}

function isPercentFollowed(word: Word, next: Word | undefined): boolean {
  return word.text.includes("%") || next?.text.startsWith("%") === true;
}

interface RawMoney extends Span { kind: MoneyKind; values: number[] }

function cellMoney(cell: Cell, words: Word[]): RawMoney[] {
  const out: RawMoney[] = [];
  const cores = words.map(wordCore);
  const consumed = new Set<number>();
  const attachedEuro = (c: WordCore) => c.lead.includes("\u20AC") || c.trail.includes("\u20AC");
  const adjacent = (first: number, last: number) =>
    isCurrencyWord(words[first - 1]) || isCurrencyWord(words[last + 1]) ||
    cores[first]!.lead.includes("\u20AC") || cores[last]!.trail.includes("\u20AC");

  // Space-grouped joins, right to left so each join is maximal. Always ambiguous_join.
  for (let j = words.length - 1; j >= 1; j -= 1) {
    const last = cores[j]!;
    if (last.lead !== "" || isPercentFollowed(words[j]!, words[j + 1])) continue;
    const decimalLast = /^\d{3}[.,]\d{2}$/.test(last.core);
    const integerLast = /^\d{3}$/.test(last.core);
    if (!decimalLast && !integerLast) continue;
    let start = j;
    while (start - 1 >= 0) {
      const prev = cores[start - 1]!;
      if (prev.trail !== "") break;
      if (/^\d{3}$/.test(prev.core)) {
        start -= 1;
        if (prev.lead !== "") break;
        continue;
      }
      if (/^\d{1,2}$/.test(prev.core)) start -= 1;
      break;
    }
    if (start === j) continue;
    if (integerLast && !adjacent(start, j)) continue;
    const values = new Set<number>();
    for (let s = start; s <= j; s += 1) {
      const digits = cores.slice(s, j + 1).map((c) => c.core).join("");
      values.add(Number(digits.replace(",", ".")));
    }
    // Independently valid split readings that end before the last word: with currency adjacency of
    // their own, `EUR 1 234,56` also reads as `EUR 1` (and `EUR 1 234 567,89` as `EUR 1 234`).
    for (let b = start; b < j; b += 1) {
      for (let a = start; a <= b; a += 1) {
        if (adjacent(a, b)) values.add(Number(cores.slice(a, b + 1).map((c) => c.core).join("")));
      }
    }
    out.push({
      start: words[start]!.start + cores[start]!.offset,
      end: words[j]!.start + last.offset + last.core.length,
      kind: "ambiguous_join",
      values: [...values],
    });
    for (let s = start; s <= j; s += 1) consumed.add(s);
    j = start;
  }

  words.forEach((word, index) => {
    if (consumed.has(index)) return;
    const c = cores[index]!;
    if (c.core === "" || LETTER_RE.test(c.core) || isPercentFollowed(word, words[index + 1])) return;
    const start = word.start + c.offset;
    const span = { start, end: start + c.core.length };
    const decimal = decimalValue(c.core);
    if (decimal !== undefined) {
      out.push({ ...span, kind: "decimal", values: [decimal] });
      return;
    }
    const ambiguous = ambiguousValues(c.core);
    if (ambiguous) {
      out.push({ ...span, kind: "ambiguous", values: ambiguous });
      return;
    }
    if (INTEGER_RE.test(c.core)) {
      if (c.core.length >= 7) return;
      if (attachedEuro(c) || isCurrencyWord(words[index - 1]) || isCurrencyWord(words[index + 1])) {
        out.push({ ...span, kind: "integer", values: [Number(c.core)] });
      }
      return;
    }
    // `10-20,00`: a dash inside a letterless word separates parts; a decimal part is a token.
    const dashSplit = new RegExp(`[${DASH_CLASS}]`, "g");
    if (!dashSplit.test(c.core)) return;
    let offset = 0;
    for (const part of c.core.split(new RegExp(`[${DASH_CLASS}]`))) {
      const value = decimalValue(part);
      const values = value !== undefined ? [value] : ambiguousValues(part);
      if (values && part.length > 0) {
        out.push({ start: start + offset, end: start + offset + part.length, kind: values.length > 1 ? "ambiguous" : "decimal", values });
      }
      offset += part.length + 1;
    }
  });
  return out;
}

function lineIbanSpans(line: TokenLine): Span[] {
  return ibanScan([line]).map(({ start, end }) => ({ start, end }));
}

export function lineTokens(line: TokenLine): LineTokens {
  const cells = lineCells(line.text);
  const words = cells.flatMap(cellWords);
  const dates = cells.flatMap(cellDates);
  const ibanSpans = lineIbanSpans(line);
  const money: MoneyToken[] = [];
  for (const cell of cells) {
    const inCell = words.filter((word) => word.cell === cell.index);
    for (const raw of cellMoney(cell, inCell)) {
      if (dates.some((date) => overlaps(date, raw)) || ibanSpans.some((iban) => overlaps(iban, raw))) continue;
      money.push({
        ...raw,
        cell: cell.index,
        text: line.text.slice(raw.start, raw.end),
        signed: isSigned(line.text, cell, raw),
      });
    }
  }
  money.sort((a, b) => a.start - b.start);
  const wordTokens: WordToken[] = [];
  for (const cell of cells) {
    for (const match of cell.text.matchAll(/[\p{L}\p{N}]+(?:[-/._][\p{L}\p{N}]+)*/gu)) {
      const start = cell.start + match.index!;
      wordTokens.push({ cell: cell.index, start, end: start + match[0].length, text: match[0] });
    }
  }
  return { cells, words, money, dates, wordTokens };
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const ALNUM_RE = /[\p{L}\p{N}]/u;
const CONNECTOR_RE = /[-/._]/;

function strictBefore(text: string, start: number): boolean {
  const c = text[start - 1];
  if (c === undefined) return true;
  if (ALNUM_RE.test(c)) return false;
  return !(CONNECTOR_RE.test(c) && text[start - 2] !== undefined && ALNUM_RE.test(text[start - 2]!));
}

function strictAfter(text: string, end: number): boolean {
  const c = text[end];
  if (c === undefined) return true;
  if (ALNUM_RE.test(c)) return false;
  return !(CONNECTOR_RE.test(c) && text[end + 1] !== undefined && ALNUM_RE.test(text[end + 1]!));
}

export interface IbanHit extends Span { line: string; value: string }

/** Validated IBANs (every passing prefix of the space-separated groups), strict outer boundaries. */
export function ibanScan(lines: ReadonlyArray<TokenLine>): IbanHit[] {
  const hits: IbanHit[] = [];
  for (const line of lines) {
    for (const cell of lineCells(line.text)) {
      const text = cell.text;
      for (const match of text.matchAll(/[A-Z]{2}\d{2}/g)) {
        const start = match.index!;
        if (!strictBefore(text, start)) continue;
        const first = /^[A-Z0-9]+/.exec(text.slice(start))![0];
        if (first.length > 34) continue;
        let compactValue = first;
        let end = start + first.length;
        const consider = () => {
          if (isValidIban(compactValue) && strictAfter(text, end)) {
            hits.push({ line: line.id, start: cell.start + start, end: cell.start + end, value: compactValue });
          }
        };
        consider();
        for (;;) {
          const group = /^ ([A-Z0-9]{1,4})(?![A-Z0-9])/.exec(text.slice(end));
          if (!group || compactValue.length + group[1]!.length > 34) break;
          compactValue += group[1];
          end += group[0].length;
          consider();
        }
      }
    }
  }
  return hits;
}

export type IdentifierKind = "ee_vat" | "ee_reg" | "foreign_vat";
export interface IdentifierHit extends Span {
  line: string;
  kind: IdentifierKind;
  /** Normalised readings. Several only for an accounting-mode foreign VAT (each validating group prefix). */
  values: string[];
}

export const FOREIGN_VAT_PREFIXES = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EL", "ES", "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV",
  "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK", "GB", "XI", "NO", "CH", "EU",
] as const;
const FOREIGN_PREFIX_SET: ReadonlySet<string> = new Set(FOREIGN_VAT_PREFIXES);

const BIC_RE = /\b[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g;

/** The VAT label words (the `VAT_LABEL_RE` vocabulary and its foreign equivalents) a country prefix may end. */
const VAT_LABEL_WORDS = ["VAT", "UST", "MWST", "IVA", "TVA", "BTW", "MOMS", "ALV"] as const;

/**
 * True when the two letters at `i` end a VAT label word (starting on a non-letter boundary) that is
 * followed by a separator and then a letter-led token, i.e. another country prefix: `VAT EE…`, `ALV FI…`.
 * `ALV40003032949` and `ALV 40003032949` are not exempt, so `LV40003032949` is still found.
 */
function isVatLabelTail(text: string, i: number): boolean {
  const separator = /^[^\p{L}\p{N}]+(.)/u.exec(text.slice(i + 2));
  if (!separator || !/\p{L}/u.test(separator[1]!)) return false;
  return VAT_LABEL_WORDS.some((word) => {
    const start = i + 2 - word.length;
    return start >= 0 && text.slice(start, i + 2) === word && (start === 0 || !/\p{L}/u.test(text[start - 1]!));
  });
}

const FIRST_GROUP_RE = /^([A-Z0-9]+)|^ ([A-Z0-9]*\d[A-Z0-9]*)(?![A-Z0-9])/;
const FR_FIRST_GROUP_RE = /^([A-Z0-9]+)|^ ([A-Z0-9]{2}|[A-Z0-9]*\d[A-Z0-9]*)(?![A-Z0-9])/;

function inside(inner: Span, outer: Span): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

function cellIdentifiers(cell: Cell, lineIdValue: string, mode: "strict" | "accounting"): IdentifierHit[] {
  const text = cell.text;
  const strict = mode === "strict";
  const bounded = (start: number, end: number) => !strict || (strictBefore(text, start) && strictAfter(text, end));
  const hits: IdentifierHit[] = [];
  const push = (kind: IdentifierKind, start: number, end: number, values: string[]) =>
    hits.push({ line: lineIdValue, kind, start: cell.start + start, end: cell.start + end, values });

  // EE VAT: EE + 9 digits with optional single spaces/tabs between digits.
  for (const match of text.matchAll(/EE[ \t]?\d(?:[ \t]?\d){8}/g)) {
    const start = match.index!;
    const end = start + match[0].length;
    const value = match[0].replace(/[ \t]/g, "");
    if (bounded(start, end) && isValidEeVatNumber(value)) push("ee_vat", start, end, [value]);
  }

  // EE registry code: a digit-group sequence with exactly 8 digits.
  for (const match of text.matchAll(/\d+(?: \d+)*/g)) {
    const seqStart = match.index!;
    const groups: Span[] = [];
    for (const g of match[0].matchAll(/\d+/g)) groups.push({ start: seqStart + g.index!, end: seqStart + g.index! + g[0].length });
    const digitsOf = (from: number, to: number) => groups.slice(from, to + 1).map((g) => text.slice(g.start, g.end)).join("");
    if (strict) {
      const value = digitsOf(0, groups.length - 1);
      const end = groups[groups.length - 1]!.end;
      if (value.length === 8 && bounded(seqStart, end) && isValidEeRegistryCode(value)) push("ee_reg", seqStart, end, [value]);
      continue;
    }
    for (let from = 0; from < groups.length; from += 1) {
      for (let to = from; to < groups.length; to += 1) {
        const value = digitsOf(from, to);
        if (value.length > 8) break;
        if (value.length === 8 && isValidEeRegistryCode(value)) push("ee_reg", groups[from]!.start, groups[to]!.end, [value]);
      }
    }
  }

  // Foreign VAT: a country prefix, an optional space, then uppercase alphanumeric groups. A
  // space-separated group must contain a digit, except where the country's format allows letters there
  // (FR's two-character key: `FR AB 123456789`). Outer boundaries are ignored in accounting mode
  // (`XDE 123456789` counts); only a prefix that is the tail of a VAT label word is discarded, so
  // `VAT EE…` does not read as `AT EE…` and `ALV FI…` not as `LV FI…`.
  for (let i = 0; i + 2 <= text.length; i += 1) {
    const prefix = text.slice(i, i + 2);
    if (!FOREIGN_PREFIX_SET.has(prefix)) continue;
    if (strict && !strictBefore(text, i)) continue;
    if (isVatLabelTail(text, i)) continue;
    let end = i + 2;
    let compactValue = prefix;
    const prefixes: Array<{ value: string; end: number }> = [];
    const firstGroup = (prefix === "FR" ? FR_FIRST_GROUP_RE : FIRST_GROUP_RE).exec(text.slice(end));
    if (!firstGroup) continue;
    compactValue += firstGroup[1] ?? firstGroup[2];
    end += firstGroup[0].length;
    prefixes.push({ value: compactValue, end });
    for (;;) {
      const group = /^ ([A-Z0-9]*\d[A-Z0-9]*)(?![A-Z0-9])/.exec(text.slice(end));
      if (!group) break;
      compactValue += group[1];
      end += group[0].length;
      prefixes.push({ value: compactValue, end });
    }
    if (strict) {
      const maximal = prefixes[prefixes.length - 1]!;
      const value = normalizeVatValue(maximal.value)!;
      if (strictAfter(text, maximal.end) && isForeignVatShape(value)) push("foreign_vat", i, maximal.end, [value]);
      continue;
    }
    const valid = prefixes.filter((p) => isForeignVatShape(normalizeVatValue(p.value)!));
    if (valid.length > 0) {
      push("foreign_vat", i, valid[valid.length - 1]!.end, valid.map((p) => normalizeVatValue(p.value)!));
    }
  }

  return hits;
}

/**
 * EE VAT, EE registry code and foreign VAT spans inside cells. `strict` requires original token
 * boundaries on both sides (and the maximal digit-group sequence for registry codes); `accounting`
 * ignores outer boundaries and takes every group-aligned sub-sequence. Spans inside a validated IBAN
 * or a BIC shape are excluded in both modes.
 */
export function identifierScan(lines: ReadonlyArray<TokenLine>, mode: "strict" | "accounting"): IdentifierHit[] {
  const hits: IdentifierHit[] = [];
  for (const line of lines) {
    const excluded: Span[] = lineIbanSpans(line);
    for (const match of line.text.matchAll(BIC_RE)) excluded.push({ start: match.index!, end: match.index! + match[0].length });
    for (const cell of lineCells(line.text)) {
      for (const hit of cellIdentifiers(cell, line.id, mode)) {
        if (!excluded.some((span) => inside(hit, span))) hits.push(hit);
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Document-level scans
// ---------------------------------------------------------------------------

function letterTokens(text: string): string[] {
  return text.normalize("NFC").toLowerCase().match(/\p{L}+/gu) ?? [];
}

/** The entries (from `entries`) that match an equal contiguous run of whole letter tokens. */
export function creditWordHits(lines: ReadonlyArray<TokenLine>, entries: readonly string[]): string[] {
  const dashRun = new RegExp(`[${DASH_CLASS}\\s]+`, "g");
  const tokens = letterTokens(lines.map((line) => line.text.replace(dashRun, " ")).join("\n"));
  return entries.filter((entry) => {
    const needle = letterTokens(entry);
    if (needle.length === 0) return false;
    for (let i = 0; i + needle.length <= tokens.length; i += 1) {
      if (needle.every((token, k) => tokens[i + k] === token)) return true;
    }
    return false;
  });
}

export interface CurrencyScanLists {
  isoCodes: readonly string[];
  /** ISO codes that are ordinary words: they count only within 2 words of a money token in the cell. */
  wordLikeCodes: readonly string[];
  letterSymbols: readonly string[];
}
export interface CurrencyHit { line: string; kind: "iso" | "symbol" | "letter_symbol"; text: string }
export interface CurrencyScanResult { hits: CurrencyHit[]; eurStated: boolean }

function nearMoney(wordIndex: number, cellWordsList: Word[], money: MoneyToken[], cellIndex: number): boolean {
  return money.some((token) => {
    if (token.cell !== cellIndex) return false;
    const indices = cellWordsList
      .map((word, index) => (overlaps(word, token) ? index : -1))
      .filter((index) => index >= 0);
    return indices.some((index) => Math.abs(index - wordIndex) <= 2);
  });
}

/** True when `text[start, start+length)` touches no letter or digit on either side (`EUR123` is no EUR). */
export function isWholeToken(text: string, start: number, length: number): boolean {
  const before = text[start - 1];
  const after = text[start + length];
  return (before === undefined || !ALNUM_RE.test(before)) && (after === undefined || !ALNUM_RE.test(after));
}

export function currencyScan(lines: ReadonlyArray<TokenLine>, lists: CurrencyScanLists): CurrencyScanResult {
  const iso = new Set(lists.isoCodes);
  const wordLike = new Set(lists.wordLikeCodes);
  const letterSymbols = new Set(lists.letterSymbols);
  const hits: CurrencyHit[] = [];
  let eurStated = false;
  for (const line of lines) {
    if (line.text.includes("\u20AC")) eurStated = true;
    for (const symbol of line.text.match(/\p{Sc}/gu) ?? []) {
      if (symbol !== "\u20AC") hits.push({ line: line.id, kind: "symbol", text: symbol });
    }
    const tokens = lineTokens(line);
    for (const cell of tokens.cells) {
      const inCell = tokens.words.filter((word) => word.cell === cell.index);
      for (const match of cell.text.matchAll(/\p{L}+/gu)) {
        const code = match[0];
        const lower = code.toLowerCase();
        if ((lower === "eur" || lower === "euro" || lower === "eurot") && isWholeToken(cell.text, match.index!, code.length)) eurStated = true;
        if (!iso.has(code)) continue;
        if (wordLike.has(code)) {
          const at = cell.start + match.index!;
          const wordIndex = inCell.findIndex((word) => at >= word.start && at < word.end);
          if (!nearMoney(wordIndex, inCell, tokens.money, cell.index)) continue;
        }
        hits.push({ line: line.id, kind: "iso", text: code });
      }
      inCell.forEach((word, index) => {
        const bare = word.text.replace(/^[(]+/, "").replace(/[,;:!?)]+$/, "");
        if (!letterSymbols.has(bare) && !letterSymbols.has(bare.replace(/\.$/, ""))) return;
        if (nearMoney(index, inCell, tokens.money, cell.index)) hits.push({ line: line.id, kind: "letter_symbol", text: bare });
      });
    }
  }
  return { hits, eurStated };
}

export interface PercentToken extends Span { line: string; value: number }

export function percentTokens(lines: ReadonlyArray<TokenLine>): PercentToken[] {
  const out: PercentToken[] = [];
  for (const line of lines) {
    for (const match of line.text.matchAll(/(?<![\p{N}.,])(\d{1,2}(?:[.,]\d{1,2})?)\s?%/gu)) {
      out.push({
        line: line.id,
        start: match.index!,
        end: match.index! + match[0].length,
        value: Number(match[1]!.replace(",", ".")),
      });
    }
  }
  return out;
}
