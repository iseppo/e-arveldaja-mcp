// Truth v2 (owner decision 2026-10-17): truth values come from the purchase invoice already booked in
// e-arveldaja and matched to the PDF, with no owner review. A PDF with no booked counterpart, an
// ambiguous match, or a company without a snapshot is `truth_unavailable` and excluded.
//
// Matching, strongest first:
//   1. the invoice's attached document has the PDF's sha256 (exactly one live invoice);
//   2. else the normalised invoice number of exactly one live invoice of the company equals a candidate
//      number (the heuristic's; for the corpus also truth v1's) AND its gross or date corroborates.
//
// Owner-confirmed truth changes (throughput round B1/B3/B5) live in <set>/truth-overrides.json, never in code:
// each entry names the document, the field, the new value (or `unscore`), the reason and who confirmed it. They
// are applied on every build, and `apply-overrides` applies them to an existing truth.json; every applied change
// is recorded in the record's `truth_changes` (field, from, to, reason) for the report.
//
// Usage:
//   npx tsx scripts/reading-p1/truth.ts match --set corpus|heldout   → <set>/matches.json + ids to fetch
//   npx tsx scripts/reading-p1/truth.ts build --set corpus|heldout   → <set>/truth.json (needs details)
//   npx tsx scripts/reading-p1/truth.ts apply-overrides --set corpus → <set>/truth.json with the confirmed overrides
//   npx tsx scripts/reading-p1/truth.ts draft-printed --set corpus   → <set>/truth-overrides.draft.json (for the owner)

import { existsSync } from "node:fs";
import { ibanScan } from "../../src/document-reading-tokens.js";
import { join } from "node:path";
import { isInvalidatedPurchaseInvoice, normalizeInvoiceNumberForComparison } from "../../src/purchase-invoice-status.js";
import type { Client, PurchaseInvoice } from "../../src/types/api.js";
import type { PacketFile, OwnIds } from "./build-packets.js";
import { LEGACY_DIR, addDays, argValue, dataPath, manifest, readJson, writeJson, type SetName } from "./common.js";
import { dueLabelledDates } from "./synth-proof.js";

export interface TruthRecord {
  id: string;
  status: "available" | "truth_unavailable";
  reason?: string;
  company: string | null;
  invoice_id?: number;
  match?: "document_sha256" | "number";
  doc_type: string | null;
  invoice_date?: string;
  invoice_number?: string;
  due_date?: string;
  term_days?: number;
  supplier_name?: string | null;
  supplier_reg?: string | null;
  supplier_vat?: string | null;
  supplier_country?: string | null;
  supplier_client_id?: number;
  supplier_iban?: string | null;
  buyer_reg?: string | null;
  buyer_vat?: string | null;
  currency?: string;
  net?: number | null;
  vat?: number | null;
  gross?: number | null;
  reverse_charge?: "applies" | "not_applicable";
  expected_document_holds?: string[];
  may_also_hold?: string[];
  /** Fields e-arveldaja holds no value for (or, for a non-VAT company, net/vat): never scored. */
  unscored_fields?: string[];
  note?: string;
  /** B1: the due date the document prints under a due label (owner-confirmed); scored instead of `due_date`. */
  due_date_printed?: string | null;
  /** B3: every account the supplier prints as its own (owner-confirmed), in print order. */
  supplier_ibans_printed?: string[];
  /** B5: the booked reference kept apart when the printed number is the scored truth; never scored. */
  booking_reference?: string;
  /** Every override applied to this record, with its reason (listed by the report). */
  truth_changes?: TruthChange[];
}

export interface TruthChange { field: string; from: unknown; to: unknown; reason: string }

export const OVERRIDE_FIELDS = ["invoice_number", "supplier_reg", "supplier_vat", "supplier_iban", "invoice_date", "currency", "net", "vat", "gross", "due_date_printed", "supplier_ibans_printed"] as const;

export interface TruthOverride {
  doc: string;
  field: typeof OVERRIDE_FIELDS[number];
  /** The new truth value; omitted with `unscore`. */
  value?: unknown;
  /** Exclude the field from scoring (only for a genuinely ambiguous field). */
  unscore?: boolean;
  /** Keep the replaced value under this key (B5). */
  keep_as?: "booking_reference";
  reason: string;
  /** Who confirmed the change (an unconfirmed draft is refused). */
  confirmed_by: string;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Applies confirmed overrides to the records in place (idempotent); returns the changes applied now. */
export function applyOverrides(truth: Record<string, TruthRecord>, overrides: TruthOverride[]): TruthChange[] {
  const applied: TruthChange[] = [];
  for (const entry of overrides) {
    if (!entry.confirmed_by?.trim()) throw new Error(`override ${entry.doc}/${entry.field} is not confirmed`);
    if (!entry.reason?.trim()) throw new Error(`override ${entry.doc}/${entry.field} has no reason`);
    if (!(OVERRIDE_FIELDS as readonly string[]).includes(entry.field)) throw new Error(`override field ${entry.field} not allowed`);
    if (!entry.unscore && !("value" in entry)) throw new Error(`override ${entry.doc}/${entry.field} has no value`);
    const record = truth[entry.doc];
    if (!record || record.status !== "available") throw new Error(`override ${entry.doc}: no available truth record`);
    const target = entry.unscore ? "unscored" : entry.value;
    if ((record.truth_changes ?? []).some((change) => change.field === entry.field && sameValue(change.to, target))) continue;
    const fields = record as unknown as Record<string, unknown>;
    const from = fields[entry.field] ?? null;
    if (entry.unscore) {
      record.unscored_fields = [...new Set([...(record.unscored_fields ?? []), entry.field])];
    } else {
      if (entry.keep_as === "booking_reference") {
        if (typeof from !== "string") throw new Error(`override ${entry.doc}/${entry.field}: nothing to keep as booking_reference`);
        record.booking_reference = from;
      }
      fields[entry.field] = entry.value;
    }
    const change: TruthChange = { field: entry.field, from, to: target, reason: `${entry.reason} (confirmed: ${entry.confirmed_by})` };
    record.truth_changes = [...(record.truth_changes ?? []), change];
    applied.push(change);
  }
  return applied;
}

function loadOverrides(set: SetName): TruthOverride[] {
  const path = dataPath(set, "truth-overrides.json");
  return existsSync(path) ? readJson<TruthOverride[]>(path) : [];
}

/** Drafts B1/B3 values from the packets for the owner to confirm (nothing is applied). */
function draftPrinted(set: SetName): void {
  const truth = readJson<Record<string, TruthRecord>>(dataPath(set, "truth.json"));
  const drafts: TruthOverride[] = [];
  for (const entry of manifest(set)) {
    const record = truth[entry.id];
    if (!record || record.status !== "available") continue;
    const packet = readJson<PacketFile>(dataPath("packets", `${entry.id}.json`)).packet;
    const due = dueLabelledDates(packet);
    if (due.length > 0) {
      drafts.push({ doc: entry.id, field: "due_date_printed", value: due[0]!.value,
        reason: `drafted: due-labelled date on ${due[0]!.line}${due.length > 1 ? ` (also ${due.slice(1).map((d) => `${d.value}@${d.line}`).join(", ")})` : ""}; booked ${record.due_date ?? "none"}`, confirmed_by: "" });
    }
    const ibans = [...new Set(ibanScan(packet.lines).map((hit) => hit.value))];
    if (ibans.length > 0 && (record.supplier_iban == null || ibans.length > 1)) {
      drafts.push({ doc: entry.id, field: "supplier_ibans_printed", value: ibans,
        reason: `drafted: every printed IBAN in print order; keep only the supplier's own accounts (not a payer's); booked ${record.supplier_iban ?? "none"}`, confirmed_by: "" });
    }
  }
  writeJson(dataPath(set, "truth-overrides.draft.json"), drafts);
  process.stdout.write(`${drafts.length} drafted overrides → ${set}/truth-overrides.draft.json (confirm, then move to truth-overrides.json)\n`);
}

interface LegacyTruth { invoice_number?: string | null; invoice_date?: string | null; gross?: number | null; supplier_name?: string[] }
interface DocumentRow { invoice_id: number; sha256: string | null }
interface MatchRow { id: string; company: string | null; invoice_id?: number; match?: TruthRecord["match"]; reason?: string }

export function companyOf(own: OwnIds | undefined): string | null {
  return own ? own.reg ?? own.vat : null;
}

function snapshotFile<T>(company: string, name: string): T | undefined {
  const path = dataPath("snapshots", company, `${name}.json`);
  return existsSync(path) ? readJson<T>(path) : undefined;
}

function match(set: SetName): MatchRow[] {
  const own = readJson<Record<string, OwnIds>>(dataPath(set, "own.json"));
  const legacy = set === "corpus" ? readJson<Record<string, LegacyTruth>>(join(LEGACY_DIR, "truth.json")) : {};
  const rows: MatchRow[] = [];
  for (const entry of manifest(set)) {
    const company = companyOf(own[entry.id]);
    const invoices = company ? snapshotFile<PurchaseInvoice[]>(company, "purchase_invoices") : undefined;
    const documents = company ? snapshotFile<DocumentRow[]>(company, "documents") : undefined;
    if (!company || !invoices || !documents) {
      rows.push({ id: entry.id, company, reason: "no_snapshot_for_company" });
      continue;
    }
    const live = new Map(invoices.filter((invoice) => invoice.id !== undefined && !isInvalidatedPurchaseInvoice(invoice)).map((invoice) => [invoice.id!, invoice]));
    const bySha = [...new Set(documents.filter((row) => row.sha256 === entry.sha256 && live.has(row.invoice_id)).map((row) => row.invoice_id))];
    if (bySha.length === 1) {
      rows.push({ id: entry.id, company, invoice_id: bySha[0], match: "document_sha256" });
      continue;
    }
    if (bySha.length > 1) {
      rows.push({ id: entry.id, company, reason: "ambiguous_document_sha256" });
      continue;
    }
    const packet = readJson<PacketFile>(dataPath("packets", `${entry.id}.json`));
    const v1 = legacy[entry.id];
    const numbers = new Set([packet.heuristic_fields.invoice_number, v1?.invoice_number]
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .map((value) => normalizeInvoiceNumberForComparison(value)).filter(Boolean));
    const grosses = [packet.heuristic_fields.gross, v1?.gross].filter((value): value is number => typeof value === "number");
    const dates = [packet.heuristic_fields.invoice_date, v1?.invoice_date].filter((value): value is string => typeof value === "string");
    const byNumber = [...live.values()].filter((invoice) => numbers.has(normalizeInvoiceNumberForComparison(invoice.number)));
    if (byNumber.length === 0) {
      rows.push({ id: entry.id, company, reason: "no_booked_counterpart" });
      continue;
    }
    if (byNumber.length > 1) {
      rows.push({ id: entry.id, company, reason: "ambiguous_number_match" });
      continue;
    }
    const invoice = byNumber[0]!;
    const corroborated = grosses.some((gross) => invoice.gross_price !== undefined && Math.abs(invoice.gross_price - gross) <= 0.01) ||
      dates.includes(invoice.create_date);
    rows.push(corroborated
      ? { id: entry.id, company, invoice_id: invoice.id, match: "number" }
      : { id: entry.id, company, reason: "number_match_uncorroborated" });
  }
  writeJson(dataPath(set, "matches.json"), rows);
  const byCompany: Record<string, number[]> = {};
  for (const row of rows) if (row.invoice_id !== undefined && row.company) (byCompany[row.company] ??= []).push(row.invoice_id);
  process.stdout.write(`${JSON.stringify({ matched: rows.filter((row) => row.invoice_id !== undefined).length, unavailable: rows.filter((row) => row.invoice_id === undefined).length, fetch: byCompany })}\n`);
  return rows;
}

function round2(value: number | undefined | null): number | null {
  return value === undefined || value === null ? null : Math.round(value * 100) / 100;
}

function build(set: SetName): void {
  const own = readJson<Record<string, OwnIds>>(dataPath(set, "own.json"));
  const matches = readJson<MatchRow[]>(dataPath(set, "matches.json"));
  const legacy = set === "corpus" ? readJson<Record<string, LegacyTruth>>(join(LEGACY_DIR, "truth.json")) : {};
  const truth: Record<string, TruthRecord> = {};
  for (const row of matches) {
    if (row.invoice_id === undefined || !row.company) {
      truth[row.id] = { id: row.id, status: "truth_unavailable", reason: row.reason, company: row.company, doc_type: null };
      continue;
    }
    const details = snapshotFile<PurchaseInvoice[]>(row.company, "purchase_invoice_details") ?? [];
    const invoice = details.find((candidate) => candidate.id === row.invoice_id);
    const clients = snapshotFile<Client[]>(row.company, "clients") ?? [];
    if (!invoice) {
      truth[row.id] = { id: row.id, status: "truth_unavailable", reason: "invoice_detail_missing", company: row.company, doc_type: null };
      continue;
    }
    const client = clients.find((candidate) => candidate.id === invoice.clients_id);
    const ownIds = own[row.id]!;
    // A non-VAT company books net = gross and VAT 0: those are not the document's net/VAT values.
    const vatRegistered = Boolean(snapshotFile<{ vat_number?: string }>(row.company, "vat_info")?.vat_number?.trim());
    const currency = invoice.cl_currencies_id.toUpperCase();
    const record: TruthRecord = {
      id: row.id,
      status: "available",
      company: row.company,
      invoice_id: invoice.id,
      match: row.match,
      doc_type: null,
      invoice_date: invoice.create_date,
      invoice_number: invoice.number,
      term_days: invoice.term_days,
      due_date: addDays(invoice.create_date, invoice.term_days ?? 0),
      supplier_name: client?.name ?? invoice.client_name ?? null,
      supplier_reg: client?.code ?? null,
      supplier_vat: client?.invoice_vat_no ?? null,
      supplier_country: client?.cl_code_country ?? null,
      supplier_client_id: invoice.clients_id,
      supplier_iban: invoice.bank_account_no ?? null,
      buyer_reg: ownIds.reg,
      buyer_vat: ownIds.vat,
      currency,
      net: round2(invoice.net_price),
      vat: round2(invoice.vat_price),
      gross: round2(invoice.gross_price),
      reverse_charge: (invoice.items ?? []).some((item) => item.reversed_vat_id !== undefined && item.reversed_vat_id !== null) ? "applies" : "not_applicable",
      ...(currency !== "EUR" ? { expected_document_holds: ["non_eur_currency", "foreign_currency_marker"] } : {}),
    };
    if (!vatRegistered) {
      record.net = null;
      record.vat = null;
    }
    const scored = ["invoice_date", "invoice_number", "supplier_reg", "supplier_vat", "supplier_iban", "currency", "net", "vat", "gross"] as const;
    record.unscored_fields = scored.filter((field) => record[field] === null || record[field] === undefined || record[field] === "");
    if (!vatRegistered) record.note = "non-VAT company: e-arveldaja books net = gross, VAT 0; net/vat unscored";
    // Owner answer 2026-10-17 (plan §5.1): Telia #01 keeps the printed values and is expected to hold.
    if (set === "corpus" && row.id === "01" && (legacy["01"]?.supplier_name ?? []).some((name) => /telia/i.test(name))) {
      Object.assign(record, {
        net: 15.92,
        vat: 28.78,
        gross: 44.7,
        expected_document_holds: ["signed_amount_present"],
        may_also_hold: ["vat_rate_not_snapped"],
        unscored_fields: (record.unscored_fields ?? []).filter((field) => !["net", "vat", "gross"].includes(field)),
        note: "owner 2026-10-17: printed values are the truth; the -104,00 returned-device deposit sits inside the taxable base; acceptance is an exit failure",
      });
    }
    truth[row.id] = record;
  }
  applyOverrides(truth, loadOverrides(set));
  writeJson(dataPath(set, "truth.json"), truth);
  const records = Object.values(truth);
  const reasons: Record<string, number> = {};
  for (const record of records) if (record.status !== "available") reasons[record.reason ?? "?"] = (reasons[record.reason ?? "?"] ?? 0) + 1;
  const summary = {
    set,
    documents: records.length,
    available: records.filter((record) => record.status === "available").length,
    truth_unavailable: records.filter((record) => record.status !== "available").length,
    reasons,
    match_kinds: records.reduce<Record<string, number>>((acc, record) => {
      if (record.match) acc[record.match] = (acc[record.match] ?? 0) + 1;
      return acc;
    }, {}),
  };
  writeJson(dataPath(set, "truth-coverage.json"), summary);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1]?.endsWith("/truth.ts")) {
  const [mode, ...rest] = process.argv.slice(2);
  const set = (argValue(rest, "--set") ?? "corpus") as SetName;
  if (mode === "match") match(set);
  else if (mode === "build") build(set);
  else if (mode === "apply-overrides") {
    const truth = readJson<Record<string, TruthRecord>>(dataPath(set, "truth.json"));
    const applied = applyOverrides(truth, loadOverrides(set));
    writeJson(dataPath(set, "truth.json"), truth);
    process.stdout.write(`${JSON.stringify(applied, null, 2)}\n`);
  } else if (mode === "draft-printed") draftPrinted(set);
  else {
    process.stderr.write("usage: truth.ts match|build|apply-overrides|draft-printed --set corpus|heldout\n");
    process.exitCode = 1;
  }
}
