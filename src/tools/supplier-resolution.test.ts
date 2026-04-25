import { describe, expect, it } from "vitest";
import type { Client } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { resolveSupplierInternal } from "./supplier-resolution.js";

// resolveSupplierInternal calls fetchRegistryData() when the resolution falls
// through to "create" mode for an EE supplier with a reg_code. The tests below
// pick inputs that either match an existing client first or use non-EE
// suppliers, so the network branch is never hit. dryRun (`execute=false`)
// also short-circuits before the api.clients.create call.
const stubApi = {
  clients: {
    listAll: () => Promise.resolve([]),
    create: () => {
      throw new Error("api.clients.create should not be called in these tests");
    },
    get: () => {
      throw new Error("api.clients.get should not be called in these tests");
    },
  },
} as unknown as ApiContext;

function makeClient(overrides: Partial<Client>): Client {
  return {
    id: 1,
    is_client: false,
    is_supplier: true,
    name: overrides.name ?? "Stub Client OÜ",
    cl_code_country: overrides.cl_code_country ?? "EST",
    is_member: false,
    send_invoice_to_email: false,
    send_invoice_to_accounting_email: false,
    is_deleted: false,
    invoice_vat_no: overrides.invoice_vat_no ?? null,
    code: overrides.code ?? null,
    ...overrides,
  };
}

describe("resolveSupplierInternal — own-VAT guard (#14)", () => {
  it("returns the matching client by VAT when ownCompanyVat is not set", async () => {
    const ownCompany = makeClient({
      id: 100,
      name: "Seppo AI OÜ",
      invoice_vat_no: "EE102809963",
      code: "17133416",
    });

    const result = await resolveSupplierInternal(
      stubApi,
      [ownCompany],
      { supplier_vat_no: "EE102809963" },
      false,
    );

    expect(result.found).toBe(true);
    expect(result.client?.id).toBe(100);
  });

  it("falls through to a different real supplier (name_fuzzy) when supplier_vat_no equals ownCompanyVat", async () => {
    const ownCompany = makeClient({
      id: 100,
      name: "Seppo AI OÜ",
      invoice_vat_no: "EE102809963",
      code: "17133416",
    });
    const realSupplier = makeClient({
      id: 200,
      name: "Anthropic, PBC",
      invoice_vat_no: null,
      code: null,
      cl_code_country: "USA",
    });

    const result = await resolveSupplierInternal(
      stubApi,
      [ownCompany, realSupplier],
      { supplier_vat_no: "EE102809963", supplier_name: "Anthropic, PBC" },
      false,
      { ownCompanyVat: "EE102809963" },
    );

    // VAT match against ourselves is blocked, but a name match still
    // resolves the legitimate supplier (here via the normalized-name
    // tier — both names reduce to "anthropic"). self_match_blocked is
    // intentionally NOT set on found:true returns: the returned client
    // is not suspect. The own-VAT-on-page note is surfaced separately
    // at the receipt-inbox layer via detectSelfVatOnly.
    expect(result.found).toBe(true);
    expect(result.match_type).toBe("name_normalized");
    expect(result.client?.id).toBe(200);
    expect(result.self_match_blocked).toBeUndefined();
  });

  it("returns found=false with self_match_blocked when only the active company exists and VAT matches", async () => {
    const ownCompany = makeClient({
      id: 100,
      name: "Seppo AI OÜ",
      invoice_vat_no: "EE102809963",
      code: "17133416",
    });

    const result = await resolveSupplierInternal(
      stubApi,
      [ownCompany],
      { supplier_vat_no: "EE102809963" },
      false,
      { ownCompanyVat: "EE102809963" },
    );

    expect(result.found).toBe(false);
    expect(result.self_match_blocked).toBe(true);
    expect(result.client?.id).not.toBe(100);
  });

  it("refuses to return the active company when matched by registry code", async () => {
    const ownCompany = makeClient({
      id: 100,
      name: "Seppo AI OÜ",
      invoice_vat_no: "EE102809963",
      code: "17133416",
    });

    const result = await resolveSupplierInternal(
      stubApi,
      [ownCompany],
      { supplier_reg_code: "17133416", supplier_name: "Seppo AI OÜ" },
      false,
      { ownCompanyVat: "EE102809963" },
    );

    expect(result.found).toBe(false);
    expect(result.self_match_blocked).toBe(true);
    expect(result.client?.id).not.toBe(100);
  });

  it("excludes the active company from fuzzy-name candidates so it cannot be picked", async () => {
    const ownCompany = makeClient({
      id: 100,
      name: "Seppo AI OÜ",
      invoice_vat_no: "EE102809963",
      code: "17133416",
    });

    const result = await resolveSupplierInternal(
      stubApi,
      [ownCompany],
      { supplier_name: "Seppo AI OÜ" },
      false,
      { ownCompanyVat: "EE102809963" },
    );

    // No other clients to match → fuzzy match is filtered out, no fallback
    // creation happens (no name in registry, no reg_code) → not found.
    expect(result.found).toBe(false);
    expect(result.client).toBeUndefined();
  });

  it("clears the buyer's own VAT from the previewed new client (cannot persist as a duplicate of self)", async () => {
    const ownCompany = makeClient({
      id: 100,
      name: "Seppo AI OÜ",
      invoice_vat_no: "EE102809963",
    });

    const result = await resolveSupplierInternal(
      stubApi,
      [ownCompany],
      {
        supplier_name: "Anthropic, PBC",
        supplier_vat_no: "EE102809963",
      },
      false, // dry run — must not call api.clients.create
      { ownCompanyVat: "EE102809963" },
    );

    expect(result.found).toBe(false);
    expect(result.preview_client?.name).toBe("Anthropic, PBC");
    // Critical: the previewed new client must not carry the buyer's own VAT.
    expect(result.preview_client?.invoice_vat_no).toBeUndefined();
  });

  it("normalizes whitespace and case when comparing ownCompanyVat", async () => {
    const ownCompany = makeClient({
      id: 100,
      invoice_vat_no: "EE102809963",
    });

    const result = await resolveSupplierInternal(
      stubApi,
      [ownCompany],
      { supplier_vat_no: "ee 102 809 963" },
      false,
      { ownCompanyVat: "EE102809963" },
    );

    expect(result.found).toBe(false);
    expect(result.self_match_blocked).toBe(true);
  });

  it("falls through to the fuzzy tier when the normalized name matches multiple clients (ambiguity bail-out)", async () => {
    // Two real clients normalize to the same key — picking one
    // arbitrarily would silently miscode the invoice. The new tier must
    // refuse to choose; the fuzzy tier's stricter inclusion check then
    // either picks the right one or leaves the supplier unresolved.
    const ownCompany = makeClient({
      id: 100,
      name: "Seppo AI OÜ",
      invoice_vat_no: "EE102809963",
    });
    const apple = makeClient({ id: 200, name: "Apple", cl_code_country: "USA" });
    const appleLp = makeClient({ id: 201, name: "Apple LP", cl_code_country: "USA" });

    const result = await resolveSupplierInternal(
      stubApi,
      [ownCompany, apple, appleLp],
      { supplier_name: "Apple" },
      false,
      { ownCompanyVat: "EE102809963" },
    );

    // Fuzzy tier picks the literal "Apple" (distance 0). The important
    // assertion is that match_type is NOT "name_normalized" — the new
    // tier refused to pick on its own.
    expect(result.match_type).not.toBe("name_normalized");
    expect(result.found).toBe(true);
    expect(result.client?.id).toBe(200);
  });

  it("does not use the normalized-name tier when the normalized key is shorter than 4 chars", async () => {
    // Floor mirrors the fuzzy tier's shorterLen >= 4 check so a
    // single common short word like "abc" can't bridge unrelated
    // suppliers. With a 3-char key, fuzzy is the only valid path.
    const ownCompany = makeClient({ id: 100, invoice_vat_no: "EE102809963" });
    const abcShort = makeClient({ id: 200, name: "ABC", cl_code_country: "USA" });

    const result = await resolveSupplierInternal(
      stubApi,
      [ownCompany, abcShort],
      { supplier_name: "ABC" },
      false,
      { ownCompanyVat: "EE102809963" },
    );

    // ABC ↔ ABC still matches via the fuzzy tier (distance 0,
    // similarity 1.0, but shorterLen 3 < 4 → fuzzy ALSO refuses) so
    // resolution falls through to "not found" / preview.
    expect(result.match_type).not.toBe("name_normalized");
    expect(result.found).toBe(false);
  });

  it("resolves to an existing client by normalized name when only the legal-form suffix differs", async () => {
    // The Anthropic case from PR #21: existing client is named just
    // "Anthropic"; the new invoice's supplier_name is "Anthropic, PBC".
    // Without the normalized-name tier, the fuzzy threshold (0.7) rejects
    // this pair (~0.62) and supplier_history misses 3 prior bookings.
    const ownCompany = makeClient({
      id: 100,
      name: "Seppo AI OÜ",
      invoice_vat_no: "EE102809963",
    });
    const anthropic = makeClient({
      id: 200,
      name: "Anthropic",
      invoice_vat_no: null,
      cl_code_country: "USA",
    });

    const result = await resolveSupplierInternal(
      stubApi,
      [ownCompany, anthropic],
      { supplier_name: "Anthropic, PBC" },
      false,
      { ownCompanyVat: "EE102809963" },
    );

    expect(result.found).toBe(true);
    expect(result.match_type).toBe("name_normalized");
    expect(result.client?.id).toBe(200);
  });

  it("still resolves a real supplier when only the supplier's VAT is provided", async () => {
    const ownCompany = makeClient({
      id: 100,
      invoice_vat_no: "EE102809963",
    });
    const openai = makeClient({
      id: 200,
      name: "OpenAI OpCo, LLC",
      invoice_vat_no: "EU372041333",
      cl_code_country: "USA",
    });

    const result = await resolveSupplierInternal(
      stubApi,
      [ownCompany, openai],
      { supplier_vat_no: "EU372041333" },
      false,
      { ownCompanyVat: "EE102809963" },
    );

    expect(result.found).toBe(true);
    expect(result.match_type).toBe("vat_no");
    expect(result.client?.id).toBe(200);
    expect(result.self_match_blocked).toBeUndefined();
  });
});
