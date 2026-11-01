import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../bank-posting-duplicate-guard.js", () => ({ checkIntakeCashDuplicates: vi.fn().mockResolvedValue({ scan_available: true, suspects: [] }), formatDuplicatePostingWarnings: vi.fn().mockReturnValue([]) }));
import { PurchaseInvoicesApi } from "../api/purchase-invoices.api.js";
import { cache } from "../api/base-resource.js";
import type { PurchaseInvoiceItem } from "../types/api.js";
import { createAndMaybeMatchPurchaseInvoice, prepareReceiptInvoiceItems } from "./receipt-inbox-booking.js";
import { detectMixedVatRates, extractReceiptFieldsFromText, type ExtractedReceiptFields } from "./receipt-extraction.js";
import { sha256Hex } from "./receipt-inbox-files.js";

// #5c: an apartment-association invoice prints a per-rate breakdown under the item table
// (synthetic names and numbers in the shape of the owner's Kaupmehe invoices).
const breakdownText = (vat = "30,02") => [
  "Näidise tn 1 korteriühistu",
  "Reg. kood 80000000",
  "Arve nr M000000001",
  "Arve kuupäev 07.10.2026",
  "Maksetähtaeg 31.10.2026",
  "Majandamiskulud perioodi september 2026 eest        Ühik   Kogus   hind   Kokku   KM   KM %   KMga",
  "Haldus ja raamatupidamine     m²   59.00   0.1960   11.56   2.77   24%   14.33",
  "Remondifond                   m²   59.00   0.3000   17.70   0.00   KM-ta  17.70",
  "Arve koostas: Näidis Isik naidis@example.invalid                 Käibemaksuta          € 37,32",
  "Haldur: Teine Isik 6100000                                      Käibemaksuga 24%      € 125,13",
  `                                                               Käibemaks             € ${vat}`,
  "                                                               Arve summa            € 192,47",
].join("\n");

const extractedOf = (text: string): ExtractedReceiptFields => extractReceiptFieldsFromText(text, "arve.pdf");

describe("mixed VAT rates are read as a breakdown (#5c)", () => {
  it("a proven breakdown: net from gross − VAT, the printed lines, and no VAT warning", () => {
    const extracted = extractedOf(breakdownText());
    expect(extracted).toMatchObject({ total_net: 162.45, total_vat: 30.02, total_gross: 192.47 });
    expect(extracted.mixed_vat_rates).toEqual({
      lines: [{ rate: null, net: 37.32, vat: 0 }, { rate: 24, net: 125.13, vat: 30.02 }],
      proven: true,
    });
    expect(extracted.amount_consistency_issues ?? []).not.toEqual(expect.arrayContaining(["vat_rate_implausible"]));
    expect(extracted.amount_consistency_issues).toBeUndefined();
  });

  it("an unproven breakdown (VAT 30.50) keeps its warnings and adds mixed_vat_rate_review", () => {
    const extracted = extractedOf(breakdownText("30,50"));
    expect(extracted.mixed_vat_rates?.proven).toBe(false);
    expect(extracted.amount_consistency_issues).toEqual(expect.arrayContaining(["mixed_vat_rate_review"]));
  });

  it.each([
    ["above the breakdown", 8],
    ["below the breakdown", 11],
  ])("a labelled net the breakdown does not explain (Netosumma 200,00 %s) keeps the conflicts and holds", (_where, at) => {
    const lines = breakdownText().split("\n");
    const extracted = extractedOf([...lines.slice(0, at), "Netosumma 200,00", ...lines.slice(at)].join("\n"));
    expect(extracted.mixed_vat_rates?.proven).toBe(true);
    expect(extracted.amount_consistency_issues).toEqual(
      expect.arrayContaining(["explicit_trio_mismatch", "explicit_net_overridden", "vat_rate_implausible"]),
    );
    const prepared = prepareReceiptInvoiceItems(vatContext, extracted, suggestion, "Haldus");
    expect(prepared.ok).toBe(false);
  });

  it.each([
    ["above the breakdown", 8],
    ["below the breakdown", 11],
  ])("money before a labelled net (Ettemaks 10,00 Netosumma 200,00 %s) is no item row: the conflict holds", (_where, at) => {
    const lines = breakdownText().split("\n");
    const extracted = extractedOf([...lines.slice(0, at), "Ettemaks 10,00 Netosumma 200,00", ...lines.slice(at)].join("\n"));
    expect(extracted.mixed_vat_rates?.proven).toBe(true);
    expect(extracted.amount_consistency_issues).toEqual(
      expect.arrayContaining(["explicit_trio_mismatch", "explicit_net_overridden", "vat_rate_implausible"]),
    );
    const prepared = prepareReceiptInvoiceItems(vatContext, extracted, suggestion, "Haldus");
    expect(prepared.ok).toBe(false);
  });

  it("a labelled net equal to the computed taxable net is explained by the breakdown", () => {
    const lines = breakdownText().split("\n");
    const extracted = extractedOf([...lines.slice(0, 11), "Netosumma 162,45", ...lines.slice(11)].join("\n"));
    expect(extracted.amount_consistency_issues).toBeUndefined();
  });

  it("a single-rate invoice with a Käibemaksuta label still reads that label as its net", () => {
    const extracted = extractedOf(["Pood OÜ", "Arve nr 55", "Arve kuupäev 07.10.2026", "Käibemaksuta 100,00", "Käibemaks 24% 24,00", "Kokku 124,00"].join("\n"));
    expect(extracted).toMatchObject({ total_net: 100, total_vat: 24, total_gross: 124 });
    expect(extracted.mixed_vat_rates).toBeUndefined();
  });

  it("is not proven with two rated lines, or a rate not in force on the invoice date", () => {
    const two = ["Käibemaksuta 10,00", "Käibemaksuga 24% 100,00", "Käibemaksuga 9% 100,00"].join("\n");
    expect(detectMixedVatRates(two, { total_net: 210, total_vat: 33, total_gross: 243, invoice_date: "2026-10-07" })?.proven).toBe(false);
    const oldRate = ["Käibemaksuta 37,32", "Käibemaksuga 20% 125,13"].join("\n");
    expect(detectMixedVatRates(oldRate, { total_net: 162.35, total_vat: 25.03, total_gross: 187.38, invoice_date: "2026-10-07" })?.proven).toBe(false);
  });
});

const suggestion = { source: "supplier_history", item: { cl_purchase_articles_id: 66, purchase_accounts_id: 5230, amount: 1 } } as never;
const vatContext = { clients: [], purchaseInvoices: [], purchaseArticlesWithVat: [], accounts: [], isVatRegistered: true } as never;
const nonVatContext = { clients: [], purchaseInvoices: [], purchaseArticlesWithVat: [], accounts: [], isVatRegistered: false } as never;

describe("a proven mixed-rate receipt is booked one item per rate (#5c)", () => {
  beforeEach(() => { cache.invalidate(); vi.clearAllMocks(); });

  it("VAT-registered: the non-taxed line first at rate '-', the 24 % line last", () => {
    const prepared = prepareReceiptInvoiceItems(vatContext, extractedOf(breakdownText()), suggestion, "Haldus");
    if (!prepared.ok) throw new Error(prepared.notes.join(" "));
    expect(prepared.items.map(item => [item.total_net_price, item.vat_rate_dropdown])).toEqual([[37.32, "-"], [125.13, "24"]]);
    expect(prepared.grossTotal).toBe(192.47);
  });

  it("non-VAT company: one folded item of the gross", () => {
    const prepared = prepareReceiptInvoiceItems(nonVatContext, extractedOf(breakdownText()), suggestion, "Haldus");
    if (!prepared.ok) throw new Error(prepared.notes.join(" "));
    expect(prepared.items).toHaveLength(1);
    expect(prepared.items[0]).toMatchObject({ total_net_price: 192.47, vat_rate_dropdown: "-" });
  });

  it("an unproven breakdown is held as mixed_vat_rate_review", () => {
    for (const context of [vatContext, nonVatContext]) {
      const prepared = prepareReceiptInvoiceItems(context, extractedOf(breakdownText("30,50")), suggestion, "Haldus");
      expect(prepared.ok).toBe(false);
      if (prepared.ok) continue;
      expect(prepared.notes.join(" ")).toContain("mixed_vat_rate_review");
    }
  });

  it("execute: POST carries both items without residue, PATCH puts 155.15 on the last item, the readback is accepted", async () => {
    type Body = { items: PurchaseInvoiceItem[]; vat_price?: number; gross_price?: number };
    type Stored = Record<string, unknown> & { items?: ReturnType<typeof readItems> };
    let stored: Stored = {};
    const writes: Array<{ method: string; path: string; body: Body }> = [];
    // Live behaviour (CLAUDE.md "Readback residue"): the API recomputes item VAT and drops the last-row override.
    const readItems = (items: PurchaseInvoiceItem[]) => items.map((item, index) => ({
      ...item, id: 700 + index, base_total_net_price: item.total_net_price, project_no_vat_gross_price: null,
      vat_rate: item.vat_rate_dropdown === "-" ? 0 : Number(item.vat_rate_dropdown),
      vat_amount: item.vat_rate_dropdown === "-" ? 0 : Math.round(item.total_net_price! * Number(item.vat_rate_dropdown)) / 100,
    }));
    const client = {
      cacheNamespace: `mixed-vat-${Math.random()}`, connectionFingerprint: "mixed-vat", apiBaseUrl: "https://fake.invalid",
      post: vi.fn(async (path: string, body: Body) => {
        writes.push({ method: "POST", path, body: structuredClone(body) });
        const items = readItems(body.items);
        const vat = items.reduce((sum, item) => sum + item.vat_amount, 0);
        stored = { ...body, id: 5555801, status: "PROJECT", base_document_files_id: null, net_price: 162.45, vat_price: Math.round(vat * 100) / 100, gross_price: Math.round((162.45 + vat) * 100) / 100, currency_rate: 1, items, transactions: [], journals: [], settlements: [] };
        stored.base_net_price = stored.net_price; stored.base_vat_price = stored.vat_price; stored.base_gross_price = stored.gross_price;
        return { created_object_id: 5555801 };
      }),
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/document_user")) return { name: "arve.pdf", contents: Buffer.from("synthetic").toString("base64") };
        if (path === "/purchase_invoices") return { current_page: 1, total_pages: 1, items: [] };
        return structuredClone(stored);
      }),
      request: vi.fn(async (path: string, init: { body: Body }) => { writes.push({ method: "PUT", path, body: init.body }); stored.base_document_files_id = 9705200; return {}; }),
      patch: vi.fn(async (path: string, body: Body) => {
        writes.push({ method: "PATCH", path, body: structuredClone(body) });
        if (path.endsWith("/register")) { stored.status = "CONFIRMED"; return {}; }
        if (path.endsWith("/invalidate")) { stored.status = "VOID"; return {}; }
        stored = { ...stored, vat_price: body.vat_price, gross_price: body.gross_price, base_vat_price: body.vat_price, base_gross_price: body.gross_price, items: readItems(body.items) };
        return {};
      }),
    };
    const purchaseInvoices = new PurchaseInvoicesApi(client as never);
    const api = { purchaseInvoices, journals: { listAll: vi.fn().mockResolvedValue([]), invalidateListCache: vi.fn() } };
    const extracted = extractedOf(breakdownText());
    const snapshot = { file: { name: "arve.pdf", path: "/tmp/arve.pdf", extension: ".pdf", file_type: "pdf" }, bytes: Buffer.from("synthetic"), sha256: sha256Hex(Buffer.from("synthetic")) };
    const supplier = { found: true, client: { id: 1702990, name: "Näidise tn 1 korteriühistu" } };

    const result = await createAndMaybeMatchPurchaseInvoice(api as never, vatContext, snapshot as never, extracted, supplier as never, suggestion, [], "create_and_confirm", false, new Set());
    expect(result.notes).not.toEqual(expect.arrayContaining([expect.stringContaining("Held")]));
    expect(result.created_invoice).toMatchObject({ id: 5555801, confirmed: true });

    const post = writes.find(write => write.method === "POST")!;
    expect(post.body.items.map((item: PurchaseInvoiceItem) => [item.total_net_price, item.vat_rate_dropdown, item.project_no_vat_gross_price])).toEqual([[37.32, "-", undefined], [125.13, "24", undefined]]);
    const totalsPatch = writes.find(write => write.method === "PATCH" && write.path === "/purchase_invoices/5555801")!;
    expect(totalsPatch.body).toMatchObject({ vat_price: 30.02, gross_price: 192.47 });
    expect(totalsPatch.body.items[0].vat_rate_dropdown).toBe("-");
    expect(totalsPatch.body.items[0].project_no_vat_gross_price ?? null).toBeNull();
    expect(totalsPatch.body.items[1].project_no_vat_gross_price).toBe(155.15);
    expect(stored).toMatchObject({ status: "CONFIRMED", vat_price: 30.02, gross_price: 192.47 });
    expect(stored.items![1]).toMatchObject({ vat_amount: 30.03, project_no_vat_gross_price: null });
    expect(stored.items![0]).toMatchObject({ vat_rate_dropdown: "-", vat_amount: 0 });
  });
});
