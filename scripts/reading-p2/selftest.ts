// Scorer self-test for batch-report.ts (Codex r4 probes): each probe is a wrong write the scorer must report.
// Usage: npx tsx scripts/reading-p2/selftest.ts → exit 1 on any failed check.

import { ceilingLines, clientWriteErrors, unscoredWrite, wrongFields, type Row } from "./batch-report.js";

let failed = 0;
const assert = (name: string, ok: boolean, show: unknown) => {
  process.stdout.write(`${ok ? "OK  " : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(show)}`}\n`);
  if (!ok) failed += 1;
};

const truth = { invoice_number: "delfi_08_2026", invoice_date: "2026-08-31", gross: 12.4, currency: "EUR", supplier_client_id: 17, supplier_name: "Näidis Meedia AS", supplier_reg: "10000017" };
const invoice = (fields: Record<string, unknown>) => ({ method: "purchaseInvoices.createAndSetTotals", fields: { clients_id: 17, client_name: "Näidis Meedia AS", number: "UP4JS131YSY2", create_date: "2026-08-31", gross_price: 12.4, cl_currencies_id: "EUR", titles: [], ...fields } });
const row = (writes: Row["writes"], over: Partial<Row> = {}): Row => ({
  doc: "h01", scope: "heldout", registry: "up", mode: "create", packet_digest_match: true, dry_status: "dry_run_preview", run_status: "created",
  signals: [], notes: [], supplier_resolution_code: null, writes, truth, ...over,
});
const printed = { h01: "UP4JS131YSY2" };

const right = row([invoice({})]);
assert("control_right_write_scores_clean", wrongFields(right, printed).length === 0 && clientWriteErrors(right).length === 0, wrongFields(right, printed));
// Probe 1: the order reference (printed on the document as a whole token) used as the invoice number.
const orderRef = row([invoice({ number: "RCWOVV0O19CF" })]);
assert("probe_order_ref_as_invoice_number", wrongFields(orderRef, printed).includes("number"), wrongFields(orderRef, printed));
// Probe 2: a USD document booked as EUR.
const usd = row([invoice({ gross_price: 12.4 })], { truth: { ...truth, currency: "USD" } });
assert("probe_usd_booked_as_eur", wrongFields(usd, printed).includes("currency"), wrongFields(usd, printed));
// Probe 3: a wrong client created, with no invoice write.
const clientOnly = row([{ method: "clients.create", fields: { name: "Tellimuse Keskus OÜ", code: "99999999", id: 9000000 } }], { run_status: "needs_review" });
assert("probe_wrong_client_only_create", clientWriteErrors(clientOnly).includes("client_name") && clientWriteErrors(clientOnly).includes("client_code"), clientWriteErrors(clientOnly));
// A created client the invoice does not use is a wrong supplier.
const otherClient = row([{ method: "clients.create", fields: { name: truth.supplier_name, code: truth.supplier_reg, id: 9000000 } }, invoice({ clients_id: 17 })]);
assert("created_client_not_booked_is_wrong_supplier", wrongFields(otherClient, printed).includes("supplier") && clientWriteErrors(otherClient).length === 0, wrongFields(otherClient, printed));
assert("no_truth_write_is_unscored", unscoredWrite(row([invoice({})], { truth: null })) && !unscoredWrite(right), null);

// Combined E4 ceiling: two disjoint 1/16 holds (6.25% each) are 12.5% together: over the ceiling.
const today = Array.from({ length: 16 }, (_, index) => row([invoice({})], { doc: `d${index}` }));
const after = today.map((entry, index) => index === 0 ? { ...entry, writes: [], signals: ["credit_word_present"] } : index === 1 ? { ...entry, writes: [], signals: ["signed_amount_present"] } : entry);
const ceiling = ceilingLines(today, after, ["credit_word_present", "signed_amount_present"]);
assert("ceiling_per_signal_under", ceiling.filter((line) => /^- (credit|signed)/.test(line)).every((line) => line.includes("under the ceiling")), ceiling);
assert("ceiling_union_over", ceiling.some((line) => line.startsWith("- union(") && line.includes("2/16") && line.includes("OVER")), ceiling);

if (failed > 0) {
  process.stdout.write(`${failed} failed\n`);
  process.exit(1);
}
process.stdout.write("all OK\n");
