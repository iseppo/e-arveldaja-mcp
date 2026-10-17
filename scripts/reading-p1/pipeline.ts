// Full-pipeline replay on the frozen read-only snapshot (plan §5.6): remove the document's own booking
// (demonstrably linked records only), build the deterministic booking with the real helpers, then run
// checkBookingBinding and the §2.6 duplicate scanners through duplicateHolds.

import { existsSync } from "node:fs";
import { checkIntakeCashDuplicates } from "../../src/bank-posting-duplicate-guard.js";
import {
  checkBookingBinding,
  duplicateHolds,
  duplicateKeys,
  supplierCandidates,
  type BindingHold,
  type BookingView,
} from "../../src/document-reading-binding.js";
import { rateMatches, type AcceptedValues, type CheckResult } from "../../src/document-reading-check.js";
import { vatRatesInForceOn } from "../../src/estonian-tax-rules.js";
import { findJournalsReferencingDocument } from "../../src/journal-reference-scan.js";
import { normalizeInvoiceNumberForComparison } from "../../src/purchase-invoice-status.js";
import { predictPurchaseItemAmounts, previewPurchaseInvoiceTotals } from "../../src/api/purchase-invoices.api.js";
import { detectDuplicatePurchaseInvoice } from "../../src/tools/document-audit.js";
import { applyPurchaseVatDefaults } from "../../src/tools/purchase-vat-defaults.js";
import { findInvoiceNumberMatchesAnySupplier } from "../../src/tools/receipt-inbox-matching.js";
import type {
  AccountDimension, BankAccount, Transaction, Client, Journal, PurchaseArticle, PurchaseInvoice, PurchaseInvoiceItem,
} from "../../src/types/api.js";
import type { PacketFile } from "./build-packets.js";
import { dataPath, readJson } from "./common.js";
import type { TruthRecord } from "./truth.js";

export interface Snapshot {
  company: string;
  clients: Client[];
  purchaseInvoices: PurchaseInvoice[];
  details: PurchaseInvoice[];
  journals: Journal[] | "unavailable";
  transactions: Transaction[];
  bankAccounts: BankAccount[];
  accountDimensions: AccountDimension[];
  purchaseArticles: PurchaseArticle[];
  vatRegistered: boolean;
}

const cache = new Map<string, Snapshot | undefined>();

export function loadSnapshot(company: string | null): Snapshot | undefined {
  if (!company) return undefined;
  if (cache.has(company)) return cache.get(company);
  const file = <T>(name: string): T | undefined => {
    const path = dataPath("snapshots", company, `${name}.json`);
    return existsSync(path) ? readJson<T>(path) : undefined;
  };
  const meta = file<{ journals: { status: string } }>("meta");
  const clients = file<Client[]>("clients");
  const invoices = file<PurchaseInvoice[]>("purchase_invoices");
  if (!meta || !clients || !invoices) {
    cache.set(company, undefined);
    return undefined;
  }
  const snapshot: Snapshot = {
    company,
    clients,
    purchaseInvoices: invoices,
    details: file<PurchaseInvoice[]>("purchase_invoice_details") ?? [],
    journals: meta.journals.status === "available" ? file<Journal[]>("journals") ?? "unavailable" : "unavailable",
    transactions: file<Transaction[]>("transactions") ?? [],
    bankAccounts: file<BankAccount[]>("bank_accounts") ?? [],
    accountDimensions: file<AccountDimension[]>("account_dimensions") ?? [],
    purchaseArticles: file<PurchaseArticle[]>("purchase_articles") ?? [],
    vatRegistered: Boolean(file<{ vat_number?: string }>("vat_info")?.vat_number?.trim()),
  };
  cache.set(company, snapshot);
  return snapshot;
}

export interface Removed { invoices: number[]; journals: number[]; transactions: number[] }

/** Only records demonstrably linked to the document's own booking (Codex r2-5); reference-only matches stay. */
export function withoutOwnBooking(snapshot: Snapshot, truth: TruthRecord | undefined): { snapshot: Snapshot; removed: Removed } {
  const removed: Removed = { invoices: [], journals: [], transactions: [] };
  if (!truth || truth.status !== "available" || truth.invoice_id === undefined) return { snapshot, removed };
  const number = normalizeInvoiceNumberForComparison(truth.invoice_number);
  const own = snapshot.purchaseInvoices.filter((invoice) => invoice.id === truth.invoice_id ||
    (invoice.clients_id === truth.supplier_client_id && normalizeInvoiceNumberForComparison(invoice.number) === number));
  const invoiceIds = new Set(own.map((invoice) => invoice.id!));
  const detailOf = (id: number) => snapshot.details.find((detail) => detail.id === id) ?? own.find((invoice) => invoice.id === id);
  const journalIds = new Set<number>();
  const transactionIds = new Set<number>();
  for (const id of invoiceIds) {
    const detail = detailOf(id);
    for (const journal of detail?.journals ?? []) journalIds.add(journal);
    for (const transaction of detail?.transactions ?? []) transactionIds.add(transaction);
  }
  const journals = snapshot.journals === "unavailable" ? "unavailable" : snapshot.journals.filter((journal) => {
    const linked = journalIds.has(journal.id!) ||
      (journal.operation_type === "PURCHASE_INVOICE" && journal.operations_id != null && invoiceIds.has(journal.operations_id)) ||
      (journal.operation_type === "TRANSACTION" && journal.operations_id != null && transactionIds.has(journal.operations_id));
    if (linked) removed.journals.push(journal.id!);
    return !linked;
  });
  const transactions = snapshot.transactions.filter((transaction) => {
    const linked = transaction.id !== undefined && transactionIds.has(transaction.id);
    if (linked) removed.transactions.push(transaction.id!);
    return !linked;
  });
  removed.invoices = [...invoiceIds];
  return {
    snapshot: { ...snapshot, purchaseInvoices: snapshot.purchaseInvoices.filter((invoice) => !invoiceIds.has(invoice.id!)), journals, transactions },
    removed,
  };
}

export interface PipelineResult {
  status: "evaluated" | "no_snapshot" | "not_accepted";
  holds: BindingHold[];
  warnings: string[];
  reversed_vat: boolean | null;
  removed?: { invoices: number; journals: number; transactions: number };
  pre_existing: string[];
}

function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export async function runPipeline(input: {
  accepted: AcceptedValues | undefined;
  check: CheckResult;
  file: PacketFile;
  truth: TruthRecord | undefined;
  company: string | null;
  /** Family (h)–(j) cases (plan §5.4): a transformed snapshot, unavailable clients, or a patched booking. */
  overrides?: { snapshot?: (snapshot: Snapshot) => Snapshot; clientsUnavailable?: boolean; booking?: (booking: BookingView) => BookingView };
  /** A synthetic snapshot in place of the company's frozen one (selftest fixtures; never private data). */
  base?: Snapshot;
}): Promise<PipelineResult> {
  const base = input.base ?? loadSnapshot(input.company);
  if (!base) return { status: "no_snapshot", holds: [], warnings: [], reversed_vat: null, pre_existing: [] };
  const accepted = input.accepted;
  if (!accepted || input.check.verdict !== "accept") return { status: "not_accepted", holds: [], warnings: [], reversed_vat: null, pre_existing: [] };
  const own = withoutOwnBooking(base, input.truth);
  const removed = own.removed;
  const snapshot = input.overrides?.snapshot ? input.overrides.snapshot(own.snapshot) : own.snapshot;

  // Supplier
  const candidates = supplierCandidates(accepted, input.overrides?.clientsUnavailable ? "unavailable" : snapshot.clients);
  const holds: BindingHold[] = [...candidates.holds];
  const supplier = candidates.candidates.length === 1 ? candidates.candidates[0]! : undefined;
  const supplierClient = supplier ? snapshot.clients.find((client) => client.id === supplier.id) : undefined;

  // Deterministic booking: one item.
  const date = accepted.invoice_date ?? "";
  const vat = accepted.vat ?? 0;
  const gross = accepted.gross ?? 0;
  const net = accepted.net ?? Math.round((gross - vat) * 100) / 100;
  const rates = vat > 0 ? rateMatches(net, vat, vatRatesInForceOn(date)) : [];
  const rate = vat > 0 && rates.length === 1 ? rates[0]! : 0;
  const reverseCharge = snapshot.vatRegistered &&
    (input.check.reverse_charge_note_present || (supplierClient !== undefined && supplierClient.cl_code_country !== "EST"));
  let item: PurchaseInvoiceItem = applyPurchaseVatDefaults(
    snapshot.purchaseArticles as Parameters<typeof applyPurchaseVatDefaults>[0],
    {
      custom_title: "reading-p1",
      total_net_price: net,
      amount: 1,
      vat_rate_dropdown: String(rate),
      ...(reverseCharge ? { reversed_vat_id: 1 } : {}),
    } as PurchaseInvoiceItem,
    snapshot.vatRegistered,
  );
  if (!snapshot.vatRegistered && item.project_no_vat_gross_price == null) item = { ...item, project_no_vat_gross_price: gross };
  const knownIbans = supplierClient?.bank_account_no ? [supplierClient.bank_account_no] : [];
  const iban = accepted.supplier_iban && knownIbans.some((known) => known.replace(/\s+/g, "") === accepted.supplier_iban!.replace(/\s+/g, ""))
    ? accepted.supplier_iban : undefined;
  const termDays = accepted.due_date && accepted.invoice_date ? dayDiff(accepted.invoice_date, accepted.due_date) : 0;
  const data = {
    clients_id: supplier?.id ?? 0,
    client_name: supplierClient?.name ?? accepted.supplier_name ?? "",
    number: accepted.invoice_number ?? "",
    create_date: date,
    journal_date: date,
    term_days: termDays,
    cl_currencies_id: accepted.currency ?? "EUR",
    items: [item],
    ...(iban ? { bank_account_no: iban } : {}),
  };
  const preview = previewPurchaseInvoiceTotals(data, snapshot.vatRegistered ? accepted.vat ?? undefined : undefined, gross, snapshot.vatRegistered);
  const finalItem = preview.ok && preview.lastItemGross !== undefined ? { ...item, project_no_vat_gross_price: preview.lastItemGross } : item;
  const amounts = predictPurchaseItemAmounts([finalItem]);
  const itemNet = amounts.reduce((sum, entry) => sum + entry.net, 0);
  const itemGross = amounts.reduce((sum, entry) => sum + entry.net + entry.vat, 0);
  const bookingSideSignals: string[] = [];
  for (const entry of amounts) {
    if (entry.vat > 0 && rateMatches(entry.net, entry.vat, vatRatesInForceOn(date)).length === 0) bookingSideSignals.push("vat_rate_implausible");
  }
  const built: BookingView = {
    clients_id: data.clients_id,
    number: data.number,
    create_date: data.create_date,
    cl_currencies_id: data.cl_currencies_id,
    gross_price: preview.ok ? preview.gross : gross,
    vat_price: preview.ok ? preview.vat : vat,
    term_days: termDays,
    bank_account_no: iban ?? null,
    items: [{ vat_rate_dropdown: finalItem.vat_rate_dropdown ?? null, reversed_vat_id: finalItem.reversed_vat_id ?? null }],
    effective: { itemNet: Math.round(itemNet * 100) / 100, itemGross: Math.round(itemGross * 100) / 100 },
  };
  const booking = input.overrides?.booking ? input.overrides.booking(built) : built;
  const binding = checkBookingBinding(accepted, booking, {
    vatRegistered: snapshot.vatRegistered,
    vatZeroNoteProven: input.check.vat_zero_note_proven,
    reverseChargeNotePresent: input.check.reverse_charge_note_present,
    supplierCountry: supplierClient?.cl_code_country ?? null,
    bookingSideSignals,
    supplierKnownIbans: knownIbans,
    supplierCandidateIds: candidates.candidates.map((candidate) => candidate.id!),
  });
  holds.push(...binding.holds);

  // Duplicates over the union keys.
  const heuristicNumber = input.file.heuristic_fields.invoice_number;
  const keys = duplicateKeys({ accepted, supplierClientId: supplier?.id ?? 0, heuristic: { invoiceNumber: heuristicNumber } });
  const exact: unknown[] = [];
  const sameAmountDate: unknown[] = [];
  const voided: unknown[] = [];
  const anySupplier: unknown[] = [];
  for (const number of keys.invoiceNumbers) {
    for (const clientId of keys.supplierClientIds) {
      if (!clientId) continue;
      const found = detectDuplicatePurchaseInvoice(snapshot.purchaseInvoices, {
        clients_id: clientId,
        invoice_number: number,
        ...(accepted.currency === "EUR" && keys.gross !== null ? { gross_price: keys.gross } : {}),
        ...(keys.invoiceDate ? { invoice_date: keys.invoiceDate } : {}),
      }) as Record<string, { items?: unknown[] }>;
      exact.push(...(found.candidate_invoice_number_matches?.items ?? []));
      sameAmountDate.push(...(found.candidate_same_amount_date_matches?.items ?? []));
      voided.push(...(found.candidate_invalidated_matches?.items ?? []));
    }
    anySupplier.push(...findInvoiceNumberMatchesAnySupplier(snapshot.purchaseInvoices, number));
  }
  let journalReferences: unknown[] | "unavailable";
  let cashSuspects: unknown[] = [];
  if (snapshot.journals === "unavailable") {
    journalReferences = "unavailable";
  } else {
    const journals = snapshot.journals;
    journalReferences = findJournalsReferencingDocument(journals, keys.invoiceNumbers);
    const cash = await checkIntakeCashDuplicates(
      {
        journals: { listAllWithPostings: async () => journals },
        readonly: { getBankAccounts: async () => snapshot.bankAccounts, getAccountDimensions: async () => snapshot.accountDimensions },
      },
      { grossAmountEur: accepted.currency === "EUR" && accepted.gross !== null ? accepted.gross : undefined, invoiceDate: date },
    );
    if (!cash.scan_available) journalReferences = "unavailable";
    cashSuspects = cash.suspects;
  }
  const duplicates = duplicateHolds({
    exactDuplicates: exact,
    sameAmountDate,
    voidedCandidates: voided,
    anySupplierNumberMatches: anySupplier,
    journalReferences,
    cashSuspects,
  });
  holds.push(...duplicates);
  return {
    status: "evaluated",
    holds,
    warnings: binding.warnings,
    reversed_vat: booking.items.some((entry) => entry.reversed_vat_id !== null && entry.reversed_vat_id !== undefined),
    removed: { invoices: removed.invoices.length, journals: removed.journals.length, transactions: removed.transactions.length },
    pre_existing: duplicates.map((hold) => hold.code),
  };
}
