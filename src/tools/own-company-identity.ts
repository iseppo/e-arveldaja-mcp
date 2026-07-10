import type { ApiContext } from "./crud/shared.js";
import type { Client } from "../types/api.js";
import { deriveOwnCompanyRegistryCode } from "./receipt-inbox.js";

/**
 * The active company's own VAT number and registry code, used to keep receipt
 * extraction and supplier resolution from mistaking the buyer's own
 * identifiers (read off the invoice header) for the supplier — which would
 * otherwise book a purchase against the company itself.
 *
 * The receipt-batch flow (`receipt_batch`) already resolves these and threads
 * them through extraction (`excludeVat` / `excludeRegCode`) and
 * `resolveSupplierInternal`'s self-match guards. The single-PDF flow
 * (`extract_pdf_invoice` / `resolve_supplier`) uses this shared helper so it
 * gets the identical defenses.
 */
export interface OwnCompanyIdentifiers {
  ownCompanyVat?: string;
  ownCompanyRegistryCode?: string;
}

/**
 * `invoice_info` is a recent endpoint; test stubs and older API-client mocks
 * may not implement it. Return an empty object on any failure so callers keep
 * working — we just lose the name-based registry-code fallback.
 */
async function safeGetInvoiceInfo(api: ApiContext): Promise<{ invoice_company_name?: string | null }> {
  try {
    const fn = api.readonly.getInvoiceInfo;
    if (typeof fn !== "function") return {};
    return await fn.call(api.readonly);
  } catch {
    return {};
  }
}

/**
 * Resolve the active company's own VAT number (from `vat_info`) and registry
 * code (derived from the clients list + `invoice_info`). Best-effort: any
 * upstream failure degrades to `undefined` for that field so the caller falls
 * back to its prior no-exclusion behaviour rather than erroring.
 */
export async function resolveOwnCompanyIdentifiers(
  api: ApiContext,
  clients: Client[],
): Promise<OwnCompanyIdentifiers> {
  let ownCompanyVat: string | undefined;
  try {
    const vatInfo = await api.readonly.getVatInfo();
    ownCompanyVat = vatInfo.vat_number?.trim() || undefined;
  } catch {
    ownCompanyVat = undefined;
  }
  const invoiceInfo = await safeGetInvoiceInfo(api);
  const ownCompanyRegistryCode = deriveOwnCompanyRegistryCode(
    clients,
    ownCompanyVat,
    invoiceInfo.invoice_company_name?.trim() || undefined,
  );
  return { ownCompanyVat, ownCompanyRegistryCode };
}
