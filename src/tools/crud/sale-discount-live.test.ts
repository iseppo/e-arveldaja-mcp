import { describe, expect, it, vi } from "vitest";
import { parseSaleInvoiceItems } from "./shared.js";
import { registerSaleInvoiceTools } from "./sale-invoices.js";

vi.mock("../../audit-log.js", () => ({ logAudit: vi.fn() }));

const row = { products_id: 51, custom_title: "Discounted service", amount: 2, unit_net_price: 0.10, discount_percent: 25 };

describe("live sales percentage-discount regression", () => {
  it("sends an absolute line discount on create and explicit row update", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 71 });
    const update = vi.fn().mockResolvedValue({ code: 200 });
    const api = {
      saleInvoices: { create, update, get: vi.fn().mockResolvedValue({ id: 71, status: "PROJECT" }), invalidateListCache: vi.fn() },
      readonly: { getAccounts: vi.fn().mockResolvedValue([]), getAccountDimensions: vi.fn().mockResolvedValue([]) },
    };
    const server = { registerTool: vi.fn() };
    registerSaleInvoiceTools(server as never, api as never);
    const handler = (name: string) => server.registerTool.mock.calls.find(([n]) => n === name)![2] as (x: unknown) => Promise<unknown>;
    const items = [row, { products_id: 51, custom_title: "Other service", amount: 1, unit_net_price: 0.20 }];
    await handler("create_sale_invoice")({ clients_id: 1, cl_templates_id: 111, create_date: "2026-10-19", journal_date: "2026-10-19", term_days: 0, items });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ items: [{ ...row, discount_amount: 0.05 }, items[1]] }));
    await handler("update_sale_invoice")({ id: 71, data: { items } });
    expect(update).toHaveBeenCalledWith(71, { items: [{ ...row, discount_amount: 0.05 }, items[1]] });
    // Independent cents expectation: .15 discounted + .20 normal = .35 net.
    expect(Math.round((0.20 - create.mock.calls[0]![0].items[0].discount_amount + 0.20) * 100)).toBe(35);
  });

  it.each([
    { amount: "2", unit_net_price: "0.10", discount_percent: "25", expected: 0.15 },
    { amount: -2, unit_net_price: 0.10, discount_percent: 25, expected: -0.15 },
    { amount: 2, unit_net_price: -0.10, discount_percent: 25, expected: -0.15 },
    { amount: 1, unit_net_price: 1.01, discount_percent: 50, expected: 0.51 },
    { amount: 1, unit_net_price: 0.15, discount_percent: 90, expected: 0.02 },
    { amount: -1, unit_net_price: 0.15, discount_percent: 90, expected: -0.02 },
    { amount: 1e-3, unit_net_price: 150, discount_percent: 90, expected: 0.02 },
    { amount: 1, unit_net_price: 0.20, discount_percent: 100, expected: 0 },
  ])("derives bounded money with coercion and credit signs: %j", ({ expected, ...data }) => {
    const parsed=parseSaleInvoiceItems([{ ...row, ...data }])[0]!;
    expect(parsed.discount_amount).toBeDefined();
    const net=Number(data.amount)*Number(data.unit_net_price)-parsed.discount_amount!;
    expect((Math.sign(net)*Math.round((Math.abs(net)+1e-12)*100)/100)||0).toBe(expected);
  });

  it.each([{ discount_amount: 0.03 }, { discount_amount: 0 }])("preserves authoritative explicit values: %j", (explicit) => {
    expect(parseSaleInvoiceItems([{ ...row, ...explicit }])[0]).toEqual({ ...row, ...explicit });
  });

  it("does not alter undiscounted product-priced rows", () => {
    const input = { products_id: 51, custom_title: "Service", amount: 2, discount_percent: 0 };
    expect(parseSaleInvoiceItems([input])[0]).toEqual(input);
  });

  it("refuses ambiguous nonzero percentage with no unit price", () => {
    expect(() => parseSaleInvoiceItems([{ products_id: 51, custom_title: "Service", amount: 2, discount_percent: 25 }])).toThrow("unit_net_price");
  });

  it.each([1001])("refuses the official upper percentage bound: %s", discount_percent => {
    expect(() => parseSaleInvoiceItems([{ ...row, discount_percent }])).toThrow("discount_percent");
  });

  it.each(["total_net_price", "discount_amount"])("coerces valid %s and refuses malformed amounts", (field) => {
    expect(parseSaleInvoiceItems([{ ...row, [field]: "0.15" }])[0]).toHaveProperty(field, 0.15);
    expect(() => parseSaleInvoiceItems([{ ...row, [field]: "bad" }])).toThrow(field);
  });

  it("rounds decimal half cents consistently across quantities and percentages", () => {
    // Independent integer oracle over cent-priced rows and whole percentages.
    for (let priceCents = 1; priceCents <= 100; priceCents++) {
      for (const amount of [1, 2, 3, -1]) for (const discount_percent of [10, 25, 50, 75, 90]) {
        const numerator = amount * priceCents * (100 - discount_percent);
        const expectedCents = (Math.sign(numerator) * Math.floor((Math.abs(numerator) + 50) / 100)) || 0;
        const [parsed] = parseSaleInvoiceItems([{ ...row, amount, unit_net_price: priceCents / 100, discount_percent }]);
        const inferred = Math.round((Math.abs(amount * priceCents / 100 - parsed!.discount_amount!) + 1e-12) * 100) * Math.sign(amount);
        expect(inferred || 0).toBe(expectedCents);
      }
    }
  });

  it("passes full-precision line discounts instead of prematurely rounding .135 to .14", () => {
    expect(parseSaleInvoiceItems([{ ...row, amount: 1, unit_net_price: 0.15, discount_percent: 90 }])[0]!.discount_amount).toBe(0.135);
  });

  it("refuses a discount that cannot survive the JSON number precision without changing cents",()=>{
    expect(()=>parseSaleInvoiceItems([{...row,amount:2.9999999999999996,unit_net_price:0.05,discount_percent:90,total_net_price:0.01}])).toThrow('precision');
  });

  it("derives an absolute discount when an explicit row total agrees with the percentage", () => {
    expect(parseSaleInvoiceItems([{ ...row, total_net_price: 0.15 }])[0]).toEqual({ ...row, total_net_price: 0.15, discount_amount: 0.05 });
    expect(()=>parseSaleInvoiceItems([{ ...row, total_net_price: 0.17 }])).toThrow("total_net_price");
    expect(parseSaleInvoiceItems([{ ...row, discount_percent:100,total_net_price:0 }])[0]).toEqual({...row,discount_percent:100,total_net_price:0,discount_amount:0.20});
    expect(()=>parseSaleInvoiceItems([{products_id:51,custom_title:'Service',amount:2,discount_percent:25,total_net_price:0.15}])).toThrow('unit_net_price');
  });

  it.each([{discount_percent:-25,discount_amount:-0.05},{discount_percent:125,discount_amount:0.25},{discount_percent:1000,discount_amount:2}])("preserves legal signed/super-100 percentages: %j", ({discount_percent,discount_amount}) => {
    expect(parseSaleInvoiceItems([{...row,discount_percent}])[0]!.discount_amount).toBe(discount_amount);
  });
});

describe("rounded API discount replay",()=>{
  it.each([
    {name:'restore precise percent evidence',amount:0.14,total:0.02,percent:90,expected:0.135},
    {name:'preserve explicit amount precedence',amount:0.14,total:0.01,percent:90,expected:0.14},
    {name:'preserve legacy decorative percentage',amount:null,total:0.15,percent:90,expected:null},
  ])('$name',async({amount,total,percent,expected})=>{
    const items=[{id:91,products_id:51,custom_title:'Service',amount:1,unit_net_price:0.15,total_net_price:total,discount_percent:percent,discount_amount:amount}];
    const update=vi.fn().mockResolvedValue({code:200}),api={saleInvoices:{get:vi.fn().mockResolvedValue({id:71,status:'PROJECT',items}),invalidateListCache:vi.fn(),update}},server={registerTool:vi.fn()};registerSaleInvoiceTools(server as never,api as never);
    const handler=server.registerTool.mock.calls.find(([n])=>n==='update_sale_invoice')![2] as (x:unknown)=>Promise<any>;
    await handler({id:71,data:{notes:'Changed'}});
    expect(update).toHaveBeenCalledWith(71,{notes:'Changed',items:[{...items[0],discount_amount:expected}]});
    expect(items[0]!.discount_amount).toBe(amount);
  });

  it('refuses unprovable financial replay before PATCH',async()=>{
    const update=vi.fn(),api={saleInvoices:{get:vi.fn().mockResolvedValue({id:71,status:'PROJECT',items:[{id:91,products_id:51,custom_title:'Service',amount:1,unit_net_price:0.15,total_net_price:0.02,discount_percent:90,discount_amount:0.12}]}),invalidateListCache:vi.fn(),update}},server={registerTool:vi.fn()};registerSaleInvoiceTools(server as never,api as never);
    const handler=server.registerTool.mock.calls.find(([n])=>n==='update_sale_invoice')![2] as (x:unknown)=>Promise<any>;
    const response=await handler({id:71,data:{notes:'Changed'}});expect(response.isError).toBe(true);expect(update).not.toHaveBeenCalled();
  });
});
