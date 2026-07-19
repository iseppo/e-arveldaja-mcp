export interface OpeningBalanceAccount { code: string; name: string; debit: number; credit: number; }
export interface ParsedOpeningBalances {
  openingDate: string;
  accounts: OpeningBalanceAccount[];
  totals: { debit: number; credit: number };
  rawText: string;
}
export class OpeningBalanceParseError extends Error {
  constructor(message: string) { super(message); this.name = "OpeningBalanceParseError"; }
}

const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})\.?$/;   // dd.mm.yyyy (trailing dot tolerated)
const CODE_RE = /^(\d{3,6})[ \t]+(\S.*)$/;          // leading account code + name remainder (requires a separating space, so a bare row-number cell like "10003." doesn't match)
const ROW_NUMBER_RE = /^\d+\.$/;                    // "Nr" cell, e.g. "10003." or "1."

/** "1 000.00 €" → 1000.00 ; "" → 0 */
function parseAmount(cell: string): number {
  const t = cell.trim();
  if (t === "") return 0;
  const cleaned = t.replace(/€/g, "").replace(/\s/g, "").replace(",", ".");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new OpeningBalanceParseError(`Unparseable amount: "${cell}"`);
  return n;
}

/** Split a row on tabs, or on runs of 2+ spaces when no tab is present. */
function splitCells(line: string, hasTab: boolean): string[] {
  if (hasTab) return line.split("\t").map(c => c.trim());
  return line.split(/ {2,}/).map(c => c.trim());
}

export function parseOpeningBalances(rawText: string): ParsedOpeningBalances {
  const byCode = new Map<string, OpeningBalanceAccount>();
  let openingDate: string | undefined;

  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    const hasTab = line.includes("\t");
    const cells = splitCells(line, hasTab);

    // Locate the Konto cell: the first cell starting with an account code.
    const kontoIdx = cells.findIndex(c => CODE_RE.test(c));
    if (kontoIdx === -1) continue;                     // header / title / noise

    const codeMatch = CODE_RE.exec(cells[kontoIdx]!)!;
    const code = codeMatch[1]!;
    const name = codeMatch[2]!.trim();

    // Amount cells follow the Konto cell; first is Deebet, second is Kreedit.
    const remainder = cells.slice(kontoIdx + 1);
    let debit: number;
    let credit: number;
    if (!hasTab && remainder.length === 1) {
      // Space-run splitting collapses empty placeholder cells, so a lone
      // trailing amount is positionally ambiguous. Disambiguate via the
      // leading "Nr" cell: present -> this is the Deebet line of the entry,
      // absent -> it's the Kreedit continuation line.
      const amount = parseAmount(remainder[0] ?? "");
      const hasRowNumber = cells.slice(0, kontoIdx).some(c => ROW_NUMBER_RE.test(c));
      debit = hasRowNumber ? amount : 0;
      credit = hasRowNumber ? 0 : amount;
    } else {
      debit = parseAmount(remainder[0] ?? "");
      credit = parseAmount(remainder[1] ?? "");
    }

    // A real opening-balance entry always has an amount on one side; a 0/0
    // row is a misdetected Konto-lookalike (e.g. a stray "Nr Name" token
    // with no trailing amount) and should be dropped, not booked.
    if (debit === 0 && credit === 0) continue;

    // Opening date: first parseable dd.mm.yyyy seen anywhere on a data row.
    if (!openingDate) {
      for (const c of cells) {
        const dm = DATE_RE.exec(c.trim());
        if (dm) { openingDate = `${dm[3]}-${dm[2]}-${dm[1]}`; break; }
      }
    }

    const entry = byCode.get(code) ?? { code, name, debit: 0, credit: 0 };
    entry.debit += debit;
    entry.credit += credit;
    if (!entry.name && name) entry.name = name;
    byCode.set(code, entry);
  }

  const accounts = [...byCode.values()].map(a => ({
    ...a,
    debit: Math.round(a.debit * 100) / 100,
    credit: Math.round(a.credit * 100) / 100,
  }));
  if (accounts.length === 0) {
    throw new OpeningBalanceParseError(
      "No opening-balance rows found. Paste the 'Algbilansi kanded' register (Nr / Kuupäev / Konto / Deebet / Kreedit columns).",
    );
  }

  const totals = accounts.reduce(
    (acc, a) => ({ debit: acc.debit + a.debit, credit: acc.credit + a.credit }),
    { debit: 0, credit: 0 },
  );
  totals.debit = Math.round(totals.debit * 100) / 100;
  totals.credit = Math.round(totals.credit * 100) / 100;

  if (Math.abs(totals.debit - totals.credit) > 0.01) {
    throw new OpeningBalanceParseError(
      `Algbilanss does not balance: Deebet ${totals.debit.toFixed(2)} € vs Kreedit ${totals.credit.toFixed(2)} €. ` +
      "Check the paste — a valid opening balance has equal debit and credit totals.",
    );
  }

  return { openingDate: openingDate ?? "", accounts, totals, rawText };
}
