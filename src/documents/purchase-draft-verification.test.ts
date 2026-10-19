import { describe, expect, it } from "vitest";
import { draftFingerprint, draftReadbackMismatches } from "./purchase-draft-verification.js";
import { draftFingerprint as readingFingerprint, draftReadbackMismatches as readingMismatches } from "./reading-operations.js";

describe("shared purchase draft evidence", () => {
  const model: any = { clients_id: 42, number: "A-1", create_date: "2026-03-15", cl_currencies_id: "EUR", items: [{ custom_title: "Teenus", purchase_accounts_id: 5000, total_net_price: 100, vat_rate_dropdown: "24" }] };
  const draft: any = { ...model, id: 7, status: "PROJECT", net_price: 100, vat_price: 24, gross_price: 124,
    base_net_price: 100, base_vat_price: 24, base_gross_price: 124,
    items: [{ ...model.items[0], amount: 1, cl_fringe_benefits_id: 1, vat_amount: 24, vat_rate: 24, base_total_net_price: 100 }] };

  it("reading compatibility exports use exactly the shared evidence functions", () => {
    expect(readingFingerprint).toBe(draftFingerprint);
    expect(readingMismatches).toBe(draftReadbackMismatches);
    expect(draftReadbackMismatches(draft, model, { vatPrice: 24, grossPrice: 124 }, true)).toEqual([]);
  });

  it.each(["client_name", "cash_accounts_id", "cash_accounts_dimensions_id", "ref_number", "notes", "unknown_posting_field"])("new %s is material at registration", field => {
    expect(draftFingerprint({ ...draft, [field]: "changed" })).not.toBe(draftFingerprint(draft));
  });

  it("omitted expected money and unknown readback fields fail closed", () => {
    const incomplete = structuredClone(draft); delete incomplete.base_gross_price;
    expect(draftReadbackMismatches(incomplete, model, { vatPrice: 24, grossPrice: 124 }, true)).toContain("base_gross_price");
    expect(draftReadbackMismatches({ ...draft, unknown_posting_field: 1 }, model, { vatPrice: 24, grossPrice: 124 }, true)).toContain("unknown_posting_field");
  });

  it("document text remains exact while numeric readbacks allow numeric strings", () => {
    expect(draftReadbackMismatches({ ...draft, gross_price: "124.00" } as any, model, { vatPrice: 24, grossPrice: 124 }, true)).toEqual([]);
    expect(draftReadbackMismatches({ ...draft, number: "01" }, { ...model, number: "1" }, { vatPrice: 24, grossPrice: 124 }, true)).toContain("number");
  });
});
