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

  it("accepts the API clearing the VAT account and article on a 0% row, and nothing wider", () => {
    const zeroModel = { ...model, items: [{ custom_title: "Workspace", purchase_accounts_id: 5140, total_net_price: 13.6, vat_rate_dropdown: "0", reversed_vat_id: 1, vat_accounts_id: 1510, cl_vat_articles_id: 1 }] };
    const zeroDraft = { ...zeroModel, id: 8, status: "PROJECT", net_price: 13.6, vat_price: 0, gross_price: 13.6, base_net_price: 13.6, base_vat_price: 0, base_gross_price: 13.6,
      items: [{ ...zeroModel.items[0], amount: 1, cl_fringe_benefits_id: 1, vat_amount: 0, vat_rate: 0, base_total_net_price: 13.6, vat_accounts_id: null, cl_vat_articles_id: null }] };
    const totals = { vatPrice: 0, grossPrice: 13.6 };
    expect(draftReadbackMismatches(zeroDraft, zeroModel, totals, true)).toEqual([]);
    // Only both cleared together, only at 0%, only for a VAT-registered company.
    expect(draftReadbackMismatches({ ...zeroDraft, items: [{ ...zeroDraft.items[0], cl_vat_articles_id: 2 }] }, zeroModel, totals, true)).toContain("items[0].cl_vat_articles_id");
    expect(draftReadbackMismatches({ ...zeroDraft, items: [{ ...zeroDraft.items[0], vat_accounts_id: 1520 }] }, zeroModel, totals, true)).toContain("items[0].vat_accounts_id");
    const at24 = { ...model, items: [{ ...model.items[0], vat_accounts_id: 1510, cl_vat_articles_id: 1 }] };
    const at24Draft = { ...draft, items: [{ ...draft.items[0], vat_accounts_id: null, cl_vat_articles_id: null }] };
    expect(draftReadbackMismatches(at24Draft, at24, { vatPrice: 24, grossPrice: 124 }, true)).toEqual(expect.arrayContaining(["items[0].vat_accounts_id", "items[0].cl_vat_articles_id"]));
  });

  it("accepts the API ignoring the last row's VAT residue on a VAT-registered invoice, and nothing wider", () => {
    // Live 2026-10-28 (Tele2): net 483.07 at 24% is 115.94; the invoice prints VAT 115.93.
    const residueModel = { ...model, items: [{ ...model.items[0], total_net_price: 483.07 }] };
    const totals = { vatPrice: 115.93, grossPrice: 599 };
    const header = { net_price: 483.07, vat_price: 115.93, gross_price: 599, base_net_price: 483.07, base_vat_price: 115.93, base_gross_price: 599 };
    const row = { ...draft.items[0], total_net_price: 483.07, base_total_net_price: 483.07 };
    const ignored = { ...draft, ...header, items: [{ ...row, vat_amount: 115.94, project_no_vat_gross_price: null }] };
    const absorbed = { ...draft, ...header, items: [{ ...row, vat_amount: 115.93, project_no_vat_gross_price: 599 }] };
    expect(draftReadbackMismatches(absorbed, residueModel, totals, true)).toEqual([]);
    expect(draftReadbackMismatches(ignored, residueModel, totals, true)).toEqual([]);
    // The invoice VAT must still be the approved one, and the row VAT exactly net × rate.
    expect(draftReadbackMismatches({ ...ignored, vat_price: 115.94 }, residueModel, totals, true)).toContain("vat_price");
    expect(draftReadbackMismatches({ ...ignored, items: [{ ...ignored.items[0], vat_amount: 115.95 }] }, residueModel, totals, true)).toContain("items[0].vat_amount");
    // Without a residue there is nothing to ignore.
    expect(draftReadbackMismatches({ ...draft, items: [{ ...draft.items[0], vat_amount: 24.01 }] }, model, { vatPrice: 24, grossPrice: 124 }, true)).toContain("items[0].vat_amount");
    // A reverse-charge row skips the totals tolerance upstream: a gap wider than one cent per line is never a residue.
    const reverseModel = { ...model, items: [{ ...model.items[0], reversed_vat_id: 1, total_net_price: 100 }] };
    const reverseDraft = { ...draft, vat_price: 0, gross_price: 100, base_vat_price: 0, base_gross_price: 100, items: [{ ...draft.items[0], reversed_vat_id: 1, vat_amount: 24, project_no_vat_gross_price: null }] };
    expect(draftReadbackMismatches(reverseDraft, reverseModel, { vatPrice: 0, grossPrice: 100 }, true)).toContain("items[0].vat_amount");
    // Only a VAT-registered company: the same readback shape on a non-VAT company is a mismatch.
    expect(draftReadbackMismatches(ignored, residueModel, totals, false)).not.toEqual([]);
    // Only the last row: a first row reading the same shape is still compared normally.
    const twoModel = { ...residueModel, items: [{ ...model.items[0], total_net_price: 100 }, { ...model.items[0], total_net_price: 483.07 }] };
    const twoTotals = { vatPrice: 139.93, grossPrice: 723 };
    const twoHeader = { net_price: 583.07, vat_price: 139.93, gross_price: 723, base_net_price: 583.07, base_vat_price: 139.93, base_gross_price: 723 };
    const first = { ...draft.items[0], total_net_price: 100, base_total_net_price: 100, vat_amount: 24, project_no_vat_gross_price: null };
    const twoDraft = { ...draft, ...twoHeader, items: [first, { ...row, vat_amount: 115.94, project_no_vat_gross_price: null }] };
    expect(draftReadbackMismatches(twoDraft, twoModel, twoTotals, true)).toEqual([]);
    expect(draftReadbackMismatches({ ...twoDraft, items: [{ ...first, vat_amount: 24.01 }, twoDraft.items[1]] }, twoModel, twoTotals, true)).toEqual(["items[0].vat_amount"]);
  });
});
