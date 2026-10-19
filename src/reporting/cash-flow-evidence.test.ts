import { describe, expect, it, vi } from "vitest";
import { makeAccount, makeJournal, makePosting as p } from "../__fixtures__/accounting.js";
import { calculateAnnualCashFlow } from "./annual-cash-flow.js";
import { loadCashFlowEvidence, type CashFlowEvidence } from "./cash-flow-evidence.js";
import type { Journal, Transaction } from "../types/api.js";

const accounts=[makeAccount(1020,"D","Varad","Pank"),makeAccount(1100,"D","Varad","Investeering"),makeAccount(1820,"D","Varad","Põhivara"),
  makeAccount(1210,"D","Varad","Nõuded ostjate vastu"),makeAccount(2310,"C","Kohustused","Tarnijad"),makeAccount(5990,"D","Kulud","Kulu"),makeAccount(3100,"C","Tulud","Tulu")];
const journal=(id:number,rows:ReturnType<typeof p>[],extra:Partial<Journal>={})=>makeJournal("2026-06-01",rows,{id,...extra});
const invoice=(id:number,amount:number,account=1820)=>journal(id,[p(account,"D",amount),p(2310,"C",amount)],{operation_type:"PURCHASE_INVOICE",operations_id:id});
const paid=(id:number,amount:number,extra:Partial<Journal>={})=>journal(id,[p(2310,"D",Math.abs(amount)),p(1020,"C",Math.abs(amount),undefined,{accounts_dimensions_id:101})],{operation_type:"TRANSACTION",operations_id:id,...extra});
const detail=(id:number,items:any[],amount=100):Transaction=>({id,status:"CONFIRMED",date:"2026-06-01",amount,base_amount:amount,cl_currencies_id:"EUR",accounts_id:1020,accounts_dimensions_id:101,items} as Transaction);
const item=(id:number,invoiceId:number,amount:number)=>({id,accounts_id:2310,relation_table:"purchase_invoices",relation_id:invoiceId,amount,base_amount:amount,cl_currencies_id:"EUR"});
const evidence=(...txs:Transaction[]):CashFlowEvidence=>({transactions:new Map(txs.map(tx=>[tx.id!,tx])),failures:new Map(),requested:txs.length,limit:500});
const calculate=(journals:Journal[],e:CashFlowEvidence)=>calculateAnnualCashFlow({accounts,journals,evidence:e,dateFrom:"2026-01-01",dateTo:"2026-12-31"});

describe("exact cash-flow evidence",()=>{
  it.each([[11,11,22,false],[11,22,11,false],[null,11,11,false],[11,null,11,false],[11,11,11,true],[null,null,null,true]])("binds capital source/item/payment dimensions %s/%s/%s",(sourceDim,itemDim,paymentDim,ok)=>{
    const source=invoice(1,100),payment=paid(3,100);
    source.postings[1]!.accounts_dimensions_id=sourceDim as number|null;payment.postings[0]!.accounts_dimensions_id=paymentDim as number|null;
    const e=evidence(detail(3,[{...item(1,1,100),accounts_dimensions_id:itemDim}]));
    const r=calculateAnnualCashFlow({accounts:accounts.map(a=>a.id===2310?{...a,allows_dimensions:true}:a),journals:[source,payment],evidence:e,dateFrom:"2026-01-01",dateTo:"2026-12-31"});
    expect(r.status).toBe(ok?"complete":"requires_review");expect(r.investing.cash_payments).toBe(ok?100:0);expect(r.unresolved_cash.payment_total).toBe(ok?0:100);
  });
  it.each([false,true])("consumes separate capital invoice dimensions exactly once swapped=%s",swapped=>{
    const sources=[invoice(1,40),invoice(2,60)];sources[0]!.postings[1]!.accounts_dimensions_id=11;sources[1]!.postings[1]!.accounts_dimensions_id=22;
    const payment=paid(3,100);payment.postings=[p(2310,"D",40,undefined,{accounts_dimensions_id:11}),p(2310,"D",60,undefined,{accounts_dimensions_id:22}),payment.postings[1]!];
    const r=calculate([...sources,payment],evidence(detail(3,[{...item(1,1,40),accounts_dimensions_id:swapped?22:11},{...item(2,2,60),accounts_dimensions_id:swapped?11:22}])));
    expect(r.status).toBe(swapped?"requires_review":"complete");expect(r.investing.cash_payments).toBe(swapped?0:100);
    if(!swapped)expect(r.cash_movements.filter(m=>m.journal_id===3).reduce((s,m)=>s+m.components.working_capital,0)).toBe(-100);
  });
  it("holds one capital invoice spanning two settlement dimensions",()=>{
    const source=invoice(1,100);source.postings=[p(1820,"D",100),p(2310,"C",40,undefined,{accounts_dimensions_id:11}),p(2310,"C",60,undefined,{accounts_dimensions_id:22})];
    const payment=paid(3,100);payment.postings=[p(2310,"D",40,undefined,{accounts_dimensions_id:11}),p(2310,"D",60,undefined,{accounts_dimensions_id:22}),payment.postings[1]!];
    const r=calculate([source,payment],evidence(detail(3,[{...item(1,1,40),accounts_dimensions_id:11},{...item(2,1,60),accounts_dimensions_id:22}])));
    expect(r.status).toBe("requires_review");expect(r.unresolved_cash.payment_total).toBe(100);
  });
  it("rejects a capital transaction header with opposite amount/base signs",()=>{
    const tx=detail(3,[item(1,1,100)]);tx.amount=-100;
    expect(calculate([invoice(1,100),paid(3,100)],evidence(tx)).status).toBe("requires_review");
  });
  it.each([true,false])("requires explicit negative distribution on ordinary capital reversal %s",negative=>{
    const source=invoice(1,100),first=paid(2,100),refund=paid(3,100);refund.postings=[p(2310,"C",100),p(1020,"D",100,undefined,{accounts_dimensions_id:101})];
    const r=calculate([source,first,refund],evidence(detail(2,[item(2,1,100)]),detail(3,[item(3,1,negative?-100:100)])));
    expect(r.status).toBe(negative?"complete":"requires_review");expect(r.investing.cash_receipts).toBe(negative?100:0);
  });
  it.each([-30,30])("preserves capital credit-note refund distribution %s",amount=>{
    const refund=paid(3,30);refund.postings=[p(2310,"D",-30),p(1020,"C",-30,undefined,{accounts_dimensions_id:101})];
    const r=calculate([invoice(1,-30),refund],evidence(detail(3,[item(3,1,amount)],30)));
    expect(r.status).toBe("complete");expect(r.investing.cash_receipts).toBe(30);
  });
  it.each(["mixed","VAT"])("binds dimension for %s capital invoice purpose",kind=>{
    for(const mismatch of [false,true]) {
      const source=invoice(1,100);source.postings=[p(1820,"D",80),p(kind==="VAT"?1530:5990,"D",20),p(2310,"C",100,undefined,{accounts_dimensions_id:11})];
      const payment=paid(3,100);payment.postings[0]!.accounts_dimensions_id=mismatch?22:11;
      const r=calculateAnnualCashFlow({accounts:[...accounts,makeAccount(1530,"D","Varad","VAT","VAT",{is_vat_account:true})],journals:[source,payment],evidence:evidence(detail(3,[{...item(1,1,100),accounts_dimensions_id:11}])),dateFrom:"2026-01-01",dateTo:"2026-12-31"});
      expect(r.status).toBe(mismatch?"requires_review":"complete");expect(r.investing.cash_payments).toBe(mismatch?0:kind==="VAT"?100:80);
      expect(r.operating_bridge.direct_operating_cash).toBe(!mismatch&&kind==="mixed"?-20:0);
    }
  });
  it.each(["matching","wrong_item_dimension","wrong_posting_dimension","wrong_direction","wrong_header_sign","duplicate_edge","reused_slice","overstated_slice"])("proves historical capital capacity %s",kind=>{
    const source=invoice(1,100);source.effective_date="2025-10-01";source.postings[1]!.accounts_dimensions_id=11;
    const prior=paid(2,40,{effective_date:"2025-11-01"});prior.postings[0]!.accounts_dimensions_id=kind==="wrong_posting_dimension"?22:11;
    const paymentAmount=kind==="duplicate_edge"||kind==="reused_slice"?20:60;
    const payment=paid(3,paymentAmount);payment.postings[0]!.accounts_dimensions_id=11;
    let priorEdge={...item(2,1,40),accounts_dimensions_id:kind==="wrong_item_dimension"?22:11};
    const priorDetail=detail(2,[priorEdge],40);priorDetail.date=prior.effective_date;
    if(kind==="wrong_direction")prior.postings=[p(2310,"C",40,undefined,{accounts_dimensions_id:11}),p(1020,"D",40,undefined,{accounts_dimensions_id:101})];
    if(kind==="wrong_header_sign")priorDetail.amount=-40;
    if(kind==="duplicate_edge")priorDetail.items=[priorEdge,priorEdge];
    if(kind==="reused_slice")priorDetail.items=[priorEdge,{...priorEdge,id:9}];
    if(kind==="overstated_slice") {prior.postings[0]!.amount=20;prior.postings.splice(1,0,p(2310,"D",20,undefined,{accounts_dimensions_id:22}));}
    const r=calculate([source,prior,payment],evidence(priorDetail,detail(3,[{...item(3,1,paymentAmount),accounts_dimensions_id:11}],paymentAmount)));
    expect(r.status).toBe(kind==="matching"?"complete":"requires_review");expect(r.investing.cash_payments).toBe(kind==="matching"?60:0);
  });
  it("does not spend an unrelated historical dimension's capacity",()=>{
    const source=invoice(1,100);source.effective_date="2025-10-01";source.postings[1]!.accounts_dimensions_id=11;
    const unrelated=journal(2,[p(2310,"D",90,undefined,{accounts_dimensions_id:22}),p(1210,"C",90)],{effective_date:"2025-11-01"});
    const payment=paid(3,100);payment.postings[0]!.accounts_dimensions_id=11;
    expect(calculate([source,unrelated,payment],evidence(detail(3,[{...item(3,1,100),accounts_dimensions_id:11}]))).status).toBe("complete");
  });
  it.each([false,true])("does not restore historical invoice capacity beyond actual cash opposed=%s",opposed=>{
    const source=invoice(10,200);source.effective_date="2025-01-01";
    const first=paid(11,200,{effective_date:"2025-02-01"});
    const refund=paid(12,100,{effective_date:"2025-03-01"});
    refund.postings=[p(1020,"D",100,undefined,{accounts_dimensions_id:101}),...(opposed?[p(2310,"D",50)]:[]),p(2310,"C",opposed?150:100)];
    const current=paid(13,opposed?150:100);
    const firstDetail=detail(11,[item(11,10,200)],200);firstDetail.date=first.effective_date;
    const refundDetail=detail(12,[item(12,10,opposed?-150:-100)],100);refundDetail.date=refund.effective_date;
    const r=calculate([source,first,refund,current],evidence(firstDetail,refundDetail,detail(13,[item(13,10,opposed?150:100)],opposed?150:100)));
    expect(r.status).toBe(opposed?"requires_review":"complete");expect(r.investing.cash_payments).toBe(opposed?0:100);
    expect(r.unresolved_cash.payment_total).toBe(opposed?150:0);
  });
  it.each(["later_invoice","prior_year","other_client_offset","earlier_exact_payment"])("separates proved operating purpose from %s capacity auditing",kind=>{
    const source=invoice(1,100,5990);source.clients_id=11;
    const extra:Journal[]=[];
    if(kind==="later_invoice")source.effective_date="2026-06-30";
    if(kind==="prior_year") {source.effective_date="2025-12-01";extra.push(paid(2,20,{effective_date:"2025-12-15",clients_id:22}));}
    if(kind==="other_client_offset")extra.push(journal(2,[p(2310,"D",20),p(1210,"C",20)],{clients_id:22}));
    if(kind==="earlier_exact_payment") {source.effective_date="2026-06-30";extra.push(paid(2,20));}
    const e=evidence(detail(3,[item(3,1,40)],40),...(kind==="earlier_exact_payment"?[detail(2,[item(2,1,20)],20)]:[]));
    const r=calculate([source,...extra,paid(3,40)],e);
    expect(r.status).toBe("complete");expect(r.unresolved_cash.count).toBe(0);
    expect(r.operating_bridge.direct_operating_cash).toBe(kind==="earlier_exact_payment"?-60:-40);
  });
  it.each([8500,1530,8610])("owns exact invoice and direct operating account %s components once",accountId=>{
    const payment=journal(3,[p(2310,"D",40),p(accountId,"D",1,undefined,{accounts_dimensions_id:77}),p(1020,"C",41,undefined,{accounts_dimensions_id:101})],{operation_type:"TRANSACTION",operations_id:3});
    const e=evidence(detail(3,[item(1,1,40),{id:2,accounts_id:accountId,accounts_dimensions_id:77,relation_table:"accounts",relation_id:Number(`${accountId}77`),amount:1,base_amount:1}],41));
    const input={accounts:[...accounts,makeAccount(accountId,"D",accountId===1530?"Varad":"Kulud","Operating source")],journals:[invoice(1,40,5990),payment],evidence:e,dateFrom:"2026-01-01",dateTo:"2026-12-31"};
    const r=calculateAnnualCashFlow(input);
    expect(r.status).toBe("complete");expect(r.operating_bridge.adjusted_total).toBe(-41);expect(r.operating_bridge.direct_operating_cash).toBe(-41);
    const slices=r.cash_movements.filter(m=>m.journal_id===3).flatMap(m=>m.component_slices);
    expect(slices.filter(s=>s.account_id===2310).reduce((sum,s)=>sum+s.working_capital,0)).toBe(-40);
    (e.transactions.get(3)!.items![1] as any).accounts_dimensions_id=78;
    expect(calculateAnnualCashFlow(input).status).toBe("requires_review");
  });
  it.each(["zero_obligation","wrong_refund_sign","over_current_invoice","source_dimension","malformed_source","duplicate_item","unknown_relation"])("retains operating source safety for %s",kind=>{
    const source=invoice(1,100,5990),payment=paid(3,100);let items:any[]=[item(1,1,100)];
    if(kind==="zero_obligation")source.postings=[p(5990,"D",100),p(5990,"C",100),p(2310,"D",0)];
    if(kind==="wrong_refund_sign")payment.postings=[p(2310,"C",100),p(1020,"D",100,undefined,{accounts_dimensions_id:101})];
    if(kind==="over_current_invoice") {source.postings=[p(5990,"D",60),p(2310,"C",60)];items=[item(1,1,50),item(2,1,50)];}
    if(kind==="source_dimension")source.postings[1]!.accounts_dimensions_id=999;
    if(kind==="malformed_source")source.postings[0]!.amount=90;
    if(kind==="duplicate_item")items=[item(1,1,50),item(1,1,50)];
    if(kind==="unknown_relation")items=[{...item(1,1,100),relation_table:"untrusted"}];
    expect(calculate([source,payment],evidence(detail(3,items))).status).toBe("requires_review");
  });
  it.each([{date:"2026-06-02"},{accounts_id:999},{accounts_dimensions_id:999},{base_amount:99},{cl_currencies_id:"USD"},{status:"PROJECT"},{is_deleted:true}])("validates operating transaction material %j",change=>{
    expect(calculate([invoice(1,100,5990),paid(3,100)],evidence({...detail(3,[item(1,1,100)]),...change} as Transaction)).status).toBe("requires_review");
  });
  it.each(["deleted","draft","ambiguous"])("holds an operating invoice with %s registration",kind=>{
    const source=invoice(1,100,5990);if(kind==="deleted")source.is_deleted=true;if(kind==="draft")source.registered=false;
    expect(calculate([source,...(kind==="ambiguous"?[{...source,id:9}]:[]),paid(3,100)],evidence(detail(3,[item(1,1,100)]))).status).toBe("requires_review");
  });
  it("preserves signed operating credit refunds and refuses an unproved direct investment split",()=>{
    const refund=journal(3,[p(2310,"D",-30),p(1020,"C",-30,undefined,{accounts_dimensions_id:101})],{operation_type:"TRANSACTION",operations_id:3});
    const r=calculate([invoice(1,-30,5990),refund],evidence(detail(3,[item(1,1,-30)],30)));
    expect(r.status).toBe("complete");expect(r.operating_bridge.direct_operating_cash).toBe(30);
    const mixed=journal(4,[p(2310,"D",40),p(1100,"D",10),p(1020,"C",50,undefined,{accounts_dimensions_id:101})],{operation_type:"TRANSACTION",operations_id:4});
    const e=evidence(detail(4,[item(1,1,40),{id:2,accounts_id:1100,relation_table:"accounts",relation_id:1100,amount:10,base_amount:10}],50));
    expect(calculate([invoice(1,40,5990),mixed],e).status).toBe("requires_review");
  });
  it("accepts the API positive distribution magnitude for a signed sales credit-note refund",()=>{
    const source=journal(1,[p(1210,"D",-450),p(3100,"C",-450)],{operation_type:"SALE_INVOICE",operations_id:1});
    const payment=journal(3,[p(1210,"D",450),p(1020,"C",450,undefined,{accounts_dimensions_id:101})],{operation_type:"TRANSACTION",operations_id:3});
    const creditItem={...item(1,1,450),accounts_id:1210,relation_table:"sale_invoices",item_sum:-450,item_subtype:"CREDIT-INVOICE"};
    const r=calculate([source,payment],evidence(detail(3,[creditItem],450)));
    expect(r.status).toBe("complete");expect(r.operating_bridge.direct_operating_cash).toBe(-450);expect(r.operating_bridge.adjusted_total).toBe(-450);
    expect(r.unresolved_cash.count).toBe(0);
  });
  it("requires exact distribution evidence to separate internal cash from external borrowing",async()=>{
    const rows=[p(1020,"D",2250,undefined,{accounts_dimensions_id:101}),p(1010,"C",783.77,undefined,{accounts_dimensions_id:92}),p(2110,"C",1466.23,undefined,{accounts_dimensions_id:91})];
    const registration=journal(3,rows,{operation_type:"TRANSACTION",operations_id:3});
    const t=detail(3,[{id:1,accounts_id:1010,accounts_dimensions_id:92,relation_table:"accounts",relation_id:101092,amount:783.77,base_amount:783.77},{id:2,accounts_id:2110,accounts_dimensions_id:91,relation_table:"accounts",relation_id:211091,amount:1466.23,base_amount:1466.23}],2250);
    const input={accounts:[...accounts,makeAccount(1010,"D","Varad","Kassa"),makeAccount(2110,"C","Kohustused","Laen")],journals:[registration],dateFrom:"2026-01-01",dateTo:"2026-12-31"};
    const r=calculateAnnualCashFlow({...input,evidence:evidence(t)});
    expect(r.status).toBe("complete");expect(r.financing).toMatchObject({cash_receipts:1466.23,cash_payments:0,net:1466.23});expect(r.operating_bridge.adjusted_total).toBe(0);
    expect(calculateAnnualCashFlow({...input,evidence:evidence()}).status).toBe("requires_review");
    (t.items![0] as any).accounts_dimensions_id=999;
    expect(calculateAnnualCashFlow({...input,evidence:evidence(t)}).status).toBe("requires_review");
    (t.items![0] as any).accounts_dimensions_id=92;t.items=t.items!.slice(0,1);
    expect(calculateAnnualCashFlow({...input,evidence:evidence(t)}).status).toBe("requires_review");
    const get=vi.fn().mockResolvedValue(t);await loadCashFlowEvidence({transactions:{get}} as any,[registration],new Set([1020,1010]),input.dateFrom,input.dateTo);
    expect(get).toHaveBeenCalledWith(3);
  });
  it.each([[3820,7100,1820],[8330,8335,1100]])("does not certify result-only invoice account %s as operating",(resultAccount,costAccount,principalAccount)=>{
    const saleAccounts=[...accounts,makeAccount(resultAccount,"C","Tulud","Müügitulu"),makeAccount(costAccount,"D","Kulud","Müügikulu")];
    const source=journal(1,[p(1210,"D",120),p(resultAccount,"C",120)],{operation_type:"SALE_INVOICE",operations_id:1});
    const disposal=journal(2,[p(costAccount,"D",80),p(principalAccount,"C",80)]);
    const payment=journal(3,[p(1020,"D",120,undefined,{accounts_dimensions_id:101}),p(1210,"C",120)],{operation_type:"TRANSACTION",operations_id:3});
    const input={accounts:saleAccounts,journals:[source,disposal,payment],evidence:evidence(detail(3,[{...item(1,1,120),accounts_id:1210,relation_table:"sale_invoices"}],120)),dateFrom:"2026-01-01",dateTo:"2026-12-31"};
    const r=calculateAnnualCashFlow(input);
    expect(r.status).toBe("requires_review");expect(r.unresolved_cash.receipt_total).toBe(120);expect(r.operating_bridge.direct_operating_cash).toBe(0);
    const direct=calculateAnnualCashFlow({...input,journals:[disposal,journal(4,[p(1020,"D",120),p(resultAccount,"C",120)])]});
    expect(direct.status).toBe("requires_review");expect(direct.unresolved_cash.receipt_total).toBe(120);
    const reviewed=calculateAnnualCashFlow({...input,categoryRule:(id:number)=>id===resultAccount?"investing" as const:undefined});
    expect(reviewed.status).toBe("complete");expect(reviewed.investing.cash_receipts).toBe(120);
    const dividend=calculateAnnualCashFlow({...input,journals:[journal(4,[p(1020,"D",120),p(resultAccount,"C",120)])],categoryRule:(id:number)=>id===resultAccount?"operating" as const:undefined});
    expect(dividend.status).toBe("complete");expect(dividend.operating_bridge.direct_operating_cash).toBe(120);
  });
  it("consumes a 100 payable component exactly once across 60 investing / 40 operating slices",()=>{
    const r=calculate([invoice(1,60),invoice(2,40,5990),paid(3,100)],evidence(detail(3,[item(1,1,60),item(2,2,40)])));
    expect(r.investing.net).toBe(-60); expect(r.operating_bridge.adjusted_total).toBe(-40);
    expect(r.operating_bridge.difference).toBe(0);expect(r.status).toBe("complete");
    const groups=r.cash_movements.filter(m=>m.journal_id===3);
    expect(groups.reduce((sum,m)=>sum+m.components.working_capital,0)).toBe(-100);
    expect(groups.map(m=>m.components.working_capital)).toEqual([-60,-40]);
  });
  it("refuses a duplicate item inside the same transaction",()=>{
    const duplicate=item(7,1,50);
    const r=calculate([invoice(1,100),paid(3,100)],evidence(detail(3,[duplicate,duplicate])));
    expect(r.status).toBe("requires_review");expect(r.unresolved_cash.items[0].reason).toBe("distribution_consumed_twice");
  });
  it.each([{date:"2026-06-02"},{accounts_dimensions_id:999},{accounts_id:999},{base_amount:99},{cl_currencies_id:"USD"}])("refuses mismatched transaction material %j",changed=>{
    const r=calculate([invoice(1,100),paid(3,100)],evidence({...detail(3,[item(1,1,100)]),...changed}));
    expect(r.status).toBe("requires_review");expect(r.unresolved_cash.items[0].reason).toBe("transaction_registration_material_mismatch");
  });
  it("traces a partial cross-year capital payment without using invoice/date/client guessing",()=>{
    const source=invoice(1,100);source.effective_date="2025-12-01";
    const r=calculate([source,paid(3,60)],evidence(detail(3,[item(1,1,60)],60)));
    expect(r.investing.net).toBe(-60);expect(r.operating_bridge.adjusted_total).toBe(0);
    expect(r.cash_movements[0].source_ids).toContain(1);
  });
  it("leaves mixed partial invoices unresolved",()=>{
    const source=journal(1,[p(1820,"D",60),p(5990,"D",40),p(2310,"C",100)],{operation_type:"PURCHASE_INVOICE",operations_id:1});
    const r=calculate([source,paid(3,50)],evidence(detail(3,[item(1,1,50)],50)));
    expect(r.status).toBe("requires_review");expect(r.unresolved_cash.payment_total).toBe(50);
  });
  it("splits an exactly fully paid mixed invoice using its actual source amounts",()=>{
    const source=journal(1,[p(1820,"D",60),p(5990,"D",40),p(2310,"C",100)],{operation_type:"PURCHASE_INVOICE",operations_id:1});
    const r=calculate([source,paid(3,100)],evidence(detail(3,[item(1,1,100)])));
    expect(r.investing.net).toBe(-60);expect(r.operating_bridge.adjusted_total).toBe(-40);expect(r.status).toBe("complete");
    expect(r.cash_movements.filter(m=>m.journal_id===3).map(m=>m.components.working_capital)).toEqual([-60,-40]);
  });
  it("holds capacity when an earlier noncash settlement may have consumed it",()=>{
    const offset=journal(2,[p(2310,"D",50),p(1210,"C",50)]);
    const r=calculate([invoice(1,100),offset,paid(3,100)],evidence(detail(3,[item(1,1,100)])));
    expect(r.status).toBe("requires_review");expect(r.investing.net).toBe(0);expect(r.unresolved_cash.payment_total).toBe(100);
  });
  it("rejects a credit item whose source and base amount signs disagree",()=>{
    const source=invoice(1,-30);
    const payment=journal(3,[p(2310,"D",-30),p(1020,"C",-30,undefined,{accounts_dimensions_id:101})],{operation_type:"TRANSACTION",operations_id:3});
    const r=calculate([source,payment],evidence(detail(3,[{...item(1,1,-30),amount:30}],30)));
    expect(r.status).toBe("requires_review");expect(r.investing.cash_receipts).toBe(0);
  });
  it("retains gross unknown even for a zero-net journal with investment counterparts",()=>{
    const r=calculate([journal(8,[p(1020,"D",100),p(1020,"C",100),p(1100,"D",100),p(1100,"C",100)])],evidence());
    expect(r.status).toBe("requires_review");expect(r.unresolved_cash).toMatchObject({receipt_total:100,payment_total:100,net:0});
  });
  it("classifies a capital credit-note supplier refund as investing receipt",()=>{
    const source=journal(1,[p(1820,"C",30),p(2310,"D",30)],{operation_type:"PURCHASE_INVOICE",operations_id:1});
    const payment=journal(3,[p(2310,"C",30),p(1020,"D",30,undefined,{accounts_dimensions_id:101})],{operation_type:"TRANSACTION",operations_id:3});
    const r=calculate([source,payment],evidence(detail(3,[item(1,1,-30)],30)));
    expect(r.investing.cash_receipts).toBe(30);expect(r.operating_bridge.adjusted_total).toBe(0);expect(r.status).toBe("complete");
  });
  it("a customer credit-note refund is an operating payment",()=>{
    const source=journal(1,[p(3100,"D",20),p(1210,"C",20)],{operation_type:"SALE_INVOICE",operations_id:1});
    const payment=journal(3,[p(1210,"D",20),p(1020,"C",20,undefined,{accounts_dimensions_id:101})],{operation_type:"TRANSACTION",operations_id:3});
    const r=calculate([source,payment],evidence(detail(3,[{...item(1,1,-20),accounts_id:1210,relation_table:"sale_invoices"}],20)));
    expect(r.operating_bridge.adjusted_total).toBe(-20);expect(r.operating_bridge.direct_operating_cash).toBe(-20);expect(r.status).toBe("complete");
  });
  it("restores only proved capacity on a partial payment reversal",()=>{
    const refund=journal(4,[p(2310,"C",20),p(1020,"D",20,undefined,{accounts_dimensions_id:101})],{operation_type:"TRANSACTION",operations_id:4});
    const r=calculate([invoice(1,100),paid(3,60),refund],evidence(detail(3,[item(1,1,60)],60),detail(4,[item(2,1,-20)],20)));
    expect(r.investing.net).toBe(-40);expect(r.status).toBe("complete");
  });
  it("does not fabricate gross cash for a mixed-sign invoice net settlement",()=>{
    const credit=journal(2,[p(1820,"C",20),p(2310,"D",20)],{operation_type:"PURCHASE_INVOICE",operations_id:2});
    const r=calculate([invoice(1,100),credit,paid(3,80)],evidence(detail(3,[item(1,1,100),item(2,2,-20)],80)));
    expect(r.status).toBe("requires_review");expect(r.investing.cash_receipts).toBe(0);expect(r.unresolved_cash.payment_total).toBe(80);
  });
  it("bounds and memoizes read-only detail hydration",async()=>{
    const get=vi.fn().mockImplementation(async(id:number)=>detail(id,[]));
    const journals=[paid(1,1),paid(1,1),paid(2,1),paid(3,1)];
    const e=await loadCashFlowEvidence({transactions:{get}} as any,journals,new Set([1020]),"2026-01-01","2026-12-31",2);
    expect(get.mock.calls.map(c=>c[0])).toEqual([1,2]);expect(e.requested).toBe(2);expect(e.failures.get(3)).toBe("detail_read_budget_exhausted");
  });
  it("does not assume missing prior-year invoice capacity is unused",()=>{
    const source=invoice(1,100);source.effective_date="2025-01-01";
    const prior=paid(2,60);prior.effective_date="2025-12-01";
    const r=calculate([source,prior,paid(3,60)],evidence(detail(3,[item(1,1,60)],60)));
    expect(r.status).toBe("requires_review");expect(r.unresolved_cash.items[0].reason).toBe("prior_invoice_capacity_unproved");
  });
  it("taints capacity after an earlier unresolved exact edge instead of silently resetting it",()=>{
    const invalid=detail(2,[item(1,1,60)],60);invalid.date="2026-06-02";
    const r=calculate([invoice(1,100),paid(2,60),paid(3,60)],evidence(invalid,detail(3,[item(2,1,60)],60)));
    expect(r.unresolved_cash.count).toBe(2);expect(r.status).toBe("requires_review");
  });
  it("supports negative D/C invoice credit rows with exact supplier refund evidence",()=>{
    const source=invoice(1,-30);
    const payment=journal(3,[p(2310,"D",-30),p(1020,"C",-30,undefined,{accounts_dimensions_id:101})],{operation_type:"TRANSACTION",operations_id:3});
    const r=calculate([source,payment],evidence(detail(3,[item(1,1,-30)],30)));
    expect(r.investing.cash_receipts).toBe(30);expect(r.status).toBe("complete");
  });
  it("does not trust unbalanced invoice source postings",()=>{
    const source=invoice(1,100);source.postings[0]!.amount=90;
    const r=calculate([source,paid(3,100)],evidence(detail(3,[item(1,1,100)])));
    expect(r.status).toBe("requires_review");expect(r.unresolved_cash.items[0].reason).toBe("invalid_invoice_posting");
  });
});
