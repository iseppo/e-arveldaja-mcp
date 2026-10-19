import { normalizeItemsForNonVat, predictPurchaseItemAmounts, previewPurchaseInvoiceTotals } from "../api/purchase-invoices.api.js";
import { applyPurchaseItemStructuralDefaults } from "../tools/purchase-vat-defaults.js";
import { parseVatRateDropdown, roundMoney } from "../money.js";
import type { CreatePurchaseInvoiceData, PurchaseInvoice } from "../types/api.js";

/** Transport fixture: retain authored fields and simulate the API's derived amounts. */
export function fixturePurchaseReadback(model: CreatePurchaseInvoiceData, vat: number | undefined, gross: number | undefined, isVatRegistered = true, id = 9001): PurchaseInvoice {
  const preview = previewPurchaseInvoiceTotals(model, vat, gross, isVatRegistered);
  if (!preview.ok) throw new Error(preview.message);
  const rows = normalizeItemsForNonVat(model.items, isVatRegistered, gross).map(applyPurchaseItemStructuralDefaults);
  if (preview.lastItemGross !== undefined && rows.length) rows[rows.length - 1] = { ...rows[rows.length - 1]!, project_no_vat_gross_price: preview.lastItemGross };
  const amounts = predictPurchaseItemAmounts(rows);
  const net = roundMoney(amounts.reduce((sum, row) => sum + row.net, 0));
  const rate = model.currency_rate ?? 1;
  return { ...model, id, status: "PROJECT", net_price: net, vat_price: preview.vat, gross_price: preview.gross,
    base_net_price: preview.base?.net ?? net, base_vat_price: preview.base?.vat ?? preview.vat, base_gross_price: preview.base?.gross ?? preview.gross,
    items: rows.map((row, index) => ({ ...row, total_net_price: amounts[index]!.net, vat_amount: amounts[index]!.vat,
      vat_rate: row.vat_rate ?? parseVatRateDropdown(row.vat_rate_dropdown), base_total_net_price: row.base_total_net_price ?? roundMoney(amounts[index]!.net / rate) })),
  } as PurchaseInvoice;
}
