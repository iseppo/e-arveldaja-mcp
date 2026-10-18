// GitHub #63 (plan .omc/plans/issue-63-nondeductible-vat.md rev 6, tests B5–B11): the
// non-deductible VAT form through the real PurchaseInvoicesApi over an HTTP double.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceCreationError, PurchaseInvoiceTotalsCorrectionError, previewPurchaseInvoiceTotals } from "./purchase-invoices.api.js";
import { chart, COST_ACCOUNT, COST_DIMENSION, fakeEarveldaja, nonDeductibleItem, resetApiCaches } from "../__fixtures__/nondeductible-vat.js";

vi.mock("../logger.js", () => ({ log: vi.fn() }));

beforeEach(() => resetApiCaches());

const header = {
  clients_id: 10,
  client_name: "Delfi Meedia AS",
  number: "D-1",
  create_date: "2026-10-01",
  journal_date: "2026-10-01",
  term_days: 0,
  liability_accounts_id: 2310,
  cl_currencies_id: "EUR",
};

/** A net-`net` row at 24% on account `account` (its own VAT account, no dimension unless 7910). */
const row24 = (net: number, account = COST_ACCOUNT, extra: Record<string, unknown> = {}) => nonDeductibleItem({
  purchase_accounts_id: account,
  vat_accounts_id: account,
  ...(account === COST_ACCOUNT ? {} : { purchase_accounts_dimensions_id: undefined, vat_accounts_dimensions_id: undefined }),
  vat_rate_dropdown: "24",
  total_net_price: net,
  ...extra,
});

const data = (items: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({ ...header, ...extra, items }) as never;

async function expectNoPost(promise: Promise<unknown>, fake: ReturnType<typeof fakeEarveldaja>, message: RegExp) {
  await expect(promise).rejects.toThrow(message);
  expect(fake.writes()).toEqual([]);
}

async function expectInvalidated(promise: Promise<unknown>, fake: ReturnType<typeof fakeEarveldaja>, totalsPatches: number) {
  await expect(promise).rejects.toBeInstanceOf(InvoiceCreationError);
  expect(fake.posts()).toHaveLength(1);
  expect(fake.totalsPatches()).toHaveLength(totalsPatches);
  expect(fake.invalidations()).toHaveLength(1);
  expect(fake.registers()).toEqual([]);
}

describe("5. happy path 11.92 @9", () => {
  it("POSTs the row unchanged (no gross override), PATCHes vat_price 1.07 and returns the proven draft", async () => {
    const fake = fakeEarveldaja();
    const created = await fake.purchaseInvoices.createAndSetTotals(data([nonDeductibleItem()]), 1.07, 12.99, false, chart());

    const posted = (fake.posts()[0]!.body as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(posted).toMatchObject({
      purchase_accounts_id: COST_ACCOUNT, purchase_accounts_dimensions_id: COST_DIMENSION,
      vat_accounts_id: COST_ACCOUNT, vat_accounts_dimensions_id: COST_DIMENSION, cl_vat_articles_id: 11, vat_rate_dropdown: "9",
    });
    expect(posted).not.toHaveProperty("project_no_vat_gross_price");
    expect(fake.totalsPatches()).toHaveLength(1);
    expect(fake.totalsPatches()[0]!.body).toMatchObject({ vat_price: 1.07, gross_price: 12.99 });
    expect(created).toMatchObject({ net_price: 11.92, vat_price: 1.07, gross_price: 12.99, status: "PROJECT" });
    expect(fake.invalidations()).toEqual([]);
  });
});

describe("6. P1 refusals before the POST", () => {
  it.each([
    ["gross 13.99 vs 11.92 + 1.07", [nonDeductibleItem()], 1.07, 13.99],
    ["two net-100 @24 rows with invoice VAT 48.02", [row24(100), row24(100, 6000)], 48.02, 248.02],
    ["a last-row residue of 0.02", [row24(100)], 24.02, 124.02],
    ["an override disagreeing with net + VAT", [nonDeductibleItem({ project_no_vat_gross_price: 13.99 })], 1.07, 12.99],
  ])("%s → purchase_totals_mismatch, zero POST", async (_label, items, vat, gross) => {
    const fake = fakeEarveldaja();
    expect(previewPurchaseInvoiceTotals(data(items), vat, gross, false, chart())).toMatchObject({ ok: false, code: "purchase_totals_mismatch" });
    await expectNoPost(fake.purchaseInvoices.createAndSetTotals(data(items), vat, gross, false, chart()), fake, /totals mismatch/);
  });

  it("a non-finite amount is refused with zero POST", async () => {
    const fake = fakeEarveldaja();
    await expect(fake.purchaseInvoices.createAndSetTotals(data([nonDeductibleItem({ total_net_price: Number.NaN })]), 1.07, 12.99, false, chart()))
      .rejects.toThrow();
    expect(fake.writes()).toEqual([]);
  });

  it.each([
    ["no chart", [nonDeductibleItem()], undefined],
    ["a reversed_vat_id", [nonDeductibleItem({ reversed_vat_id: 1 })], chart()],
    ["a 1510 VAT account", [nonDeductibleItem({ vat_accounts_id: 1510, vat_accounts_dimensions_id: undefined })], chart()],
    ["the cost account marked is_vat_account", [nonDeductibleItem()], chart({ costIsVatAccount: true })],
  ])("%s → nonvat_form_unproven, zero POST", async (_label, items, accounts) => {
    const fake = fakeEarveldaja();
    expect(previewPurchaseInvoiceTotals(data(items), 1.07, 12.99, false, accounts)).toMatchObject({ ok: false, code: "nonvat_form_unproven" });
    await expectNoPost(fake.purchaseInvoices.createAndSetTotals(data(items), 1.07, 12.99, false, accounts), fake, /not the proven non-deductible form/);
  });
});

describe("7. P2: the first read-back must be the intended rows", () => {
  const tamper = (change: (items: Array<Record<string, any>>) => Array<Record<string, any>>) =>
    (invoice: Record<string, any>, nth: number) => (nth === 1 ? { ...invoice, items: change(invoice.items) } : invoice);

  it.each([
    ["two rows (50/12 on 7910 and 6000) for one intended 100/24 row", tamper(([row]) => [
      { ...row, total_net_price: 50, vat_amount: 12 },
      { ...row, id: 2, purchase_accounts_id: 6000, vat_accounts_id: 6000, purchase_accounts_dimensions_id: null, vat_accounts_dimensions_id: null, total_net_price: 50, vat_amount: 12 },
    ])],
    ["a changed account", tamper(([row]) => [{ ...row, purchase_accounts_id: 6000 }])],
    ["a changed net", tamper(([row]) => [{ ...row, total_net_price: 90 }])],
    ["a reversed_vat_id", tamper(([row]) => [{ ...row, reversed_vat_id: 1 }])],
    ["a substituted row base net", tamper(([row]) => [{ ...row, base_total_net_price: 150 }])],
    ["an inconsistent row VAT", tamper(([row]) => [{ ...row, vat_amount: 20 }])],
    ["a conflicting row gross override", tamper(([row]) => [{ ...row, project_no_vat_gross_price: 130 }])],
  ])("%s → draft invalidated, zero totals PATCH", async (_label, onGet) => {
    const fake = fakeEarveldaja({ onGet });
    await expectInvalidated(fake.purchaseInvoices.createAndSetTotals(data([row24(100)]), 24, 124, false, chart()), fake, 0);
  });
});

describe("7b. a supplied item vat_amount is refused for this form (zero POST)", () => {
  it.each([
    ["net 100 @24 with vat_amount 20 (header 24 / 124)", [row24(100, COST_ACCOUNT, { vat_amount: 20 })], 24, 124],
    ["credit note net −100 with vat_amount −20 (header −24 / −124)", [row24(-100, COST_ACCOUNT, { vat_amount: -20 })], -24, -124],
    ["residue variant: vat_amount 24.01 with header VAT 24.01", [row24(100, COST_ACCOUNT, { vat_amount: 24.01 })], 24.01, 124.01],
  ])("%s", async (_label, items, vat, gross) => {
    const fake = fakeEarveldaja();
    await expectNoPost(fake.purchaseInvoices.createAndSetTotals(data(items), vat, gross, false, chart()), fake, /vat_amount must not be supplied/);
  });
});

describe("8. P3: the stored draft after the PATCH must be the intended one, proven", () => {
  const afterPatch = (change: (invoice: Record<string, any>) => Record<string, any>) =>
    (invoice: Record<string, any>, nth: number) => (nth === 2 ? change(invoice) : invoice);
  const rowsChanged = (change: (row: Record<string, any>, index: number) => Record<string, any>) =>
    afterPatch((invoice) => ({ ...invoice, items: invoice.items.map(change) }));

  it.each([
    ["vat_price read back as 0", afterPatch((invoice) => ({ ...invoice, vat_price: 0, gross_price: 100 }))],
    ["a changed VAT account", rowsChanged((row) => ({ ...row, vat_accounts_id: 1510 }))],
    ["a changed VAT dimension", rowsChanged((row) => ({ ...row, vat_accounts_dimensions_id: 1 }))],
    ["a changed rate", rowsChanged((row) => ({ ...row, vat_rate_dropdown: "22" }))],
    ["reversed_vat_id introduced", rowsChanged((row) => ({ ...row, reversed_vat_id: 1 }))],
    ["a conflicting project_no_vat_gross_price", rowsChanged((row) => ({ ...row, project_no_vat_gross_price: 130 }))],
  ])("%s → draft invalidated", async (_label, onGet) => {
    const fake = fakeEarveldaja({ onGet });
    await expectInvalidated(fake.purchaseInvoices.createAndSetTotals(data([row24(100)]), 24, 124, false, chart()), fake, 1);
  });

  it("a VAT 24.01 / 23.99 redistribution between two rows → draft invalidated", async () => {
    const fake = fakeEarveldaja({
      onGet: rowsChanged((row, index) => ({ ...row, vat_amount: index === 0 ? 24.01 : 23.99 })),
    });
    await expectInvalidated(fake.purchaseInvoices.createAndSetTotals(data([row24(100), row24(100, 6000)]), 48, 248, false, chart()), fake, 1);
  });
});

describe("9a. row base net (EUR rows)", () => {
  const baseSwap = (row: Record<string, any>, index: number) => ({ ...row, base_total_net_price: index === 0 ? 150 : 50 });

  it("a read-back with row base nets 150 / 50 for nets 100 / 100 (header unchanged) → P3 rejects", async () => {
    const fake = fakeEarveldaja({
      onGet: (invoice, nth) => (nth === 2 ? { ...invoice, items: invoice.items.map(baseSwap) } : invoice),
    });
    await expectInvalidated(fake.purchaseInvoices.createAndSetTotals(data([row24(100), row24(100, 6000)]), 48, 248, false, chart()), fake, 1);
  });

  it("the same stored draft at confirm → P4 holds, zero register", async () => {
    const fake = fakeEarveldaja();
    const id = fake.seed({ ...header, vat_price: 48, gross_price: 248 }, [row24(100), row24(100, 6000)].map(baseSwap));
    await expect(fake.purchaseInvoices.confirmWithTotals(id, false, { accounts: chart() }))
      .rejects.toMatchObject({ code: "correction_nonvat_form_unproven" });
    expect(fake.registers()).toEqual([]);
  });
});

describe("10. P4 before register (confirmWithTotals)", () => {
  const proven = (fake: ReturnType<typeof fakeEarveldaja>) => fake.seed({ ...header, vat_price: 1.07, gross_price: 12.99 }, [nonDeductibleItem()]);

  it("registers a proven draft", async () => {
    const fake = fakeEarveldaja();
    const id = proven(fake);
    await fake.purchaseInvoices.confirmWithTotals(id, false, { accounts: chart() });
    expect(fake.registers()).toHaveLength(1);
    expect(fake.totalsPatches()).toEqual([]);
  });

  it.each([
    ["a 1510 VAT account", (fake: ReturnType<typeof fakeEarveldaja>) =>
      fake.seed({ ...header, vat_price: 1.07, gross_price: 12.99 }, [nonDeductibleItem({ vat_accounts_id: 1510, vat_accounts_dimensions_id: undefined })]), chart()],
    ["mixed rows", (fake: ReturnType<typeof fakeEarveldaja>) =>
      fake.seed({ ...header, vat_price: 25.07, gross_price: 137.03 }, [nonDeductibleItem(), row24(100, 6000)]), chart()],
    ["stored VAT 48.01 vs rows 48", (fake: ReturnType<typeof fakeEarveldaja>) =>
      fake.seed({ ...header, vat_price: 48.01, gross_price: 248.01 }, [row24(100), row24(100, 6000)]), chart()],
    ["no chart", proven, undefined],
  ])("%s → correction_nonvat_form_unproven, zero PATCH, zero register", async (_label, seed, accounts) => {
    const fake = fakeEarveldaja();
    const id = seed(fake);
    await expect(fake.purchaseInvoices.confirmWithTotals(id, false, accounts ? { accounts } : {}))
      .rejects.toBeInstanceOf(PurchaseInvoiceTotalsCorrectionError);
    expect(fake.writes()).toEqual([]);
  });

  it("a header net that is not the item net sum → held", async () => {
    const fake = fakeEarveldaja({ onGet: (invoice) => ({ ...invoice, net_price: 12.92, gross_price: 13.99 }) });
    const id = proven(fake);
    await expect(fake.purchaseInvoices.confirmWithTotals(id, false, { accounts: chart() }))
      .rejects.toMatchObject({ code: "correction_nonvat_form_unproven" });
    expect(fake.writes()).toEqual([]);
  });

  it("a fresh chart with is_vat_account true holds even though the cached chart still says false", async () => {
    const fake = fakeEarveldaja();
    const id = proven(fake);
    expect((await fake.readonly.getAccounts()).find((account) => account.id === COST_ACCOUNT)?.is_vat_account).toBe(false);
    fake.state.accounts = chart({ costIsVatAccount: true });
    expect((await fake.readonly.getAccounts()).find((account) => account.id === COST_ACCOUNT)?.is_vat_account).toBe(false); // cached
    await expect(fake.purchaseInvoices.confirmWithTotals(id, false, { accounts: await fake.readonly.getAccounts({ fresh: true }) }))
      .rejects.toMatchObject({ code: "correction_nonvat_form_unproven" });
    expect(fake.registers()).toEqual([]);
  });

  it("a folded non-VAT draft without a chart registers as today, with no /accounts read", async () => {
    const fake = fakeEarveldaja();
    const id = fake.seed({ ...header, vat_price: 0, gross_price: 12.99 },
      [{ custom_title: "Folded", purchase_accounts_id: 6000, total_net_price: 11.92, cl_vat_articles_id: 11, vat_rate_dropdown: "-", project_no_vat_gross_price: 12.99 }]);
    await fake.purchaseInvoices.confirmWithTotals(id, false);
    expect(fake.registers()).toHaveLength(1);
    expect(fake.accountReads()).toEqual([]);
  });
});

describe("10a. the residue never rewrites a supplied override (zero POST)", () => {
  it.each([
    ["override 124.02 with VAT 24.01 / gross 124.01", 100, 124.02, 24.01, 124.01],
    ["override 124.01 with VAT 24.00 / gross 124.00", 100, 124.01, 24, 124],
    ["override −124.02 with VAT −24.01 / gross −124.01", -100, -124.02, -24.01, -124.01],
    ["override −124.01 with VAT −24.00 / gross −124.00", -100, -124.01, -24, -124],
  ])("%s → purchase_totals_mismatch", async (_label, net, override, vat, gross) => {
    const fake = fakeEarveldaja();
    const items = [row24(net, COST_ACCOUNT, { project_no_vat_gross_price: override })];
    expect(previewPurchaseInvoiceTotals(data(items), vat, gross, false, chart())).toMatchObject({ ok: false, code: "purchase_totals_mismatch" });
    await expectNoPost(fake.purchaseInvoices.createAndSetTotals(data(items), vat, gross, false, chart()), fake, /totals mismatch/);
  });

  it.each([
    [100, 24.01, 124.01],
    [100, 23.99, 123.99],
    [-100, -24.01, -124.01],
    [-100, -23.99, -123.99],
  ])("without an override, net %s with VAT %s / gross %s absorbs the residue on the last row and is created", async (net, vat, gross) => {
    const fake = fakeEarveldaja();
    const created = await fake.purchaseInvoices.createAndSetTotals(data([row24(net)]), vat, gross, false, chart());
    expect((fake.totalsPatches()[0]!.body as { items: Array<Record<string, unknown>> }).items[0]!.project_no_vat_gross_price).toBe(gross);
    expect(created).toMatchObject({ vat_price: vat, gross_price: gross });
    expect(fake.invalidations()).toEqual([]);
  });
});

describe("10b. EUR only", () => {
  it("USD 100 / 24 / 124 at rate 1.24 → zero POST", async () => {
    const fake = fakeEarveldaja();
    await expectNoPost(
      fake.purchaseInvoices.createAndSetTotals(data([row24(100)], { cl_currencies_id: "USD", currency_rate: 1.24 }), 24, 124, false, chart()),
      fake, /EUR invoices only/,
    );
  });

  it("an EUR read-back whose base amounts are substituted (806.45 / 193.55 / 1000) → P3 rejects", async () => {
    const fake = fakeEarveldaja({
      onGet: (invoice, nth) => (nth === 2 ? { ...invoice, base_net_price: 806.45, base_vat_price: 193.55, base_gross_price: 1000 } : invoice),
    });
    await expectInvalidated(fake.purchaseInvoices.createAndSetTotals(data([row24(100)]), 24, 124, false, chart()), fake, 1);
  });

  it("a stored EUR draft with such base amounts → P4 holds, zero register", async () => {
    const fake = fakeEarveldaja();
    const id = fake.seed({ ...header, vat_price: 24, gross_price: 124, base_net_price: 806.45, base_vat_price: 193.55, base_gross_price: 1000 }, [row24(100)]);
    await expect(fake.purchaseInvoices.confirmWithTotals(id, false, { accounts: chart() }))
      .rejects.toMatchObject({ code: "correction_nonvat_form_unproven" });
    expect(fake.registers()).toEqual([]);
  });
});

describe("11. totals correction: none for this form", () => {
  it("a proven draft previews correction_required false and confirms with that preview without a PATCH", async () => {
    const fake = fakeEarveldaja();
    const id = fake.seed({ ...header, vat_price: 1.07, gross_price: 12.99 }, [nonDeductibleItem()]);
    const preview = await fake.purchaseInvoices.previewTotalsCorrection(id, false, chart());
    expect(preview).toMatchObject({ correction_required: false, current_vat_price: 1.07, proposed_vat_price: 1.07, proposed_gross_price: 12.99 });
    await fake.purchaseInvoices.confirmWithTotals(id, false, { recalculateTotals: true, approvedCorrection: preview, accounts: chart() });
    expect(fake.totalsPatches()).toEqual([]);
    expect(fake.registers()).toHaveLength(1);
  });

  it("an unproven draft has nothing to approve: the preview throws", async () => {
    const fake = fakeEarveldaja();
    const id = fake.seed({ ...header, vat_price: 1.07, gross_price: 12.99 }, [nonDeductibleItem({ vat_accounts_id: 1510, vat_accounts_dimensions_id: undefined })]);
    await expect(fake.purchaseInvoices.previewTotalsCorrection(id, false, chart())).rejects.toMatchObject({ code: "correction_nonvat_form_unproven" });
    expect(fake.writes()).toEqual([]);
  });
});
