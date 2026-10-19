import {expect,it} from "vitest";
import {positiveEurAmount} from "./eur-amount-proof.js";
it.each([
  [{amount:100},undefined],
  [{amount:100,cl_currencies_id:"EUR"},undefined],
  [{amount:108,base_amount:100,currency_rate:1.08,cl_currencies_id:"USD"},undefined],
  [{amount:108,base_amount:100,cl_currencies_id:"USD"},undefined],
  [{amount:108,base_amount:100,currency_rate:1.08},"USD"],
])("proves supported native EUR and explicit FX base: %j",(row,currency)=>{
  expect(positiveEurAmount(row as any,currency as any)).toEqual({ok:true,value:100});
});
it.each([
  [{amount:100,cl_currencies_id:"USD"},undefined,"foreign_eur_base_unavailable"],
  [{amount:100},"USD","foreign_eur_base_unavailable"],
  [{amount:108,currency_rate:1.08,cl_currencies_id:"USD"},undefined,"foreign_eur_base_unavailable"],
  [{amount:-100},undefined,"nominal_amount_nonpositive_or_invalid"],
  [{amount:-108,base_amount:100,cl_currencies_id:"USD"},undefined,"nominal_amount_nonpositive_or_invalid"],
  [{amount:108,base_amount:-100,cl_currencies_id:"USD"},undefined,"base_amount_nonpositive_or_invalid"],
  [{amount:108,base_amount:100,currency_rate:0,cl_currencies_id:"USD"},undefined,"currency_rate_nonpositive_or_invalid"],
  [{amount:108,base_amount:100,currency_rate:1.09,cl_currencies_id:"USD"},undefined,"nominal_rate_base_conflict"],
  [{amount:108,base_amount:100,cl_currencies_id:"EUR"},undefined,"eur_nominal_base_conflict"],
  [{amount:NaN},undefined,"nominal_amount_nonpositive_or_invalid"],
  [{amount:Infinity},undefined,"nominal_amount_nonpositive_or_invalid"],
  [{amount:100,cl_currencies_id:"??"},undefined,"currency_invalid"],
])("refuses unsupported or contradictory amount proof: %j",(row,currency,reason)=>{
  expect(positiveEurAmount(row as any,currency as any)).toEqual({ok:false,reason});
});
