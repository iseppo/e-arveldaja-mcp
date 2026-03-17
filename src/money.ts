/** Round to 2 decimal places (cents). Use for all monetary arithmetic. */
export const roundMoney = (v: number): number => Math.round(v * 100) / 100;
