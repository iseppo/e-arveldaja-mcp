/** Round to 2 decimal places (cents). Use for all monetary arithmetic. */
export const roundMoney = (v: number): number =>
  Math.sign(v) * Math.round((Math.abs(v) + Number.EPSILON) * 100) / 100;
