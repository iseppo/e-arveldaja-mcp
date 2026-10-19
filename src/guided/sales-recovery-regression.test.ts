import { describe, expect, it, vi } from 'vitest';
import { registerManageSaleInvoiceTool } from './manage-sale-invoice.ts';
import { SaleInvoicesApi } from '../api/sale-invoices.api.ts';
import { HttpError } from '../http-client.ts';
import { MutationIndeterminateError } from '../mutation-outcome.js';
import { captureSaleCreateScope, saleCreateIntent, saleCreateRecoveryFor } from '../sales/create-recovery.js';
import { createTestRuntimeSafetyContext } from '../__fixtures__/runtime-safety.ts';
import { parseMcpResponse } from '../mcp-json.ts';
import { registerRunAccountingReportTool } from './run-accounting-report.ts';
import { registerAgingTools } from '../tools/aging-analysis.ts';
vi.mock('../audit-log.ts', () => ({ logAudit: vi.fn() }));

async function salesFixture(failureMode: string, responseId?: unknown, existing = false) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok:false, headers:{get:()=> '0'},text:async()=>''}));
  const committed: any[] = [];
  const clients: any[] = [];
  if (existing) clients.push({id:77,name:'New Buyer OÜ',code:'17133416',cl_code_country:'EST',is_deleted:false,is_client:true,is_supplier:false});
  const account=(id:number,name:string,balance_type:string,account_type_est:string,is_vat_account=false)=>({id,name_est:name,name_eng:name,balance_type,account_type_est,account_type_eng:account_type_est,is_valid:true,allows_dimensions:false,allows_deactivation:true,is_vat_account,is_fixed_asset:false,transaction_in_bindable:true,transaction_out_bindable:true,transaction_in_user_bindable:true,transaction_out_user_bindable:true,cl_account_groups:[],default_disabled:false,is_product_account:false});
  const accounts=[account(1210,'Nõuded ostjate vastu','D','Varad'),account(3100,'Teenuste müük','C','Tulud'),account(2510,'Müügi käibemaks','C','Kohustused',true)];
  const article={id:7,name_est:'Teenuste müük 24%',name_eng:'Services 24%',group_est:'Müük',group_eng:'Sales',accounts_id:3100,vat_accounts_id:2510,vat_rate:24,vat_type:1,is_valid:true,start_date:'2025-07-01',cl_account_groups:[]};
  const product={id:9,name:'Consulting service',code:'CONSULT',cl_sale_articles_id:7,sale_accounts_id:3100,sales_price:100,unit:'h',is_deleted:false};
  const post = vi.fn(async (_path:string, body: any) => {
   expect(_path).toBe('/sale_invoices');
   expect(body).toMatchObject({sale_invoice_type:'INVOICE',cl_templates_id:1,cl_currencies_id:'EUR',cl_countries_id:'EST',receivable_accounts_id:1210,number_prefix:'ARV',number_suffix:'',create_date:'2026-10-18',journal_date:'2026-10-18',term_days:14,net_price:100,vat20_price:24,gross_price:124,base_net_price:100,base_vat20_price:24,base_gross_price:124});
   expect(body.client).toBeUndefined();
   expect(body.items).toEqual([{products_id:product.id,cl_sale_articles_id:article.id,sale_accounts_id:article.accounts_id,vat_accounts_id:article.vat_accounts_id,vat_rate:article.vat_rate,custom_title:'Consulting service',amount:1,unit:'h',unit_net_price:100,total_net_price:100,base_total_net_price:100,vat_amount:24,discount_percent:0,discount_amount:0}]);
   expect(body.items[0].amount*body.items[0].unit_net_price).toBe(body.net_price);
   expect(body.items[0].total_net_price*body.items[0].vat_rate/100).toBe(body.vat20_price);
   expect(body.net_price+body.vat20_price).toBe(body.gross_price);
   expect(clients.find(c=>c.id===body.clients_id)).toMatchObject({name:'New Buyer OÜ',code:'17133416',cl_code_country:'EST',is_deleted:false});
   const id=500+committed.length;
   committed.push({ id, status:'PROJECT', ...body });
   if(committed.length>1)return {created_object_id:id};
   if(failureMode==='network')throw new HttpError('response lost after backend commit', 'network', 'POST', '/sale_invoices');
   if(failureMode==='generic')throw new Error('unknown POST result');
   if(failureMode==='500'||failureMode==='408')throw new HttpError('ambiguous backend failure',Number(failureMode),'POST','/sale_invoices');
   if(failureMode==='indeterminate')throw new MutationIndeterminateError({operation:'create',entity:'sale_invoice',businessKey:'invoice intent',affectedCaches:['/sale_invoices'],cause:new Error('unknown commit'),nextAction:'Read invoices'});
   if(failureMode==='decoder')return {get created_object_id(){throw new Error('response decoder failed after commit');}};
   return {created_object_id:responseId};
  });
  const namespace = `control-probe-${Math.random()}`;
  const http:any = { post, getCacheNamespace:()=> namespace, get: vi.fn(async (path:string) => path === '/sale_invoices' ? {current_page:1,total_pages:1,items:committed} : committed.find(i=>path === `/sale_invoices/${i.id}`)) };
  const deactivate = vi.fn(async (id:number)=>{clients.find(c=>c.id===id).is_deleted=true;return {};});
  const api:any = {
   saleInvoices:new SaleInvoicesApi(http),
   readonly:{getAccounts:async()=>accounts, getAccountDimensions:async()=>[],getSaleArticles:async()=>[article], getVatInfo:async()=>({vat_number:'EE123456789',tax_refnumber:'12345678'}),getInvoiceInfo:async()=>({invoice_company_name:'Seller OÜ'})},
   products:{get:async(id:number)=>id===product.id?product:undefined},
   clients:{invalidateListCache:vi.fn(),listAll:async()=>clients.map(c=>({...c})),create:async(body:any)=>{const id=77+clients.length;clients.push({id,...body,is_deleted:false});return {created_object_id:id};},get:async(id:number)=>clients.find(c=>c.id===id),deactivate},
  };
  const server:any={registerTool:vi.fn()};
  const runtime = createTestRuntimeSafetyContext();
  registerManageSaleInvoiceTool(server,api,runtime);
  const handler=server.registerTool.mock.calls.find((c:any)=>c[0]==='manage_sale_invoice')[2];
  const parse=(r:any)=>parseMcpResponse(r.content[0].text) as any;
  const payload={client:{name:'New Buyer OÜ',reg_code:'17133416',country:'EST'},sale_invoice_type:'INVOICE',cl_templates_id:1,cl_countries_id:'EST',cl_currencies_id:'EUR',receivable_accounts_id:1210,number_prefix:'ARV',number_suffix:'',term_days:14,show_client_balance:false,create_date:'2026-10-18',journal_date:'2026-10-18',net_price:100,vat20_price:24,gross_price:124,base_net_price:100,base_vat20_price:24,base_gross_price:124,items:[{products_id:9,cl_sale_articles_id:7,sale_accounts_id:3100,vat_accounts_id:2510,vat_rate:24,custom_title:'Consulting service',amount:1,unit:'h',unit_net_price:100,total_net_price:100,base_total_net_price:100,vat_amount:24,discount_percent:0,discount_amount:0}]};
  return {handler,parse,payload,post,http,committed,clients,deactivate,runtime,api};
}

describe('public sales create transport-loss recovery', () => {
 it.each<[string, unknown]>([['network',undefined],['generic',undefined],['500',undefined],['408',undefined],['indeterminate',undefined],['decoder',undefined],['missing',undefined],['zero',0],['negative',-1],['fractional',1.5],['unsafe',Number.MAX_SAFE_INTEGER+1],['string','500']])('a committed invoice POST keeps its customer and prevents a second create (%s)', async (failureMode, responseId) => {
  const {handler,parse,payload,post,committed,deactivate} = await salesFixture(failureMode,responseId);
  const prepared=parse(await handler({mode:'prepare',action:'create',payload}));
  expect(prepared.status).toBe('ready_for_approval');
  const output=parse(await handler({mode:'execute',action:'create',payload,plan_handle:prepared.plan_handle}));
  expect(committed).toHaveLength(1);
  expect(committed[0].clients_id).toBe(77);
  expect(deactivate).not.toHaveBeenCalled();
  expect(output.category).toBe('sale_invoice_create_indeterminate');
  expect(output.retry).toBe('never');
  expect(output.mutation_may_have_occurred).toBe(true);
  expect(output.mutated_objects).toEqual([{type:'client',id:77}]);
  expect(output.recovery.related_objects).toContainEqual({type:'client',id:77});
  const retryPrepared=parse(await handler({mode:'prepare',action:'create',payload}));
  expect(retryPrepared.plan_handle).toBeUndefined();
  expect(retryPrepared.category).toBe('sale_invoice_create_indeterminate');
  expect(retryPrepared.recovery.related_objects).toContainEqual({type:'sale_invoice',id:500});
  expect(committed).toHaveLength(1);
  expect(post).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
 });
});

describe('public sales recovery controls', () => {
 it.each(['inline','explicit'])('retains an existing client and binds the other alias (%s)', async alias => {
  const {handler,parse,payload,post,deactivate} = await salesFixture('network',undefined,true);
  const {client,...body} = payload;
  const explicit = {...body,clients_id:77};
  const first = alias === 'inline' ? payload : explicit;
  const alternate = alias === 'inline' ? explicit : payload;
  const prepared = parse(await handler({mode:'prepare',action:'create',payload:first}));
  const output = parse(await handler({mode:'execute',action:'create',payload:first,plan_handle:prepared.plan_handle}));
  expect(output.category).toBe('sale_invoice_create_indeterminate');
  expect(output.mutated_objects).toBeUndefined();
  expect(output.recovery.related_objects).toContainEqual({type:'client',id:77});
  const held = parse(await handler({mode:'prepare',action:'create',payload:alternate}));
  expect(held.plan_handle).toBeUndefined();
  expect(held.recovery.related_objects).toContainEqual({type:'sale_invoice',id:500});
  expect(deactivate).not.toHaveBeenCalled(); expect(post).toHaveBeenCalledTimes(1);
 });

 it('serializes two already prepared public handles across a pending POST', async () => {
  const f = await salesFixture('network',undefined,true);
  const p1=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload}));
  const p2=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload}));
  const original=f.post.getMockImplementation()!;
  let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve;});
  let entered!:()=>void; const started=new Promise<void>(resolve=>{entered=resolve;});
  f.post.mockImplementation(async (...args:any[])=>{entered(); await gate; return original(...args);});
  const a=f.handler({mode:'execute',action:'create',payload:f.payload,plan_handle:p1.plan_handle});
  await started;
  const b=f.handler({mode:'execute',action:'create',payload:f.payload,plan_handle:p2.plan_handle});
  await Promise.resolve(); expect(f.post).toHaveBeenCalledTimes(1);
  release();
  const [ar,br]=await Promise.all([a,b]);
  expect(f.parse(ar).category).toBe('sale_invoice_create_indeterminate');
  expect(f.parse(br).category).toBe('sale_invoice_create_indeterminate');
  expect(f.post).toHaveBeenCalledTimes(1);
 });

 it.each(['prepare','execute'])('released recovery keeps the client and late invoice discoverable before %s', async boundary => {
  const f=await salesFixture('network',undefined,true);
  const p=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload}));
  const failed=f.parse(await f.handler({mode:'execute',action:'create',payload:f.payload,plan_handle:p.plan_handle}));
  const marker=failed.recovery.marker;
  const persisted=f.committed.splice(0);
  const held=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload}));
  expect(held.plan_handle).toBeUndefined(); expect(held.recovery.marker).toBe(marker);
  const wrong=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload,release_indeterminate:'wrong-marker'}));
  expect(wrong.plan_handle).toBeUndefined();
  const released=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload,release_indeterminate:marker}));
  expect(released.status).toBe('recovery_released'); expect(released.plan_handle).toBeUndefined();
  const reads=f.http.get.mock.calls.length;
  if(boundary==='prepare')f.committed.push(...persisted);
  const fresh=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload}));
  expect(f.http.get.mock.calls.length).toBeGreaterThan(reads);
  let late=fresh;
  if(boundary==='execute') {
    expect(fresh.plan_handle).toBeTypeOf('string');
    f.committed.push(...persisted);
    late=f.parse(await f.handler({mode:'execute',action:'create',payload:f.payload,plan_handle:fresh.plan_handle}));
  }
  expect(late.plan_handle).toBeUndefined(); expect(late.category).toBe('sale_invoice_create_indeterminate');
  expect(late.retry).toBe('never');
  expect(late.recovery.related_objects).toContainEqual({type:'sale_invoice',id:500});
  expect(late.recovery.related_objects).toContainEqual({type:'client',id:77});
  const guard=saleCreateRecoveryFor(f.runtime),scope=captureSaleCreateScope(f.runtime);
  await guard.withLock(scope,async s=>expect(s.findPending(saleCreateIntent({action:'create',...f.payload}))).toBeUndefined());
  const again=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload,release_indeterminate:marker}));
  expect(again.category).toBe('invalid_recovery_release');expect(again.plan_handle).toBeUndefined();
  expect(f.post).toHaveBeenCalledTimes(1);
 });

 it('keeps the marker when list/detail reads fail or a matching draft prevents release', async () => {
  const f=await salesFixture('network',undefined,true);
  const p=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload}));
  const failed=f.parse(await f.handler({mode:'execute',action:'create',payload:f.payload,plan_handle:p.plan_handle}));
  const marker=failed.recovery.marker;
  const refused=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload,release_indeterminate:marker}));
  expect(refused.recovery.related_objects).toContainEqual({type:'sale_invoice',id:500}); expect(refused.plan_handle).toBeUndefined();
  f.http.get.mockRejectedValueOnce(new Error('list unavailable'));
  const unavailable=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload,release_indeterminate:marker}));
  expect(unavailable.recovery.marker).toBe(marker); expect(unavailable.plan_handle).toBeUndefined();
  expect(f.post).toHaveBeenCalledTimes(1);
 });

 it.each(['execute','read'])('rejects release in %s without consuming an existing plan', async mode=>{
  const f=await salesFixture('positive',500,true);
  const p=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload}));
  const invalid=f.parse(await f.handler({mode,action:'create',payload:f.payload,plan_handle:p.plan_handle,release_indeterminate:'marker'}));
  expect(invalid.status).not.toBe('completed'); expect(f.post).not.toHaveBeenCalled();
  const valid=f.parse(await f.handler({mode:'execute',action:'create',payload:f.payload,plan_handle:p.plan_handle}));
  expect(valid.mode).toBe('execute'); expect(valid.mutation_occurred).toBe(true); expect(f.post).toHaveBeenCalledTimes(1);
 });
 it.each([null,42,{},''])('rejects malformed release %j before consuming a public plan',async release=>{
  const f=await salesFixture('positive',500,true);
  const p=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload}));
  const invalid=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload,release_indeterminate:release}));
  expect(invalid.category).toBe('invalid_recovery_release');expect(f.post).not.toHaveBeenCalled();
  const done=f.parse(await f.handler({mode:'execute',action:'create',payload:f.payload,plan_handle:p.plan_handle}));
  expect(done.mutation_occurred).toBe(true);expect(f.post).toHaveBeenCalledTimes(1);
 });
 it('shares recovery across two public registrations with one runtime',async()=>{
  const f=await salesFixture('network',undefined,true);
  const p=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload}));
  await f.handler({mode:'execute',action:'create',payload:f.payload,plan_handle:p.plan_handle});
  const second:any={registerTool:vi.fn()}; registerManageSaleInvoiceTool(second,f.api,f.runtime);
  const handler=second.registerTool.mock.calls.find((c:any)=>c[0]==='manage_sale_invoice')[2];
  const held=f.parse(await handler({mode:'prepare',action:'create',payload:f.payload}));
  expect(held.plan_handle).toBeUndefined();expect(held.recovery.related_objects).toContainEqual({type:'sale_invoice',id:500});expect(f.post).toHaveBeenCalledTimes(1);
 });
 it('rejects another company or material intent from releasing the marker',async()=>{
  const f=await salesFixture('network',undefined,true);
  const p=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload}));
  const failure=f.parse(await f.handler({mode:'execute',action:'create',payload:f.payload,plan_handle:p.plan_handle}));
  const marker=failure.recovery.marker;
  const wrongIntent=f.parse(await f.handler({mode:'prepare',action:'create',payload:{...f.payload,gross_price:999},release_indeterminate:marker}));
  expect(wrongIntent.category).toBe('invalid_recovery_release');
  const scope={...f.runtime.getActiveScope()};
  f.runtime.setScope({connectionFingerprint:'other-company',baseUrl:'https://other-company.example/api',connectionGeneration:999});
  const wrongCompany=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload,release_indeterminate:marker}));
  expect(wrongCompany.category).toBe('invalid_recovery_release');
  f.runtime.setScope(scope);
  const held=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload}));
  expect(held.recovery.marker).toBe(marker);expect(f.post).toHaveBeenCalledTimes(1);
 });
 it('capacity refusal makes zero new client/invoice writes and preserves retained holds',async()=>{
  const f=await salesFixture('positive',500,true);
  const guard=saleCreateRecoveryFor(f.runtime),scope=captureSaleCreateScope(f.runtime);
  await guard.withLock(scope,async s=>{
    for(let i=0;i<128;i++) {
      const intent=saleCreateIntent({action:'create',clients_id:900+i,create_date:'2026-10-18',gross_price:1000+i,cl_currencies_id:'EUR',items:[]});
      const reservation=s.reserve(intent);s.markIndeterminate(reservation,{clientsId:900+i,intent});
    }
  });
  const p=f.parse(await f.handler({mode:'prepare',action:'create',payload:f.payload}));
  const failure=f.parse(await f.handler({mode:'execute',action:'create',payload:f.payload,plan_handle:p.plan_handle}));
  expect(failure.category).toBe('sale_invoice_create_recovery_unavailable');expect(failure.retry).toBe('never');
  expect(f.post).not.toHaveBeenCalled();expect(f.clients).toHaveLength(1);
 });
});

describe('historical aging entrypoint equivalence',()=>{
 it('guided historical report preserves the standalone current-payment-state caveat',async()=>{
  const api:any={saleInvoices:{listAll:async()=>[{id:1,status:'CONFIRMED',payment_status:'PAID',create_date:'2026-09-01',journal_date:'2026-09-01',term_days:14,gross_price:100,base_gross_price:100,clients_id:10,client_name:'Buyer'}]},purchaseInvoices:{listAll:async()=>[]}};
  const server:any={registerTool:vi.fn()};
  registerRunAccountingReportTool(server,api,{enableSales:true});
  registerAgingTools(server,api,{enableSales:true} as any);
  const get=(name:string)=>server.registerTool.mock.calls.find((c:any)=>c[0]===name)[2];
  const parse=(r:any)=>parseMcpResponse(r.content[0].text) as any;
  const guided=parse(await get('run_accounting_report')({report:'aging',as_of_date:'2026-09-30'}));
  const granular=parse(await get('compute_receivables_aging')({as_of_date:'2026-09-30'}));
  expect(guided.receivables.total_unpaid_face_value).toBe(0);
  expect(guided.receivables.warnings.join(' ')).toContain('CURRENT state');
  expect(granular.warnings.join(' ')).toContain('CURRENT state');

 });
});
