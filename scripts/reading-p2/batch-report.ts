// P2 §4 E batch replay report: compares two batch-replay result files (before → after) and checks the pass
// criteria on the after file. Private output under <data>/p2-batch/.
//
// Usage: npx tsx scripts/reading-p2/batch-report.ts --before <name> --after <name> [--ceiling] → p2-batch/<after>.report.md
//   --ceiling: the E4 stop rule (plan §2 E4): newly held auto-creates over today's (before) auto-creates, > 10% stops,
//   per signal and for the union of both signals.
// Truth: the frozen truth record (booking), except the invoice number, whose truth is the number printed on the
// document (owner) where the booking used another: <data>/p2-batch/printed-invoice-numbers.json ({doc: number}).
// A write on a document without truth is listed as unscored, never counted as right.

import { existsSync, writeFileSync } from "node:fs";
import { CREDIT_WORDS } from "../../src/document-reading-check.js";
import { creditWordHits, lineTokens } from "../../src/document-reading-tokens.js";
import { normalizeInvoiceNumberForComparison } from "../../src/purchase-invoice-status.js";
import type { PacketFile } from "../reading-p1/build-packets.js";
import { argValue, dataPath, hasFlag, readJson } from "../reading-p1/common.js";

export interface Row {
  doc: string;
  scope: string;
  registry: string;
  mode: "create" | "create_and_confirm";
  packet_digest_match: boolean | null;
  dry_status: string | null;
  run_status: string | null;
  signals: string[];
  notes: string[];
  supplier_resolution_code: string | null;
  writes: Array<{ method: string; fields?: Record<string, unknown> }>;
  truth: { invoice_number?: string; invoice_date?: string; gross?: number; currency?: string; supplier_client_id?: number; supplier_name?: string; supplier_reg?: string | null } | null;
  error?: string;
}

const key = (row: Row) => `${row.doc}|${row.registry}|${row.mode}`;
const createsInvoice = (row: Row) => row.writes.some((write) => write.method === "purchaseInvoices.createAndSetTotals");
const createsClient = (row: Row) => row.writes.some((write) => write.method === "clients.create");

export type PrintedNumbers = Record<string, string>;
const sameName = (a: unknown, b: unknown) => String(a ?? "").replace(/\s+/g, " ").trim().toLowerCase() === String(b ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const invoiceWrites = (row: Row) => row.writes.filter((entry) => entry.method === "purchaseInvoices.createAndSetTotals");
const clientWrites = (row: Row) => row.writes.filter((entry) => entry.method === "clients.create");

/** Fields of every invoice write that differ from truth (truth-available documents only). One document books at
 * most one invoice: a second create is an error of its own, and is scored too. */
export function wrongFields(row: Row, printed: PrintedNumbers = {}): string[] {
  const writes = invoiceWrites(row);
  const wrong: string[] = writes.length > 1 ? ["multiple_invoice_creates"] : [];
  if (!row.truth) return wrong;
  for (const write of writes) wrong.push(...invoiceWriteErrors(row, write.fields ?? {}, printed));
  return wrong;
}

function invoiceWriteErrors(row: Row, fields: Record<string, unknown>, printed: PrintedNumbers): string[] {
  if (!row.truth) return [];
  const wrong: string[] = [];
  const number = printed[row.doc] ?? row.truth.invoice_number;
  if (number !== undefined && normalizeInvoiceNumberForComparison(String(fields.number ?? "")) !== normalizeInvoiceNumberForComparison(number)) wrong.push("number");
  if (row.truth.invoice_date !== undefined && fields.create_date !== row.truth.invoice_date) wrong.push("date");
  if (typeof row.truth.gross === "number" && typeof fields.gross_price === "number" && Math.abs(fields.gross_price - row.truth.gross) > 0.005) wrong.push("gross");
  if (String(fields.cl_currencies_id ?? "EUR").toUpperCase() !== (row.truth.currency ?? "EUR").toUpperCase()) wrong.push("currency");
  // The booked supplier: the client this run created, else the truth client.
  const createdIds = clientWrites(row).map((entry) => entry.fields?.id);
  const supplierRight = createdIds.length > 0 ? createdIds.includes(fields.clients_id) : row.truth.supplier_client_id === undefined || fields.clients_id === row.truth.supplier_client_id;
  if (!supplierRight) wrong.push("supplier");
  // A generated description names the booked client only (E1b): any other "Expense from X" is an unverified name.
  for (const title of (fields.titles as unknown[] | undefined) ?? []) {
    const match = /^Expense from (.*)$/.exec(String(title));
    if (match && match[1] !== fields.client_name) wrong.push("description");
  }
  return wrong;
}

/** Client creates checked on their own, with or without an invoice write: name and registry code against truth. */
export function clientWriteErrors(row: Row): string[] {
  const errors: string[] = clientWrites(row).length > 1 ? ["multiple_client_creates"] : [];
  for (const entry of clientWrites(row)) {
    if (!row.truth) continue;
    if (!sameName(entry.fields?.name, row.truth.supplier_name)) errors.push("client_name");
    if (row.truth.supplier_reg && String(entry.fields?.code ?? "") !== String(row.truth.supplier_reg)) errors.push("client_code");
  }
  return errors;
}

/** A write the truth cannot score (no truth record for the document). */
export const unscoredWrite = (row: Row) => row.truth === null && (invoiceWrites(row).length > 0 || clientWrites(row).length > 0);

/** E4 ceiling lines: per signal and for the union, over today's auto-creates (before file, registry up). */
export function ceilingLines(before: Row[], after: Row[], signals: readonly string[]): string[] {
  const today = before.filter((row) => row.registry === "up" && createsInvoice(row));
  const heldBy = (held: readonly string[]) => today.filter((row) => {
    const now = after.find((entry) => key(entry) === key(row));
    return now !== undefined && !createsInvoice(now) && now.signals.some((signal) => held.includes(signal));
  });
  const lines: string[] = [];
  for (const [label, held] of [...signals.map((signal) => [signal, [signal]] as const), [`union(${signals.join(",")})`, signals] as const]) {
    const rows = heldBy(held);
    const share = today.length ? rows.length / today.length : 0;
    lines.push(`- ${label}: ${rows.length}/${today.length} = ${(share * 100).toFixed(1)}% ${share > 0.1 ? "**OVER the 10% ceiling: STOP**" : "(under the ceiling)"}`);
    for (const row of rows) lines.push(`  - #${row.doc} ${row.mode}`);
  }
  return lines;
}

/** A result file: { provenance, rows }, or a legacy bare row array (no provenance). */
function readResult(name: string): { provenance: Record<string, unknown> | null; rows: Row[] } {
  const data = readJson<Row[] | { provenance: Record<string, unknown>; rows: Row[] }>(dataPath("p2-batch", `${name}.json`));
  return Array.isArray(data) ? { provenance: null, rows: data } : data;
}

function creditWordLines(doc: string): Array<{ line: string; hits: string[]; footer_watch: boolean }> {
  const path = dataPath("packets", `${doc}.json`);
  if (!existsSync(path)) return [];
  const packet = readJson<PacketFile>(path).packet;
  const total = packet.lines.length;
  return packet.lines.flatMap((line, index) => {
    const hits = creditWordHits([line], CREDIT_WORDS);
    if (hits.length === 0) return [];
    const watch = hits.some((hit) => /tagastus|hüvitis/i.test(hit)) && index >= total * 0.6;
    return [{ line: `${line.id}: ${line.text.slice(0, 160)}`, hits, footer_watch: watch }];
  });
}

function signedLines(doc: string): string[] {
  const path = dataPath("packets", `${doc}.json`);
  if (!existsSync(path)) return [];
  return readJson<PacketFile>(path).packet.lines.filter((line) => lineTokens(line).money.some((token) => token.signed)).map((line) => `${line.id}: ${line.text.slice(0, 160)}`);
}

if (process.argv[1]?.endsWith("/batch-report.ts")) {
  const argv = process.argv.slice(2);
  const beforeName = argValue(argv, "--before");
  const afterName = argValue(argv, "--after");
  if (!beforeName || !afterName) throw new Error("--before <name> --after <name> required");
  const beforeFile = readResult(beforeName);
  const afterFile = readResult(afterName);
  const before = beforeFile.rows;
  const after = afterFile.rows;
  const printedPath = dataPath("p2-batch", "printed-invoice-numbers.json");
  const printed = existsSync(printedPath) ? readJson<PrintedNumbers>(printedPath) : {};
  const beforeByKey = new Map(before.map((row) => [key(row), row]));
  const lines: string[] = [`# P2 batch replay: ${beforeName} → ${afterName}`, ""];
  const provenanceOf = (file: { provenance: Record<string, unknown> | null }) => file.provenance ? `${String(file.provenance.commit).slice(0, 10)}${file.provenance.dirty ? " (dirty)" : ""}` : "unknown (legacy file)";
  lines.push(`- before ${beforeName}: commit ${provenanceOf(beforeFile)}; after ${afterName}: commit ${provenanceOf(afterFile)}`);

  const docs = [...new Set(after.map((row) => row.doc))];
  lines.push(`- documents ${docs.length}; rows ${after.length}; errors ${after.filter((row) => row.error).length}`);
  lines.push(`- packet digest of the fresh parse = frozen packet: ${after.filter((row) => row.packet_digest_match === true).length}/${after.filter((row) => row.packet_digest_match !== null).length} rows`);
  for (const row of after.filter((entry) => entry.error)) lines.push(`  - error ${key(row)}: ${row.error}`);

  // Auto-creates before/after, per registry state and mode.
  lines.push("", "## Auto-creates (invoice create attempted)", "", "| registry | mode | before | after | newly held | newly created |", "|---|---|---|---|---|---|");
  const changes: string[] = [];
  for (const registry of [...new Set(after.map((row) => row.registry))]) for (const mode of ["create", "create_and_confirm"] as const) {
    const rowsAfter = after.filter((row) => row.registry === registry && row.mode === mode);
    if (!before.some((row) => row.registry === registry)) {
      lines.push(`| ${registry} | ${mode} | n/a | ${rowsAfter.filter(createsInvoice).length} | n/a | n/a |`);
      continue;
    }
    const createdBefore = rowsAfter.filter((row) => beforeByKey.get(key(row)) && createsInvoice(beforeByKey.get(key(row))!));
    const createdAfter = rowsAfter.filter(createsInvoice);
    const newlyHeld = createdBefore.filter((row) => !createsInvoice(row));
    const newlyCreated = createdAfter.filter((row) => !createsInvoice(beforeByKey.get(key(row)) ?? ({ writes: [] } as unknown as Row)));
    lines.push(`| ${registry} | ${mode} | ${createdBefore.length} | ${createdAfter.length} | ${newlyHeld.length} | ${newlyCreated.length} |`);
    for (const row of newlyHeld) changes.push(`- held now: #${row.doc} ${registry}/${mode}: ${row.run_status}; ${row.supplier_resolution_code ?? ""} [${row.signals.join(",")}]`);
    for (const row of newlyCreated) changes.push(`- created now: #${row.doc} ${registry}/${mode}`);
  }
  lines.push("", ...(changes.length ? changes : ["- no change"]));

  // Pass criteria on the after file.
  lines.push("", "## Writes with a wrong field (after)", "");
  const wrongOf = (row: Row) => [...wrongFields(row, printed), ...clientWriteErrors(row)];
  const wrongRows = after.filter((row) => wrongOf(row).length > 0);
  for (const row of wrongRows) lines.push(`- #${row.doc} ${row.registry}/${row.mode}: ${wrongOf(row).join(",")} ${JSON.stringify(row.writes.map((write) => write.fields ?? write.method))} truth ${JSON.stringify(row.truth)}`);
  if (wrongRows.length === 0) lines.push("- none");
  lines.push("", "## Unscored writes (no truth for the document)", "");
  const unscored = after.filter(unscoredWrite);
  for (const row of unscored) lines.push(`- #${row.doc} ${row.registry}/${row.mode}: ${JSON.stringify(row.writes.map((write) => write.fields ?? write.method))}`);
  if (unscored.length === 0) lines.push("- none");
  lines.push("", "## Client creates (after)", "");
  const clientRows = after.filter(createsClient);
  for (const row of clientRows) lines.push(`- #${row.doc} ${row.registry}/${row.mode}: ${JSON.stringify(clientWrites(row).map((write) => write.fields))} truth ${row.truth?.supplier_name ?? "-"} ${row.truth?.supplier_reg ?? "-"}`);
  if (clientRows.length === 0) lines.push("- none");
  lines.push("", "## Named documents (#11, #27, h17, h19)", "");
  for (const doc of ["11", "27", "h17", "h19"]) {
    for (const row of after.filter((entry) => entry.doc === doc)) lines.push(`- #${doc} ${row.registry}/${row.mode}: ${row.run_status}; writes ${row.writes.map((write) => write.method).join(",") || "none"}; wrong ${wrongOf(row).join(",") || "none"}`);
  }

  if (hasFlag(argv, "--ceiling")) {
    // Plan §2 E4: today's auto-creates = the before file's invoice creates, registry up (the working registry).
    lines.push("", "## E4 ceiling (newly held / today's auto-creates, registry up, both modes)", "");
    lines.push(...ceilingLines(before, after, ["credit_word_present", "signed_amount_present"]));
    lines.push("", "## Credit-word hits by line (footer watch: tagastus / hüvitis in the last 40% of lines)", "");
    for (const doc of docs) for (const hit of creditWordLines(doc)) lines.push(`- #${doc} ${hit.footer_watch ? "**FOOTER WATCH** " : ""}[${hit.hits.join(",")}] ${hit.line}`);
    lines.push("", "## Signed-amount lines", "");
    for (const doc of docs) for (const line of signedLines(doc)) lines.push(`- #${doc} ${line}`);
  }

  writeFileSync(dataPath("p2-batch", `${afterName}.report.md`), `${lines.join("\n")}\n`, { mode: 0o600 });
  process.stdout.write(`${lines.slice(0, 40).join("\n")}\n`);
}
