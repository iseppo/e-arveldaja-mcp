import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { toMcpJson } from "../src/mcp-json.js";

export const REQUIRED_RESPONSE_FIXTURE_NAMES = [
  "camt-10",
  "camt-100",
  "camt-1000",
  "receipts-10",
  "receipts-100",
  "classifications-10",
  "classifications-100",
  "accounting-inbox-1",
  "accounting-inbox-20",
  "accounting-inbox-100",
  "plan-page-first",
  "plan-page-second",
  "generic-batch-30",
  "generic-batch-100",
] as const;

export type ResponseFixtureName = typeof REQUIRED_RESPONSE_FIXTURE_NAMES[number];

export interface ResponseFixture {
  name: ResponseFixtureName;
  category: string;
  itemCount: number;
  payload: Record<string, unknown>;
  encoded: string;
}

export interface ResponseFixtureMeasurement {
  name: ResponseFixtureName;
  category: string;
  itemCount: number;
  encoding: "json" | "toon";
  encodedBytes: number;
  jsonBytes: number;
  sha256: string;
}

export interface ResponseFixtureBaseline {
  schema: "context-budget-baseline-v1";
  fixtures: ResponseFixtureMeasurement[];
}

function numbered(length: number): number[] {
  return Array.from({ length }, (_, index) => index + 1);
}

function camtPayload(rows: number): Record<string, unknown> {
  return {
    contract: "camt_import_preview_v1",
    statement: { iban: "EE637700771011212909", currency: "EUR", rows },
    transactions: numbered(rows).map((index) => ({
      row: index,
      booking_date: `2026-06-${String(((index - 1) % 28) + 1).padStart(2, "0")}`,
      amount: Number((12.35 + index * 1.17).toFixed(2)),
      direction: index % 3 === 0 ? "CRDT" : "DBIT",
      counterparty: `Counterparty ${String(index).padStart(4, "0")}`,
      counterparty_iban: `EE${String(100000000000000000n + BigInt(index)).padStart(18, "0")}`,
      bank_reference: `CAMT-${String(index).padStart(6, "0")}`,
      description: `Statement row ${index} deterministic fixture`,
      status: index % 7 === 0 ? "duplicate" : "ready",
    })),
    counts: { total: rows, ready: rows - Math.floor(rows / 7), duplicate: Math.floor(rows / 7) },
  };
}

function receiptPayload(files: number): Record<string, unknown> {
  return {
    contract: "receipt_scan_v1",
    folder_ref: "<ABSOLUTE_PATH>",
    files: numbered(files).map((index) => ({
      file_ref: `<FILE_REF_${String(index).padStart(4, "0")}>`,
      display_name: `receipt-${String(index).padStart(4, "0")}.pdf`,
      bytes: 25_000 + index * 137,
      modified_at: "<TIMESTAMP>",
      media_type: "application/pdf",
      status: index % 9 === 0 ? "needs_ocr" : "ready",
    })),
    counts: { total: files, ready: files - Math.floor(files / 9), needs_ocr: Math.floor(files / 9) },
  };
}

function classificationPayload(groups: number): Record<string, unknown> {
  return {
    contract: "classification_groups_v1",
    groups: numbered(groups).map((index) => ({
      group_id: `group-${String(index).padStart(4, "0")}`,
      signature: `merchant-${String(index).padStart(4, "0")}|out|eur`,
      transaction_ids: numbered(3).map((offset) => index * 1000 + offset),
      sample_description: `Merchant ${index} monthly service`,
      proposed_account: { id: 5000 + (index % 20), code: String(5000 + (index % 20)), name: `Expense ${index % 20}` },
      confidence: Number((0.7 + (index % 25) / 100).toFixed(2)),
      ambiguity: index % 8 === 0 ? "confirm supplier-specific exception" : null,
    })),
    counts: { groups, transactions: groups * 3, ambiguous: Math.floor(groups / 8) },
  };
}

function accountingInboxPayload(reviewItems: number): Record<string, unknown> {
  return {
    contract: "accounting_inbox_v1",
    workspace_ref: "<ABSOLUTE_PATH>",
    review_items: numbered(reviewItems).map((index) => ({
      review_id: `review-${String(index).padStart(4, "0")}`,
      source: ["camt", "wise", "receipt"][index % 3],
      reason: index % 4 === 0 ? "ambiguous_account" : "approval_required",
      amount: Number((20 + index * 3.21).toFixed(2)),
      currency: "EUR",
      occurred_on: `2026-06-${String(((index - 1) % 28) + 1).padStart(2, "0")}`,
      counterparty: `Inbox Counterparty ${index}`,
      technical_ids: { transaction_id: 70_000 + index, source_ref: `SRC-${String(index).padStart(6, "0")}` },
      question: index % 4 === 0
        ? `Which expense account should be used for item ${index}?`
        : `Approve the proposed mutation for item ${index}?`,
    })),
    counts: { review: reviewItems, approval_required: reviewItems - Math.floor(reviewItems / 4), ambiguous: Math.floor(reviewItems / 4) },
  };
}

function planPagePayload(page: 1 | 2): Record<string, unknown> {
  const from = page === 1 ? 1 : 51;
  const to = page === 1 ? 50 : 100;
  return {
    contract: "execution_plan_page_v1",
    plan_handle: "<HANDLE>",
    plan_schema: "execution_plan_v1",
    operation: "generic_batch",
    total_commands: 100,
    category_counts: { create: 100 },
    monetary_totals: { eur: 12_345.67 },
    section: "commands",
    section_total: 100,
    range: { from, to, count: 50 },
    current_cursor: page === 1 ? null : "<CURSOR_PAGE_2>",
    next_cursor: page === 1 ? "<CURSOR_PAGE_2>" : null,
    review_sections: {
      exclusions: { count: 2, page_reference: { tool: "get_execution_plan_page", args: { plan_handle: "<HANDLE>", section: "exclusions" } } },
      reviews: { count: 4, page_reference: { tool: "get_execution_plan_page", args: { plan_handle: "<HANDLE>", section: "reviews" } } },
    },
    commands: numbered(50).map((offset) => {
      const index = from + offset - 1;
      return {
        command_id: `create:${String(index).padStart(4, "0")}`,
        category: "create",
        review_data: `{"amount":${(100 + index / 100).toFixed(2)},"counterparty":"Batch ${index}"}`,
      };
    }),
  };
}

function genericBatchPayload(transactions: number): Record<string, unknown> {
  return {
    contract: "generic_batch_preview_v1",
    plan_handle: "<HANDLE>",
    transactions: numbered(transactions).map((index) => ({
      command_id: `transaction:${String(index).padStart(4, "0")}`,
      transaction_id: 80_000 + index,
      amount: Number((5 + index * 2.05).toFixed(2)),
      direction: index % 2 === 0 ? "IN" : "OUT",
      proposed_account_id: 5000 + (index % 15),
      counterparty: `Generic Batch ${index}`,
      approval_required: true,
    })),
    counts: { total: transactions, approval_required: transactions },
  };
}

function fixture(name: ResponseFixtureName, category: string, itemCount: number, payload: Record<string, unknown>): ResponseFixture {
  return { name, category, itemCount, payload, encoded: toMcpJson(payload) };
}

export async function buildResponseFixtures(): Promise<ResponseFixture[]> {
  return [
    fixture("camt-10", "camt", 10, camtPayload(10)),
    fixture("camt-100", "camt", 100, camtPayload(100)),
    fixture("camt-1000", "camt", 1000, camtPayload(1000)),
    fixture("receipts-10", "receipts", 10, receiptPayload(10)),
    fixture("receipts-100", "receipts", 100, receiptPayload(100)),
    fixture("classifications-10", "classification", 10, classificationPayload(10)),
    fixture("classifications-100", "classification", 100, classificationPayload(100)),
    fixture("accounting-inbox-1", "accounting-inbox", 1, accountingInboxPayload(1)),
    fixture("accounting-inbox-20", "accounting-inbox", 20, accountingInboxPayload(20)),
    fixture("accounting-inbox-100", "accounting-inbox", 100, accountingInboxPayload(100)),
    fixture("plan-page-first", "plan-page", 50, planPagePayload(1)),
    fixture("plan-page-second", "plan-page", 50, planPagePayload(2)),
    fixture("generic-batch-30", "generic-batch", 30, genericBatchPayload(30)),
    fixture("generic-batch-100", "generic-batch", 100, genericBatchPayload(100)),
  ];
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export async function measureResponseFixtures(): Promise<ResponseFixtureBaseline> {
  const fixtures = await buildResponseFixtures();
  return {
    schema: "context-budget-baseline-v1",
    fixtures: fixtures.map(({ name, category, itemCount, payload, encoded }) => ({
      name,
      category,
      itemCount,
      encoding: isJson(encoded) ? "json" : "toon",
      encodedBytes: Buffer.byteLength(encoded, "utf8"),
      jsonBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
      sha256: createHash("sha256").update(encoded).digest("hex"),
    })),
  };
}

function parseOutputPath(argv: string[]): string | undefined {
  const index = argv.indexOf("--output");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--output requires an explicit JSON path");
  return resolve(value);
}

async function readBaseline(): Promise<ResponseFixtureBaseline | undefined> {
  try {
    return JSON.parse(await readFile(new URL("../testdata/context-budgets.json", import.meta.url), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function signedDelta(current: number, baseline: number | undefined): string {
  if (baseline === undefined) return "baseline unavailable";
  const delta = current - baseline;
  return `${delta >= 0 ? "+" : ""}${delta}`;
}

async function main(): Promise<void> {
  const result = await measureResponseFixtures();
  const outputPath = parseOutputPath(process.argv.slice(2));
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  const baseline = await readBaseline();
  const previous = new Map(baseline?.fixtures.map((entry) => [entry.name, entry]));
  for (const entry of result.fixtures) {
    process.stdout.write(
      `${entry.name}: ${entry.encodedBytes} B (${signedDelta(entry.encodedBytes, previous.get(entry.name)?.encodedBytes)}), ` +
      `${entry.encoding}, json=${entry.jsonBytes} B (${signedDelta(entry.jsonBytes, previous.get(entry.name)?.jsonBytes)}), ` +
      `sha256=${entry.sha256.slice(0, 12)}\n`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
