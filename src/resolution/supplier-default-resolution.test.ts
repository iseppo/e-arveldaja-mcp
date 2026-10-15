import { describe, expect, it } from "vitest";
import type { Client } from "../types/api.js";
import { normalizeCompanyName } from "../company-name.js";
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

  it("resolves an OCR name carrying a social handle (live: 'Anthropic, PBC @anthropic')", () => {
    const outcome = matchSupplier(
      [makeClient({ id: 2010417, name: "Anthropic", cl_code_country: "USA" })],
      { supplier_name: "Anthropic, PBC @anthropic", supplier_vat_no: "IE4276970QH" },
    );
    expect(outcome.kind).toBe("matched");
    if (outcome.kind === "matched") {
      expect(outcome.match_type).toBe("name_normalized");
      expect(outcome.client.id).toBe(2010417);
    }
  });

  it("a handle-only OCR name never matches through the normalized tier", () => {
    const outcome = matchSupplier(
      [makeClient({ id: 1, name: "Acme OÜ" }), makeClient({ id: 2, name: "Beta AS" })],
      { supplier_name: "@acme" },
    );
    expect(outcome.kind).not.toBe("matched");
  });

  it("a handle neither breaks nor blocks a legal-form tie: the name decides as if printed bare (R-S7)", () => {
    const clients = [makeClient({ id: 1, name: "Acme OÜ" }), makeClient({ id: 2, name: "Acme AS" })];
    // The literal "Acme OÜ" breaks the tie, with or without the handle.
    for (const supplier_name of ["Acme OÜ", "Acme OÜ @acme"]) {
      const outcome = matchSupplier(clients, { supplier_name });
      expect(outcome.kind, supplier_name).toBe("matched");
      if (outcome.kind === "matched") expect(outcome.client.id, supplier_name).toBe(1);
    }
    // No literal match: still ambiguous.
    expect(matchSupplier(clients, { supplier_name: "Acme @acme" }).kind).toBe("ambiguous");
  });

  it("strips the handle in the fuzzy tier too (R-S7)", () => {
    const outcome = matchSupplier(
      [makeClient({ id: 7, name: "Anthropic Labs EU", cl_code_country: "USA" })],
      { supplier_name: "Anthropic Labs @anthropic" },
    );
    expect(outcome.kind).toBe("matched");
    if (outcome.kind === "matched") {
      expect(outcome.match_type).toBe("name_fuzzy");
      expect(outcome.client.id).toBe(7);
    }
  });

  it("a bare \"@\" is part of the name, and handle-only names match no tier", () => {
    const outcome = matchSupplier([makeClient({ id: 8, name: "Foo @ Bar OÜ" })], { supplier_name: "Foo @ Bar OÜ" });
    expect(outcome.kind).toBe("matched");
    if (outcome.kind === "matched") expect(outcome.client.id).toBe(8);
    expect(matchSupplier([makeClient({ id: 9, name: "Anthropic" })], { supplier_name: "@anthropic" }).kind).toBe("no_match");
  });

  it("the shared company-name key (auto-booking rule keys) keeps the handle: only matching strips it", () => {
    expect(normalizeCompanyName("Anthropic, PBC @anthropic")).not.toBe(normalizeCompanyName("Anthropic, PBC"));
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

describe("supplier name ties are ambiguous, never first-wins (finding 9)", () => {
  it("returns ambiguous when two active clients normalize to the supplier name and neither is a literal match", () => {
    const clients = [makeClient({ id: 1, name: "Apple" }), makeClient({ id: 2, name: "Apple LP" })];
    const outcome = matchSupplier(clients, { supplier_name: "Apple Inc" });
    expect(outcome.kind).toBe("ambiguous");
    expect(resolveSupplierDefault(clients, { supplier_name: "Apple Inc" }).status).toBe("ambiguous");
  });

  it("returns ambiguous for two clients with the identical name (equal fuzzy score)", () => {
    const clients = [makeClient({ id: 1, name: "Some Vendor Ltd" }), makeClient({ id: 2, name: "Some Vendor Ltd" })];
    expect(matchSupplier(clients, { supplier_name: "Some Vendor Ltd" }).kind).toBe("ambiguous");
  });

  it("returns ambiguous when two different names tie at the best fuzzy distance", () => {
    const clients = [makeClient({ id: 1, name: "Nordic Tradex" }), makeClient({ id: 2, name: "Nordic Tradey" })];
    expect(matchSupplier(clients, { supplier_name: "Nordic Trade" }).kind).toBe("ambiguous");
  });

  it("matches a registry code despite surrounding whitespace on the stored client code", () => {
    const clients = [makeClient({ id: 7, name: "Coded OÜ", code: " 12345678 " })];
    const outcome = matchSupplier(clients, { supplier_reg_code: "12345678" });
    expect(outcome).toMatchObject({ kind: "matched", match_type: "registry_code" });
  });
});

describe("matchSupplier — strict legal-identity tier (WP5 A5)", () => {
  it("matches a spelled-out legal form to its abbreviation", () => {
    const outcome = matchSupplier(
      [makeClient({ id: 11, name: "Mittetulundusühing Näidisselts" })],
      { supplier_name: "MTÜ Näidisselts" },
    );
    expect(outcome).toMatchObject({ kind: "matched", client: { id: 11 } });
  });

  it("two clients of the same legal identity are terminal: the relaxed tiers are not reached", () => {
    const outcome = matchSupplier(
      [
        makeClient({ id: 11, name: "Mittetulundusühing Näidisselts" }),
        makeClient({ id: 12, name: "MTÜ Näidisselts" }),
      ],
      { supplier_name: "MTÜ Näidisselts" },
    );
    // The literal-name tie-break of the relaxed tiers would have picked id 12.
    expect(outcome.kind).toBe("ambiguous");
  });

  it("a deleted or own-company twin is ignored", () => {
    const outcome = matchSupplier(
      [
        makeClient({ id: 11, name: "Mittetulundusühing Näidisselts" }),
        makeClient({ id: 12, name: "MTÜ Näidisselts", is_deleted: true }),
        makeClient({ id: 13, name: "Näidisselts MTÜ", code: "80000001" }),
      ],
      { supplier_name: "MTÜ Näidisselts" },
      { ownCompanyRegistryCode: "80000001" },
    );
    expect(outcome).toMatchObject({ kind: "matched", client: { id: 11 } });
  });

  it("a strict match whose registry code contradicts the invoice's is a conflict", () => {
    const outcome = matchSupplier(
      [makeClient({ id: 11, name: "Mittetulundusühing Näidisselts", code: "80000002" })],
      { supplier_name: "MTÜ Näidisselts", supplier_reg_code: "80000003" },
    );
    expect(outcome.kind).toBe("conflict");
  });
});
