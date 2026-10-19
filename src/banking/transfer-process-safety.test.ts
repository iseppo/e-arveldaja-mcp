import { beforeEach, expect, it, vi } from "vitest";
import { registerBankReconciliationTools } from "../tools/bank-reconciliation.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { withSignedCamtMarker } from "../__fixtures__/camt-marker.js";
import { parseMcpResponse } from "../mcp-json.js";
import { cache } from "../api/base-resource.js";
vi.mock("../audit-log.js",()=>({logAudit:vi.fn()}));
vi.mock("../progress.js",()=>({reportProgress:vi.fn().mockResolvedValue(undefined)}));
beforeEach(()=>cache.invalidate());

function nativeGetSetup(itemPatch:Record<string,unknown>={},journalMode="valid") {
  const original:any={...withSignedCamtMarker({id:14318149,status:"PROJECT",is_deleted:false,type:"C",date:"2026-10-18",accounts_id:1020,
    accounts_dimensions_id:12637392,bank_accounts_id:134912,amount:.03,base_amount:.03,currency_rate:1,cl_currencies_id:"EUR",clients_id:2025557,
    bank_account_name:"Test OÜ",bank_account_no:"BE08905767222113",items:[]},"DBIT"),bank_account_no:null};
  let source=original;
  const mirror:any={...withSignedCamtMarker({...original,id:14318150,accounts_dimensions_id:12762251,bank_accounts_id:138535,bank_account_no:"EE123456789012345678"},"CRDT"),bank_account_no:null};
  const item={id:14310640,accounts_id:1020,accounts_dimensions_id:12762251,relation_table:"accounts",relation_id:102012762251,
    amount:.03,base_amount:.03,is_deleted:false,clients_id:2025557,client_name:null,item_type:"accounts",item_subtype:null,
    item_number:null,item_date:null,item_sum:.03,item_currency:"EUR",journals_title:"Arvelduskontod",...itemPatch};
  const journal:any={id:29608400,operation_type:"TRANSACTION",operations_id:14318149,registered:true,is_deleted:false,cl_currencies_id:"EUR",currency_rate:1,clients_id:2025557,postings:[
    {accounts_id:1020,accounts_dimensions_id:12637392,type:"C",amount:.03,base_amount:.03,cl_currencies_id:"EUR"},
    {accounts_id:1020,accounts_dimensions_id:12762251,type:"D",amount:.03,base_amount:.03,cl_currencies_id:"EUR"},
  ]};
  const api:any={transactions:{invalidateListCache:vi.fn(),listAll:vi.fn(async()=>[source,mirror]),get:vi.fn(async(id:number)=>id===14318149?source:mirror),
    confirm:vi.fn(async()=>{source={...original,status:"CONFIRMED",items:[item]};return{};}),delete:vi.fn(async()=>({}))},
    journals:{invalidateListCache:vi.fn(),listAllWithPostings:vi.fn(async()=>source.status!=="CONFIRMED"||journalMode==="missing"?[]:journalMode==="ambiguous"?[journal,{...journal,id:29608401}]:[journal])},
    clients:{findByName:vi.fn(async()=>[{id:2025557,name:"Test OÜ"}])},readonly:{
      getBankAccounts:vi.fn(async()=>[{accounts_dimensions_id:12637392,iban_code:"EE123456789012345678"},{accounts_dimensions_id:12762251,iban_code:"BE08905767222113"}]),
      getAccountDimensions:vi.fn(async()=>[{id:12637392,accounts_id:1020},{id:12762251,accounts_id:1020}]),getInvoiceInfo:vi.fn(async()=>({invoice_company_name:"Test OÜ"}))}};
  const server={registerTool:vi.fn()} as any;registerBankReconciliationTools(server,api,createTestRuntimeSafetyContext());
  const handler=server.registerTool.mock.calls.find((args:any)=>args[0]==="reconcile_bank_transactions")![2];
  const run=async(args:any)=>parseMcpResponse((await handler(args)).content[0].text) as any;
  return {api,execute:async()=>{const dry=await run({mode:"inter_account_dry_run"});return run({mode:"execute_inter_account",plan_handle:dry.result.plan_handle});}};
}

it("native GET composite relation completes reviewed M5 only after exact actual journal proof",async()=>{
  const f=nativeGetSetup();const result=await f.execute();
  expect(f.api.transactions.confirm).toHaveBeenCalledExactlyOnceWith(14318149,[{related_table:"accounts",related_id:1020,related_sub_id:12762251,amount:.03}],expect.objectContaining({expectedTransaction:expect.objectContaining({id:14318149})}));
  expect(f.api.transactions.delete).toHaveBeenCalledExactlyOnceWith(14318150);
  expect(result.result.execution.execution_report.status).toBe("completed");
  expect(result.result.pairs[0]).toMatchObject({registration_journal_id:29608400,linkage_evidence:"get_distribution",incoming_action:"deleted"});
  expect(f.api.journals.listAllWithPostings.mock.invocationCallOrder.at(-1)).toBeLessThan(f.api.transactions.delete.mock.invocationCallOrder[0]);
});
it.each([
  {relation_id:102012762252},{relation_id:1210},{accounts_id:undefined},{accounts_dimensions_id:undefined},
  {accounts_dimensions_id:12762252},{accounts_id:1021},{accounts_id:10201,accounts_dimensions_id:2762251},
  {accounts_dimensions_id:Number.MAX_SAFE_INTEGER,relation_id:Number(`1020${Number.MAX_SAFE_INTEGER}`)},
  {amount:-.03},{base_amount:-.03},{relation_table:"sale_invoices"},
])("native GET composite keeps real conflicts on HOLD: %j",async patch=>{
  const f=nativeGetSetup(patch);const result=await f.execute();
  expect(f.api.transactions.confirm).toHaveBeenCalledTimes(1);expect(f.api.transactions.delete).not.toHaveBeenCalled();
  expect(result.result.execution.execution_report.status).toBe("partial_execution");
});
it.each(["missing","ambiguous"])("native GET composite cannot authorize cleanup with %s actual journal",async mode=>{
  const f=nativeGetSetup({},mode);const result=await f.execute();
  expect(f.api.transactions.confirm).toHaveBeenCalledTimes(1);expect(f.api.transactions.delete).not.toHaveBeenCalled();
  expect(result.result.execution.execution_report.status).toBe("partial_execution");
});
it.each(["missing","conflicting"])("native GET composite cannot bypass %s live target mapping",async mode=>{
  const f=nativeGetSetup();const confirm=f.api.transactions.confirm.getMockImplementation();
  f.api.transactions.confirm.mockImplementation(async()=>{
    await confirm();f.api.readonly.getAccountDimensions.mockResolvedValue(mode==="missing"?[{id:12637392,accounts_id:1020}]:[{id:12637392,accounts_id:1020},{id:12762251,accounts_id:1020},{id:12762251,accounts_id:1021}]);return{};
  });
  const result=await f.execute();expect(f.api.transactions.delete).not.toHaveBeenCalled();expect(result.result.execution.execution_report.status).toBe("partial_execution");
});

function setup(kind: "signed" | "native" | "fx" | "one_in" | "one_out" = "signed", missingClient = false) {
  const fx = kind === "fx";
  const incoming = kind === "one_in";
  let source: any = {id:1,status:"PROJECT",is_deleted:false,type:"C",date:"2026-10-01",accounts_id:1020,
    accounts_dimensions_id:100,amount:fx?108:100,base_amount:100,cl_currencies_id:fx?"USD":"EUR",
    ...(fx?{currency_rate:1.08}:{}),clients_id:missingClient?null:99,bank_account_name:"Test OÜ",bank_account_no:"BE08905767222113"};
  let mirror: any = {...source,id:2,accounts_dimensions_id:200,bank_account_no:"EE123456789012345678"};
  if(kind !== "native") {
    source=withSignedCamtMarker(source,incoming?"CRDT":"DBIT");
  }
  mirror=withSignedCamtMarker(mirror,"CRDT");
  let bankAccounts = [{accounts_dimensions_id:100,iban_code:"EE123456789012345678"},{accounts_dimensions_id:200,iban_code:"BE08905767222113"}];
  const dimensions=[{id:100,accounts_id:1020},{id:200,accounts_id:1020}];
  const journal: any={id:811,operation_type:"TRANSACTION",operations_id:1,registered:true,is_deleted:false,postings:[
    {accounts_id:1020,accounts_dimensions_id:100,type:incoming?"D":"C",amount:100},
    {accounts_id:1020,accounts_dimensions_id:200,type:incoming?"C":"D",amount:100},
  ]};
  const afterConfirm=vi.fn(); const afterUpdate=vi.fn();
  const api: any={transactions:{invalidateListCache:vi.fn(),listAll:vi.fn(async()=>kind.startsWith("one_")?[source]:[source,mirror]),
    get:vi.fn(async(id:number)=>id===1?source:mirror),update:vi.fn(async(_id:number,body:any)=>{source={...source,...body};afterUpdate();return{};}),
    confirm:vi.fn(async()=>{source={...source,status:"CONFIRMED",items:[{accounts_id:1020,accounts_dimensions_id:200,
      amount:fx?108:100,base_amount:100,cl_currencies_id:fx?"USD":"EUR",...(fx?{currency_rate:1.08}:{})}]};afterConfirm();return{};}),delete:vi.fn(async()=>({}))},
    journals:{invalidateListCache:vi.fn(),listAllWithPostings:vi.fn(async()=>source.status==="CONFIRMED"?[journal]:[])},
    clients:{findByName:vi.fn(async()=>[{id:99,name:"Test OÜ"}])},readonly:{getBankAccounts:vi.fn(async()=>bankAccounts),getAccountDimensions:vi.fn(async()=>dimensions),getInvoiceInfo:vi.fn(async()=>({invoice_company_name:"Test OÜ"}))}};
  const server={registerTool:vi.fn()} as any;
  registerBankReconciliationTools(server,api,createTestRuntimeSafetyContext());
  const handler=server.registerTool.mock.calls.find((args:any)=>args[0]==="reconcile_bank_transactions")![2];
  const run=async(args:any)=>parseMcpResponse((await handler(args)).content[0].text) as any;
  return{api,journal,afterConfirm,afterUpdate,changeSource:(patch:any)=>{source={...source,...patch};},changeMirror:(patch:any)=>{mirror={...mirror,...patch};},changeMapping:()=>{bankAccounts=bankAccounts.map(row=>({...row,iban_code:"CHANGED"}));},
    execute:async()=>{const dry=await run({mode:"inter_account_dry_run"});return run({mode:"execute_inter_account",plan_handle:dry.result.plan_handle});}};
}

it.each(["signed","native","fx","one_in","one_out"] as const)("preserves unchanged %s transfer with actual registration evidence",async kind=>{
  const f=setup(kind); const result=await f.execute();
  expect(f.api.transactions.confirm,JSON.stringify(result)).toHaveBeenCalledTimes(1);
  expect(result.result.execution.execution_report.status).toBe("completed");
  if(kind.startsWith("one_"))expect(f.api.transactions.delete).not.toHaveBeenCalled();
  else expect(f.api.transactions.delete).toHaveBeenCalledExactlyOnceWith(2);
});
it.each([{amount:999},{date:"2026-10-02"},{accounts_dimensions_id:300},{bank_account_name:"External supplier"},{bank_account_no:"DE89370400440532013000"},{ref_number:"CHANGED"},{status:"CONFIRMED"},{is_deleted:true}])("retains a mirror changed while register awaits: %j",async patch=>{
  const f=setup();f.afterConfirm.mockImplementation(()=>f.changeMirror(patch));
  const result=await f.execute();
  expect(f.api.transactions.confirm).toHaveBeenCalledTimes(1);expect(f.api.transactions.delete).not.toHaveBeenCalled();
  expect(result.result.execution.execution_report).toMatchObject({status:"partial_execution",automatic_retry_forbidden:true});
  expect(result.result.execution.execution_report.known_object_ids).toContainEqual(expect.objectContaining({entity_type:"transaction",entity_id:1,outcome:"confirmed"}));
});
it.each([{amount:999},{status:"PROJECT"},{is_deleted:true},{ref_number:"CHANGED"},{items:[{accounts_id:999,accounts_dimensions_id:200,amount:100,cl_currencies_id:"EUR"}]}])("retains mirror after confirmed source changes: %j",async patch=>{
  const f=setup();f.afterConfirm.mockImplementation(()=>f.changeSource(patch));const result=await f.execute();
  expect(f.api.transactions.delete).not.toHaveBeenCalled();expect(result.result.execution.execution_report.status).toBe("partial_execution");
});
it.each(["missing","wrong_direction","wrong_account","wrong_amount","ambiguous","wrong_link","negative_nominal_positive_base","foreign_base_missing"])("requires actual unique registration proof: %s",async scenario=>{
  const f=setup();f.afterConfirm.mockImplementation(()=>{
    if(scenario==="missing")f.api.journals.listAllWithPostings.mockResolvedValue([]);
    if(scenario==="ambiguous")f.api.journals.listAllWithPostings.mockResolvedValue([f.journal,{...f.journal,id:812}]);
    if(scenario==="wrong_link")f.journal.operations_id=2;
    if(scenario==="wrong_direction")f.journal.postings[0].type="D";
    if(scenario==="wrong_account")f.journal.postings[1].accounts_dimensions_id=300;
    if(scenario==="wrong_amount")f.journal.postings[1].amount=99;
    if(scenario==="negative_nominal_positive_base")f.journal.postings[0]={...f.journal.postings[0],amount:-100,base_amount:100};
    if(scenario==="foreign_base_missing")f.journal.cl_currencies_id="USD";
  });
  const result=await f.execute();expect(f.api.transactions.delete).not.toHaveBeenCalled();expect(result.result.execution.execution_report.status).toBe("partial_execution");
});
it("retains mirror when own bank mapping changes after confirm",async()=>{const f=setup();f.afterConfirm.mockImplementation(f.changeMapping);await f.execute();expect(f.api.transactions.delete).not.toHaveBeenCalled();});
it("allows absent GET linkage only with the full exact actual registration journal",async()=>{
  const f=setup();f.afterConfirm.mockImplementation(()=>f.changeSource({items:[]}));
  const result=await f.execute();expect(f.api.transactions.delete).toHaveBeenCalledExactlyOnceWith(2);expect(result.result.execution.execution_report.status).toBe("completed");
});
it("fetches an actual registration journal when its listing omits postings",async()=>{
  const f=setup();f.afterConfirm.mockImplementation(()=>{
    f.api.journals.listAllWithPostings.mockResolvedValue([{...f.journal,postings:undefined}]);
    f.api.journals.get=vi.fn(async()=>f.journal);
  });
  await f.execute();expect(f.api.journals.get).toHaveBeenCalledExactlyOnceWith(811);expect(f.api.transactions.delete).toHaveBeenCalledExactlyOnceWith(2);
});
it("rechecks the mirror after the awaited actual-journal load",async()=>{
  const f=setup();const read=f.api.journals.listAllWithPostings.getMockImplementation();
  f.api.journals.listAllWithPostings.mockImplementation(async()=>{
    const journals=await read();if(journals.length)f.changeMirror({amount:999});return journals;
  });
  const result=await f.execute();expect(f.api.transactions.confirm).toHaveBeenCalledTimes(1);expect(f.api.transactions.delete).not.toHaveBeenCalled();expect(result.result.execution.execution_report.status).toBe("partial_execution");
});
it("stops after exact own client fill when unrelated source material changes",async()=>{
  const f=setup("signed",true);f.afterUpdate.mockImplementation(()=>f.changeSource({ref_number:"EXTERNAL"}));const result=await f.execute();
  expect(f.api.transactions.update).toHaveBeenCalledExactlyOnceWith(1,{clients_id:99});
  expect(f.api.transactions.confirm).not.toHaveBeenCalled();expect(f.api.transactions.delete).not.toHaveBeenCalled();
  expect(result.result.execution.execution_report).toMatchObject({status:"partial_execution",known_object_ids:[expect.objectContaining({entity_id:1,outcome:"updated"})]});
});
