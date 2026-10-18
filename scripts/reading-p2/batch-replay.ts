// P2 §4 E batch replay: the REAL receipt_batch path (batch-operations.ts, receipt-inbox-booking.ts,
// supplier-resolution.ts) over the frozen documents of both scopes, against a recording mock API seeded from the
// read-only snapshots. Nothing reaches e-arveldaja or the business registry: every write is recorded and answered
// locally, and fetch (the registry lookup) is replaced by a stub.
//
// Per document × registry (down | up) × mode (create | create_and_confirm): the dry run (preview) and the approved
// run, the writes attempted (client creates, invoice creates, confirms) with the fields written, and the gate
// signals. The packet digest of the fresh parse is checked against the frozen packet (same liteparse build).
//
// Usage: npx tsx --import ./scripts/reading-p2/register.mjs scripts/reading-p2/batch-replay.ts --out <name>
//          [--only 10,h25] [--modes create,create_and_confirm] [--registries down,up,up-down,down-up,error] [--no-digest]
// Registry states: down (no answer), up (the truth supplier's name), up-down / down-up (one state in the dry run, the
// other in the approved run: a transition between preview and execute), error (every lookup throws).
// register.mjs serves every parse from the frozen-parse cache (cached-parser.ts): one real parse per file.
//   → <data>/p2-batch/<name>.json (private data dir, gitignored)

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseDocument } from "../../src/document-parser.js";
import { createReceiptBatchOperations } from "../../src/receipts/batch-operations.js";
import { createTestRuntimeSafetyContext } from "../../src/__fixtures__/runtime-safety.js";
import type { Client, PurchaseInvoice } from "../../src/types/api.js";
import type { OwnIds, PacketFile } from "../reading-p1/build-packets.js";
import { SCOPES, argValue, dataPath, manifest, readJson, sha256Hex, writeJson, type Scope } from "../reading-p1/common.js";
import { loadSnapshot, withoutOwnBooking, type Snapshot } from "../reading-p1/pipeline.js";
import type { TruthRecord } from "../reading-p1/truth.js";

type Mode = "create" | "create_and_confirm";
const DIGEST = !process.argv.includes("--no-digest");
const REGISTRIES = ["down", "up", "up-down", "down-up", "error"] as const;
type Registry = typeof REGISTRIES[number];
type Phase = "dry" | "run";
/** The registry answer a state gives in a phase. */
const registryIn = (registry: Registry, phase: Phase): "down" | "up" | "error" =>
  registry === "up-down" ? (phase === "dry" ? "up" : "down") : registry === "down-up" ? (phase === "dry" ? "down" : "up") : registry;

interface Write { method: string; payload: unknown; result?: unknown }

/** Reads come from the snapshot; every other call is a write: recorded, answered locally. */
function recordingApi(snapshot: Snapshot, writes: Write[], ownVat: string | null) {
  const clients: Client[] = snapshot.clients.map((client) => ({ ...client }));
  const created = new Map<number, PurchaseInvoice>();
  let nextId = 9_000_000;
  const record = (method: string, payload: unknown, result: unknown) => writes.push({ method, payload: JSON.parse(JSON.stringify(payload ?? null)), result: JSON.parse(JSON.stringify(result ?? null)) });
  const noop = async () => undefined;
  const journals = async () => {
    if (snapshot.journals === "unavailable") throw new Error("journals unavailable in the snapshot");
    return snapshot.journals;
  };
  const write = (method: string, answer: (payload: unknown) => unknown) => async (...args: unknown[]) => {
    const result = answer(args[0]);
    record(method, args, result);
    return result;
  };
  return {
    clients: {
      listAll: async () => clients.map((client) => ({ ...client })),
      get: async (id: number) => clients.find((client) => client.id === id),
      invalidateListCache: noop,
      create: write("clients.create", (payload) => {
        const id = nextId++;
        clients.push({ ...(payload as Client), id, is_deleted: false } as Client);
        return { created_object_id: id };
      }),
    },
    purchaseInvoices: {
      listAll: async () => [...snapshot.purchaseInvoices, ...created.values()],
      get: async (id: number) => created.get(id) ?? snapshot.details.find((detail) => detail.id === id) ?? snapshot.purchaseInvoices.find((invoice) => invoice.id === id),
      invalidateListCache: noop,
      createAndSetTotals: write("purchaseInvoices.createAndSetTotals", (payload) => {
        const data = payload as Record<string, unknown>;
        const invoice = { ...data, id: nextId++, status: "PROJECT", cl_currencies_id: data.cl_currencies_id ?? "EUR" } as unknown as PurchaseInvoice;
        created.set(invoice.id!, invoice);
        return invoice;
      }),
      uploadDocument: write("purchaseInvoices.uploadDocument", () => undefined),
      confirmWithTotals: write("purchaseInvoices.confirmWithTotals", () => undefined),
      invalidate: write("purchaseInvoices.invalidate", () => undefined),
      delete: write("purchaseInvoices.delete", () => undefined),
    },
    transactions: {
      listAll: async () => snapshot.transactions,
      get: async (id: number) => snapshot.transactions.find((transaction) => transaction.id === id),
      invalidateListCache: noop,
      confirm: write("transactions.confirm", () => undefined),
      update: write("transactions.update", () => undefined),
    },
    journals: { listAll: journals, listAllWithPostings: journals, invalidateListCache: noop },
    saleInvoices: { listAll: async () => [] },
    readonly: {
      getAccounts: async () => readSnapshotFile(snapshot.company, "accounts") ?? [],
      getPurchaseArticles: async () => snapshot.purchaseArticles,
      getVatInfo: async () => readSnapshotFile(snapshot.company, "vat_info") ?? (ownVat ? { vat_number: ownVat } : {}),
      getBankAccounts: async () => snapshot.bankAccounts,
      getAccountDimensions: async () => snapshot.accountDimensions,
      getInvoiceInfo: async () => readSnapshotFile(snapshot.company, "invoice_info") ?? {},
    },
  };
}

function readSnapshotFile<T>(company: string, name: string): T | undefined {
  const path = dataPath("snapshots", company, `${name}.json`);
  return existsSync(path) ? readJson<T>(path) : undefined;
}

/** Registry stub: "down" answers nothing; "up" returns the truth supplier's own name for its registry code only;
 * "error" throws. The phase (dry run, approved run) is set by the caller. */
function stubRegistry(registry: Registry, truth: TruthRecord | undefined, snapshot: Snapshot): { lookups: string[]; setPhase: (phase: Phase) => void } {
  const lookups: string[] = [];
  let phase: Phase = "dry";
  const known = truth?.status === "available" && truth.supplier_reg
    ? { reg: String(truth.supplier_reg), name: snapshot.clients.find((client) => client.id === truth.supplier_client_id)?.name ?? truth.supplier_name }
    : undefined;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const code = /[?&]q=([^&]+)/.exec(url)?.[1] ?? "";
    lookups.push(decodeURIComponent(code));
    const state = registryIn(registry, phase);
    if (state === "error") throw new TypeError("fetch failed");
    if (state === "down") return { ok: false, headers: { get: () => "0" }, text: async () => "" };
    const data = known && decodeURIComponent(code) === known.reg && known.name
      ? [{ reg_code: Number(known.reg), name: known.name, legal_address: "", status: "R" }]
      : [];
    const text = JSON.stringify({ status: "OK", data });
    return { ok: true, headers: { get: () => String(text.length) }, text: async () => text };
  }) as unknown as typeof fetch;
  return { lookups, setPhase: (next) => { phase = next; } };
}

interface ResultRow {
  doc: string;
  scope: Scope;
  registry: Registry;
  mode: Mode;
  packet_digest_match: boolean | null;
  snapshot?: "frozen" | "empty";
  dry_status: string | null;
  run_status: string | null;
  signals: string[];
  notes: string[];
  supplier_resolution_code: string | null;
  writes: Array<{ method: string; fields?: Record<string, unknown> }>;
  registry_lookups: number;
  truth: Record<string, unknown> | null;
  error?: string;
}

/** createAndSetTotals(data, vatPrice, grossPrice, isVatRegistered): the fields the booking writes. */
function invoiceFields(args: unknown): Record<string, unknown> {
  const [payload, vatPrice, grossPrice] = args as [unknown, unknown, unknown];
  const data = payload as Record<string, unknown>;
  const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
  return {
    clients_id: data.clients_id, client_name: data.client_name, number: data.number, create_date: data.create_date,
    gross_price: grossPrice ?? data.gross_price, vat_price: vatPrice ?? data.vat_price, cl_currencies_id: data.cl_currencies_id ?? "EUR",
    titles: items.map((item) => item.custom_title),
  };
}

async function replayDocument(scope: Scope, id: string, path: string, modes: Mode[], registries: readonly Registry[]): Promise<ResultRow[]> {
  const own = readJson<Record<string, OwnIds>>(dataPath(scope, "own.json"))[id];
  const truthPath = dataPath(scope, "truth.json");
  const truth = existsSync(truthPath) ? readJson<Record<string, TruthRecord>>(truthPath)[id] : undefined;
  const company = own?.reg ?? own?.vat ?? null;
  const frozen = existsSync(dataPath("packets", `${id}.json`)) ? readJson<PacketFile>(dataPath("packets", `${id}.json`)) : undefined;
  // A company without a frozen snapshot (its read failed) books against an empty company: no clients, no
  // invoices, no journals. Every supplier is then new, which exercises the client-create boundary.
  const snapshot: Snapshot | undefined = loadSnapshot(company) ?? (company ? {
    company, clients: [], purchaseInvoices: [], details: [], journals: [], transactions: [], bankAccounts: [],
    accountDimensions: [], purchaseArticles: [], vatRegistered: Boolean(own?.vat),
  } : undefined);
  const snapshotKind = loadSnapshot(company) ? "frozen" : "empty";
  const rows: ResultRow[] = [];
  const truthView = truth?.status === "available"
    ? { invoice_number: truth.invoice_number, invoice_date: truth.invoice_date, gross: truth.gross, currency: truth.currency, supplier_client_id: truth.supplier_client_id, supplier_name: truth.supplier_name, supplier_reg: truth.supplier_reg }
    : null;
  if (!snapshot) return [{ doc: id, scope, registry: registries[0]!, mode: modes[0]!, packet_digest_match: null, dry_status: null, run_status: null, signals: [], notes: [], supplier_resolution_code: null, writes: [], registry_lookups: 0, truth: truthView, error: "no_snapshot" }];
  const base = withoutOwnBooking(snapshot, truth).snapshot;
  const ownSnapshot = readSnapshotFile<{ ownCompanyName?: string }>(snapshot.company, "own");

  // The fresh parse must be the frozen one (same parser build): its packet digest is compared once.
  // (Skipped with --no-digest on a base commit that predates the shared packet adapter.)
  const parsed = await parseDocument(path);
  let digestMatch: boolean | null = null;
  if (DIGEST && frozen) {
    const { buildReadingPacket } = await import("../../src/document-reading-packet.js");
    const { packetInputFromParse } = await import("../../src/tools/document-text-hazards.js");
    const { PARSER_VERSION } = await import("../reading-p1/build-packets.js");
    digestMatch = buildReadingPacket(packetInputFromParse(parsed, sha256Hex(readFileSync(path)), PARSER_VERSION)).packet_digest === frozen.packet.packet_digest;
  }

  for (const registry of registries) for (const mode of modes) {
    const folder = mkdtempSync(join(tmpdir(), "p2-batch-"));
    try {
      copyFileSync(path, join(folder, basename(path)));
      process.env.EARVELDAJA_ALLOWED_PATHS = folder;
      const writes: Write[] = [];
      const api = recordingApi(base, writes, own?.vat ?? null);
      const { lookups, setPhase } = stubRegistry(registry, truth, base);
      const ops = createReceiptBatchOperations(api as never, createTestRuntimeSafetyContext());
      const input = {
        resolvedFolderPath: folder, accountsDimensionsId: base.accountDimensions[0]?.id ?? 0, legacyExecuteCreate: false, directoryAccessOptions: {},
        ...(ownSnapshot?.ownCompanyName ? { ownCompanyName: ownSnapshot.ownCompanyName } : {}),
      };
      const dry = await ops.runBatch({ ...input, executionMode: "dry_run", dryRun: true } as never);
      if (!dry.ok) throw new Error(`dry run failed: ${JSON.stringify(dry).slice(0, 300)}`);
      const preview = dry.value.results[0];
      setPhase("run");
      const run = dry.value.planHandles
        ? await ops.runBatch({ ...input, executionMode: mode, dryRun: false, approvedManifest: dry.value.manifest, planHandle: dry.value.planHandles[mode] } as never)
        : undefined;
      const executed = run?.ok ? run.value.results[0] : undefined;
      rows.push({
        doc: id, scope, registry, mode, packet_digest_match: digestMatch, snapshot: snapshotKind,
        dry_status: preview?.status ?? null,
        run_status: executed?.status ?? (run && !run.ok ? `error:${JSON.stringify(run).slice(0, 200)}` : null),
        signals: preview?.llm_fallback?.confidence_signals ?? [],
        notes: [...(preview?.notes ?? []), ...(executed?.notes ?? [])].map((note) => String(note).slice(0, 300)),
        supplier_resolution_code: (executed?.supplier_resolution as { code?: string } | undefined)?.code ?? (preview?.supplier_resolution as { code?: string } | undefined)?.code ?? null,
        writes: writes.map((entry) => entry.method === "purchaseInvoices.createAndSetTotals"
          ? { method: entry.method, fields: invoiceFields(entry.payload) }
          : entry.method === "clients.create"
            ? { method: entry.method, fields: { name: (entry.payload as Client[])[0]!.name, code: (entry.payload as Client[])[0]!.code, id: (entry.result as { created_object_id?: number } | null)?.created_object_id } }
            : { method: entry.method }),
        registry_lookups: lookups.length,
        truth: truthView,
      });
    } catch (error) {
      rows.push({ doc: id, scope, registry, mode, packet_digest_match: digestMatch, dry_status: null, run_status: null, signals: [], notes: [], supplier_resolution_code: null, writes: [], registry_lookups: 0, truth: truthView, error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }
  return rows;
}

if (process.argv[1]?.endsWith("/batch-replay.ts")) {
  const argv = process.argv.slice(2);
  const out = argValue(argv, "--out");
  if (!out || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(out)) throw new Error("--out <name> required (lower-case, digits, -)");
  const only = argValue(argv, "--only")?.split(",");
  const modes = (argValue(argv, "--modes")?.split(",") ?? ["create", "create_and_confirm"]) as Mode[];
  const registries = (argValue(argv, "--registries")?.split(",") ?? [...REGISTRIES]) as Registry[];
  for (const registry of registries) if (!(REGISTRIES as readonly string[]).includes(registry)) throw new Error(`unknown registry state ${registry}`);
  const realFetch = globalThis.fetch;
  const rows: ResultRow[] = [];
  for (const scope of SCOPES) {
    for (const entry of manifest(scope)) {
      if (only && !only.includes(entry.id)) continue;
      process.stderr.write(`${scope} ${entry.id}\n`);
      rows.push(...await replayDocument(scope, entry.id, entry.path, modes, registries));
    }
  }
  globalThis.fetch = realFetch;
  mkdirSync(dataPath("p2-batch"), { recursive: true, mode: 0o700 });
  // Provenance: the commit the replay ran on, and whether the tree had uncommitted tracked changes.
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const provenance = { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--untracked-files=no") !== "", generated_at: new Date().toISOString(), argv };
  writeJson(dataPath("p2-batch", `${out}.json`), { provenance, rows });
  process.stdout.write(`${rows.length} rows → p2-batch/${out}.json\n`);
}
