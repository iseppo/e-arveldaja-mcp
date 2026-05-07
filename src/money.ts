/**
 * Round to 2 decimal places (cents). Use for all monetary arithmetic.
 * Uses string exponent trick to avoid IEEE 754 intermediate multiplication errors
 * (e.g. 1.005 * 100 = 100.499... but parseFloat('1.005e2') = 100.5 exactly).
 */
export const roundMoney = (v: number): number => {
  if (v === 0) return 0;
  if (Number.isNaN(v)) throw new Error("roundMoney received NaN — indicates a bug in the caller");
  if (!Number.isFinite(v)) throw new Error("roundMoney received a non-finite value — indicates a bug in the caller");
  const abs = Math.abs(v);

  // Once the scaled value reaches 1e21, Number stringification switches to
  // exponential notation and the string-exponent trick becomes invalid
  // (e.g. Number(Math.round(...)) + "e-2" => "1e+21e-2"). At that magnitude
  // the IEEE 754 spacing is already much larger than 0.01, so the original
  // value is the closest representable cent-rounded result.
  if (abs >= 1e19) return v;

  const rounded = Number(Math.round(parseFloat(abs + "e2")) + "e-2");
  return (v < 0 ? -rounded : rounded) || 0;
};

/**
 * Round to N decimals. Use for non-money quantities (exchange rates, ratios)
 * where 2dp would lose meaningful precision. Currency conversion uses 6dp
 * to match what most APIs accept and Wise's published precision.
 */
export const roundTo = (value: number, decimals: number): number => {
  if (value === 0) return 0;
  if (Number.isNaN(value)) throw new Error("roundTo received NaN");
  if (!Number.isFinite(value)) throw new Error("roundTo received a non-finite value");
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
};

/** Parse a vat_rate_dropdown string (e.g. "9", "24", "-", "9,5") to a numeric rate or 0 for "-". */
export function parseVatRateDropdown(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const str = String(value).trim();
  if (!str || str === "-") return 0;
  const parsed = Number(str.replace(",", ".").replace("%", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Invoice gross amount in base currency, falling back to gross_price. Returns 0 with a warning if both are null. */
export function effectiveGross(inv: { base_gross_price?: number | null; gross_price?: number | null; id?: number }): number {
  const value = inv.base_gross_price ?? inv.gross_price;
  if (value == null) {
    process.stderr.write(`WARNING: Invoice ${inv.id ?? "unknown"} has no gross_price or base_gross_price — treating as 0\n`);
    return 0;
  }
  return value;
}
