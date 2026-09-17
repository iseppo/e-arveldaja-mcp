import { describe, expect, it, vi } from "vitest";
import { computeReceiptClientAlignment } from "./receipt-client-alignment.js";
import { createReportingOperations } from "./operations.js";
import type { ApiContext } from "../tools/crud/shared.js";
import type { Journal, Transaction } from "../types/api.js";

const PAYER = 2309260;
const INVOICE_CLIENT = 2327264;

function tx(o: Partial<Transaction>): Transaction {
  return {
    id: 1,
    date: "2026-09-01",
    amount: 1488,
    cl_currencies_id: "EUR",
    accounts_dimensions_id: 12345,
    type: "D",
    status: "CONFIRMED",
    is_deleted: false,
    ...o,
  } as Transaction;
}

function registrationJournal(o: Partial<Journal>): Journal {
  return {
    operation_type: "TRANSACTION",
    effective_date: "2026-09-01",
    registered: true,
    is_deleted: false,
    postings: [],
    ...o,
  } as Journal;
}

const saleItem = (o: Record<string, unknown> = {}) => ({
  accounts_id: 1210,
  relation_table: "sale_invoices",
  relation_id: 5001,
  clients_id: INVOICE_CLIENT,
  client_name: "EIS",
  item_number: "2026-11",
  ...o,
});

describe("computeReceiptClientAlignment", () => {
  // Plan item 7: one mismatched confirmed tx + one aligned + one whose
  // registration journal cannot be located.
  it("reports exactly the mismatched rows and separates the missing registration journal", () => {
    const transactions = [
      tx({ id: 7001, clients_id: PAYER, bank_account_name: "RAHANDUSMINISTEERIUM", items: [saleItem()] }),
      tx({ id: 7002, clients_id: INVOICE_CLIENT, items: [saleItem({ relation_id: 5002, item_number: "2026-12" })] }),
      tx({
        id: 7003,
        clients_id: PAYER,
        amount: 240,
        items: [saleItem({
          relation_table: "purchase_invoices",
          relation_id: 6001,
          item_number: "P-77",
          client_name: "Supplier OÜ",
        })],
      }),
    ];
    const journals = [
      registrationJournal({ id: 28013080, operations_id: 7001, clients_id: PAYER }),
      registrationJournal({ id: 28013081, operations_id: 7002, clients_id: INVOICE_CLIENT }),
    ];

    const core = computeReceiptClientAlignment({
      transactions,
      journals,
      clientNames: new Map([[PAYER, "Rahandusministeerium"], [INVOICE_CLIENT, "EIS"]]),
    });

    expect(core.scanned).toBe(3);
    expect(core.invoice_linked).toBe(3);
    expect(core.aligned_count).toBe(1);
    expect(core.invoice_client_missing).toBe(0);
    expect(core.warnings).toEqual([]);
    expect(core.journal_not_found).toEqual([7003]);
    expect(core.mismatches).toEqual([
      {
        transaction_id: 7001,
        date: "2026-09-01",
        amount: 1488,
        currency: "EUR",
        invoice_type: "sale_invoice",
        invoice_id: 5001,
        invoice_number: "2026-11",
        journal_id: 28013080,
        bank_account_name: "RAHANDUSMINISTEERIUM",
        transaction_client: { id: PAYER, name: "Rahandusministeerium" },
        invoice_client: { id: INVOICE_CLIENT, name: "EIS" },
        next_action: "invalidate_transaction 7001; then confirm_transaction 7001 with the same distributions and reassign_client_to_invoice: true",
      },
      {
        transaction_id: 7003,
        date: "2026-09-01",
        amount: 240,
        currency: "EUR",
        invoice_type: "purchase_invoice",
        invoice_id: 6001,
        invoice_number: "P-77",
        journal_id: null,
        registration_journal_not_found: true,
        bank_account_name: null,
        transaction_client: { id: PAYER, name: "Rahandusministeerium" },
        invoice_client: { id: INVOICE_CLIENT, name: "Supplier OÜ" },
        next_action: "invalidate_transaction 7003; then confirm_transaction 7003 with the same distributions and reassign_client_to_invoice: true",
      },
    ]);
  });

  it("counts only confirmed, non-deleted transactions and marks which ones settle an invoice", () => {
    const core = computeReceiptClientAlignment({
      transactions: [
        tx({ id: 1, status: "PROJECT", clients_id: PAYER, items: [saleItem()] }),
        tx({ id: 2, status: "VOID", clients_id: PAYER, items: [saleItem()] }),
        tx({ id: 3, is_deleted: true, clients_id: PAYER, items: [saleItem()] }),
        // Booked straight to a GL account: no invoice sub-ledger to misalign.
        tx({ id: 4, clients_id: PAYER, items: [{ accounts_id: 2110, relation_table: "accounts", relation_id: 2110 }] }),
        tx({ id: 5, clients_id: PAYER }),
      ],
      journals: [],
    });
    expect(core).toEqual({
      scanned: 2,
      invoice_linked: 0,
      mismatches: [],
      aligned_count: 0,
      invoice_client_missing: 0,
      journal_not_found: [],
      warnings: [],
    });
  });

  it("does not flag a link whose payer or invoice client is unknown, and says how to fix the invoice", () => {
    const core = computeReceiptClientAlignment({
      transactions: [
        tx({ id: 1, clients_id: null, items: [saleItem()] }),
        tx({ id: 2, clients_id: PAYER, items: [saleItem({ clients_id: null })] }),
      ],
      journals: [],
    });
    expect(core.scanned).toBe(2);
    expect(core.invoice_linked).toBe(2);
    expect(core.mismatches).toEqual([]);
    expect(core.aligned_count).toBe(0);
    expect(core.invoice_client_missing).toBe(1);
    expect(core.warnings).toEqual([
      "1 invoice link(s) have no client on the invoice, so the receipt cannot be checked against a client sub-ledger. Set the client on the invoice (update_sale_invoice / update_purchase_invoice) and re-run.",
    ]);
    expect(core.journal_not_found).toEqual([]);
  });

  // A purchase-side-only deployment has no sale-invoice tools registered, so a
  // sale link is out of scope and the guidance must not name a missing tool.
  it("skips sale-invoice links and drops update_sale_invoice from the guidance when sales are disabled", () => {
    const core = computeReceiptClientAlignment({
      transactions: [tx({
        id: 9,
        clients_id: PAYER,
        items: [
          saleItem({ relation_id: 5001 }),
          saleItem({ relation_table: "purchase_invoices", relation_id: 6001, clients_id: null, client_name: null }),
        ],
      })],
      journals: [registrationJournal({ id: 555, operations_id: 9 })],
      enableSales: false,
    });
    expect(core.scanned).toBe(1);
    expect(core.invoice_linked).toBe(1);
    expect(core.mismatches).toEqual([]);
    expect(core.invoice_client_missing).toBe(1);
    expect(core.warnings).toEqual([
      "1 invoice link(s) have no client on the invoice, so the receipt cannot be checked against a client sub-ledger. Set the client on the invoice (update_purchase_invoice) and re-run.",
    ]);
  });

  it("emits one row per misaligned invoice link and looks the journal up once", () => {
    const core = computeReceiptClientAlignment({
      transactions: [tx({
        id: 9,
        clients_id: PAYER,
        items: [saleItem({ relation_id: 1 }), saleItem({ relation_id: 2 }), saleItem({ clients_id: PAYER, relation_id: 3 })],
      })],
      journals: [registrationJournal({ id: 555, operations_id: 9, clients_id: PAYER })],
    });
    expect(core.scanned).toBe(1);
    expect(core.invoice_linked).toBe(1);
    expect(core.aligned_count).toBe(1);
    expect(core.mismatches.map(m => [m.invoice_id, m.journal_id])).toEqual([[1, 555], [2, 555]]);
    expect(core.journal_not_found).toEqual([]);
  });

  it("ignores a deleted, unregistered, differently-typed or foreign journal when resolving the registration journal", () => {
    const core = computeReceiptClientAlignment({
      transactions: [tx({ id: 7001, clients_id: PAYER, items: [saleItem()] })],
      journals: [
        registrationJournal({ id: 1, operations_id: 7001, is_deleted: true }),
        registrationJournal({ id: 2, operations_id: 7001, operation_type: "ENTRY" }),
        registrationJournal({ id: 3, operations_id: 7002 }),
        // Superseded by an invalidate + re-confirm: the row stays, unregistered.
        registrationJournal({ id: 10, operations_id: 7001, registered: false }),
        registrationJournal({ id: 4, operations_id: 7001 }),
      ],
    });
    expect(core.mismatches[0]!.journal_id).toBe(4);
    expect(core.mismatches[0]!.registration_journal_not_found).toBeUndefined();
    expect(core.journal_not_found).toEqual([]);
  });
});

describe("ReportingOperations receipt_client_alignment", () => {
  // The list endpoint never returns `items[]` — only GET /transactions/{id}
  // does — so the mock serves stripped list rows and full detail records, the
  // way the live API behaves.
  const DETAIL: Record<number, Transaction> = {
    7001: tx({ id: 7001, clients_id: PAYER, items: [saleItem()] }),
    7002: tx({ id: 7002, date: "2025-01-05", clients_id: PAYER, items: [saleItem({ relation_id: 5099 })] }),
  };
  const LIST_ROWS = Object.values(DETAIL).map(({ items: _items, ...row }) => row as Transaction);

  function makeApi() {
    return {
      clients: {
        listAllCached: vi.fn().mockResolvedValue([
          { id: PAYER, name: "Rahandusministeerium" },
          { id: INVOICE_CLIENT, name: "EIS" },
        ]),
        create: vi.fn(), update: vi.fn(), delete: vi.fn(), deactivate: vi.fn(), restore: vi.fn(),
      },
      journals: {
        listAll: vi.fn().mockResolvedValue([registrationJournal({ id: 28013080, operations_id: 7001, clients_id: PAYER })]),
        listAllWithPostings: vi.fn().mockRejectedValue(new Error("postings are not needed for this audit")),
        create: vi.fn(), update: vi.fn(), delete: vi.fn(), confirm: vi.fn(), invalidate: vi.fn(),
      },
      transactions: {
        listAll: vi.fn(async (params?: { status?: string; start_date?: string; end_date?: string }) =>
          LIST_ROWS.filter(row =>
            (params?.status === undefined || row.status === params.status)
            && (params?.start_date === undefined || row.date >= params.start_date)
            && (params?.end_date === undefined || row.date <= params.end_date))),
        get: vi.fn(async (id: number) => DETAIL[id]!),
        create: vi.fn(), update: vi.fn(), delete: vi.fn(), confirm: vi.fn(), invalidate: vi.fn(),
      },
      saleInvoices: { listAll: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), delete: vi.fn(), confirm: vi.fn() },
      purchaseInvoices: { listAll: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), delete: vi.fn(), confirm: vi.fn() },
      readonly: { getAccounts: vi.fn().mockResolvedValue([]) },
    };
  }

  it("narrows the window server-side, reads items per transaction, and mutates nothing", async () => {
    const api = makeApi();
    // The precondition the whole fix rests on: a list row carries no items.
    expect(LIST_ROWS[0]!.items).toBeUndefined();

    const ops = createReportingOperations(api as unknown as ApiContext, true);
    const outcome = await ops.run({ report: "receipt_client_alignment", period: { from: "2026-01-01", to: "2026-12-31" } });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.value.report !== "receipt_client_alignment") return;
    expect(outcome.value.window).toEqual({ from: "2026-01-01", to: "2026-12-31", defaulted: false });
    expect(api.transactions.listAll).toHaveBeenCalledWith({ status: "CONFIRMED", start_date: "2026-01-01", end_date: "2026-12-31" });
    expect(api.journals.listAll).toHaveBeenCalledWith({ start_date: "2026-01-01", end_date: "2026-12-31" });
    // One detail read per confirmed transaction in the window; the 2025 row is
    // outside it and is never fetched.
    expect(api.transactions.get.mock.calls).toEqual([[7001]]);

    expect(outcome.value.scanned).toBe(1);
    expect(outcome.value.invoice_linked).toBe(1);
    expect(outcome.value.mismatches).toHaveLength(1);
    expect(outcome.value.mismatches[0]!.transaction_id).toBe(7001);
    expect(outcome.value.mismatches[0]!.journal_id).toBe(28013080);
    // UNWRAPPED at the op layer — the façade is the sole wrapping site.
    expect(outcome.value.mismatches[0]!.transaction_client.name).toBe("Rahandusministeerium");
    expect(outcome.value.warnings).toEqual([]);

    for (const [resource, methods] of Object.entries({
      clients: ["create", "update", "delete", "deactivate", "restore"],
      journals: ["create", "update", "delete", "confirm", "invalidate"],
      transactions: ["create", "update", "delete", "confirm", "invalidate"],
      saleInvoices: ["create", "update", "delete", "confirm"],
      purchaseInvoices: ["create", "update", "delete", "confirm"],
    })) {
      for (const method of methods) {
        const mock = (api as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>)[resource]![method]!;
        expect(mock, `${resource}.${method} must not be called by a read-only audit`).not.toHaveBeenCalled();
      }
    }
  });

  it("defaults to the last 12 months and says so", async () => {
    const api = makeApi();
    const ops = createReportingOperations(api as unknown as ApiContext, true);
    const outcome = await ops.run({ report: "receipt_client_alignment", period: {} });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.value.report !== "receipt_client_alignment") return;
    const { from, to, defaulted } = outcome.value.window;
    expect(defaulted).toBe(true);
    expect(to).toBe(new Date().toISOString().split("T")[0]!);
    const [year, month, day] = to.split("-").map(Number);
    expect(from).toBe(new Date(Date.UTC(year!, month! - 1 - 12, day!)).toISOString().split("T")[0]!);
    expect(api.transactions.listAll).toHaveBeenCalledWith({ status: "CONFIRMED", start_date: from, end_date: to });
    expect(outcome.value.warnings[0]).toContain("audited the 12 months ending");
  });
});
