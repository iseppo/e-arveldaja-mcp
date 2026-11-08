import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { dirname, extname, isAbsolute, resolve } from "path";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { destructive } from "../annotations.js";
import { toolError } from "../tool-error.js";
import { logAudit } from "../audit-log.js";
import {
  checkBundleRecordIdentity,
  describeAccountingRuleScope,
  getBundleRecordIdentity,
  isTransferableRuleFile,
  listTransferableRuleFiles,
  parseRuleFileContent,
  readBoundedBundleJson,
  resetAccountingRulesCache,
  resolveActiveRulesBundle,
  withBundleLock,
  writeImportedRuleFiles,
} from "../accounting-rules.js";
import { writePrivateFile } from "../config.js";
import { getAllowedRoots, isPathWithinRoot, validateFilePath } from "../file-validation.js";
import { exactCompanyName, mappedCompany, unresolvedCompanyReason } from "../company-identity.js";
import { normalizeVatValue } from "../document-identifiers.js";
import { deriveOwnCompanyRegistryCode } from "./receipt-inbox.js";
import { MAX_JSON_INPUT_SIZE } from "./crud/shared.js";
import { canonicalPlanJson } from "./camt-plan.js";
import { resetStatementBalanceCache } from "../statement-balance-store.js";
import { receiptAttachmentDigestStore, RECEIPT_ATTACHMENT_DIGEST_FILE } from "../receipts/attachment-digest-store.js";
import { camtReviewAcknowledgementStore, CAMT_REVIEW_ACKNOWLEDGEMENT_FILE } from "../camt/review-acknowledgement-store.js";
import { limitedVatStore, LIMITED_VAT_STORE_FILE } from "../company-vat-status.js";
import { defaultUsdPoolStore } from "../lightyear/usd-pool.js";
import type { ExecutionPlanInput, PlanRecord } from "../plan-store.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import type { ApiContext } from "./crud-tools.js";

export const COMPANY_DATA_FORMAT = "e-arveldaja-mcp-company-data";
export const COMPANY_DATA_VERSION = 1;
/** Upper bound on an export file (import refuses anything larger before reading it). */
export const MAX_COMPANY_DATA_BYTES = 16 * 1024 * 1024;
const MAX_RULE_FILE_BYTES = 256 * 1024;
const MAX_FILES = 5000;
const MAX_DETAILED_DIFFS = 200;
const MAX_ROWS_PER_DIFF = 200;
export const ACCOUNTING_DATA_IMPORT_DOMAIN = "accounting_data_import";

/** The connection-scoped state stores a company export carries (file name → label). */
export const STATE_STORE_FILES = [
  "statement-balances.json",
  RECEIPT_ATTACHMENT_DIGEST_FILE,
  CAMT_REVIEW_ACKNOWLEDGEMENT_FILE,
  LIMITED_VAT_STORE_FILE,
  "lightyear-usd-pool.json",
] as const;
export type StateStoreFile = typeof STATE_STORE_FILES[number];
const STATE_STORE_LABELS: Record<StateStoreFile, string> = {
  "statement-balances.json": "statement closing balances (statement-balances.json)",
  "receipt-attachment-digests.json": "receipt attachment digests (receipt-attachment-digests.json)",
  "camt-review-acknowledgements.json": "CAMT review acknowledgements (camt-review-acknowledgements.json)",
  "limited-vat.json": "Limited-VAT settings (limited-vat.json)",
  "lightyear-usd-pool.json": "Lightyear USD pool records",
};
/** Minimal per-store record shape: the fields each store keys or reads by. */
function stateRecordShapeOk(name: StateStoreFile, r: Record<string, unknown>): boolean {
  switch (name) {
    case "statement-balances.json": return typeof r.dimensionId === "number" && typeof r.date === "string" && typeof r.closingBalance === "number";
    case "receipt-attachment-digests.json": return typeof r.sha256 === "string" && typeof r.entity_id === "number";
    case "camt-review-acknowledgements.json": return Object.keys(r).length > 0;
    case "limited-vat.json": return typeof r.key === "string" && typeof r.kind === "string";
    case "lightyear-usd-pool.json": return r.record === "event" || r.record === "checkpoint";
  }
}
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isStateStoreFile(name: string): name is StateStoreFile {
  return (STATE_STORE_FILES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Company identity
// ---------------------------------------------------------------------------

export interface CompanyDataIdentity {
  name: string | null;
  registry_code: string | null;
  /** Where the registry code came from: a public register (emta_kmkr / ariregister_name) or the company's own client record. */
  registry_code_source?: "emta_kmkr" | "ariregister_name" | "client_record" | null;
  vat_number: string | null;
  tax_refnumber: string | null;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const API_SERVER_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)*\/?$/;
const PLAIN_IDENTIFIER = /^[A-Za-z0-9 .-]*$/;

const exportFileSchema = z.object({
  format: z.literal(COMPANY_DATA_FORMAT),
  version: z.literal(COMPANY_DATA_VERSION),
  // Values echoed back to the client are strictly shaped (the name is sandboxed).
  exported_at: z.string().max(40).regex(ISO_TIMESTAMP).refine(value => Number.isFinite(Date.parse(value))),
  server: z.string().max(200).regex(API_SERVER_URL),
  company: z.object({
    name: z.string().max(500).nullable(),
    registry_code: z.string().regex(/^\d{8}$/).nullable(),
    registry_code_source: z.enum(["emta_kmkr", "ariregister_name", "client_record"]).nullable().optional(),
    vat_number: z.string().max(32).regex(PLAIN_IDENTIFIER).nullable(),
    tax_refnumber: z.string().max(32).regex(PLAIN_IDENTIFIER).nullable(),
  }).strict(),
  source_identity: z.string().max(128),
  rule_scope: z.enum(["this_company", "shared"]),
  files: z.array(z.object({
    path: z.string().max(200),
    kind: z.enum(["rule", "state"]),
    content: z.string(),
  }).strict()).max(MAX_FILES),
}).strict();
export type CompanyDataExportFile = z.infer<typeof exportFileSchema>;

function normalizeServer(server: string): string {
  return server.trim().replace(/\/+$/, "");
}

function normalizeCode(value: string | null): string | null {
  const trimmed = value?.replace(/\s+/g, "").toUpperCase();
  return trimmed ? trimmed : null;
}

export type CompanyIdentityVerdict =
  | { match: true; basis: "registry_code" | "tax_refnumber" | "name_and_server" }
  | { match: false; reason: string };

/**
 * Whether an export belongs to the active company. Any identifier both sides
 * have (registry code, EMTA tax reference number, VAT number) must agree. A
 * positive match needs an equal registry code or tax reference number, or —
 * when neither is available on both sides — an equal company name on the same
 * API server. Anything less is a mismatch: an import never lands in a company
 * it cannot be attributed to.
 */
export function compareCompanyIdentity(
  exported: { server: string; company: CompanyDataIdentity },
  active: { server: string; company: CompanyDataIdentity },
): CompanyIdentityVerdict {
  const fields = [
    ["registry_code", (c: CompanyDataIdentity) => normalizeCode(c.registry_code)],
    ["tax_refnumber", (c: CompanyDataIdentity) => normalizeCode(c.tax_refnumber)],
    ["vat_number", (c: CompanyDataIdentity) => normalizeVatValue(c.vat_number) ?? null],
  ] as const;
  for (const [field, read] of fields) {
    const left = read(exported.company);
    const right = read(active.company);
    if (left && right && left !== right) {
      return { match: false, reason: `${field} differs (export ${left}, active company ${right})` };
    }
  }
  const regLeft = normalizeCode(exported.company.registry_code);
  if (regLeft && regLeft === normalizeCode(active.company.registry_code)) return { match: true, basis: "registry_code" };
  const taxLeft = normalizeCode(exported.company.tax_refnumber);
  if (taxLeft && taxLeft === normalizeCode(active.company.tax_refnumber)) return { match: true, basis: "tax_refnumber" };
  const nameLeft = exported.company.name ? exactCompanyName(exported.company.name) : "";
  const nameRight = active.company.name ? exactCompanyName(active.company.name) : "";
  if (nameLeft && nameLeft === nameRight && normalizeServer(exported.server) === normalizeServer(active.server)) {
    return { match: true, basis: "name_and_server" };
  }
  return { match: false, reason: "the export cannot be attributed to the active company (no equal registry code or tax reference number, and no equal company name on the same server)" };
}

async function readCompanyIdentity(api: ApiContext, required: boolean): Promise<CompanyDataIdentity> {
  let name: string | null = null;
  let vatNumber: string | null = null;
  let taxRef: string | null = null;
  try {
    const info = await api.readonly.getInvoiceInfo();
    name = info.invoice_company_name?.trim() || null;
  } catch (error) {
    if (required) throw error;
  }
  try {
    const vat = await api.readonly.getVatInfo();
    vatNumber = vat.vat_number?.trim() || null;
    taxRef = vat.tax_refnumber?.trim() || null;
  } catch (error) {
    if (required) throw error;
  }
  // The registry code resolved from a public register (EMTA KMKR, else the
  // business register by exact name) for this connection, when known.
  const mapped = mappedCompany(api.journals.connectionFingerprint);
  if (mapped && normalizeServer(mapped.entry.server) === normalizeServer(api.journals.apiBaseUrl)) {
    return { name, registry_code: mapped.entry.registry_code, registry_code_source: mapped.entry.source, vat_number: vatNumber, tax_refnumber: taxRef };
  }
  let registryCode: string | null = null;
  try {
    // Fallback: derived from the company's own client record (VAT, then name).
    registryCode = deriveOwnCompanyRegistryCode(await api.clients.listAll(), vatNumber ?? undefined, name ?? undefined) ?? null;
  } catch {
    registryCode = null;
  }
  // Only a plain 8-digit code is carried (the import accepts nothing else).
  if (registryCode !== null && !/^\d{8}$/.test(registryCode)) registryCode = null;
  return { name, registry_code: registryCode, registry_code_source: registryCode ? "client_record" : null, vat_number: vatNumber, tax_refnumber: taxRef };
}

// ---------------------------------------------------------------------------
// Local bundle reads
// ---------------------------------------------------------------------------

type PersistedRecord = Record<string, unknown> & { connectionIdentity?: unknown };

function readStoreRecords(path: string, name: StateStoreFile): PersistedRecord[] | null {
  if (!existsSync(path)) return null;
  const parsed = readBoundedBundleJson(path, name);
  if (!Array.isArray(parsed)) throw new Error(`${name} is not a JSON array.`);
  return parsed as PersistedRecord[];
}

function isOwn(record: PersistedRecord, name: StateStoreFile): boolean {
  return checkBundleRecordIdentity(record.connectionIdentity, STATE_STORE_LABELS[name]).accept;
}

function stripStamp(record: PersistedRecord): Record<string, unknown> {
  const { connectionIdentity: _identity, ...rest } = record;
  return rest;
}

/** This connection's records of a store, unstamped; [] when the file is absent. */
function readOwnStateRecords(dir: string, name: StateStoreFile): { own: Record<string, unknown>[]; other: number } {
  const all = readStoreRecords(resolve(dir, name), name) ?? [];
  const own = all.filter(record => isOwn(record, name)).map(stripStamp);
  return { own, other: all.length - own.length };
}

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Digest of the local files an import touches (rule file bytes; own state records), for drift checks. */
function localDigest(dir: string, ruleFiles: readonly string[], stateFiles: readonly StateStoreFile[]): string {
  const parts: unknown[] = [];
  for (const rel of [...ruleFiles].sort()) {
    const path = resolve(dir, rel);
    parts.push([rel, existsSync(path) ? sha256(readFileSync(path)) : null]);
  }
  for (const name of [...stateFiles].sort()) {
    parts.push([name, sha256(JSON.stringify(readOwnStateRecords(dir, name).own))]);
  }
  return sha256(JSON.stringify(parts));
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function respond(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: toMcpJson(payload) }] };
}

function refuse(errorCode: string, message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return toolError({ error: message, error_code: errorCode, note: "Nothing was written.", ...extra });
}

class TransferRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface AccountingDataExportPayload {
  mode: "export";
  status: "exported";
  path: string;
  company: { name?: string; registry_code: string | null; registry_code_source: CompanyDataIdentity["registry_code_source"] };
  rule_scope: "this_company" | "shared";
  rule_files: string[];
  state_stores: Array<{ name: StateStoreFile; records: number; other_connection_records_left_out: number }>;
  notes: string[];
}

function resolveOutputPath(filePath: string): string {
  if (extname(filePath).toLowerCase() !== ".json") {
    throw new TransferRefusal("output_path_invalid", "The export file name must end with .json.");
  }
  const target = resolve(filePath);
  let realParent: string;
  try {
    realParent = realpathSync(dirname(target));
  } catch {
    throw new TransferRefusal("output_path_invalid", `The folder ${dirname(target)} does not exist.`);
  }
  if (!statSync(realParent).isDirectory()) throw new TransferRefusal("output_path_invalid", `${dirname(target)} is not a folder.`);
  const real = resolve(realParent, target.slice(dirname(target).length + 1));
  if (!getAllowedRoots().some(root => isPathWithinRoot(real, root))) {
    throw new TransferRefusal("output_path_not_allowed", `The export path is outside the allowed folders (${getAllowedRoots().join(", ")}). Set EARVELDAJA_ALLOWED_PATHS to allow another folder.`);
  }
  if (existsSync(real)) throw new TransferRefusal("output_exists", `${real} already exists; choose a new file name (an export never overwrites a file).`);
  return real;
}

async function handleExport(api: ApiContext, filePath: string | undefined): Promise<CallToolResult> {
  if (!filePath) return refuse("file_path_required", "mode \"export\" needs file_path: the new .json file to write.");
  if (!isAbsolute(filePath)) return refuse("file_path_not_absolute", "file_path must be an absolute path (export and import both take absolute paths).");
  const bundle = resolveActiveRulesBundle();
  if (!bundle) return refuse("bundle_storage_required", "Export needs bundle storage; single-file EARVELDAJA_RULES_FILE mode is not supported.");
  let target: string;
  try {
    target = resolveOutputPath(filePath);
  } catch (error) {
    if (error instanceof TransferRefusal) return refuse(error.code, error.message);
    throw error;
  }
  const company = await readCompanyIdentity(api, false);
  const notes: string[] = [];
  const files: CompanyDataExportFile["files"] = [];
  const ruleFiles = listTransferableRuleFiles(bundle.dir);
  const stateSummary: AccountingDataExportPayload["state_stores"] = [];
  withBundleLock(bundle.dir, () => {
    for (const rel of ruleFiles) {
      files.push({ path: rel, kind: "rule", content: readFileSync(resolve(bundle.dir, rel), "utf8") });
    }
    for (const name of STATE_STORE_FILES) {
      const path = resolve(bundle.dir, name);
      if (!existsSync(path)) continue;
      const { own, other } = readOwnStateRecords(bundle.dir, name);
      files.push({ path: name, kind: "state", content: JSON.stringify(own, null, 2) });
      stateSummary.push({ name, records: own.length, other_connection_records_left_out: other });
    }
  });
  if (ruleFiles.every(rel => rel === "index.md" || rel === "log.md") && existsSync(bundle.legacyFile)) {
    notes.push(`Rules still live in the legacy file ${bundle.legacyFile} and were not exported. Save any rule once (it migrates the file into the rules folder) and export again.`);
  }
  const scope = describeAccountingRuleScope().rule_scope;
  if (scope === "shared") notes.push("The rules folder is shared by every connection of this server, so the exported rules may also apply to other companies.");
  if (company.registry_code_source !== "emta_kmkr" && company.registry_code_source !== "ariregister_name") {
    const reason = unresolvedCompanyReason(api.journals.connectionFingerprint);
    notes.push(`The company's registry code is not resolved from a public register${reason ? ` (${reason})` : ""}${company.registry_code ? "; the one in the file comes from the company's own client record" : ""}. Rules and records stay in this API key's store; the import checks the registry code, tax reference number, VAT number or company name.`);
  }
  const storageNotice = describeAccountingRuleScope().storage_notice;
  if (storageNotice) notes.push(storageNotice);
  const document: CompanyDataExportFile = {
    format: COMPANY_DATA_FORMAT,
    version: COMPANY_DATA_VERSION,
    exported_at: new Date().toISOString(),
    server: normalizeServer(api.journals.apiBaseUrl),
    company,
    source_identity: getBundleRecordIdentity().stableIdentity,
    rule_scope: scope,
    files,
  };
  const serialized = JSON.stringify(document, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_COMPANY_DATA_BYTES) {
    return refuse("export_too_large", `The export would exceed ${MAX_COMPANY_DATA_BYTES} bytes.`);
  }
  try {
    // O_CREAT|O_EXCL: never overwrites and never follows a planted symlink.
    writeFileSync(target, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    return refuse("export_write_failed", `The export file could not be written (${(error as Error).message}).`);
  }
  logAudit({
    tool: "accounting_data_transfer",
    action: "EXPORTED",
    entity_type: "company_data",
    summary: `Exported ${ruleFiles.length} rule file(s) and ${stateSummary.length} state store(s)`,
    details: { path: target, rule_files: ruleFiles.length, state_stores: stateSummary.map(s => s.name) },
  });
  const payload: AccountingDataExportPayload = {
    mode: "export",
    status: "exported",
    path: target,
    company: { ...(company.name ? { name: wrapUntrustedOcr(company.name)! } : {}), registry_code: company.registry_code, registry_code_source: company.registry_code_source ?? null },
    rule_scope: scope,
    rule_files: ruleFiles,
    state_stores: stateSummary,
    notes,
  };
  return respond(payload);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

type Row = Record<string, string>;

export interface RuleFileDiff {
  field_changes: Array<{ field: string; local: string | null; imported: string | null }>;
  rows_added: Row[];
  rows_changed: Array<{ key: string; local: Row; imported: Row }>;
  rows_only_local: Row[];
  rows_truncated?: true;
}

export interface ImportRuleFilePlan {
  path: string;
  status: "new" | "identical" | "differs" | "skipped";
  action: "write" | "none" | "replace" | "held";
  hold?: "rule_file_differs";
  diff?: RuleFileDiff;
}

export interface ImportStateStorePlan {
  name: StateStoreFile;
  status: "new" | "identical" | "differs";
  action: "write" | "none" | "replace" | "held";
  hold?: "state_store_exists" | "state_store_server_mismatch";
  imported_records: number;
  local_records: number;
}

interface ImportPlan {
  rules: ImportRuleFilePlan[];
  state: ImportStateStorePlan[];
  ruleWrites: Array<{ rel: string; content: string }>;
  stateWrites: Array<{ name: StateStoreFile; records: Record<string, unknown>[] }>;
}

export type ImportHoldCode = "rule_file_differs" | "state_store_exists" | "state_store_server_mismatch";

export interface AccountingDataImportPreviewPayload {
  mode: "import";
  status: "ready_for_approval";
  plan_handle: string;
  source: { exported_at: string; server: string; company: { name?: string; registry_code: string | null }; identity_basis: string };
  rule_files: ImportRuleFilePlan[];
  state_stores: ImportStateStorePlan[];
  will_write: { rule_files: string[]; state_stores: StateStoreFile[] };
  held: Array<{ path: string; code: ImportHoldCode }>;
  diffs_truncated?: true;
  notes: string[];
  next_step_summary: string;
}

export interface AccountingDataImportResultPayload {
  mode: "import";
  status: "imported" | "nothing_to_import";
  written: { rule_files: string[]; state_stores: Array<{ name: StateStoreFile; records: number }> };
  held: Array<{ path: string; code: ImportHoldCode }>;
  notes: string[];
}

const stripTimestamp = (content: string) => content.replace(/\r\n/g, "\n").replace(/^timestamp:.*$/m, "").trimEnd();
const rowKey = (row: Row) => row.account_id ?? row.expense_account ?? JSON.stringify(row);
const wrapRow = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, wrapUntrustedOcr(v) ?? v]));

function diffRuleFile(localContent: string, importedContent: string): RuleFileDiff {
  const local = parseRuleFileContent(localContent);
  const imported = parseRuleFileContent(importedContent);
  const fieldChanges: RuleFileDiff["field_changes"] = [];
  const fields = new Set([...Object.keys(local.frontmatter), ...Object.keys(imported.frontmatter)]);
  for (const field of [...fields].sort()) {
    if (field === "timestamp") continue;
    const a = local.frontmatter[field] ?? null;
    const b = imported.frontmatter[field] ?? null;
    if (a !== b) fieldChanges.push({ field, local: wrapUntrustedOcr(a) ?? null, imported: wrapUntrustedOcr(b) ?? null });
  }
  const localRows = new Map(local.rows.map(row => [rowKey(row), row]));
  const importedRows = new Map(imported.rows.map(row => [rowKey(row), row]));
  const diff: RuleFileDiff = { field_changes: fieldChanges, rows_added: [], rows_changed: [], rows_only_local: [] };
  let count = 0;
  const room = () => (++count <= MAX_ROWS_PER_DIFF ? true : ((diff.rows_truncated = true), false));
  for (const [key, row] of importedRows) {
    const before = localRows.get(key);
    if (!before) { if (room()) diff.rows_added.push(wrapRow(row)); continue; }
    if (JSON.stringify(before) !== JSON.stringify(row) && room()) {
      diff.rows_changed.push({ key: wrapUntrustedOcr(key) ?? key, local: wrapRow(before), imported: wrapRow(row) });
    }
  }
  for (const [key, row] of localRows) if (!importedRows.has(key) && room()) diff.rows_only_local.push(wrapRow(row));
  return diff;
}

function parseStateContent(name: StateStoreFile, content: string): Record<string, unknown>[] {
  if (Buffer.byteLength(content, "utf8") > MAX_JSON_INPUT_SIZE) {
    throw new TransferRefusal("import_file_invalid", `${name} in the export exceeds ${MAX_JSON_INPUT_SIZE} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new TransferRefusal("import_file_invalid", `${name} in the export is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new TransferRefusal("import_file_invalid", `${name} in the export is not a JSON array.`);
  return parsed.map((record, index) => {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new TransferRefusal("import_file_invalid", `${name} record ${index} is not an object.`);
    }
    const value = record as Record<string, unknown>;
    if (Object.keys(value).some(key => UNSAFE_KEYS.has(key)) || !stateRecordShapeOk(name, value)) {
      throw new TransferRefusal("import_file_invalid", `${name} record ${index} does not have the expected shape.`);
    }
    return stripStamp(value);
  });
}

/** Parse and strictly validate an export file's text. */
export function parseCompanyDataExport(text: string): CompanyDataExportFile {
  if (Buffer.byteLength(text, "utf8") > MAX_COMPANY_DATA_BYTES) {
    throw new TransferRefusal("import_file_too_large", `The import file exceeds ${MAX_COMPANY_DATA_BYTES} bytes.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TransferRefusal("import_file_invalid", "The import file is not valid JSON.");
  }
  const parsed = exportFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues.find(() => true);
    throw new TransferRefusal("import_file_invalid", `The import file is not an e-arveldaja-mcp company export (${issue?.path.join(".") || "root"}: ${issue?.message}).`);
  }
  const seen = new Set<string>();
  for (const file of parsed.data.files) {
    const known = file.kind === "rule" ? isTransferableRuleFile(file.path) : isStateStoreFile(file.path);
    if (!known) throw new TransferRefusal("import_path_refused", `The import file names an unknown or unsafe path: ${JSON.stringify(file.path)}.`);
    if (seen.has(file.path)) throw new TransferRefusal("import_file_invalid", `The import file lists ${file.path} twice.`);
    seen.add(file.path);
    if (file.kind === "rule" && Buffer.byteLength(file.content, "utf8") > MAX_RULE_FILE_BYTES) {
      throw new TransferRefusal("import_file_invalid", `${file.path} exceeds ${MAX_RULE_FILE_BYTES} bytes.`);
    }
  }
  return parsed.data;
}

function buildImportPlan(
  dir: string,
  doc: CompanyDataExportFile,
  applyRuleFiles: ReadonlySet<string>,
  replaceStateStores: ReadonlySet<string>,
  serverMismatch: boolean,
): ImportPlan {
  const plan: ImportPlan = { rules: [], state: [], ruleWrites: [], stateWrites: [] };
  for (const file of doc.files) {
    if (file.kind === "rule") {
      if (file.path === "index.md" || file.path === "log.md") {
        plan.rules.push({ path: file.path, status: "skipped", action: "none" });
        continue;
      }
      const localPath = resolve(dir, file.path);
      if (!existsSync(localPath)) {
        plan.rules.push({ path: file.path, status: "new", action: "write" });
        plan.ruleWrites.push({ rel: file.path, content: file.content });
        continue;
      }
      const localContent = readFileSync(localPath, "utf8");
      if (stripTimestamp(localContent) === stripTimestamp(file.content)) {
        plan.rules.push({ path: file.path, status: "identical", action: "none" });
        continue;
      }
      const approved = applyRuleFiles.has(file.path);
      plan.rules.push({
        path: file.path,
        status: "differs",
        action: approved ? "replace" : "held",
        ...(approved ? {} : { hold: "rule_file_differs" as const }),
        diff: diffRuleFile(localContent, file.content),
      });
      if (approved) plan.ruleWrites.push({ rel: file.path, content: file.content });
    } else {
      const name = file.path as StateStoreFile;
      const imported = parseStateContent(name, file.content);
      const local = readOwnStateRecords(dir, name).own;
      const base = { name, imported_records: imported.length, local_records: local.length };
      // Records of another API server (live vs demo) never describe this server's ledger.
      if (serverMismatch && imported.length > 0) {
        const same = canonicalPlanJson(local as never) === canonicalPlanJson(imported as never);
        plan.state.push(same
          ? { ...base, status: "identical", action: "none" }
          : { ...base, status: local.length === 0 ? "new" : "differs", action: "held", hold: "state_store_server_mismatch" });
        continue;
      }
      if (local.length === 0) {
        if (imported.length === 0) plan.state.push({ ...base, status: "identical", action: "none" });
        else {
          plan.state.push({ ...base, status: "new", action: "write" });
          plan.stateWrites.push({ name, records: imported });
        }
        continue;
      }
      if (canonicalPlanJson(local as never) === canonicalPlanJson(imported as never)) {
        plan.state.push({ ...base, status: "identical", action: "none" });
        continue;
      }
      if (replaceStateStores.has(name)) {
        plan.state.push({ ...base, status: "differs", action: "replace" });
        plan.stateWrites.push({ name, records: imported });
      } else {
        plan.state.push({ ...base, status: "differs", action: "held", hold: "state_store_exists" });
      }
    }
  }
  return plan;
}

function writeStateStore(dir: string, name: StateStoreFile, records: Record<string, unknown>[]): void {
  const path = resolve(dir, name);
  const existing = readStoreRecords(path, name) ?? [];
  const identity = getBundleRecordIdentity().stableIdentity;
  // Other connections' records stay; this connection's are replaced by the
  // imported ones, restamped to the active connection.
  const next = [...existing.filter(record => !isOwn(record, name)), ...records.map(record => ({ ...record, connectionIdentity: identity }))];
  const serialized = JSON.stringify(next, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_INPUT_SIZE) {
    throw new Error(`${name} would exceed the maximum size of ${MAX_JSON_INPUT_SIZE} bytes; not written.`);
  }
  writePrivateFile(path, serialized);
}

function resetStateCaches(): void {
  resetAccountingRulesCache();
  resetStatementBalanceCache();
  receiptAttachmentDigestStore.reset();
  camtReviewAcknowledgementStore.reset();
  limitedVatStore.reset();
  defaultUsdPoolStore.reset();
}

interface ImportArgs {
  file_path?: string;
  apply_rule_files?: string[];
  replace_state_stores?: string[];
  execute?: boolean;
  plan_handle?: string;
}

function heldOf(plan: ImportPlan): AccountingDataImportPreviewPayload["held"] {
  return [
    ...plan.rules.filter(r => r.hold).map(r => ({ path: r.path, code: "rule_file_differs" as const })),
    ...plan.state.filter(s => s.hold).map(s => ({ path: s.name, code: s.hold! })),
  ];
}

const IMPORT_NOT_ATOMIC_NOTE = "The import writes its files one by one. If it stops part-way (an error or a crash), run the dry run again: it shows what is already in place and what is still to write.";

async function handleImport(api: ApiContext, ctx: RuntimeSafetyContext, args: ImportArgs): Promise<CallToolResult> {
  if (!args.file_path) return refuse("file_path_required", "mode \"import\" needs file_path: the export .json file.");
  if (!isAbsolute(args.file_path)) return refuse("file_path_not_absolute", "file_path must be an absolute path (export and import both take absolute paths).");
  const bundle = resolveActiveRulesBundle();
  if (!bundle) return refuse("bundle_storage_required", "Import needs bundle storage; single-file EARVELDAJA_RULES_FILE mode is not supported.");
  let realPath: string;
  let text: string;
  let doc: CompanyDataExportFile;
  try {
    // Size is checked here (not by validateFilePath) so an oversize file gets its own code.
    realPath = await validateFilePath(args.file_path, [".json"], Number.MAX_SAFE_INTEGER);
    if (statSync(realPath).size > MAX_COMPANY_DATA_BYTES) throw new TransferRefusal("import_file_too_large", `The import file exceeds ${MAX_COMPANY_DATA_BYTES} bytes.`);
    const bytes = readFileSync(realPath);
    if (bytes.length > MAX_COMPANY_DATA_BYTES) throw new TransferRefusal("import_file_too_large", `The import file exceeds ${MAX_COMPANY_DATA_BYTES} bytes.`);
    text = bytes.toString("utf8");
    doc = parseCompanyDataExport(text);
  } catch (error) {
    if (error instanceof TransferRefusal) return refuse(error.code, error.message);
    return refuse("import_file_unreadable", (error as Error).message);
  }
  const ruleNames = new Set(doc.files.filter(f => f.kind === "rule").map(f => f.path));
  const stateNames = new Set(doc.files.filter(f => f.kind === "state").map(f => f.path));
  const applyRuleFiles = [...new Set(args.apply_rule_files ?? [])].sort();
  const replaceStateStores = [...new Set(args.replace_state_stores ?? [])].sort();
  const unknownRule = applyRuleFiles.find(rel => !ruleNames.has(rel));
  if (unknownRule) return refuse("unknown_file", `apply_rule_files names ${JSON.stringify(unknownRule)}, which is not a rule file in this export.`);
  const unknownState = replaceStateStores.find(name => !stateNames.has(name));
  if (unknownState) return refuse("unknown_file", `replace_state_stores names ${JSON.stringify(unknownState)}, which is not a state store in this export.`);

  let active: CompanyDataIdentity;
  try {
    active = await readCompanyIdentity(api, true);
  } catch (error) {
    return refuse("company_identity_unavailable", `The active company's identity could not be read from e-arveldaja (${(error as Error).message}); retry.`);
  }
  const verdict = compareCompanyIdentity(
    { server: doc.server, company: doc.company },
    { server: normalizeServer(api.journals.apiBaseUrl), company: active },
  );
  if (!verdict.match) {
    return refuse("company_mismatch", `This export belongs to another company: ${wrapUntrustedOcr(verdict.reason)}. Switch to the right connection or use the right file.`);
  }
  const serverMismatch = normalizeServer(doc.server) !== normalizeServer(api.journals.apiBaseUrl);

  const normalizedArgs: PlanRecord = {
    file_path: realPath,
    apply_rule_files: applyRuleFiles,
    replace_state_stores: replaceStateStores,
  };
  const touchedRules = [...ruleNames].filter(rel => rel !== "index.md" && rel !== "log.md");
  const touchedState = [...stateNames] as StateStoreFile[];
  const fileDigest = sha256(text);
  const notes: string[] = [];
  if (describeAccountingRuleScope().rule_scope === "shared") {
    notes.push("The rules folder is shared by every connection of this server, so imported rules apply to every company it uses.");
  } else if (doc.rule_scope === "shared" && ruleNames.size > 0) {
    notes.push(`Warning: this export came from a rules folder shared by every company of that server, so these rules may belong to other companies: ${[...ruleNames].filter(rel => rel !== "index.md" && rel !== "log.md").sort().join(", ")}. Check them before approving; they are imported into this company's own store.`);
  }
  if (serverMismatch) {
    notes.push("The export comes from another e-arveldaja server (for example demo vs live), so its local records are held (state_store_server_mismatch); rule files can still be imported.");
  }
  notes.push(IMPORT_NOT_ATOMIC_NOTE);

  if (!args.execute) {
    let plan: ImportPlan;
    let digest: string;
    try {
      ({ plan, digest } = withBundleLock(bundle.dir, () => ({
        plan: buildImportPlan(bundle.dir, doc, new Set(applyRuleFiles), new Set(replaceStateStores), serverMismatch),
        digest: localDigest(bundle.dir, touchedRules, touchedState),
      })));
    } catch (error) {
      if (error instanceof TransferRefusal) return refuse(error.code, error.message);
      throw error;
    }
    const held = heldOf(plan);
    const planInput: ExecutionPlanInput = {
      normalizedArgs,
      sourceIdentities: [{ file_digest: fileDigest }],
      liveSnapshot: { local_digest: digest, destructive: plan.state.some(s => s.action === "replace") || plan.rules.some(r => r.action === "replace") },
      commands: [{ id: "accounting-data-import", category: "import_company_data", reviewProjection: normalizedArgs }],
      counts: { rule_writes: plan.ruleWrites.length, state_writes: plan.stateWrites.length, held: held.length },
      totals: {},
      exclusions: [],
      reviews: [],
      privatePayload: { file_digest: fileDigest, local_digest: digest },
    };
    const planHandle = ctx.planStore.issue(ACCOUNTING_DATA_IMPORT_DOMAIN, planInput);
    let detailed = 0;
    let truncated = false;
    for (const rule of plan.rules) {
      if (rule.diff && ++detailed > MAX_DETAILED_DIFFS) { delete rule.diff; truncated = true; }
    }
    const payload: AccountingDataImportPreviewPayload = {
      mode: "import",
      status: "ready_for_approval",
      plan_handle: planHandle,
      source: {
        exported_at: doc.exported_at,
        server: doc.server,
        company: { ...(doc.company.name ? { name: wrapUntrustedOcr(doc.company.name)! } : {}), registry_code: doc.company.registry_code },
        identity_basis: verdict.basis,
      },
      rule_files: plan.rules,
      state_stores: plan.state,
      will_write: { rule_files: plan.ruleWrites.map(w => w.rel), state_stores: plan.stateWrites.map(w => w.name) },
      held,
      ...(truncated ? { diffs_truncated: true as const } : {}),
      notes,
      next_step_summary: "Show the owner what would be written and what is held. A held rule file is written only when named in apply_rule_files (the imported file then replaces the local one); a held state store only when named in replace_state_stores (this company's records in it are replaced). Change those lists by running the dry run again. Only after approval, call again with the same file_path, apply_rule_files and replace_state_stores, execute: true and this plan_handle.",
    };
    return respond(payload);
  }

  if (!args.plan_handle) return refuse("plan_handle_required", "execute: true needs the plan_handle from the import dry run.");
  let stored;
  try {
    stored = ctx.planStore.consume(args.plan_handle, ACCOUNTING_DATA_IMPORT_DOMAIN);
  } catch (error) {
    return refuse((error as { code?: string }).code ?? "plan_handle_invalid", "The reviewed import plan could not be consumed.");
  }
  if (canonicalPlanJson(stored.normalizedArgs) !== canonicalPlanJson(normalizedArgs)) {
    return refuse("plan_drift", "file_path, apply_rule_files or replace_state_stores differ from the approved dry run.");
  }
  const bound = stored.privatePayload as { file_digest?: unknown; local_digest?: unknown } | null;
  if (bound?.file_digest !== fileDigest) {
    return refuse("plan_drift", "The import file changed after the dry run. Run the dry run again.");
  }
  let outcome: { plan: ImportPlan } | { drift: true };
  try {
    outcome = withBundleLock(bundle.dir, () => {
      if (localDigest(bundle.dir, touchedRules, touchedState) !== bound?.local_digest) return { drift: true as const };
      const plan = buildImportPlan(bundle.dir, doc, new Set(applyRuleFiles), new Set(replaceStateStores), serverMismatch);
      if (plan.ruleWrites.length > 0) {
        writeImportedRuleFiles(bundle, plan.ruleWrites, plan.ruleWrites.map(w => `imported ${w.rel} (company data import)`));
      }
      for (const write of plan.stateWrites) writeStateStore(bundle.dir, write.name, write.records);
      return { plan };
    });
  } catch (error) {
    resetStateCaches();
    if (error instanceof TransferRefusal) return refuse(error.code, error.message);
    throw error;
  }
  resetStateCaches();
  if ("drift" in outcome) {
    return refuse("plan_drift", "The local rules or state changed after the dry run. Run the dry run again.");
  }
  const { plan } = outcome;
  const written = {
    rule_files: plan.ruleWrites.map(w => w.rel),
    state_stores: plan.stateWrites.map(w => ({ name: w.name, records: w.records.length })),
  };
  const nothing = written.rule_files.length === 0 && written.state_stores.length === 0;
  if (!nothing) {
    logAudit({
      tool: "accounting_data_transfer",
      action: "IMPORTED",
      entity_type: "company_data",
      summary: `Imported ${written.rule_files.length} rule file(s) and ${written.state_stores.length} state store(s)`,
      details: { path: realPath, ...written, identity_basis: verdict.basis },
    });
  }
  const payload: AccountingDataImportResultPayload = {
    mode: "import",
    status: nothing ? "nothing_to_import" : "imported",
    written,
    held: heldOf(plan),
    notes: [...notes, "Imported state records were restamped to this connection. Nothing was changed in e-arveldaja."],
  };
  return respond(payload);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAccountingDataTransferTool(server: McpServer, api: ApiContext, runtimeSafetyContext: RuntimeSafetyContext): void {
  registerTool(server, "accounting_data_transfer",
    "Move this company's local MCP data (saved booking and annual-report rules, plus local state: statement balances, receipt digests, CAMT acknowledgements, limited-VAT settings, Lightyear USD pool) to another machine or a new API key. " +
    "export = write one .json file (new file only, 0600; no credentials). import = dry run (per file new / identical / differs, row-level rule diffs, state record counts) → owner approval → execute:true + plan_handle. " +
    "Refused for another company (company_mismatch). Existing state is never overwritten unless named in replace_state_stores; a differing rule file is written only when named in apply_rule_files. Nothing is changed in e-arveldaja.",
    {
      mode: z.enum(["export", "import"]).describe("export | import"),
      file_path: z.string().min(1).max(4096).describe("Absolute path. export: the new .json file to write; import: the export file to read"),
      apply_rule_files: z.array(z.string().max(200)).max(MAX_FILES).optional().describe("import: rule files (paths as listed by the dry run) whose imported version replaces a differing local one"),
      replace_state_stores: z.array(z.enum(STATE_STORE_FILES)).max(STATE_STORE_FILES.length).optional().describe("import: state stores whose existing records for this company are replaced by the imported ones"),
      execute: z.boolean().optional().describe("import: false (default) = dry run; true = execute an approved plan_handle"),
      plan_handle: z.string().optional().describe("import with execute:true: the handle from the dry run"),
    },
    { ...destructive, title: "Export / Import Company Data" },
    async (args) => {
      if (args.mode === "export") return handleExport(api, args.file_path);
      return handleImport(api, runtimeSafetyContext, args);
    },
  );
}
