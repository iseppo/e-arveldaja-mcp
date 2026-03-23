/**
 * Round to 2 decimal places (cents). Use for all monetary arithmetic.
 * Uses string exponent trick to avoid IEEE 754 intermediate multiplication errors
 * (e.g. 1.005 * 100 = 100.499... but parseFloat('1.005e2') = 100.5 exactly).
 */
export const roundMoney = (v: number): number => {
  if (v === 0) return 0;
  if (Number.isNaN(v)) throw new Error("roundMoney received NaN — indicates a bug in the caller");
  if (!Number.isFinite(v)) throw new Error("roundMoney received Infinity — indicates a bug in the caller (e.g. division by zero)");
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

/** Invoice gross amount in base currency, falling back to gross_price. */
export function effectiveGross(inv: { base_gross_price?: number | null; gross_price?: number | null }): number {
  return inv.base_gross_price ?? inv.gross_price ?? 0;
}
