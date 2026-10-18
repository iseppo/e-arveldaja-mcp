// Synthetic fixtures for the P2 D verified-draft path (no corpus text): the clean
// invoice of invoice.ts as a parse, a reading and proof bound to its real packet,
// and a workflow API whose own company, supplier and history fit it.
import { vi } from "vitest";
import { buildReadingPacket, type ReadingPacket } from "../../document-reading-packet.js";
import type { ReadingField } from "../../document-reading-schemas.js";
import type { ParsedDocument } from "../../document-parser.js";
import { packetInputFromParse } from "../../tools/document-text-hazards.js";
import { READING_PARSER_VERSION } from "../../documents/reading-operations.js";
import { createAccountingWorkflowApi, fixtureAccount, fixtureClient } from "../accounting-workflow.js";
import { BASE_EVIDENCE, BASE_LABELS, BASE_LINES, BASE_VALUES } from "./invoice.js";
import { makeAnswer, makeProof, makeReading } from "./readings.js";
import { parseOfLines } from "./text-hazard-parses.js";
import { predictPurchaseItemAmounts } from "../../api/purchase-invoices.api.js";
import { parseVatRateDropdown } from "../../money.js";

export { BASE_LINES };
export const OWN_CLIENT_ID = 1;
export const SUPPLIER_ID = 4242;
/** The clean invoice is dated 2026-03-15; the checker's date window is relative to this day. */
export const FIXTURE_NOW = new Date("2026-04-01T09:00:00Z");

export function readingParse(lines: string[] = BASE_LINES): ParsedDocument {
  return parseOfLines(lines);
}

export function packetFor(sha256: string, lines: string[] = BASE_LINES): ReadingPacket {
  return buildReadingPacket(packetInputFromParse(readingParse(lines), sha256, READING_PARSER_VERSION));
}

export interface ReadingCaseInput {
  values?: Record<string, unknown>;
  evidence?: Record<string, { line: string; quote: string } | undefined>;
  labels?: Partial<Record<ReadingField, string | null>>;
  answers?: Partial<Record<ReadingField, Record<string, unknown>>>;
  extra?: Record<string, unknown>;
}

/** A reading + proof of the clean invoice bound to `packet` (accepted by the checker as is). */
export function readingFor(packet: ReadingPacket, input: ReadingCaseInput = {}): { reading: Record<string, unknown>; proof: Record<string, unknown> } {
  const evidence = Object.fromEntries(Object.entries({ ...BASE_EVIDENCE, ...input.evidence }).filter(([, entry]) => entry !== undefined));
  const reading = makeReading({
    ...BASE_VALUES,
    ...input.values,
    source_sha256: packet.source_sha256,
    packet_digest: packet.packet_digest,
    evidence,
    ...input.extra,
  });
  const answers: Partial<Record<ReadingField, Record<string, unknown>>> = {};
  for (const [field, label] of Object.entries({ ...BASE_LABELS, ...input.labels })) {
    answers[field as ReadingField] = makeAnswer({ label_quote: label ?? null });
  }
  const proof = makeProof({ ...answers, ...input.answers }, { source_sha256: packet.source_sha256, packet_digest: packet.packet_digest });
  return { reading, proof };
}

export const ownClient = () => fixtureClient({ id: OWN_CLIENT_ID, name: "Ostja AS", code: "10000024", invoice_vat_no: "EE100000010", cl_code_country: "EST" });
export const supplierClient = () => fixtureClient({ id: SUPPLIER_ID, name: "Näidis OÜ", code: "10000018", invoice_vat_no: "EE100000007", cl_code_country: "EST" });

/** The supplier's last confirmed invoice: the server's one-item booking suggestion comes from it. */
export const HISTORY_INVOICE = {
  id: 501, clients_id: SUPPLIER_ID, client_name: "Näidis OÜ", number: "A-01", create_date: "2026-01-10", gross_price: 62, status: "CONFIRMED",
};
export const HISTORY_DETAIL = {
  ...HISTORY_INVOICE,
  liability_accounts_id: 2310,
  items: [{ custom_title: "Teenus", cl_purchase_articles_id: 1, purchase_accounts_id: 5000, total_net_price: 50, vat_rate_dropdown: "24", vat_accounts_id: 1510 }],
};

export interface ReadingApiOptions {
  purchaseInvoiceRows?: unknown[];
  journals?: unknown[];
  clientRows?: unknown[];
  withHistory?: boolean;
  createAndSetTotals?: ReturnType<typeof vi.fn>;
  allowWrites?: boolean;
}

export function readingApi(options: ReadingApiOptions = {}) {
  const history = options.withHistory === false ? [] : [HISTORY_INVOICE];
  const rows = [...history, ...(options.purchaseInvoiceRows ?? [])];
  const details: Record<number, unknown> = options.withHistory === false ? {} : { [HISTORY_INVOICE.id]: HISTORY_DETAIL };
  return createAccountingWorkflowApi({
    allowWrites: options.allowWrites,
    clientRows: (options.clientRows ?? [ownClient(), supplierClient()]) as never,
    accounts: [
      fixtureAccount({ id: 5000, name_est: "Teenused" }),
      fixtureAccount({ id: 1510, name_est: "Sisendkäibemaks", is_vat_account: true }),
    ],
    clients: { get: vi.fn().mockImplementation(async (id: number) => (id === SUPPLIER_ID ? supplierClient() : ownClient())) },
    journals: { listAll: vi.fn().mockResolvedValue(options.journals ?? []), listAllWithPostings: vi.fn().mockResolvedValue([]) },
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue(rows),
      get: vi.fn().mockImplementation(async (id: number) => {
        const detail = details[id];
        if (!detail) throw new Error(`Missing purchase invoice ${id}`);
        return detail;
      }),
      ...(options.createAndSetTotals ? { createAndSetTotals: options.createAndSetTotals } : {}),
      uploadDocument: vi.fn().mockResolvedValue({}),
    },
    readonly: {
      getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE100000010" }),
      getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Ostja AS" }),
    },
  } as never);
}

/**
 * The fields the live GET computes and returns (live presence check 2026-10-18), on top of what was written: the
 * invoice net and base amounts, and per item the VAT, VAT rate, unit and base net and the #62 structural defaults.
 * Fields the write already set are kept.
 */
export function served(data: Record<string, any>, vat?: number, gross?: number) {
  const items = (data.items ?? []) as Array<Record<string, any>>;
  const amounts = predictPurchaseItemAmounts(items as never);
  const net = Math.round(amounts.reduce((sum, entry) => sum + entry.net, 0) * 100) / 100;
  return {
    net_price: data.net_price ?? net, base_net_price: data.base_net_price ?? net, base_vat_price: data.base_vat_price ?? vat, base_gross_price: data.base_gross_price ?? gross,
    items: items.map((item, index) => ({
      amount: 1, cl_fringe_benefits_id: 1, vat_amount: amounts[index]!.vat, vat_rate: parseVatRateDropdown(item.vat_rate_dropdown),
      unit_net_price: null, base_total_net_price: amounts[index]!.net, ...item,
    })),
  };
}
