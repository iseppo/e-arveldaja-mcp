import { expect, it } from "vitest";
import { confirmedDistributionEvidence } from "./confirmed-transfer-proof.js";
import type { Transaction } from "../../types/api.js";
const reviewed = [{related_table:"accounts", related_id:1020, related_sub_id:200, amount:100}];
const tx = (items: any[]): Transaction => ({id:1,accounts_dimensions_id:100,type:"C",status:"CONFIRMED",date:"2026-10-01",amount:108,base_amount:100,cl_currencies_id:"USD",items});
const fx = {accounts_id:1020,accounts_dimensions_id:200,amount:108,base_amount:100,currency_rate:1.08,cl_currencies_id:"USD"};
// Native GET shape observed on the owned temporary transfer, 2026-10-18.
const nativeItem={id:14310640,accounts_id:1020,accounts_dimensions_id:12762251,relation_table:"accounts",relation_id:102012762251,
  amount:.03,base_amount:.03,is_deleted:false,clients_id:2025557,client_name:null,item_type:"accounts",item_subtype:null,
  item_number:null,item_date:null,item_sum:.03,item_currency:"EUR",journals_title:"Arvelduskontod"};
it("native GET composite account/dimension relation preserves the approved explicit target",()=>{
  const source={...tx([nativeItem]),amount:.03,base_amount:.03,cl_currencies_id:"EUR"};
  const approved=[{related_table:"accounts",related_id:1020,related_sub_id:12762251,amount:.03}];
  expect(confirmedDistributionEvidence(source,approved)).toEqual({ok:true,linkage_absent:false,rows:[{table:"accounts",relation_id:1020,accounts_id:1020,accounts_dimensions_id:12762251,amount_eur:.03}]});
});
it.each([
  {relation_id:102012762252},{relation_id:1210},{accounts_id:undefined},{accounts_dimensions_id:undefined},
  {accounts_dimensions_id:12762252},{accounts_id:1021},{accounts_id:10201,accounts_dimensions_id:2762251},
  {accounts_id:-1020},{accounts_dimensions_id:0},{relation_id:"102012762251"},{relation_table:undefined},
  {accounts_dimensions_id:Number.MAX_SAFE_INTEGER,relation_id:Number(`1020${Number.MAX_SAFE_INTEGER}`)},
  {accounts_id:Number.MAX_SAFE_INTEGER+1},{relation_table:"sale_invoices"},
])("native composite never infers missing/conflicting/unsafe target identity: %j",patch=>{
  const source={...tx([{...nativeItem,...patch}]),amount:.03,base_amount:.03,cl_currencies_id:"EUR"};
  expect(confirmedDistributionEvidence(source,[{related_table:"accounts",related_id:1020,related_sub_id:12762251,amount:.03}]).ok).toBe(false);
});
it("normalizes nominal USD108/base EUR100 instead of comparing nominal to the request", () => {
  expect(confirmedDistributionEvidence(tx([fx]), reviewed)).toEqual({ok:true,linkage_absent:false,rows:[{table:"accounts",relation_id:1020,accounts_id:1020,accounts_dimensions_id:200,amount_eur:100}]});
});
it("accepts explicit EUR without optional relation metadata", () => {
  expect(confirmedDistributionEvidence(tx([{accounts_id:1020,accounts_dimensions_id:200,amount:100,cl_currencies_id:"EUR"}]), reviewed).ok).toBe(true);
});
it.each([
  {...fx,relation_id:1210}, {...fx,relation_table:"sale_invoices",relation_id:9},
  {...fx,accounts_dimensions_id:300}, {...fx,base_amount:99}, {...fx,currency_rate:1.09},
  {...fx,base_amount:undefined}, {...fx,amount:-108}, {...fx,base_amount:-100}, {...fx,amount:NaN}, {...fx,currency_rate:Infinity},
])("refuses contradictory or incomplete GET distribution: %j", row => {
  expect(confirmedDistributionEvidence(tx([row]), reviewed).ok).toBe(false);
});
it("retains row multiplicity and reports absent linkage without claiming a link", () => {
  expect(confirmedDistributionEvidence(tx([fx,fx]), reviewed).ok).toBe(false);
  expect(confirmedDistributionEvidence(tx([]), reviewed)).toEqual({ok:true,rows:[],linkage_absent:true});
});
it("uses explicit FX EUR base without inventing an omitted optional rate",()=>{
  expect(confirmedDistributionEvidence(tx([{...fx,currency_rate:undefined}]),reviewed).ok).toBe(true);
});
it("requires invoice relation instead of manufacturing one from account fields", () => {
  const invoice = [{related_table:"sale_invoices",related_id:77,amount:100}];
  expect(confirmedDistributionEvidence(tx([{...fx,relation_table:"sale_invoices",relation_id:77}]),invoice).ok).toBe(true);
  expect(confirmedDistributionEvidence(tx([{...fx,accounts_id:77}]),invoice).ok).toBe(false);
});
