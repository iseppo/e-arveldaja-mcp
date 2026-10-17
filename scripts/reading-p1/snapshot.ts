// Step 4b: owner-approved READ-ONLY snapshot of the live API, one per company (plan §5.6, OQ-P1-12).
// Every HTTP request is logged (method + path) to snapshots/http-log.jsonl, and every network call to
// snapshots/fetch-log.jsonl. Any method other than GET is refused BEFORE it reaches the network, at
// both layers. Credentials are read from the given files only; nothing secret is printed or stored.
//
// Usage:
//   npx tsx scripts/reading-p1/snapshot.ts identify --cred <apikey.txt|.env> [--cred ...]
//   npx tsx scripts/reading-p1/snapshot.ts snapshot --cred <file> --company <key> [--documents]
//   npx tsx scripts/reading-p1/snapshot.ts invoices --company <key> --ids 1,2,3   (purchaseInvoices.get)
//   npx tsx scripts/reading-p1/snapshot.ts verify-log

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import dotenv from "dotenv";
import { getBaseUrlForServer, parseApiKeyFile, type Config } from "../../src/config.js";
import { HttpClient, type RequestOptions } from "../../src/http-client.js";
import { ClientsApi } from "../../src/api/clients.api.js";
import { JournalsApi } from "../../src/api/journals.api.js";
import { ProductsApi } from "../../src/api/products.api.js";
import { PurchaseInvoicesApi } from "../../src/api/purchase-invoices.api.js";
import { ReferenceDataApi } from "../../src/api/readonly.api.js";
import { SaleInvoicesApi } from "../../src/api/sale-invoices.api.js";
import { TransactionsApi } from "../../src/api/transactions.api.js";
import type { ApiContext } from "../../src/tools/crud/shared.js";
import { resolveOwnCompanyIdentifiers } from "../../src/tools/own-company-identity.js";
import { argValue, dataPath, hasFlag, readJson, sha256Hex, todayIso, writeJson } from "./common.js";

const HTTP_LOG = dataPath("snapshots", "http-log.jsonl");
const FETCH_LOG = dataPath("snapshots", "fetch-log.jsonl");

function logLine(path: string, entry: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
}

// Network-level guard: wraps fetch for the whole process.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const url = new URL(input instanceof Request ? input.url : String(input));
  logLine(FETCH_LOG, { method, path: url.pathname, query: url.search, refused: method !== "GET" });
  if (method !== "GET") throw new Error(`read-only snapshot: refused ${method} ${url.pathname}`);
  return realFetch(input, init);
}) as typeof fetch;

/** HttpClient that refuses every non-GET request before signing it, and logs every request. */
class ReadOnlyHttpClient extends HttpClient {
  constructor(config: Config, namespace: string, private readonly label: string) {
    super(config, namespace);
  }

  override async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    logLine(HTTP_LOG, { company: this.label, method, path, params: options.params ?? null, refused: method !== "GET" });
    if (method !== "GET") throw new Error(`read-only snapshot: refused ${method} ${path}`);
    return super.request<T>(path, options);
  }
}

function loadCredential(path: string): Config {
  if (/\.env$/.test(path) || path.endsWith("/.env")) {
    const env = dotenv.parse(readFileSync(path));
    const keyId = env.EARVELDAJA_API_KEY_ID;
    const publicValue = env.EARVELDAJA_API_PUBLIC_VALUE;
    const password = env.EARVELDAJA_API_PASSWORD;
    if (!keyId || !publicValue || !password) throw new Error(`credential file has no API key fields: ${path}`);
    return { apiKeyId: keyId, apiPublicValue: publicValue, apiPassword: password, baseUrl: getBaseUrlForServer(env.EARVELDAJA_SERVER || "live") };
  }
  const parsed = parseApiKeyFile(path);
  if (!parsed) throw new Error(`unreadable credential file: ${path}`);
  return { apiKeyId: parsed.keyId, apiPublicValue: parsed.publicValue, apiPassword: parsed.password, baseUrl: getBaseUrlForServer("live") };
}

function apiContext(config: Config, label: string): ApiContext {
  const http = new ReadOnlyHttpClient(config, `reading-p1:${label}`, label);
  return {
    clients: new ClientsApi(http),
    products: new ProductsApi(http),
    journals: new JournalsApi(http),
    transactions: new TransactionsApi(http),
    saleInvoices: new SaleInvoicesApi(http),
    purchaseInvoices: new PurchaseInvoicesApi(http),
    readonly: new ReferenceDataApi(http),
  };
}

function credentialPaths(argv: string[]): string[] {
  const paths: string[] = [];
  argv.forEach((arg, index) => {
    if (arg === "--cred") paths.push(argv[index + 1]!);
  });
  if (paths.length === 0) throw new Error("--cred <file> is required");
  return paths;
}

/** Company key = own registry code, else own VAT number (the own.json identity). */
function companyKey(ids: { reg?: string; vat?: string }): string | undefined {
  return ids.reg ?? ids.vat;
}

async function identify(argv: string[]): Promise<void> {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Map<string, string>();
  for (const path of credentialPaths(argv)) {
    let config: Config;
    try {
      config = loadCredential(path);
    } catch (error) {
      rows.push({ cred: path, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const identity = sha256Hex(`${config.baseUrl}\n${config.apiKeyId}\n${config.apiPublicValue}`).slice(0, 12);
    if (seen.has(identity)) {
      rows.push({ cred: path, same_as: seen.get(identity) });
      continue;
    }
    seen.set(identity, path);
    const api = apiContext(config, `identify:${identity}`);
    try {
      const clients = await api.clients.listAll();
      const own = await resolveOwnCompanyIdentifiers(api, clients);
      rows.push({
        cred: path,
        server: config.baseUrl.includes("demo") ? "demo" : "live",
        company_name: own.ownCompanyName ?? null,
        reg: own.ownCompanyRegistryCode ?? null,
        vat: own.ownCompanyVat ?? null,
        key: companyKey({ reg: own.ownCompanyRegistryCode, vat: own.ownCompanyVat }) ?? null,
      });
    } catch (error) {
      rows.push({ cred: path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  writeJson(dataPath("snapshots", "companies.json"), rows);
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

async function snapshot(argv: string[]): Promise<void> {
  const company = argValue(argv, "--company");
  const credPath = argValue(argv, "--cred");
  if (!company || !credPath) throw new Error("snapshot needs --cred and --company");
  const api = apiContext(loadCredential(credPath), company);
  const out = (name: string, value: unknown) => writeJson(dataPath("snapshots", company, `${name}.json`), value);

  const clients = await api.clients.listAll();
  const own = await resolveOwnCompanyIdentifiers(api, clients);
  if (companyKey({ reg: own.ownCompanyRegistryCode, vat: own.ownCompanyVat }) !== company) {
    throw new Error(`credential does not belong to company ${company}`);
  }
  out("clients", clients);
  out("own", own);
  out("vat_info", await api.readonly.getVatInfo());
  out("invoice_info", await api.readonly.getInvoiceInfo());
  out("purchase_invoices", await api.purchaseInvoices.listAll());
  out("transactions", await api.transactions.listAll());
  out("bank_accounts", await api.readonly.getBankAccounts());
  out("account_dimensions", await api.readonly.getAccountDimensions());
  out("accounts", await api.readonly.getAccounts());
  out("purchase_articles", await api.readonly.getPurchaseArticles());

  // Journals with postings; any hydration failure marks the whole journals snapshot unavailable.
  let journalsStatus: Record<string, unknown>;
  try {
    const journals = await api.journals.listAllWithPostings();
    const unhydrated = journals.filter((journal) => journal.is_deleted !== true && (!journal.postings || journal.postings.length === 0));
    if (unhydrated.length > 0) {
      journalsStatus = { status: "unavailable", reason: "journals_without_postings", count: journals.length, unhydrated: unhydrated.length };
    } else {
      out("journals", journals);
      journalsStatus = { status: "available", count: journals.length };
    }
  } catch (error) {
    journalsStatus = { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }

  // Attached source documents: only their sha256 and name are kept (to match PDFs to bookings).
  const documents: Array<{ invoice_id: number; name: string | null; sha256: string | null; error?: string }> = [];
  if (hasFlag(argv, "--documents")) {
    const invoices = readJson<Array<{ id?: number; base_document_files_id?: number | null }>>(dataPath("snapshots", company, "purchase_invoices.json"));
    for (const invoice of invoices) {
      if (invoice.id === undefined) continue;
      try {
        const file = await api.purchaseInvoices.getDocument(invoice.id);
        documents.push({ invoice_id: invoice.id, name: file?.name ?? null, sha256: file?.contents ? sha256Hex(Buffer.from(file.contents, "base64")) : null });
      } catch (error) {
        documents.push({ invoice_id: invoice.id, name: null, sha256: null, error: error instanceof Error ? error.message.slice(0, 120) : "error" });
      }
    }
    out("documents", documents);
  }
  const meta = { company, taken_at: new Date().toISOString(), date: todayIso(), journals: journalsStatus, documents: documents.length };
  out("meta", meta);
  process.stdout.write(`${JSON.stringify(meta)}\n`);
}

async function invoices(argv: string[]): Promise<void> {
  const company = argValue(argv, "--company");
  const credPath = argValue(argv, "--cred");
  const ids = (argValue(argv, "--ids") ?? "").split(",").filter(Boolean).map(Number);
  if (!company || !credPath || ids.length === 0) throw new Error("invoices needs --cred, --company and --ids");
  const api = apiContext(loadCredential(credPath), company);
  const rows = [];
  for (const id of ids) rows.push(await api.purchaseInvoices.get(id));
  writeJson(dataPath("snapshots", company, "purchase_invoice_details.json"), rows);
  process.stdout.write(`fetched ${rows.length} purchase invoices\n`);
}

/** Verifies that both logs hold only GET requests and that no request was refused. */
function verifyLog(): void {
  const summary: Record<string, unknown> = {};
  for (const [name, path] of [["http", HTTP_LOG], ["fetch", FETCH_LOG]] as const) {
    const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; refused: boolean; path: string }) : [];
    const methods: Record<string, number> = {};
    for (const line of lines) methods[line.method] = (methods[line.method] ?? 0) + 1;
    const nonGet = lines.filter((line) => line.method !== "GET");
    const paths = new Set(lines.map((line) => line.path.split("?")[0]!.replace(/\/\d+(?=\/|$)/g, "/{id}")));
    summary[name] = { requests: lines.length, methods, non_get: nonGet.length, refused: lines.filter((line) => line.refused).length, path_shapes: [...paths].sort() };
  }
  const ok = (summary.http as { non_get: number }).non_get === 0 && (summary.fetch as { non_get: number }).non_get === 0;
  writeJson(dataPath("snapshots", "get-only-verification.json"), { ok, ...summary });
  process.stdout.write(`${JSON.stringify({ ok, ...summary }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

const [mode, ...rest] = process.argv.slice(2);
const run = mode === "identify" ? identify(rest) : mode === "snapshot" ? snapshot(rest) : mode === "invoices" ? invoices(rest) : mode === "verify-log" ? Promise.resolve(verifyLog()) : Promise.reject(new Error(`unknown mode ${mode}`));
run.catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
