import { describe, expect, it, vi } from "vitest";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../bank-posting-duplicate-guard.js", () => ({
  checkIntakeCashDuplicates: vi.fn().mockResolvedValue({ scan_available: true, suspects: [] }),
  formatDuplicatePostingWarnings: vi.fn().mockReturnValue([]),
}));

import { createAndMaybeMatchPurchaseInvoice, resolveReceiptVatRateDropdown } from "./receipt-inbox-booking.js";
import { sha256Hex } from "./receipt-inbox-files.js";

const file = {
  name: "Telia arve 2026-08 SECRET-FILENAME.pdf",
  path: "/tmp/receipts/telia.pdf",
  extension: ".pdf",
  file_type: "pdf",
  size_bytes: 100,
  modified_at: "2026-08-10T00:00:00.000Z",
} as any;

function snapshot() {
  const bytes = Buffer.from("pdf-bytes");
  return { file, relative_path: file.name, sha256: sha256Hex(bytes), bytes, snapshot_path: file.path };
}

const supplierResolution = {
  found: true,
  created: false,
  match_type: "exact_name",
  client: { id: 7, name: "Telia Eesti AS", is_supplier: true, is_client: false, cl_code_country: "EST", is_member: false, send_invoice_to_email: false, send_invoice_to_accounting_email: false, is_deleted: false },
} as any;

const context = { clients: [], purchaseInvoices: [], purchaseArticlesWithVat: [], accounts: [], isVatRegistered: true } as any;

function extracted(overrides: Record<string, unknown> = {}) {
  return {
    supplier_name: "Telia Eesti AS",
    invoice_number: "T-100",
    invoice_date: "2026-08-10",
    total_net: 100,
    total_vat: 24,
    total_gross: 124,
    currency: "EUR",
    description: "Mobile service",
    ...overrides,
  } as any;
}

function makeApi() {
  const createAndSetTotals = vi.fn().mockResolvedValue({ id: 900, number: "T-100", status: "PROJECT", clients_id: 7, client_name: "Telia Eesti AS", create_date: "2026-08-10", gross_price: 124 });
  return {
    api: { purchaseInvoices: { createAndSetTotals, uploadDocument: vi.fn().mockResolvedValue({}), invalidate: vi.fn() } } as any,
    createAndSetTotals,
  };
}

async function run(extractedFields: any, suggestionItem: Record<string, unknown>, mode: "create" | "dry_run" = "create") {
  const { api, createAndSetTotals } = makeApi();
  const result = await createAndMaybeMatchPurchaseInvoice(
    api, context, snapshot() as any, extractedFields, supplierResolution,
    { source: "keyword_match", item: { cl_purchase_articles_id: 1, purchase_accounts_id: 5230, custom_title: "x", amount: 1, ...suggestionItem } } as any,
    [], mode, false, new Set(),
  );
  return { result, createAndSetTotals };
}

describe("receipt inbox booking — notes never carry the source filename (finding 12)", () => {
  it("creates the invoice with notes that do not contain the file name", async () => {
    const { result, createAndSetTotals } = await run(extracted(), {});
    expect(result.status).toBe("created");
    const data = createAndSetTotals.mock.calls[0]![0];
    expect(String(data.notes ?? "")).not.toContain(file.name);
    expect(String(data.notes ?? "")).not.toContain("SECRET-FILENAME");
  });
});

describe("receipt inbox booking — VAT rate from extracted totals and date (findings 3/4)", () => {
  it("keyword path (no history rate): books the standard rate implied by VAT/net, not '-'", async () => {
    const { createAndSetTotals } = await run(extracted(), {});
    expect(createAndSetTotals.mock.calls[0]![0].items[0].vat_rate_dropdown).toBe("24");
  });

  it("history rate 22 on a 24% receipt dated after 1.07.2025 books 24", async () => {
    const { createAndSetTotals } = await run(extracted(), { vat_rate_dropdown: "22" });
    expect(createAndSetTotals.mock.calls[0]![0].items[0].vat_rate_dropdown).toBe("24");
  });

  it("snaps to a valid reduced rate (9%)", async () => {
    const { createAndSetTotals } = await run(extracted({ total_vat: 9, total_gross: 109 }), {});
    expect(createAndSetTotals.mock.calls[0]![0].items[0].vat_rate_dropdown).toBe("9");
  });

  it("routes a VAT/net ratio that matches no valid rate to review without creating", async () => {
    const { result, createAndSetTotals } = await run(extracted({ total_vat: 17, total_gross: 117 }), {});
    expect(result.status).toBe("needs_review");
    expect(createAndSetTotals).not.toHaveBeenCalled();
    expect(result.notes.join(" ")).toMatch(/implies 17%/);
  });

  it("routes the old 22% rate on a post-2025-07 receipt to review (date-gated)", async () => {
    expect(resolveReceiptVatRateDropdown({ total_vat: 22, invoice_date: "2026-08-10" }, 100, {}).review).toBeDefined();
    expect(resolveReceiptVatRateDropdown({ total_vat: 22, invoice_date: "2025-03-10" }, 100, {}).rate).toBe("22");
  });

  it("reverse charge with total_vat 0 keeps the history rate instead of '-'", async () => {
    const { createAndSetTotals } = await run(extracted({ total_vat: 0, total_gross: 100 }), { vat_rate_dropdown: "24", reversed_vat_id: 1 });
    expect(createAndSetTotals.mock.calls[0]![0].items[0].vat_rate_dropdown).toBe("24");
  });

  it("reverse charge with total_vat 0 and no numeric history rate uses the standard rate on the invoice date", () => {
    expect(resolveReceiptVatRateDropdown({ total_vat: 0, invoice_date: "2025-03-10" }, 100, { vat_rate_dropdown: "-", reversed_vat_id: 1 }).rate).toBe("22");
    expect(resolveReceiptVatRateDropdown({ total_vat: 0, invoice_date: "2025-03-10" }, 100, { vat_rate_dropdown: "-" }).rate).toBe("-");
  });

  it("reverse charge replaces a stale history standard rate with the standard rate on the invoice date", () => {
    expect(resolveReceiptVatRateDropdown({ total_vat: 0, invoice_date: "2026-03-10" }, 100, { vat_rate_dropdown: "22", reversed_vat_id: 1 }))
      .toEqual({ rate: "24" });
    expect(resolveReceiptVatRateDropdown({ total_vat: 0, invoice_date: "2026-03-10" }, 100, { vat_rate_dropdown: "20", reversed_vat_id: 1 }))
      .toEqual({ rate: "24" });
    expect(resolveReceiptVatRateDropdown({ total_vat: 0, invoice_date: "2024-06-10" }, 100, { vat_rate_dropdown: "24", reversed_vat_id: 1 }))
      .toEqual({ rate: "22" });
  });

  it("reverse charge keeps a history reduced rate in force on the invoice date, else routes to review", () => {
    expect(resolveReceiptVatRateDropdown({ total_vat: 0, invoice_date: "2026-03-10" }, 100, { vat_rate_dropdown: "9", reversed_vat_id: 1 }))
      .toEqual({ rate: "9" });
    expect(resolveReceiptVatRateDropdown({ total_vat: 0, invoice_date: "2024-06-10" }, 100, { vat_rate_dropdown: "13", reversed_vat_id: 1 }).review)
      .toMatch(/13%/);
    expect(resolveReceiptVatRateDropdown({ total_vat: 0, invoice_date: "2026-03-10" }, 100, { vat_rate_dropdown: "5", reversed_vat_id: 1 }).review)
      .toMatch(/5%/);
  });
});

describe("receipt inbox booking — due date before invoice date (MINOR)", () => {
  it("warns that the payment term was clamped to 0", async () => {
    const { result, createAndSetTotals } = await run(extracted({ due_date: "2026-08-01" }), {});
    expect(createAndSetTotals.mock.calls[0]![0].term_days).toBe(0);
    expect(result.notes.join(" ")).toMatch(/precedes invoice date/);
  });
});
