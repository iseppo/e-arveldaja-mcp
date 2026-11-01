/** Synthetic Lightyear statement rows for tests: one string[] per CSV row in the statement's column order. */
export const LIGHTYEAR_STATEMENT_HEADER = "Date,Reference,Ticker,ISIN,Type,Quantity,CCY,Price/share,Gross Amount,FX Rate,Fee,Net Amt.,Tax Amt.";

export function lightyearStatementCsv(rows: readonly string[][]): string {
  return `${LIGHTYEAR_STATEMENT_HEADER}\n${rows.map(row => row.map(value => `"${value}"`).join(",")).join("\n")}\n`;
}

/** The parsed statement-row shape the Lightyear extraction works on (row_index = position). */
export function parseLightyearRowsForTest(rows: readonly string[][]) {
  const numeric = (value: string | undefined): number => value?.trim() ? Number.parseFloat(value) : 0;
  return rows.map((fields, row_index) => ({
    row_index,
    date: fields[0]!,
    reference: fields[1]!,
    ticker: fields[2]!,
    isin: fields[3]!,
    type: fields[4]! as "Buy" | "Sell" | "Conversion" | "Deposit" | "Withdrawal" | "Distribution" | "Dividend" | "Interest" | "Reward",
    quantity: numeric(fields[5]),
    ccy: fields[6]!,
    price_per_share: numeric(fields[7]),
    gross_amount: numeric(fields[8]),
    fx_rate: numeric(fields[9]),
    fee: numeric(fields[10]),
    net_amount: numeric(fields[11]),
    tax_amount: numeric(fields[12]),
  }));
}
