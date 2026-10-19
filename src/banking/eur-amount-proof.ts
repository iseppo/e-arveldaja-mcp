export interface EurAmountRow {
  amount?: number | null;
  base_amount?: number | null;
  currency_rate?: number | null;
  cl_currencies_id?: string | null;
}

/** EUR base is evidence, never an absolute value or an inferred FX conversion. */
export function positiveEurAmount(row: EurAmountRow, inheritedCurrency?: string | null):
  {ok:true; value:number} | {ok:false; reason:string} {
  const nominal=row.amount;
  const base=row.base_amount;
  const rate=row.currency_rate;
  const rawCurrency=row.cl_currencies_id ?? inheritedCurrency;
  if (rawCurrency!=null && typeof rawCurrency!=="string") return {ok:false,reason:"currency_invalid"};
  const currency=rawCurrency?.trim().toUpperCase();
  if (currency!==undefined && !/^[A-Z]{3}$/.test(currency)) return {ok:false,reason:"currency_invalid"};
  if (nominal!=null && (!Number.isFinite(nominal) || nominal<=0)) return {ok:false,reason:"nominal_amount_nonpositive_or_invalid"};
  if (base!=null && (!Number.isFinite(base) || base<=0)) return {ok:false,reason:"base_amount_nonpositive_or_invalid"};
  if (rate!=null && (!Number.isFinite(rate) || rate<=0)) return {ok:false,reason:"currency_rate_nonpositive_or_invalid"};
  // Native journal rows may omit currency and base. That established EUR
  // omission never overrides an explicitly foreign row or journal currency.
  const value=base ?? (currency===undefined || currency==="EUR" ? nominal : undefined);
  if (value==null) return {ok:false,reason:currency && currency!=="EUR"?"foreign_eur_base_unavailable":"amount_unavailable"};
  if (nominal!=null && base!=null && currency==="EUR" && Math.abs(nominal-base)>.01) return {ok:false,reason:"eur_nominal_base_conflict"};
  if (nominal!=null && rate!=null && Math.abs(nominal/rate-value)>.01) return {ok:false,reason:"nominal_rate_base_conflict"};
  return {ok:true,value};
}
