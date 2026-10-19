import { vi } from "vitest";
import { served } from "./verified-draft.js";

/** Upgrade old legacy fixtures to actual GET-able PROJECT drafts, retaining their post-register receipt. */
export function installLegacyDraftReadback(api: any) {
  const create = api.purchaseInvoices.createAndSetTotals;
  if (!vi.isMockFunction(create)) return;
  const original = create.getMockImplementation();
  const get = api.purchaseInvoices.get.getMockImplementation();
  const drafts = new Map<number, any>();
  let registered = false;
  const confirm = api.purchaseInvoices.confirm;
  if (vi.isMockFunction(confirm)) {
    const register = confirm.getMockImplementation();
    confirm.mockImplementation(async (...args: any[]) => {
      const result = await register?.(...args);
      registered = true;
      return result;
    });
  }
  create.mockImplementation(async (data: any, vat?: number, gross?: number, ...rest: any[]) => {
    const result = await original?.(data, vat, gross, ...rest);
    if (result?.id && result.status === "SAVED") {
      const draft = { ...data, ...result, status: "PROJECT", vat_price: vat, gross_price: gross, ...served(data, vat, gross) };
      drafts.set(result.id, draft);
      return structuredClone(draft);
    }
    return result;
  });
  api.purchaseInvoices.get.mockImplementation(async (id: number) => {
    if (!registered && drafts.has(id)) return structuredClone(drafts.get(id));
    return get?.(id);
  });
}
