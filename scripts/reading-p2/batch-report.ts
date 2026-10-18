// P2 §4 E batch replay report: compares two batch-replay result files (before → after) and checks the pass
// criteria on the after file. Private output under <data>/p2-batch/.
//
// Usage: npx tsx scripts/reading-p2/batch-report.ts --before <name> --after <name> [--ceiling] → p2-batch/<after>.report.md
//   --ceiling: the E4 stop rule (plan §2 E4): newly held auto-creates over today's (before) auto-creates, > 10% stops.

import { existsSync, writeFileSync } from "node:fs";
import { CREDIT_WORDS } from "../../src/document-reading-check.js";
import { creditWordHits, lineTokens } from "../../src/document-reading-tokens.js";
import { normalizeInvoiceNumberForComparison } from "../../src/purchase-invoice-status.js";
import type { PacketFile } from "../reading-p1/build-packets.js";
import { argValue, dataPath, hasFlag, readJson } from "../reading-p1/common.js";

interface Row {
  doc: string;
  scope: string;
  registry: "down" | "up";
  mode: "create" | "create_and_confirm";
  packet_digest_match: boolean | null;
  dry_status: string | null;
  run_status: string | null;
  signals: string[];
  notes: string[];
  supplier_resolution_code: string | null;
  writes: Array<{ method: string; fields?: Record<string, unknown> }>;
  truth: { invoice_number?: string; invoice_date?: string; gross?: number; currency?: string; supplier_client_id?: number; supplier_name?: string } | null;
  error?: string;
}

const key = (row: Row) => `${row.doc}|${row.registry}|${row.mode}`;
const createsInvoice = (row: Row) => row.writes.some((write) => write.method === "purchaseInvoices.createAndSetTotals");
const createsClient = (row: Row) => row.writes.some((write) => write.method === "clients.create");

/** Fields of an invoice write that differ from truth (truth-available documents only). */
function wrongFields(row: Row): string[] {
  const write = row.writes.find((entry) => entry.method === "purchaseInvoices.createAndSetTotals");
  if (!write?.fields || !row.truth) return [];
  const fields = write.fields;
  const wrong: string[] = [];
  // Invoice-number truth is the printed number (owner): a written number printed on the document as a whole
  // token is right even where the booking used another reference.
  if (row.truth.invoice_number !== undefined && normalizeInvoiceNumberForComparison(String(fields.number ?? "")) !== normalizeInvoiceNumberForComparison(row.truth.invoice_number) &&
    !printedToken(row.doc, String(fields.number ?? ""))) wrong.push("number");
  if (row.truth.invoice_date !== undefined && fields.create_date !== row.truth.invoice_date) wrong.push("date");
  if (typeof row.truth.gross === "number" && typeof fields.gross_price === "number" && Math.abs(fields.gross_price - row.truth.gross) > 0.005) wrong.push("gross");
  if (fields.cl_currencies_id !== "EUR") wrong.push("currency");
  if (row.truth.supplier_client_id !== undefined && !createsClient(row) && fields.clients_id !== row.truth.supplier_client_id) wrong.push("supplier");
  // A generated description names the booked client only (E1b): any other "Expense from X" is an unverified name.
  for (const title of (fields.titles as unknown[] | undefined) ?? []) {
    const match = /^Expense from (.*)$/.exec(String(title));
    if (match && match[1] !== fields.client_name) wrong.push("description");
  }
  return wrong;
}

function printedToken(doc: string, value: string): boolean {
  const path = dataPath("packets", `${doc}.json`);
  if (!value || !existsSync(path)) return false;
  return readJson<PacketFile>(path).packet.lines.some((line) => line.text.split(/[\s¦]+/).includes(value));
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
  const before = readJson<Row[]>(dataPath("p2-batch", `${beforeName}.json`));
  const after = readJson<Row[]>(dataPath("p2-batch", `${afterName}.json`));
  const beforeByKey = new Map(before.map((row) => [key(row), row]));
  const lines: string[] = [`# P2 batch replay: ${beforeName} → ${afterName}`, ""];

  const docs = [...new Set(after.map((row) => row.doc))];
  lines.push(`- documents ${docs.length}; rows ${after.length}; errors ${after.filter((row) => row.error).length}`);
  lines.push(`- packet digest of the fresh parse = frozen packet: ${after.filter((row) => row.packet_digest_match === true).length}/${after.filter((row) => row.packet_digest_match !== null).length} rows`);
  for (const row of after.filter((entry) => entry.error)) lines.push(`  - error ${key(row)}: ${row.error}`);

  // Auto-creates before/after, per registry state and mode.
  lines.push("", "## Auto-creates (invoice create attempted)", "", "| registry | mode | before | after | newly held | newly created |", "|---|---|---|---|---|---|");
  const changes: string[] = [];
  for (const registry of ["down", "up"] as const) for (const mode of ["create", "create_and_confirm"] as const) {
    const rowsAfter = after.filter((row) => row.registry === registry && row.mode === mode);
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
  const wrongRows = after.filter((row) => wrongFields(row).length > 0);
  for (const row of wrongRows) lines.push(`- #${row.doc} ${row.registry}/${row.mode}: ${wrongFields(row).join(",")} ${JSON.stringify(row.writes.find((write) => write.method === "purchaseInvoices.createAndSetTotals")?.fields)} truth ${JSON.stringify(row.truth)}`);
  if (wrongRows.length === 0) lines.push("- none");
  lines.push("", "## Client creates (after)", "");
  const clientRows = after.filter(createsClient);
  for (const row of clientRows) lines.push(`- #${row.doc} ${row.registry}/${row.mode}: ${JSON.stringify(row.writes.find((write) => write.method === "clients.create")?.fields)} truth ${row.truth?.supplier_name ?? "-"}`);
  if (clientRows.length === 0) lines.push("- none");
  lines.push("", "## Named documents (#11, #27, h17, h19)", "");
  for (const doc of ["11", "27", "h17", "h19"]) {
    for (const row of after.filter((entry) => entry.doc === doc)) lines.push(`- #${doc} ${row.registry}/${row.mode}: ${row.run_status}; writes ${row.writes.map((write) => write.method).join(",") || "none"}; wrong ${wrongFields(row).join(",") || "none"}`);
  }

  if (hasFlag(argv, "--ceiling")) {
    // Plan §2 E4: today's auto-creates = the before file's invoice creates, registry up (the working registry).
    const today = before.filter((row) => row.registry === "up" && createsInvoice(row));
    const heldBy = (signal: string) => today.filter((row) => {
      const now = after.find((entry) => key(entry) === key(row));
      return now !== undefined && !createsInvoice(now) && now.signals.includes(signal);
    });
    lines.push("", "## E4 ceiling (newly held / today's auto-creates, registry up, both modes)", "");
    for (const signal of ["credit_word_present", "signed_amount_present"]) {
      const held = heldBy(signal);
      const share = today.length ? held.length / today.length : 0;
      lines.push(`- ${signal}: ${held.length}/${today.length} = ${(share * 100).toFixed(1)}% ${share > 0.1 ? "**OVER the 10% ceiling: STOP**" : "(under the ceiling)"}`);
      for (const row of held) lines.push(`  - #${row.doc} ${row.mode}`);
    }
    lines.push("", "## Credit-word hits by line (footer watch: tagastus / hüvitis in the last 40% of lines)", "");
    for (const doc of docs) for (const hit of creditWordLines(doc)) lines.push(`- #${doc} ${hit.footer_watch ? "**FOOTER WATCH** " : ""}[${hit.hits.join(",")}] ${hit.line}`);
    lines.push("", "## Signed-amount lines", "");
    for (const doc of docs) for (const line of signedLines(doc)) lines.push(`- #${doc} ${line}`);
  }

  writeFileSync(dataPath("p2-batch", `${afterName}.report.md`), `${lines.join("\n")}\n`, { mode: 0o600 });
  process.stdout.write(`${lines.slice(0, 40).join("\n")}\n`);
}
