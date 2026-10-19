import { describe, expect, it } from "vitest";
import { makeAccount, makeJournal, makePosting } from "../__fixtures__/accounting.js";
import { calculateAnnualCashFlow } from "./annual-cash-flow.js";
import type { Journal } from "../types/api.js";

const accounts = [
  makeAccount(1020, "D", "Varad", "Pank"), makeAccount(1100, "D", "Varad", "Investeeringud"),
  makeAccount(1360, "D", "Varad", "Aruandvad isikud"), makeAccount(1410, "D", "Varad", "Laenunõuded"),
  makeAccount(1820, "D", "Varad", "Põhivara"), makeAccount(2110, "C", "Kohustused", "Laenud"),
  makeAccount(2210, "C", "Kohustused", "Ostjate ettemaksed"), makeAccount(2310, "C", "Kohustused", "Võlad tarnijatele"),
  makeAccount(2650, "C", "Kohustused", "Dividendivõlad"), makeAccount(2656, "C", "Kohustused", "Dividenditulumaksu võlg"),
  makeAccount(2810, "C", "Kohustused", "Pikaajalised laenud"), makeAccount(2900, "C", "Omakapital", "Osakapital"),
  makeAccount(2960, "C", "Omakapital", "Jaotamata kasum"), makeAccount(3100, "C", "Tulud", "Müügitulu"),
  makeAccount(5990, "D", "Kulud", "Muud kulud"), makeAccount(7000, "D", "Kulud", "Kulum"),
  makeAccount(8330, "C", "Tulud", "Tulu aktsiatelt ja osadelt"), makeAccount(8335, "D", "Kulud", "Kulu aktsiatelt ja osadelt"),
  makeAccount(8500, "C", "Tulud", "Kasum/kahjum valuutakursi muutustest"),
];
const p = makePosting;
const j = (id: number, rows: ReturnType<typeof p>[], extra: Partial<Journal> = {}) => makeJournal("2026-06-01", rows, { id, ...extra });
const calculate = (journals: Journal[], extra = {}) => calculateAnnualCashFlow({ accounts, journals, dateFrom: "2026-01-01", dateTo: "2026-12-31", ...extra });

describe("auditable indirect cash flow", () => {
  const fxAccounts=[...accounts,makeAccount(3840,"C","Tulud","Valuutakursi kasum"),makeAccount(7310,"D","Kulud","Valuutakursi kahjum")];
  it.each([3840,7310,8500].flatMap(id=>[
    {id,cash:130,principal:-100,result:-30},{id,cash:80,principal:-100,result:20},
    {id,cash:-105,principal:100,result:5},{id,cash:-95,principal:100,result:-5},
  ]))("uses actual cash for valued FX principal bundle $id/$cash",({id,cash,principal,result})=>{
    for(const negative of [false,true]) {
      const row=(account:number,n:number)=>p(account,negative?(n>0?"C":"D"):(n>0?"D":"C"),negative?-Math.abs(n):Math.abs(n));
      const r=calculate([j(400,[row(1020,cash),row(1100,principal),row(id,result)])],{accounts:fxAccounts});
      expect(r.investing.net).toBe(cash);expect(r.operating_bridge.non_operating_adjustments).toBe(result);
      expect(r.operating_bridge.adjusted_total).toBe(0);expect(r.exchange_rate_effect_on_cash).toBe(0);expect(r.status).toBe("complete");
    }
  });
  it.each([3840,7310,8500])("uses EUR base for foreign-cash principal bundle %s",id=>{
    const r=calculate([j(400,[p(1020,"D",143,130,{cl_currencies_id:"USD"}),p(1100,"C",100),p(id,"C",30)])],{accounts:fxAccounts});
    expect(r.investing.cash_receipts).toBe(130);expect(r.status).toBe("complete");expect(r.operating_bridge.non_operating_adjustments).toBe(-30);expect(r.operating_bridge.difference).toBe(0);expect(r.exchange_rate_effect_on_cash).toBe(0);
  });
  it.each([
    [p(1020,"D",70),p(1100,"D",30),p(8330,"C",100)],
    [p(1100,"D",100),p(1020,"C",70),p(8330,"C",30)],
    [p(1410,"D",100),p(1020,"C",70),p(8330,"C",30)],
    [p(1020,"D",130),p(1410,"C",100),p(8330,"C",30)],
    [p(1100,"D",105),p(8335,"C",5),p(1020,"C",100)],
    [p(1020,"D",100),p(1100,"D",0),p(8330,"C",100)],
    [p(1020,"D",130),p(1100,"C",50),p(1820,"C",50),p(8330,"C",30)],
    [p(5990,"D",100),p(7310,"D",5),p(1020,"C",105)],
  ].map(rows=>[rows]))("holds unsupported principal/result shapes %# before generic fallback",rows=>{
    const r=calculate([j(400,rows)],{accounts:fxAccounts,categoryRule:(id:number)=>id===5990?"investing":undefined});
    expect(r.status).toBe("requires_review");expect(r.investing.net).toBe(0);expect(r.financing.net).toBe(0);
    expect(r.unresolved_cash.net).toBe(rows.filter(p=>p.accounts_id===1020).reduce((s,p)=>s+(p.type==="D"?p.amount:-p.amount),0));
  });
  it.each(["operating","investing"] as const)("holds bundled FX with explicit %s result rule",rule=>{
    const r=calculate([j(400,[p(1020,"D",130),p(1100,"C",100),p(8500,"C",30)])],{categoryRule:(id:number)=>id===8500?rule:undefined});
    expect(r.status).toBe("requires_review");expect(r.unresolved_cash.receipt_total).toBe(130);
  });
  it.each([[p(2110,"D",100),p(7310,"D",5),p(1020,"C",105)],[p(1020,"D",130),p(2110,"C",100),p(8500,"C",30)]].map(rows=>[rows]))("holds unsupported financing FX %#",rows=>{
    const r=calculate([j(400,rows)],{accounts:fxAccounts});expect(r.status).toBe("requires_review");expect(r.financing.net).toBe(0);expect(r.unresolved_cash.count).toBe(1);
  });
  it.each([1100,1410,2110])("ignores valued zero FX on ordinary principal %s",id=>{
    const r=calculate([j(400,[p(id,"D",100),p(1020,"C",100),p(8500,"C",0)])]);
    expect(r.status).toBe("complete");expect(id===2110?r.financing.net:r.investing.net).toBe(-100);
  });
  it("preserves multiple securities acquisition fees and simultaneous sale gain/fees",()=>{
    for(const rows of [[p(1100,"D",100),p(8335,"D",2),p(8335,"D",3),p(1020,"C",105)],
      [p(1020,"D",125),p(1100,"C",100),p(8330,"C",30),p(8335,"D",2),p(8335,"D",3)]]) {
      const r=calculate([j(400,rows)]);expect(r.status).toBe("complete");expect(r.operating_bridge.adjusted_total).toBe(0);
      expect(r.investing.net).toBe(rows[0]!.accounts_id===1020?125:-105);
    }
  });
  const fixedAccounts=[...accounts,makeAccount(1829,"C","Varad","Akumuleeritud kulum"),makeAccount(3820,"C","Tulud","Põhivara müügikasum"),makeAccount(7100,"D","Kulud","Põhivara müügikahjum")];
  it.each([60,100])("proves conventional fixed asset disposal with depreciation %s",depreciation=>{
    const r=calculate([j(400,[p(1020,"D",50),p(1820,"C",100),p(1829,"D",depreciation),p(3820,"C",depreciation-50)])],{accounts:fixedAccounts});
    expect(r.status).toBe("complete");expect(r.investing.cash_receipts).toBe(50);expect(r.operating_bridge.adjusted_total).toBe(0);expect(r.operating_bridge.non_operating_adjustments).toBe(50-depreciation);
  });
  it.each([false,true])("preserves cent-valued fully depreciated sale with split contra=%s",split=>{
    const contra=split?[p(1829,"D",.10),p(1829,"D",.20)]:[p(1829,"D",.30)];
    const r=calculate([j(400,[p(1020,"D",.20),p(1820,"C",.30),...contra,p(3820,"C",.20)])],{accounts:fixedAccounts});
    expect(r.status).toBe("complete");expect(r.investing.cash_receipts).toBe(.20);expect(r.operating_bridge.non_operating_adjustments).toBe(-.20);expect(r.operating_bridge.adjusted_total).toBe(0);expect(r.exchange_rate_effect_on_cash).toBe(0);
  });
  it.each([.001,.00001])("does not round away an excess contra amount %s",excess=>{
    const r=calculate([j(400,[p(1020,"D",.20),p(1820,"C",.30),p(1829,"D",.30+excess),p(3820,"C",.20+excess)])],{accounts:fixedAccounts});
    expect(r.status).toBe("requires_review");expect(r.investing.cash_receipts).toBe(0);expect(r.unresolved_cash.receipt_total).toBe(.20);
  });
  it.each(["unrelated","wrong_side","excess","contra_only","wrong_family"])("holds unsupported accumulated depreciation %s",kind=>{
    const contra=kind==="wrong_family"?1799:1829;
    const rows=kind==="contra_only"?[p(1020,"D",50),p(contra,"C",100),p(3820,"C",-50)]:
      [p(1020,"D",50),p(1820,"C",100),p(contra,kind==="wrong_side"?"C":"D",kind==="excess"?110:60),p(3820,"C",kind==="wrong_side"?-110:kind==="excess"?60:10)];
    const accts=[...fixedAccounts.filter(a=>a.id!==1829),makeAccount(contra,"C","Varad",kind==="unrelated"?"Unrelated asset":"Akumuleeritud kulum")];
    expect(calculate([j(400,rows)],{accounts:accts}).status).toBe("requires_review");
  });
  it.each(["receipt","payment","opposed","zero_net","partial_cash","only_unknown","bad_side","nonfinite","sign_conflict","initial"])("preserves independently valued gross on invalid %s",kind=>{
    const malformed=p(5990,"C",108,undefined,{cl_currencies_id:"USD"});
    const rows=kind==="payment"?[p(1020,"C",95),malformed]:kind==="opposed"?[p(1020,"D",150),p(1020,"C",55),malformed]:
      kind==="zero_net"?[p(1020,"D",95),p(1020,"C",95),malformed]:kind==="only_unknown"?[p(1020,"D",108,undefined,{cl_currencies_id:"USD"}),p(3100,"C",95)]:
      kind==="partial_cash"?[p(1020,"D",95),p(1020,"D",108,undefined,{cl_currencies_id:"USD"}),malformed]:[p(1020,"D",95),malformed];
    if(kind==="bad_side")rows[1]={...p(5990,"C",95),type:"X" as any};
    if(kind==="nonfinite")rows[1]=p(5990,"C",95,NaN);
    if(kind==="sign_conflict")rows[1]=p(5990,"C",95,-95);
    const r=calculate([j(400,rows,{operation_type:kind==="initial"?"INITIAL":undefined})]);
    expect(r.status).toBe("requires_review");
    expect(r.unresolved_cash).toMatchObject({receipt_total:kind==="initial"||kind==="only_unknown"||kind==="payment"?0:kind==="opposed"?150:95,payment_total:kind==="initial"?0:kind==="opposed"?55:kind==="payment"||kind==="zero_net"?95:0});
    expect(r.evidence_coverage).toMatchObject({unvalued_cash_posting_count:kind==="partial_cash"||kind==="only_unknown"?1:0});
    if(kind==="initial")expect(r.cash_movements).toEqual([]);
    if(kind==="partial_cash")expect(r.unresolved_cash.items[0]).toMatchObject({unvalued_cash_posting_count:1,unvalued_cash_posting_indexes:[1],valued_cash_posting_indexes:[0]});
  });
  it("keeps a balanced investment purchase currency result inside the principal bundle",()=>{
    const r=calculate([j(40,[p(1100,"D",225.37),p(1020,"C",225.02),p(3840,"C",.35)])],{accounts:[...accounts,makeAccount(3840,"C","Tulud","Valuutakursi kasum")]});
    expect(r.status).toBe("complete");expect(r.investing.net).toBe(-225.02);expect(r.operating_bridge.adjusted_total).toBe(0);expect(r.exchange_rate_effect_on_cash).toBe(0);
    expect(r.operating_bridge.non_operating_adjustments).toBe(-.35);
    expect(calculate([j(41,[p(1020,"D",.35),p(3840,"C",.35)])],{accounts:[...accounts,makeAccount(3840,"C","Tulud","Valuutakursi kasum")]}).status).toBe("requires_review");
  });
  it("requires an explicit rule for unsupported custom financial receivables",()=>{
    const result=calculate([j(40,[p(1460,"D",100),p(1020,"C",100)])],{accounts:[...accounts,makeAccount(1460,"D","Varad","Custom loan receivable")]});
    expect(result.status).toBe("requires_review");expect(result.unresolved_cash.payment_total).toBe(100);
  });
  it("removes declarations and loan offsets once, preserving zero dividend-offset components", () => {
    const result = calculate([
      j(1, [p(2960,"D",2500),p(2650,"C",2500)]), j(2,[p(2960,"D",2000),p(2650,"C",2000)]),
      j(3,[p(2650,"D",2500),p(1360,"C",2500)]), j(4,[p(2650,"D",2000),p(1360,"C",2000)]),
      j(5,[p(2110,"D",3100),p(1410,"C",3100)]), j(6,[p(2110,"D",100),p(1360,"C",100)]),
    ]);
    expect(result.operating_bridge.base_total).toBe(7700);
    expect(result.operating_bridge.non_cash_adjustments).toBe(-7700);
    expect(result.operating_bridge.adjusted_total).toBe(0);
    expect(result.operating_bridge.source_rows.find(r=>r.journal_id===3)).toMatchObject({ adjustment: 0, components: { working_capital: 0 } });
    for(const [id,amount] of [[1,-2500],[2,-2000],[3,0],[4,0],[5,-3100],[6,-100]]) expect(result.operating_bridge.source_rows.find(r=>r.journal_id===id)?.adjustment).toBe(amount);
    expect(result.operating_bridge.source_rows.find(r=>r.journal_id===3)?.component_slices.map(s=>s.working_capital)).toEqual([-2500,2500]);
    expect(result.status).toBe("complete");
  });
  it.each([[80,100,20,0],[130,100,0,30],[1675,1691.53,16.53,0],[1665,1888.22,223.22,0]])("uses actual investment proceeds %s, not book value %s", (cash,book,loss,gain) => {
    const result=calculate([j(8,[p(1020,"D",cash),p(1100,"C",book),...(loss?[p(8335,"D",loss)]:[]),...(gain?[p(8330,"C",gain)]:[])])]);
    expect(result.investing.cash_receipts).toBe(cash);
    expect(result.operating_bridge.adjusted_total).toBe(0);
    expect(result.operating_bridge.non_operating_adjustments).toBe(loss-gain);
    expect(result.status).toBe("complete");
  });
  it("does not sweep an unrelated expense into investment sales",()=>{
    const result=calculate([j(9,[p(1020,"D",100),p(5990,"D",50),p(1100,"C",150)])]);
    expect(result.status).toBe("requires_review"); expect(result.unresolved_cash.receipt_total).toBe(100);
  });
  it("classifies given loans, dividends and borrowing while keeping tax operating",()=>{
    const result=calculate([j(10,[p(1410,"D",50),p(1020,"C",50)]),j(11,[p(2650,"D",40),p(1020,"C",40)]),
      j(12,[p(2810,"C",60),p(1020,"D",60)]),j(13,[p(2656,"D",10),p(1020,"C",10)])]);
    expect(result.investing.net).toBe(-50); expect(result.financing.net).toBe(20);
    expect(result.operating_bridge.adjusted_total).toBe(-10); expect(result.operating_bridge.difference).toBe(0);
  });
  it("keeps unsupported operating bridge coverage visible",()=>{
    const result=calculate([j(14,[p(1020,"D",100),p(2210,"C",100)])]);
    expect(result.operating_bridge.adjusted_total).toBe(0); expect(result.operating_bridge.direct_operating_cash).toBe(100);
    expect(result.operating_bridge.difference).toBe(-100); expect(result.status).toBe("requires_review");
  });
  it("retains zero-net unknown gross exposure",()=>{
    const result=calculate([j(15,[p(1020,"D",100),p(9999,"C",100)]),j(16,[p(1020,"C",100),p(9999,"D",100)])]);
    expect(result.unresolved_cash).toMatchObject({ count:2,receipt_total:100,payment_total:100,net:0 });
    expect(result.status).toBe("requires_review");
  });
  it("aggregates subcent movements before rounding",()=>{
    const result=calculate([1,2,3].map(id=>j(id,[p(1020,"D",0.004),p(3100,"C",0.004)])));
    expect(result.operating_bridge.adjusted_total).toBe(0.01); expect(result.operating_bridge.direct_operating_cash).toBe(0.01);
  });
  it("separates an evidenced base-only FX effect",()=>{
    const result=calculate([j(17,[p(1020,"D",0,5,{cl_currencies_id:"USD"}),p(8500,"C",5)])]);
    expect(result.exchange_rate_effect_on_cash).toBe(5); expect(result.operating_bridge.adjusted_total).toBe(0);
  });
  it("never certifies foreign source currency as EUR when base amount is missing",()=>{
    const result=calculate([j(18,[p(1020,"D",10,undefined,{cl_currencies_id:"USD"}),p(3100,"C",10)])]);
    expect(result.status).toBe("requires_review"); expect(result.unresolved_cash.count).toBe(1);
    expect(result.unresolved_cash.items[0].reason).toBe("missing_base_amount");
  });
  it("excludes INITIAL and ignores drafts and deleted journals",()=>{
    const result=calculate([j(19,[p(1020,"D",1000),p(2900,"C",1000)],{operation_type:"INITIAL"}),
      j(20,[p(1020,"D",60),p(3100,"C",60)]),j(21,[p(1020,"D",10),p(3100,"C",10)],{registered:false}),
      j(22,[p(1020,"D",10),p(3100,"C",10)],{is_deleted:true}),
      j(23,[p(1020,"D",10),p(3100,"C",10)],{effective_date:"2027-01-01"}),
      j(24,[p(1020,"D",10,undefined,{is_deleted:true}),p(3100,"C",10,undefined,{is_deleted:true})])]);
    expect(result.operating_bridge.adjusted_total).toBe(60);expect(result.financing.net).toBe(0);
  });
  it("accepts signed ordinary credit-note postings without treating them as malformed",()=>{
    const result=calculate([j(25,[p(5990,"D",-30),p(1020,"C",-30)])]);
    expect(result.operating_bridge.adjusted_total).toBe(30);expect(result.operating_bridge.direct_operating_cash).toBe(30);expect(result.status).toBe("complete");
  });
  it("does not certify an unbalanced noncash declaration",()=>{
    const result=calculate([j(26,[p(2960,"D",6999),p(2650,"C",7000)])]);
    expect(result.status).toBe("requires_review");
  });
  it("respects an explicit result-account override instead of swallowing it in a sale bundle",()=>{
    const result=calculate([j(27,[p(1020,"D",80),p(8335,"D",20),p(1100,"C",100)])],{categoryRule:(id:number)=>id===8335?"financing":undefined});
    expect(result.status).toBe("requires_review");expect(result.unresolved_cash.receipt_total).toBe(80);
  });
  it("recognizes an internal transfer with an operating bank fee without inventing gross external flows",()=>{
    const result=calculate([j(28,[p(1020,"D",100),p(1020,"C",101),p(5990,"D",1)])]);
    expect(result.operating_bridge.adjusted_total).toBe(-1);expect(result.investing.net).toBe(0);expect(result.financing.net).toBe(0);expect(result.status).toBe("complete");
  });
});
