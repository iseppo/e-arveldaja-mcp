import { describe, expect, it } from "vitest";
import type { Client } from "../types/api.js";
import {
  matchSupplier,
  resolveSupplierDefault,
  type SupplierMatchOutcome,
} from "./supplier-default-resolution.js";

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

describe("matchSupplier — extracted pure match-decision core", () => {
  it("returns a registry_code match", () => {
    const outcome = matchSupplier(
      [makeClient({ id: 400, name: "Registry Co", code: "16899999" })],
      { supplier_reg_code: "16899999" },
    );
    expect(outcome.kind).toBe("matched");
    if (outcome.kind === "matched") {
      expect(outcome.match_type).toBe("registry_code");
      expect(outcome.client.id).toBe(400);
    }
  });

  it("self-match guard (#14): own-VAT match is blocked, no match returned", () => {
    const own = makeClient({ id: 100, name: "Seppo AI OÜ", invoice_vat_no: "EE102809963", code: "17133416" });
    const outcome = matchSupplier(
      [own],
      { supplier_vat_no: "EE102809963" },
      { ownCompanyVat: "EE102809963" },
    );
    expect(outcome.kind).toBe("no_match");
    if (outcome.kind === "no_match") expect(outcome.selfMatchBlocked).toBe(true);
  });

  it("H13 strong-identifier conflict vetoes a name match", () => {
    const outcome = matchSupplier(
      [makeClient({ id: 1, name: "Acme OÜ", code: "12345678" })],
      { supplier_name: "Acme OÜ", supplier_reg_code: "87654321" },
    );
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind === "conflict") expect(typeof outcome.reason).toBe("string");
  });

  it("tied normalized name never picked — falls through (no match here)", () => {
    const apple = makeClient({ id: 200, name: "Apple Corp", cl_code_country: "USA" });
    const appleLp = makeClient({ id: 201, name: "Apple Corp", cl_code_country: "USA" });
    const outcome = matchSupplier(
      [apple, appleLp],
      { supplier_name: "Apple Corp Widgets Unlimited" },
    );
    // normalized tie → fuzzy fails inclusion → no match. Crucially not a
    // silent pick of one of the two.
    expect(outcome.kind).not.toBe("matched");
  });

  it("resolves normalized-name uniquely when only the legal-form suffix differs", () => {
    const outcome = matchSupplier(
      [makeClient({ id: 200, name: "Anthropic", cl_code_country: "USA" })],
      { supplier_name: "Anthropic, PBC" },
    );
    expect(outcome.kind).toBe("matched");
    if (outcome.kind === "matched") {
      expect(outcome.match_type).toBe("name_normalized");
      expect(outcome.client.id).toBe(200);
    }
  });

  it("strips OCR sandbox markers before matching (write/match boundary)", () => {
    const nonce = "deadbeef";
    const wrap = (s: string) => `<<UNTRUSTED_OCR_START:${nonce}>>\n${s}\n<<UNTRUSTED_OCR_END:${nonce}>>`;
    const supplier = makeClient({ id: 300, name: "Fragmented Tools OÜ", cl_code_country: "USA" });
    const outcome = matchSupplier(
      [supplier],
      { supplier_name: wrap("Fragmented Tools OÜ") },
    );
    expect(outcome.kind).toBe("matched");
    if (outcome.kind === "matched") expect(outcome.client.id).toBe(300);
    // the canonical fields carry no marker
    if (outcome.kind === "no_match") expect(outcome.canonicalFields.supplier_name).not.toContain("UNTRUSTED_OCR");
  });
});

describe("resolveSupplierDefault — Resolution<SupplierRef> view", () => {
  it("resolved when a supplier matches", () => {
    const r = resolveSupplierDefault(
      [makeClient({ id: 400, name: "Registry Co", code: "16899999" })],
      { supplier_reg_code: "16899999" },
    );
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.value.client.id).toBe(400);
      expect(r.evidence.map(e => e.tag)).toContain("registry_code");
    }
  });

  it("ambiguous (manual review) on a strong-identifier conflict", () => {
    const r = resolveSupplierDefault(
      [makeClient({ id: 1, name: "Acme OÜ", code: "12345678" })],
      { supplier_name: "Acme OÜ", supplier_reg_code: "87654321" },
    );
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") expect(r.question.toLowerCase()).toContain("manual");
  });

  it("not_found when nothing matches", () => {
    const r = resolveSupplierDefault(
      [makeClient({ id: 1, name: "Totally Different GmbH" })],
      { supplier_name: "Nonexistent Vendor LLC" },
    );
    expect(r.status).toBe("not_found");
  });

  it("ambiguous when a self-match was blocked (suspect, needs manual resolution)", () => {
    const own = makeClient({ id: 100, name: "Seppo AI OÜ", invoice_vat_no: "EE102809963" });
    const r = resolveSupplierDefault(
      [own],
      { supplier_vat_no: "EE102809963" },
      { ownCompanyVat: "EE102809963" },
    );
    expect(r.status).toBe("ambiguous");
  });
});
