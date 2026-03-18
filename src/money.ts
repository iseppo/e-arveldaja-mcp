/**
 * Round to 2 decimal places (cents). Use for all monetary arithmetic.
 * Uses string exponent trick to avoid IEEE 754 intermediate multiplication errors
 * (e.g. 1.005 * 100 = 100.499... but parseFloat('1.005e2') = 100.5 exactly).
 */
export const roundMoney = (v: number): number => {
  if (v === 0 || !Number.isFinite(v)) return 0;
  const abs = Math.abs(v);
  const rounded = Number(Math.round(parseFloat(abs + "e2")) + "e-2");
  return (v < 0 ? -rounded : rounded) || 0;
};
