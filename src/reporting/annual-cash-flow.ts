import type { Account, Journal, Posting } from "../types/api.js";
import type { CashFlowEvidence } from "./cash-flow-evidence.js";
import { roundMoney } from "../money.js";
import { isYearEndClosingJournal } from "../year-end-closing-journal.js";
import { resolveDividendPayableAccount, resolveDividendCitPayableAccount } from "../account-resolution.js";

export type CashCategory = "operating" | "investing" | "financing" | "fx" | "unclassified";
interface Components { profit: number; depreciation: number; working_capital: number }
interface ComponentSlice extends Components { posting_id: number | null; posting_index:number; account_id: number }
interface InvoiceEvidence { transaction_id:number; transaction_item_id:number|null; invoice_id:number; invoice_journal_id:number|null; invoice_posting_ids:number[] }
interface DistributionEvidence { transaction_id:number; items:Array<{transaction_item_id:number|null;account_id:number;account_dimension_id:number|null;amount:number;posting_ids:number[];internal_cash:boolean}> }
interface Movement { journal_id: number | null; posting_ids: number[]; category: CashCategory; amount: number; source_ids: number[]; reason: string; receipt_total: number; payment_total: number; components:Components; component_slices:ComponentSlice[]; invoice_evidence?:InvoiceEvidence; distribution_evidence?:DistributionEvidence;
  unvalued_cash_posting_count?:number; unvalued_cash_posting_ids?:number[]; unvalued_cash_posting_indexes?:number[]; valued_cash_posting_count?:number; valued_cash_posting_ids?:number[]; valued_cash_posting_indexes?:number[]; cash_valuation_lists_truncated?:boolean;
}
interface Adjustment { journal_id: number | null; posting_ids: number[]; kind: "non_cash" | "non_operating" | "unresolved" | "opening_position"; components: Components; adjustment: number; source_ids: number[]; reason: string; component_slices: ComponentSlice[] }
interface Input {
  accounts: Account[]; journals: Journal[]; dateFrom: string; dateTo: string;
  baseOperating?: number; calculatedResultAccount?: number;
  categoryRule?: (accountId: number) => "operating" | "investing" | "financing" | undefined;
  evidence?: CashFlowEvidence;
}
const sum = (c: Components) => c.profit + c.depreciation + c.working_capital;
const zero = (): Components => ({ profit: 0, depreciation: 0, working_capital: 0 });
const combine = (slices: ComponentSlice[]): Components => slices.reduce((c, s) => ({ profit:c.profit+s.profit, depreciation:c.depreciation+s.depreciation, working_capital:c.working_capital+s.working_capital }), zero());
const range = (id: number, a: number, b: number) => id >= a && id <= b;
const settling = (id: number) => range(id,1200,1299) || range(id,2300,2399);
const rawAmount = (p: Posting) => p.base_amount ?? p.amount;
const signed = (p: Posting) => (p.type === "D" ? 1 : -1) * rawAmount(p);
const postingIsValued = (p:Posting,j:Journal) => (p.type==="D"||p.type==="C") && Number.isFinite(rawAmount(p)) &&
  !(p.base_amount!=null&&p.amount!==0&&Math.sign(p.amount)!==Math.sign(p.base_amount)) &&
  !((p.cl_currencies_id??j.cl_currencies_id??"EUR")!=="EUR"&&p.base_amount==null);
export function isCashFlowCashAccount(account: Account): boolean { return account.account_type_est === "Varad" && String(account.id).startsWith("10"); }

export function calculateAnnualCashFlow(input: Input) {
  const chart = new Map(input.accounts.map(a => [a.id,a]));
  const cash = new Set(input.accounts.filter(isCashFlowCashAccount).map(a=>a.id));
  const dividend = resolveDividendPayableAccount(input.accounts), cit = resolveDividendCitPayableAccount(input.accounts);
  const year = Number(input.dateFrom.slice(0,4));
  const sourceRows: Adjustment[] = [], movements: Movement[] = [];
  const issues: Array<{ journal_id:number|null; reason:string }> = [];
  const consumed = new Map<string,number>(), usedItems = new Set<string>();
  const taintedSources=new Set<string>();
  const componentInventory=new Map<Journal,{expected:ComponentSlice[];allocated:ComponentSlice[]}>();
  const sourceIndex = new Map<string,Journal[]>();
  for (const j of input.journals) {
    if (!j.registered || j.is_deleted) continue;
    const key = `${j.operation_type}:${j.operations_id}`;
    sourceIndex.set(key,[...(sourceIndex.get(key)??[]),j]);
  }
  const role = (id: number): CashCategory => {
    const a = chart.get(id); if (!a) return "unclassified";
    const override = input.categoryRule?.(id); if (override) return override;
    // A result-only disposal account does not prove where the sold principal
    // was booked. Only a principal bundle or an explicit policy can classify it.
    if ([3820,7100,7110,8330,8335].includes(id)) return "unclassified";
    if (id === cit) return "operating";
    if (id === dividend || a.account_type_est === "Omakapital") return "financing";
    if (a.account_type_est === "Varad" && (id === 1410 || range(id,1100,1199) || range(id,1700,1999) || a.is_fixed_asset)) return "investing";
    if (a.account_type_est === "Varad" && range(id,1400,1499) && ![1420,1430,1440].includes(id)) return "unclassified";
    if (a.account_type_est === "Kohustused" && (range(id,2000,2199) || (range(id,2800,2899) && /laen|võlakir|borrowing|loan/i.test(`${a.name_est} ${a.name_eng}`)))) return "financing";
    if (a.account_type_est === "Tulud" || a.account_type_est === "Kulud" ||
      (a.account_type_est === "Varad" && range(id,1200,1699)) || (a.account_type_est === "Kohustused" && range(id,2200,2799))) return "operating";
    return "unclassified";
  };
  const components = (j:Journal,p:Posting): ComponentSlice => {
    const a=chart.get(p.accounts_id), n=signed(p), id=p.accounts_id;
    const pl = a && (a.account_type_est==="Tulud" || a.account_type_est==="Kulud") && id !== (input.calculatedResultAccount??9000) && !isYearEndClosingJournal(j,year);
    const assetWC = a?.account_type_est==="Varad" && range(id,1200,1699);
    const liabilityWC = a?.account_type_est==="Kohustused" && (range(id,2300,2399)||range(id,2500,2799));
    return { posting_id:p.id??null,posting_index:j.postings.indexOf(p),account_id:id,profit:pl?-n:0,
      depreciation:pl && a?.account_type_est==="Kulud" && range(id,7000,7099)?n:0,
      working_capital:assetWC||liabilityWC?-n:0 };
  };
  const adjust = (j:Journal,slices:ComponentSlice[],kind:Adjustment["kind"],reason:string,source_ids:number[]=[]) => {
    if (!slices.some(s=>s.profit!==0||s.depreciation!==0||s.working_capital!==0)) return;
    const c=combine(slices);
    sourceRows.push({journal_id:j.id??null,posting_ids:slices.flatMap(s=>s.posting_id==null?[]:[s.posting_id]),kind,components:c,adjustment:sum(c)===0?0:-sum(c),source_ids,reason,component_slices:slices});
  };
  const movement = (j:Journal,ps:Posting[],category:CashCategory,amount:number,reason:string,source_ids:number[]=[],gross?:{receipt:number;payment:number},owned?:ComponentSlice[]) => {
    const component_slices=owned??(j.postings??[]).filter(p=>!p.is_deleted).map(p=>components(j,p));
    componentInventory.get(j)?.allocated.push(...component_slices);
    movements.push({journal_id:j.id??null,posting_ids:ps.flatMap(p=>p.id==null?[]:[p.id]),category,amount,source_ids,reason,
      receipt_total:gross?.receipt??Math.max(amount,0),payment_total:gross?.payment??Math.max(-amount,0),components:combine(component_slices),component_slices});
  };
  let baseRaw=0, openingPD=0;
  for (const j of [...input.journals].sort((a,b)=>a.effective_date.localeCompare(b.effective_date)||(a.id??0)-(b.id??0))) {
    if (!j.registered || j.is_deleted || j.effective_date<input.dateFrom || j.effective_date>input.dateTo) continue;
    const ps=(j.postings??[]).filter(p=>!p.is_deleted), cashPs=ps.filter(p=>cash.has(p.accounts_id));
    if(ps.some(p=>!chart.has(p.accounts_id))) issues.push({journal_id:j.id??null,reason:"missing_chart_account"});
    const invalid = ps.find(p=>!postingIsValued(p,j));
    if (invalid) {
      const reason=(invalid.cl_currencies_id??j.cl_currencies_id??"EUR")!=="EUR"&&invalid.base_amount==null?"missing_base_amount":"malformed_posting";
      issues.push({journal_id:j.id??null,reason});
      if (cashPs.length&&j.operation_type!=="INITIAL") {
        const knownCash=cashPs.filter(p=>postingIsValued(p,j)),unvaluedCash=cashPs.filter(p=>!postingIsValued(p,j));
        movement(j,cashPs,"unclassified",knownCash.reduce((s,p)=>s+signed(p),0),reason,[],{
          receipt:knownCash.reduce((s,p)=>s+Math.max(signed(p),0),0),payment:knownCash.reduce((s,p)=>s+Math.max(-signed(p),0),0)},[]);
        if(unvaluedCash.length)Object.assign(movements[movements.length-1]!,{
          unvalued_cash_posting_count:unvaluedCash.length,
          valued_cash_posting_count:knownCash.length,
          unvalued_cash_posting_ids:unvaluedCash.flatMap(p=>p.id==null?[]:[p.id]).slice(0,500),
          unvalued_cash_posting_indexes:unvaluedCash.filter(p=>p.id==null).map(p=>j.postings.indexOf(p)).slice(0,500),
          valued_cash_posting_ids:knownCash.flatMap(p=>p.id==null?[]:[p.id]).slice(0,500),
          valued_cash_posting_indexes:knownCash.filter(p=>p.id==null).map(p=>j.postings.indexOf(p)).slice(0,500),
          cash_valuation_lists_truncated:unvaluedCash.length>500||knownCash.length>500,
        });
      }
      continue;
    }
    const slices=ps.map(p=>components(j,p));
    if (j.operation_type==="INITIAL") {
      const pd=slices.map(s=>({...s,working_capital:0})); openingPD+=sum(combine(pd)); adjust(j,pd,"opening_position","initial_starting_position"); continue;
    }
    baseRaw+=sum(combine(slices));
    if (!cashPs.length) {
      if(Math.abs(ps.reduce((s,p)=>s+signed(p),0))>0.000001) issues.push({journal_id:j.id??null,reason:"unbalanced_noncash_journal"});
      else adjust(j,slices,"non_cash","noncash_journal_bridge");
      continue;
    }
    componentInventory.set(j,{expected:slices,allocated:[]});
    const net=cashPs.reduce((s,p)=>s+signed(p),0), counterpart=ps.filter(p=>!cash.has(p.accounts_id));
    const unknown = (reason:string) => {
      for(const edge of input.evidence?.transactions.get(Number(j.operations_id))?.items??[]) {
        if(edge.relation_table==="purchase_invoices"||edge.relation_table==="sale_invoices")
          taintedSources.add(`${edge.relation_table==="purchase_invoices"?"PURCHASE_INVOICE":"SALE_INVOICE"}:${Number(edge.relation_id)}`);
      }
      movement(j,cashPs,"unclassified",net,reason,[],{receipt:cashPs.reduce((s,p)=>s+Math.max(signed(p),0),0),payment:cashPs.reduce((s,p)=>s+Math.max(-signed(p),0),0)});
      adjust(j,slices,"unresolved",reason);
    };
    if (Math.abs(ps.reduce((s,p)=>s+signed(p),0))>0.000001) { unknown("unbalanced_cash_journal"); continue; }
    if (!counterpart.length) {
      if (Math.abs(net)<0.000001) continue;
      unknown("cash_only_unbalanced_movement"); continue;
    }
    // Exact homogeneous operating purpose does not certify the historical
    // invoice balance. Date/capacity vetoes below remain for I/F and mixed
    // invoice purposes; they are not evidence that a proved operating payment
    // has an unknown economic kind.
    const detailForPurpose=input.evidence?.transactions.get(Number(j.operations_id));
    const purposeItems=(detailForPurpose?.items??[]).filter(item=>!(item as {is_deleted?:boolean}).is_deleted);
    const opposedCash=cashPs.some(p=>signed(p)>0)&&cashPs.some(p=>signed(p)<0);
    if(j.operation_type==="TRANSACTION"&&detailForPurpose&&purposeItems.length&&
      (counterpart.some(p=>settling(p.accounts_id))||opposedCash)) {
      const txId=Number(j.operations_id), detail=detailForPurpose;
      const prepared:Array<{item:typeof purposeItems[number];proof?:InvoiceEvidence;category:CashCategory;amount:number;obligation?:number;purchase?:boolean;base:number}>=[];
      let eligible=true, proofError="";
      for(const item of purposeItems) {
        const currency=item.cl_currencies_id??detail.cl_currencies_id??"EUR";
        const base=item.base_amount??(currency==="EUR"?item.amount:undefined);
        if(!Number.isFinite(base)||base===0||(item.base_amount!=null&&item.amount!=null&&item.amount!==0&&Math.sign(item.amount)!==Math.sign(item.base_amount))) {
          proofError="distribution_base_or_sign_unproved";break;
        }
        if(item.relation_table==="accounts") {
          const category=cash.has(item.accounts_id)?"operating":role(item.accounts_id);
          if(category==="unclassified"||(!opposedCash&&category!=="operating")){eligible=false;break;}
          if(base!<0){proofError="distribution_base_or_sign_unproved";break;}
          prepared.push({item,category,amount:Math.abs(base!),base:base!});
        } else if(item.relation_table==="purchase_invoices"||item.relation_table==="sale_invoices") {
          const op=item.relation_table==="purchase_invoices"?"PURCHASE_INVOICE":"SALE_INVOICE";
          const sources=sourceIndex.get(`${op}:${Number(item.relation_id)}`)??[];
          if(sources.length!==1){proofError="invoice_edge_or_base_unproved";break;}
          const source=sources[0]!, rows=source.postings.filter(p=>!p.is_deleted);
          if(!settling(item.accounts_id)||!rows.some(p=>p.accounts_id===item.accounts_id)||rows.some(p=>
            !chart.has(p.accounts_id)||(p.type!=="D"&&p.type!=="C")||!Number.isFinite(rawAmount(p))||
            (p.base_amount!=null&&p.amount!==0&&Math.sign(p.amount)!==Math.sign(p.base_amount))||
            ((p.cl_currencies_id??source.cl_currencies_id??"EUR")!=="EUR"&&p.base_amount==null))||
            Math.abs(rows.reduce((s,p)=>s+signed(p),0))>0.000001) {proofError="invalid_invoice_posting";break;}
          const economic=rows.filter(p=>p.accounts_id!==item.accounts_id&&!chart.get(p.accounts_id)?.is_vat_account);
          if(!economic.length||economic.some(p=>role(p.accounts_id)!=="operating")){eligible=false;break;}
          const obligation=(op==="PURCHASE_INVOICE"?-1:1)*rows.filter(p=>p.accounts_id===item.accounts_id).reduce((s,p)=>s+signed(p),0);
          if(!obligation||Math.abs(base!)>Math.abs(obligation)+0.000001||rows.some(p=>p.accounts_id===item.accounts_id&&p.accounts_dimensions_id!=null&&p.accounts_dimensions_id!==(item.accounts_dimensions_id??null))){proofError="invoice_settlement_leg_unproved";break;}
          prepared.push({item,category:"operating",amount:Math.abs(base!),base:base!,obligation,purchase:op==="PURCHASE_INVOICE",proof:{transaction_id:txId,transaction_item_id:item.id??null,
            invoice_id:Number(item.relation_id),invoice_journal_id:source.id??null,invoice_posting_ids:rows.flatMap(p=>p.id==null?[]:[p.id])}});
        } else {eligible=false;break;}
      }
      if(eligible) {
        const mains=cashPs.filter(p=>p.accounts_id===detail.accounts_id&&(p.accounts_dimensions_id??null)===(detail.accounts_dimensions_id??null));
        const main=mains[0], base=detail.base_amount??(detail.cl_currencies_id==="EUR"?detail.amount:undefined);
        if(mains.length!==1||detail.id!==txId||detail.status!=="CONFIRMED"||detail.is_deleted||detail.date!==j.effective_date||
          (sourceIndex.get(`TRANSACTION:${txId}`)?.length??0)!==1||!Number.isFinite(base)||!main||
          detail.cl_currencies_id!==(main.cl_currencies_id??j.cl_currencies_id??"EUR")||Math.abs(base!-Math.abs(signed(main)))>0.000001||
          (detail.base_amount!=null&&detail.amount!==0&&Math.sign(detail.amount)!==Math.sign(detail.base_amount)))proofError="transaction_registration_material_mismatch";
        const remaining=new Map(ps.filter(p=>p!==main).map(p=>[p,Math.abs(signed(p))]));
        const planned:Array<{part:typeof prepared[number];owned:ComponentSlice[]}>=[],seen=new Set<string>();
        let total=0;const currentInvoiceUse=new Map<number,number>();
        if(!proofError)for(const part of prepared) {
          if(part.obligation!=null) {
            const expectedCash=(part.purchase?-1:1)*Math.sign(part.obligation);
            const normalDirection=Math.sign(signed(main!))===expectedCash;
            // API credit notes can carry either their signed credit amount or
            // a positive distribution magnitude. The registered source and
            // actual cash direction prove a normal refund; a reversal of an
            // ordinary invoice still requires an explicitly negative item.
            const validItemSign=normalDirection?(part.base>0||part.obligation<0):part.base<0;
            if(!validItemSign){proofError="invoice_item_direction_unproved";break;}
            const key=part.proof!.invoice_journal_id!;
            const use=(currentInvoiceUse.get(key)??0)+part.amount;
            if(use>Math.abs(part.obligation)+0.000001){proofError="invoice_current_distribution_exceeds_source";break;}currentInvoiceUse.set(key,use);
          }
          const key=`${txId}:${part.item.id??purposeItems.indexOf(part.item)}`;
          if(seen.has(key)||usedItems.has(key)){proofError="distribution_consumed_twice";break;}seen.add(key);
          let left=part.amount;const owned:ComponentSlice[]=[];
          for(const [p,available] of remaining) {
            if(p.accounts_id!==part.item.accounts_id||(p.accounts_dimensions_id??null)!==(part.item.accounts_dimensions_id??null)||Math.sign(signed(p))!==-Math.sign(signed(main!)))continue;
            const take=Math.min(left,available);if(take<=0)continue;
            const c=components(j,p), fraction=take/Math.abs(signed(p));
            owned.push({...c,profit:c.profit*fraction,depreciation:c.depreciation*fraction,working_capital:c.working_capital*fraction});
            remaining.set(p,available-take);left-=take;
          }
          if(left>0.000001){proofError="distribution_posting_or_dimension_unproved";break;}
          total+=part.amount;planned.push({part,owned});
        }
        if(!proofError&&(Math.abs(total-Math.abs(signed(main!)))>0.000001||[...remaining.values()].some(n=>n>0.000001)))proofError="distribution_cash_total_mismatch";
        if(proofError){unknown(proofError);continue;}
        const distribution:DistributionEvidence={transaction_id:txId,items:planned.map(({part,owned})=>({transaction_item_id:part.item.id??null,
          account_id:part.item.accounts_id,account_dimension_id:part.item.accounts_dimensions_id??null,amount:part.amount,
          posting_ids:owned.flatMap(s=>s.posting_id==null?[]:[s.posting_id]),internal_cash:cash.has(part.item.accounts_id)}))};
        for(const {part,owned} of planned) {
          usedItems.add(`${txId}:${part.item.id??purposeItems.indexOf(part.item)}`);
          if(cash.has(part.item.accounts_id))continue; // Exact internal leg has no external cash flow or bridge component.
          const amount=Math.sign(signed(main!))*part.amount;
          const sourceIds=part.proof?[txId,part.proof.invoice_id,...(part.proof.invoice_journal_id==null?[]:[part.proof.invoice_journal_id])]:[txId];
          movement(j,cashPs,part.category,amount,"exact_transaction_distribution",sourceIds,undefined,owned);
          movements[movements.length-1]!.distribution_evidence=distribution;
          if(part.proof)movements[movements.length-1]!.invoice_evidence=part.proof;
          if(part.category!=="operating")adjust(j,owned,"non_operating","exact_transaction_distribution",sourceIds);
        }
        continue;
      }
    }
    const fxResult = (p:Posting) => [3840,7310,8500].includes(p.accounts_id) &&
      ["Tulud","Kulud"].includes(chart.get(p.accounts_id)?.account_type_est??"") && /valuut|kurs|exchange/i.test(`${chart.get(p.accounts_id)?.name_est??""} ${chart.get(p.accounts_id)?.name_eng??""}`);
    const nonzero=counterpart.filter(p=>signed(p)!==0);
    const fxAccounts = nonzero.length>0&&nonzero.every(fxResult);
    if (fxAccounts) {
      if (cashPs.every(p=>p.amount===0 && p.base_amount!=null && (p.cl_currencies_id??j.cl_currencies_id??"EUR")!=="EUR")) {
        movement(j,cashPs,"fx",net,"proved_base_only_fx"); adjust(j,slices,"non_operating","proved_base_only_fx");
      } else unknown("unproved_cash_fx_effect");
      continue;
    }
    if(cashPs.some(p=>signed(p)>0)&&cashPs.some(p=>signed(p)<0)) {
      const transferFee=net<0&&counterpart.every(p=>chart.get(p.accounts_id)?.account_type_est==="Kulud"&&role(p.accounts_id)==="operating"&&signed(p)>0);
      if(transferFee) movement(j,cashPs,"operating",net,"internal_transfer_with_operating_fee");
      else unknown(Math.abs(net)<0.000001?"zero_net_external_allocation_unproved":"opposed_cash_legs_unproved");
      continue;
    }
    const supportedResult=(p:Posting)=>fxResult(p)||([8330,8335,3820,7100,7110].includes(p.accounts_id)&&["Tulud","Kulud"].includes(chart.get(p.accounts_id)?.account_type_est??""));
    const results=nonzero.filter(supportedResult);
    const fixed=(id:number)=>range(id,1700,1999)||chart.get(id)?.is_fixed_asset===true;
    const assetFamily=(id:number)=>range(id,1100,1199)?"securities":id===1410?"loan":fixed(id)?`fixed:${Math.floor(id/100)}`:null;
    // Detect candidates before requiring their nature/direction. Otherwise a
    // rejected override, zero principal or contra asset could escape to a split.
    const investmentCandidate=counterpart.some(p=>!supportedResult(p)&&(role(p.accounts_id)==="investing"||
      (chart.get(p.accounts_id)?.account_type_est==="Varad"&&assetFamily(p.accounts_id)!==null)));
    if(results.length&&investmentCandidate) {
      if(results.some(p=>input.categoryRule?.(p.accounts_id)!==undefined)) {unknown("investment_result_override_requires_allocation");continue;}
      const principals=nonzero.filter(p=>!supportedResult(p)&&chart.get(p.accounts_id)?.account_type_est==="Varad"&&chart.get(p.accounts_id)?.balance_type==="D"&&role(p.accounts_id)==="investing"&&assetFamily(p.accounts_id)!==null);
      const families=new Set(principals.map(p=>assetFamily(p.accounts_id))),family=[...families][0];
      const contra=nonzero.filter(p=>!results.includes(p)&&!principals.includes(p));
      const gross=principals.reduce((s,p)=>s+Math.abs(signed(p)),0),reversal=contra.reduce((s,p)=>s+signed(p),0);
      const provedContra=net>0&&family?.startsWith("fixed:")&&contra.every(p=>chart.get(p.accounts_id)?.account_type_est==="Varad"&&
        chart.get(p.accounts_id)?.balance_type==="C"&&assetFamily(p.accounts_id)===family&&signed(p)>0&&
        (/akumuleeritud.*kulum|accumulated.*depreciation/i.test(`${chart.get(p.accounts_id)?.name_est} ${chart.get(p.accounts_id)?.name_eng}`)))&&reversal<=gross+0.000001;
      const nonFx=results.filter(p=>!fxResult(p));
      const resultFamily=nonFx.length===0||
        (family==="securities"&&(net>0?nonFx.every(p=>[8330,8335].includes(p.accounts_id)):
          nonFx.every(p=>p.accounts_id===8335&&chart.get(p.accounts_id)?.account_type_est==="Kulud"&&signed(p)>0)))||
        (family?.startsWith("fixed:")&&net>0&&nonFx.every(p=>[3820,7100,7110].includes(p.accounts_id)));
      if(principals.length&&families.size===1&&net!==0&&principals.every(p=>Math.sign(signed(p))===-Math.sign(net))&&
        (contra.length===0||provedContra)&&resultFamily) {
        movement(j,cashPs,"investing",net,"investment_principal_and_result");adjust(j,slices,"non_operating","investment_principal_and_result");
      } else unknown("investment_principal_result_unproved");
      continue;
    }
    if(nonzero.some(fxResult)&&nonzero.some(p=>!supportedResult(p)&&role(p.accounts_id)==="financing")) {
      unknown("financing_principal_fx_unproved");continue;
    }
    if (counterpart.some(p=>settling(p.accounts_id))) {
      const txId=Number(j.operations_id), detail=input.evidence?.transactions.get(txId);
      const items=(detail?.items??[]).filter(item=>!(item as {is_deleted?:boolean}).is_deleted);
      if (j.operation_type!=="TRANSACTION" || !detail || !items.length || cashPs.length!==1 || counterpart.some(p=>!settling(p.accounts_id))) {
        unknown(input.evidence?.failures.get(txId)??"settlement_source_unproved"); continue;
      }
      const cashPosting=cashPs[0]!;
      if((sourceIndex.get(`TRANSACTION:${txId}`)?.length??0)!==1) {unknown("ambiguous_transaction_registration");continue;}
      if(detail.id!==txId || detail.status!=="CONFIRMED" || detail.is_deleted || detail.date!==j.effective_date ||
        detail.accounts_id!==cashPosting.accounts_id || detail.accounts_dimensions_id!==(cashPosting.accounts_dimensions_id??null) ||
        detail.cl_currencies_id!==(cashPosting.cl_currencies_id??j.cl_currencies_id??"EUR") ||
        !Number.isFinite(detail.base_amount??(detail.cl_currencies_id==="EUR"?detail.amount:undefined)) ||
        (detail.base_amount!=null&&detail.amount!==0&&Math.sign(detail.amount)!==Math.sign(detail.base_amount)) ||
        Math.abs((detail.base_amount??detail.amount)-Math.abs(net))>0.000001) {
        unknown("transaction_registration_material_mismatch");continue;
      }
      const allocations:Array<{category:CashCategory;amount:number;sourceIds:number[];accountId:number;accountDimensionId:number|null;itemKey:string;capacityKey:string;next:number;proof:InvoiceEvidence}>=[];
      let reason="", total=0;
      const plannedConsumption=new Map(consumed);
      const plannedItems=new Set<string>();
      for (let itemIndex=0;itemIndex<items.length;itemIndex++) {
        const item=items[itemIndex]!, table=item.relation_table, sourceId=Number(item.relation_id);
        const itemKey=`${txId}:${item.id??itemIndex}`;
        if (usedItems.has(itemKey)||plannedItems.has(itemKey)) {reason="distribution_consumed_twice";break;}
        plannedItems.add(itemKey);
        const operation=table==="purchase_invoices"?"PURCHASE_INVOICE":table==="sale_invoices"?"SALE_INVOICE":null;
        const sources=sourceIndex.get(`${operation}:${sourceId}`)??[];
        const base=item.base_amount??((item.cl_currencies_id??detail.cl_currencies_id??"EUR")==="EUR"?item.amount:undefined);
        if (!operation||sources.length!==1||!Number.isFinite(base)||base===0||
          (item.base_amount!=null&&item.amount!=null&&item.amount!==0&&Math.sign(item.amount)!==Math.sign(item.base_amount))) {reason="invoice_edge_or_base_unproved";break;}
        const source=sources[0]!;
        if (source.effective_date>j.effective_date) {reason="invoice_after_payment";break;}
        const rows=source.postings.filter(p=>!p.is_deleted);
        if(rows.some(p=>(p.type!=="D"&&p.type!=="C")||!Number.isFinite(rawAmount(p))||
          (p.base_amount!=null&&p.amount!==0&&Math.sign(p.amount)!==Math.sign(p.base_amount))||
          ((p.cl_currencies_id??source.cl_currencies_id??"EUR")!=="EUR"&&p.base_amount==null)) ||
          Math.abs(rows.reduce((s,p)=>s+signed(p),0))>0.000001) {reason="invalid_invoice_posting";break;}
        const sameSlice=(p:Posting)=>p.accounts_id===item.accounts_id&&(p.accounts_dimensions_id??null)===(item.accounts_dimensions_id??null);
        const sourceSettlement=rows.filter(p=>settling(p.accounts_id)&&signed(p)!==0);
        const sourceKeys=new Set(sourceSettlement.map(p=>`${p.accounts_id}:${p.accounts_dimensions_id??null}`));
        if(sourceKeys.size!==1||sourceSettlement.some(p=>!sameSlice(p))){reason="invoice_settlement_dimension_unproved";break;}
        const settlementRows=rows.filter(sameSlice);
        const obligation=(operation==="PURCHASE_INVOICE"?-1:1)*settlementRows.reduce((s,p)=>s+signed(p),0);
        if(!obligation||!settling(item.accounts_id)||!counterpart.some(p=>sameSlice(p)&&Math.sign(signed(p))===-Math.sign(net))) {reason="invoice_settlement_leg_unproved";break;}
        const expectedSign=(operation==="PURCHASE_INVOICE"?-1:1)*Math.sign(obligation);
        const magnitude=Math.abs(base!);
        const capacityKey=`${operation}:${sourceId}`;
        if(taintedSources.has(capacityKey)){reason="earlier_invoice_allocation_unproved";break;}
        // An unlinked noncash clearing cannot prove which invoice it consumed.
        // Hold the affected slice rather than inventing remaining capacity.
        const earlierUnlinkedSettlement=input.journals.some(prior=>prior!==source&&prior.registered&&!prior.is_deleted&&
          prior.operation_type!=="INITIAL"&&prior.operation_type!=="PURCHASE_INVOICE"&&prior.operation_type!=="SALE_INVOICE"&&
          (prior.effective_date>source.effective_date||(prior.effective_date===source.effective_date&&(prior.id??0)>(source.id??0)))&&
          (prior.effective_date<j.effective_date||(prior.effective_date===j.effective_date&&(prior.id??0)<(j.id??0)))&&
          !prior.postings.some(p=>!p.is_deleted&&cash.has(p.accounts_id))&&
          prior.postings.some(p=>!p.is_deleted&&sameSlice(p)&&Math.sign(signed(p))===Math.sign(settlementRows.reduce((s,p)=>s+signed(p),0))*-1));
        if(earlierUnlinkedSettlement){reason="unlinked_settlement_capacity_unproved";break;}
        if(source.effective_date<input.dateFrom) {
          const priorSettlements=input.journals.filter(prior=>prior.registered&&!prior.is_deleted&&prior.operation_type==="TRANSACTION"&&
            prior.effective_date>=source.effective_date&&prior.effective_date<input.dateFrom&&
            (prior.postings.some(p=>!p.is_deleted&&sameSlice(p))||input.evidence?.transactions.get(Number(prior.operations_id))?.items?.some(edge=>edge.relation_table===table&&Number(edge.relation_id)===sourceId))&&
            prior.postings.some(p=>!p.is_deleted&&cash.has(p.accounts_id)));
          if(priorSettlements.some(prior=>!input.evidence?.transactions.has(Number(prior.operations_id)))) {reason="prior_invoice_capacity_unproved";break;}
          if(!plannedConsumption.has(capacityKey)) {
            let priorConsumed=0;
            for(const prior of priorSettlements) {
              const tx=input.evidence!.transactions.get(Number(prior.operations_id))!;
              const priorNet=prior.postings.filter(p=>!p.is_deleted&&cash.has(p.accounts_id)).reduce((s,p)=>s+signed(p),0);
              const priorEdges=tx.items??[],edgeIds=priorEdges.map((edge,index)=>edge.id??`index:${index}`);
              const sameInvoice=priorEdges.some(edge=>edge.relation_table===table&&Number(edge.relation_id)===sourceId);
              if(sameInvoice) {
                const sliceBudget=prior.postings.filter(p=>!p.is_deleted&&sameSlice(p)&&Math.sign(signed(p))===-Math.sign(priorNet)).reduce((s,p)=>s+Math.abs(signed(p)),0);
                let sliceUsed=0,totalUsed=0;
                for(const edge of priorEdges) {
                  const amount=edge.base_amount??((edge.cl_currencies_id??tx.cl_currencies_id??"EUR")==="EUR"?edge.amount:undefined);
                  if(!Number.isFinite(amount)){reason="prior_invoice_capacity_unproved";break;}
                  totalUsed+=Math.abs(amount!);
                  if(edge.accounts_id===item.accounts_id&&(edge.accounts_dimensions_id??null)===(item.accounts_dimensions_id??null))sliceUsed+=Math.abs(amount!);
                }
                // Opposed settlement rows do not prove gross restoration. An
                // invoice edge cannot consume more than its registered slice
                // or share a transaction budget greater than actual cash.
                if(new Set(edgeIds).size!==edgeIds.length||sliceUsed>sliceBudget+0.000001||totalUsed>Math.abs(priorNet)+0.000001||
                  prior.postings.some(p=>!p.is_deleted&&sameSlice(p)&&signed(p)!==0&&Math.sign(signed(p))===Math.sign(priorNet))||
                  (sourceIndex.get(`TRANSACTION:${prior.operations_id}`)?.length??0)!==1||
                  Math.abs(prior.postings.filter(p=>!p.is_deleted).reduce((s,p)=>s+signed(p),0))>0.000001) reason="prior_invoice_capacity_unproved";
                if(reason)break;
              }
              for(const edge of tx.items??[]) if(edge.relation_table===table&&Number(edge.relation_id)===sourceId) {
                const priorAmount=edge.base_amount??((edge.cl_currencies_id??tx.cl_currencies_id??"EUR")==="EUR"?edge.amount:undefined);
                const priorRows=prior.postings.filter(p=>!p.is_deleted),priorCash=priorRows.filter(p=>cash.has(p.accounts_id));
                const matched=priorRows.filter(p=>sameSlice(p)&&Math.sign(signed(p))===-Math.sign(priorNet));
                const normal=Math.sign(priorNet)===expectedSign;
                if(!Number.isFinite(priorAmount)||priorAmount===0||edge.accounts_id!==item.accounts_id||
                  (edge.accounts_dimensions_id??null)!==(item.accounts_dimensions_id??null)||priorRows.some(p=>!postingIsValued(p,prior))||
                  priorCash.length!==1||priorNet===0||tx.id!==Number(prior.operations_id)||tx.status!=="CONFIRMED"||tx.is_deleted||tx.date!==prior.effective_date||
                  tx.accounts_id!==priorCash[0]!.accounts_id||(tx.accounts_dimensions_id??null)!==(priorCash[0]!.accounts_dimensions_id??null)||
                  tx.cl_currencies_id!==(priorCash[0]!.cl_currencies_id??prior.cl_currencies_id??"EUR")||
                  !Number.isFinite(tx.base_amount??(tx.cl_currencies_id==="EUR"?tx.amount:undefined))||Math.abs((tx.base_amount??tx.amount)-Math.abs(priorNet))>0.000001||
                  (tx.base_amount!=null&&tx.amount!==0&&Math.sign(tx.amount)!==Math.sign(tx.base_amount))||
                  (edge.base_amount!=null&&edge.amount!=null&&edge.amount!==0&&Math.sign(edge.amount)!==Math.sign(edge.base_amount))||
                  !(normal?(priorAmount!>0||obligation<0):priorAmount!<0)||
                  matched.reduce((s,p)=>s+Math.abs(signed(p)),0)+0.000001<Math.abs(priorAmount!)) {reason="prior_invoice_capacity_unproved";break;}
                priorConsumed+=(Math.sign(priorNet)===expectedSign?1:-1)*Math.abs(priorAmount!);
              }
            }
            if(reason)break;
            if(priorConsumed< -0.000001||priorConsumed>Math.abs(obligation)+0.000001){reason="prior_invoice_capacity_unproved";break;}
            plannedConsumption.set(capacityKey,priorConsumed);
          }
        }
        const prior=plannedConsumption.get(capacityKey)??0;
        const next=prior+(Math.sign(net)===expectedSign?magnitude:-magnitude);
        if(next < -0.000001||next>Math.abs(obligation)+0.000001) {reason="invoice_capacity_or_reversal_unproved";break;}
        const normalDirection=Math.sign(net)===expectedSign;
        if(!(normalDirection?(base!>0||obligation<0):base!<0)) {reason="invoice_item_direction_unproved";break;}
        const economic=rows.filter(p=>p.accounts_id!==item.accounts_id && !chart.get(p.accounts_id)?.is_vat_account);
        const categories=new Set(economic.map(p=>role(p.accounts_id)));
        const fullMixed=categories.size>1&&!categories.has("unclassified")&&Math.abs(magnitude-Math.abs(obligation))<0.000001&&
          !rows.some(p=>chart.get(p.accounts_id)?.is_vat_account&&rawAmount(p)!==0)&&
          economic.every(p=>Math.sign(signed(p))===Math.sign(obligation)*(operation==="PURCHASE_INVOICE"?1:-1))&&
          Math.abs(economic.reduce((s,p)=>s+Math.abs(rawAmount(p)),0)-magnitude)<0.000001;
        if((categories.size!==1&&!fullMixed)||categories.has("unclassified")) {reason="mixed_invoice_source_unproved";break;}
        const sourceIds=[txId,sourceId,...(source.id==null?[]:[source.id])];
        const proof:InvoiceEvidence={transaction_id:txId,transaction_item_id:item.id??null,invoice_id:sourceId,invoice_journal_id:source.id??null,invoice_posting_ids:rows.flatMap(p=>p.id==null?[]:[p.id])};
        const parts=fullMixed?economic.map(p=>({category:role(p.accounts_id),amount:Math.sign(net)*Math.abs(rawAmount(p))})):
          [{category:[...categories][0]!,amount:Math.sign(net)*magnitude}];
        for(const part of parts)allocations.push({...part,sourceIds,accountId:item.accounts_id,accountDimensionId:item.accounts_dimensions_id??null,itemKey,capacityKey,next,proof});
        plannedConsumption.set(capacityKey,next); total+=magnitude;
      }
      if (reason||Math.abs(total-Math.abs(net))>0.000001) {unknown(reason||"distribution_cash_total_mismatch");continue;}
      const remaining=new Map(counterpart.map(p=>[p,Math.abs(rawAmount(p))]));
      const groups:Array<{allocation:typeof allocations[number];slices:ComponentSlice[]}>=[];
      for(const allocation of allocations) {
        let left=Math.abs(allocation.amount); const owned:ComponentSlice[]=[];
        for(const p of counterpart.filter(p=>p.accounts_id===allocation.accountId&&(p.accounts_dimensions_id??null)===allocation.accountDimensionId&&Math.sign(signed(p))===-Math.sign(net))) {
          const available=remaining.get(p)!; const take=Math.min(available,left); if(take<=0)continue;
          const c=components(j,p); // Settlement postings have W only; exact distribution slices consume that W once.
          owned.push({...c,working_capital:Math.sign(c.working_capital)*take}); remaining.set(p,available-take);left-=take;
        }
        if(left>0.000001){reason="bridge_slice_capacity_exceeded";break;} groups.push({allocation,slices:owned});
      }
      if(reason||[...remaining.values()].some(v=>v>0.000001)) {unknown(reason||"bridge_components_unallocated");continue;}
      for(const {allocation,slices:owned} of groups) {
        movement(j,cashPs,allocation.category,allocation.amount,"exact_invoice_distribution",allocation.sourceIds,undefined,owned);
        movements[movements.length-1]!.invoice_evidence=allocation.proof;
        if(allocation.category!=="operating")adjust(j,owned,"non_operating","exact_invoice_distribution",allocation.sourceIds);
        consumed.set(allocation.capacityKey,allocation.next);usedItems.add(allocation.itemKey);
      }
      continue;
    }
    const categories=new Set(nonzero.map(p=>role(p.accounts_id)));
    if(categories.size===1&&!categories.has("unclassified")) {
      const category=[...categories][0]!;
      if(Math.abs(net)<0.000001 && counterpart.length>1){unknown("zero_net_external_allocation_unproved");continue;}
      movement(j,cashPs,category,net,"homogeneous_counterpart");
      if(category!=="operating")adjust(j,slices,"non_operating","homogeneous_counterpart");
      continue;
    }
    // A split is proved only for one cash leg and same-direction exact noncash slices.
    if(cashPs.length===1&&nonzero.every(p=>role(p.accounts_id)!=="unclassified"&&Math.sign(signed(p))===-Math.sign(net))) {
      for(const p of nonzero) {
        const category=role(p.accounts_id), c=components(j,p);
        movement(j,cashPs,category,-signed(p),"exact_counterpart_slice",[],undefined,[c]);
        if(category!=="operating")adjust(j,[c],"non_operating","exact_counterpart_slice");
      }
    } else unknown("mixed_cash_categories_unproved");
  }
  const bucket=(category:CashCategory)=>{
    const rows=movements.filter(m=>m.category===category);
    const receipts=rows.reduce((s,m)=>s+m.receipt_total,0),payments=rows.reduce((s,m)=>s+m.payment_total,0);
    return {cash_receipts:roundMoney(receipts),cash_payments:roundMoney(payments),net:roundMoney(receipts-payments)};
  };
  for(const [j,inventory] of componentInventory) {
    for(const original of inventory.expected) for(const key of ["profit","depreciation","working_capital"] as const) {
      const allocated=inventory.allocated.filter(s=>s.posting_index===original.posting_index).reduce((total,s)=>total+s[key],0);
      if(Math.abs(original[key]-allocated)>0.00000001) {
        issues.push({journal_id:j.id??null,reason:"bridge_component_conservation_failed"});
        break;
      }
    }
  }
  const total=(kind:Adjustment["kind"])=>sourceRows.filter(r=>r.kind===kind).reduce((s,r)=>s+r.adjustment,0);
  const base=input.baseOperating??baseRaw+openingPD;
  const adjusted=base+sourceRows.reduce((s,r)=>s+r.adjustment,0),directRaw=movements.filter(m=>m.category==="operating").reduce((s,m)=>s+m.amount,0);
  const difference=roundMoney(adjusted-directRaw),coverageDifference=roundMoney(base-baseRaw-openingPD);
  const unknown=movements.filter(m=>m.category==="unclassified"),u=bucket("unclassified");
  return {
    calculation_version:"indirect-evidence-v2" as const,
    status:unknown.length||issues.length||Math.abs(difference)>=0.01||Math.abs(coverageDifference)>=0.01?"requires_review" as const:"complete" as const,
    operating_bridge:{base_total:roundMoney(base),non_cash_adjustments:roundMoney(total("non_cash")),non_operating_adjustments:roundMoney(total("non_operating")),unresolved_exclusions:roundMoney(total("unresolved")),opening_position_adjustments:roundMoney(total("opening_position")),adjusted_total:roundMoney(adjusted),direct_operating_cash:roundMoney(directRaw),difference,coverage_difference:coverageDifference,source_rows:sourceRows},
    investing:bucket("investing"),financing:bucket("financing"),exchange_rate_effect_on_cash:bucket("fx").net,
    unresolved_cash:{count:unknown.length,receipt_total:u.cash_receipts,payment_total:u.cash_payments,net:u.net,items:unknown},
    cash_movements:movements,evidence_coverage:{detail_requests:input.evidence?.requested??0,request_limit:input.evidence?.limit??500,unvalued_or_malformed_postings:issues,
      unvalued_cash_posting_count:movements.reduce((s,m)=>s+(m.unvalued_cash_posting_count??0),0)},
  };
}
