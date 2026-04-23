/**
 * Disk-backed session audit log.
 * Entries are written as human-readable Markdown sections to
 * `{projectRoot}/logs/{companyOrConnectionLabel}.audit.md`.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  normalizeAuditLabel,
  sanitizeAuditLogName,
} from "./audit-log-labels.js";

export interface AuditEntry {
  timestamp: string;
  tool: string;
  action: string;
  entity_type: string;
  entity_id?: number;
  summary: string;
  details: Record<string, unknown>;
}

export interface AuditLogLabelAssignment {
  connectionName: string;
  label: string;
}

const LOGS_DIR = join(process.cwd(), "logs");
const LABELS_FILE = join(LOGS_DIR, ".audit-labels.json");
const ENTRY_SEPARATOR = "\n---\n\n";
const META_RE = /^<!-- audit:(\{.*\}) -->$/m;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const AUDIT_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ISO_TS_NO_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;
const PRIVATE_FILE_MODE = 0o600;

let activeConnectionNameGetter: () => string = () => "default";
const auditLabelByConnection = new Map<string, string>();
const auditFingerprintByConnection = new Map<string, string>();

interface PersistedAuditLabel {
  label: string;
  fingerprint?: string;
}

function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
  }
}

function enforcePrivateFileMode(filePath: string): void {
  try {
    chmodSync(filePath, PRIVATE_FILE_MODE);
  } catch {
    // best-effort
  }
}

function writePrivateTextFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, {
    encoding: "utf-8",
    mode: PRIVATE_FILE_MODE,
  });
  enforcePrivateFileMode(filePath);
}

function appendPrivateTextFile(filePath: string, content: string): void {
  appendFileSync(filePath, content, {
    encoding: "utf-8",
    mode: PRIVATE_FILE_MODE,
  });
  enforcePrivateFileMode(filePath);
}

function readPersistedAuditLabels(): Record<string, unknown> {
  if (!existsSync(LABELS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(LABELS_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parsePersistedAuditLabel(value: unknown): PersistedAuditLabel | null {
  if (typeof value === "string") {
    return { label: value };
  }

  if (typeof value !== "object" || value === null) {
    return null;
  }

  const label = (value as { label?: unknown }).label;
  const fingerprint = (value as { fingerprint?: unknown }).fingerprint;
  if (typeof label !== "string") return null;
  if (fingerprint !== undefined && typeof fingerprint !== "string") return null;

  return { label, fingerprint };
}

function loadAuditLabelMap(): void {
  auditLabelByConnection.clear();
  const persistedLabels = readPersistedAuditLabels();
  for (const [connectionName, persistedValue] of Object.entries(persistedLabels)) {
    const persisted = parsePersistedAuditLabel(persistedValue);
    if (!persisted) continue;

    const expectedFingerprint = auditFingerprintByConnection.get(connectionName);
    if (expectedFingerprint && persisted.fingerprint !== expectedFingerprint) continue;

    auditLabelByConnection.set(
      connectionName,
      normalizeAuditLabel(persisted.label),
    );
  }
}

function persistAuditLabelMap(): void {
  ensureLogsDir();
  const persisted = Object.fromEntries(
    Array.from(auditLabelByConnection.entries()).map(([connectionName, label]) => {
      const fingerprint = auditFingerprintByConnection.get(connectionName);
      return [
        connectionName,
        fingerprint ? { label, fingerprint } : { label },
      ];
    }),
  );
  writePrivateTextFile(LABELS_FILE, `${JSON.stringify(persisted, null, 2)}\n`);
}

/** Initialize the audit log with a function that returns the current connection name. */
export function initAuditLog(
  getConnectionName: () => string,
  connectionFingerprints?: Record<string, string>,
): void {
  activeConnectionNameGetter = getConnectionName;
  auditFingerprintByConnection.clear();
  if (connectionFingerprints) {
    for (const [connectionName, fingerprint] of Object.entries(connectionFingerprints)) {
      if (typeof fingerprint !== "string" || !fingerprint) continue;
      auditFingerprintByConnection.set(connectionName, fingerprint);
    }
  }
  ensureLogsDir();
  loadAuditLabelMap();
}

function getAuditLabel(connectionName: string): string {
  return auditLabelByConnection.get(connectionName) ?? connectionName;
}

export function getCurrentAuditLogLabel(connectionName: string): string {
  return getAuditLabel(connectionName);
}

function getLogFilePathForLabel(label: string): string {
  return join(LOGS_DIR, `${sanitizeAuditLogName(label)}.audit.md`);
}

function getLogFilePathForConnection(connectionName: string): string {
  return getLogFilePathForLabel(getAuditLabel(connectionName));
}

function getLogFilePath(): string {
  return getLogFilePathForConnection(activeConnectionNameGetter());
}

function splitAuditSections(content: string): string[] {
  return content.split(ENTRY_SEPARATOR).filter(Boolean);
}

function getSectionTimestampMs(section: string): number | undefined {
  const match = section.match(/^### (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  if (!match) return undefined;
  return parseAuditTimestamp(match[1]!);
}

function renderMergedSections(sections: string[]): string {
  return sections.join(ENTRY_SEPARATOR) + (sections.length > 0 ? ENTRY_SEPARATOR : "");
}

function mergeAuditLogFiles(sourcePath: string, targetPath: string): void {
  const sourceContent = readFileSync(sourcePath, "utf-8");
  if (!sourceContent.trim()) {
    unlinkSync(sourcePath);
    return;
  }

  const targetContent = readFileSync(targetPath, "utf-8");
  const mergedSections = [...splitAuditSections(targetContent), ...splitAuditSections(sourceContent)]
    .map((section, index) => ({
      section,
      index,
      timestampMs: getSectionTimestampMs(section),
    }))
    .sort((left, right) => {
      if (left.timestampMs === undefined && right.timestampMs === undefined) {
        return left.index - right.index;
      }
      if (left.timestampMs === undefined) return 1;
      if (right.timestampMs === undefined) return -1;
      if (left.timestampMs !== right.timestampMs) {
        return left.timestampMs - right.timestampMs;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.section);

  writeFileSync(targetPath, renderMergedSections(mergedSections), {
    encoding: "utf-8",
    mode: PRIVATE_FILE_MODE,
  });
  enforcePrivateFileMode(targetPath);
  unlinkSync(sourcePath);
}

function migrateAuditLogFile(previousLabel: string, nextLabel: string): void {
  const previousPath = getLogFilePathForLabel(previousLabel);
  const nextPath = getLogFilePathForLabel(nextLabel);
  if (previousPath === nextPath || !existsSync(previousPath)) return;

  if (!existsSync(nextPath)) {
    renameSync(previousPath, nextPath);
    enforcePrivateFileMode(nextPath);
    return;
  }

  mergeAuditLogFiles(previousPath, nextPath);
}

function setAuditLogLabelInternal(connectionName: string, label: string): void {
  const normalizedLabel = normalizeAuditLabel(label);
  const previousLabel = getAuditLabel(connectionName);
  if (previousLabel === normalizedLabel) return;

  migrateAuditLogFile(previousLabel, normalizedLabel);
  auditLabelByConnection.set(connectionName, normalizedLabel);
}

export function setAuditLogLabel(connectionName: string, label: string): void {
  setAuditLogLabels([{ connectionName, label }]);
}

export function setAuditLogLabels(assignments: AuditLogLabelAssignment[]): void {
  const changedAssignments = assignments
    .map((assignment) => ({
      connectionName: assignment.connectionName,
      label: normalizeAuditLabel(assignment.label),
    }))
    .filter((assignment) => getAuditLabel(assignment.connectionName) !== assignment.label);

  if (changedAssignments.length === 0) return;

  const originalLabels = new Map(auditLabelByConnection);
  const tempPrefix = `__audit_tmp__${Date.now().toString(36)}`;
  const tempAssignments = changedAssignments.map((assignment, index) => ({
    ...assignment,
    tempLabel: `${tempPrefix}_${index}`,
  }));
  const touchedPaths = new Set<string>([LABELS_FILE]);

  for (const assignment of tempAssignments) {
    touchedPaths.add(getLogFilePathForLabel(getAuditLabel(assignment.connectionName)));
    touchedPaths.add(getLogFilePathForLabel(assignment.tempLabel));
    touchedPaths.add(getLogFilePathForLabel(assignment.label));
  }

  const originalFiles = new Map<string, string | null>();
  for (const path of touchedPaths) {
    originalFiles.set(path, existsSync(path) ? readFileSync(path, "utf-8") : null);
  }

  try {
    for (const assignment of tempAssignments) {
      setAuditLogLabelInternal(assignment.connectionName, assignment.tempLabel);
    }

    for (const assignment of tempAssignments) {
      setAuditLogLabelInternal(assignment.connectionName, assignment.label);
    }

    persistAuditLabelMap();
  } catch (error) {
    auditLabelByConnection.clear();
    for (const [connectionName, label] of originalLabels.entries()) {
      auditLabelByConnection.set(connectionName, label);
    }

    for (const [path, content] of originalFiles.entries()) {
      try {
        if (content === null) {
          if (existsSync(path)) unlinkSync(path);
        } else {
          writePrivateTextFile(path, content);
        }
      } catch {
        // best-effort rollback
      }
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Bilingual labels (Estonian / English)
// ---------------------------------------------------------------------------

type Lang = "et" | "en";

function getLang(): Lang {
  const v = process.env.EARVELDAJA_AUDIT_LANG?.toLowerCase();
  return v === "en" ? "en" : "et";
}

const ACTION_LABELS: Record<Lang, Record<string, string>> = {
  et: { CREATED: "Loodud", UPDATED: "Muudetud", DELETED: "Kustutatud", CONFIRMED: "Kinnitatud", INVALIDATED: "Tühistatud", UPLOADED: "Üles laetud", IMPORTED: "Imporditud", SENT: "Saadetud" },
  en: { CREATED: "Created", UPDATED: "Updated", DELETED: "Deleted", CONFIRMED: "Confirmed", INVALIDATED: "Invalidated", UPLOADED: "Uploaded", IMPORTED: "Imported", SENT: "Sent" },
};

const ENTITY_LABELS: Record<Lang, Record<string, string>> = {
  et: { client: "Klient", product: "Toode", journal: "Kanne", transaction: "Pangatehing", sale_invoice: "Müügiarve", purchase_invoice: "Ostuarve" },
  en: { client: "Client", product: "Product", journal: "Journal", transaction: "Transaction", sale_invoice: "Sale invoice", purchase_invoice: "Purchase invoice" },
};

const FIELD_LABELS: Record<Lang, Record<string, string>> = {
  et: {
    tool: "Tööriist", supplier: "Hankija", client: "Klient", name: "Nimi",
    invoice_no: "Arve nr", date: "Kuupäev", due_date: "Tähtaeg", amount: "Summa",
    total: "Kokku", net: "neto", vat: "KM", gross: "bruto",
    postings: "Kanded", account: "Konto", direction: "Suund", description: "Kirjeldus",
    items: "Read", distribution: "Jaotus", count: "Arv", fields_changed: "Muudetud väljad",
    file: "Fail", warnings: "Hoiatused",
  },
  en: {
    tool: "Tool", supplier: "Supplier", client: "Client", name: "Name",
    invoice_no: "Invoice no", date: "Date", due_date: "Due date", amount: "Amount",
    total: "Total", net: "net", vat: "VAT", gross: "gross",
    postings: "Postings", account: "Account", direction: "Type", description: "Description",
    items: "Lines", distribution: "Distribution", count: "Count", fields_changed: "Fields changed",
    file: "File", warnings: "Warnings",
  },
};

function l(key: string): string {
  return FIELD_LABELS[getLang()][key] ?? key;
}

function actionLabel(action: string): string {
  return ACTION_LABELS[getLang()][action] ?? action;
}

function entityLabel(entityType: string): string {
  return ENTITY_LABELS[getLang()][entityType] ?? entityType;
}

function formatTimestamp(iso: string): string {
  // "2026-03-24T10:15:32.123Z" → "2026-03-24 10:15:32"
  return iso.replace("T", " ").replace(/\.\d+Z$|Z$/, "");
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function escapeMarkdown(s: string): string {
  return s.replace(/[|*_`[\]\\]/g, "\\$&");
}

function renderPostingsTable(postings: unknown): string {
  if (!Array.isArray(postings) || postings.length === 0) return "";
  const rows = postings.map((p: Record<string, unknown>) => {
    const account = String(p.account_name ?? p.accounts_id ?? "");
    const type = p.type === "D" ? "D" : p.type === "C" ? "K" : String(p.type);
    const amount = typeof p.amount === "number" ? p.amount.toFixed(2) : String(p.amount ?? "");
    return `| ${account} | ${type} | ${amount} |`;
  });
  return `\n**${l("postings")}:**\n| ${l("account")} | ${l("direction")} | ${l("amount")} |\n|-------|-------|-------|\n` + rows.join("\n");
}

function renderDetails(entry: Omit<AuditEntry, "timestamp"> & { timestamp: string }): string {
  const d = entry.details;
  const lines: string[] = [];

  lines.push(`**${l("tool")}:** \`${entry.tool}\``);

  // Supplier / client info
  if (d.client_name || d.supplier_name) {
    const name = escapeMarkdown(String(d.client_name ?? d.supplier_name ?? ""));
    const reg = d.reg_code ? ` (reg: ${escapeMarkdown(String(d.reg_code))})` : "";
    lines.push(`**${entry.entity_type === "purchase_invoice" ? l("supplier") : l("client")}:** ${name}${reg}`);
  }
  if (d.name && (entry.entity_type === "client" || entry.entity_type === "product")) {
    lines.push(`**${l("name")}:** ${escapeMarkdown(String(d.name))}`);
  }

  // Invoice number
  if (d.invoice_number) {
    lines.push(`**${l("invoice_no")}:** ${escapeMarkdown(String(d.invoice_number))}`);
  }

  // Dates
  const dateParts: string[] = [];
  if (d.date || d.effective_date || d.invoice_date) {
    dateParts.push(`**${l("date")}:** ${d.date ?? d.effective_date ?? d.invoice_date}`);
  }
  if (d.due_date) {
    dateParts.push(`**${l("due_date")}:** ${d.due_date}`);
  }
  if (dateParts.length > 0) {
    lines.push(dateParts.join(" | "));
  }

  // Amounts
  if (d.amount !== undefined) {
    lines.push(`**${l("amount")}:** ${typeof d.amount === "number" ? (d.amount as number).toFixed(2) : d.amount}`);
  }

  // Totals line
  const totalParts: string[] = [];
  if (d.total_net !== undefined) totalParts.push(`${l("net")} ${(d.total_net as number).toFixed(2)}`);
  if (d.total_vat !== undefined) totalParts.push(`${l("vat")} ${(d.total_vat as number).toFixed(2)}`);
  if (d.total_gross !== undefined) totalParts.push(`${l("gross")} ${(d.total_gross as number).toFixed(2)}`);
  if (totalParts.length > 0) {
    lines.push(`**${l("total")}:** ${totalParts.join(" | ")}`);
  }

  // Postings table
  if (d.postings) {
    const table = renderPostingsTable(d.postings as unknown);
    if (table) lines.push(table);
  }

  // Description
  if (d.description && !d.client_name && !d.supplier_name) {
    lines.push(`**${l("description")}:** ${escapeMarkdown(String(d.description))}`);
  }

  // Items
  if (Array.isArray(d.items) && d.items.length > 0) {
    lines.push(`**${l("items")}:** ${d.items.length}`);
  }

  // Distribution
  if (Array.isArray(d.distributions) && d.distributions.length > 0) {
    const distParts = (d.distributions as Array<Record<string, unknown>>).map(
      dist => `${dist.related_table}/${dist.related_id}: ${dist.amount}`,
    );
    lines.push(`**${l("distribution")}:** ${distParts.join(", ")}`);
  }

  // Count (for batch operations)
  if (d.count !== undefined) {
    lines.push(`**${l("count")}:** ${d.count}`);
  }

  // Fields changed (for updates)
  if (Array.isArray(d.fields_changed) && d.fields_changed.length > 0) {
    lines.push(`**${l("fields_changed")}:** ${d.fields_changed.join(", ")}`);
  }

  // File
  if (d.file_name) {
    lines.push(`**${l("file")}:** ${escapeMarkdown(String(d.file_name))}`);
  }

  // Warnings
  if (Array.isArray(d.warnings) && d.warnings.length > 0) {
    lines.push(`**${l("warnings")}:** ${(d.warnings as string[]).join("; ")}`);
  }

  // Extra key-value pairs not already covered
  const rendered = new Set([
    "client_name", "supplier_name", "reg_code", "name", "invoice_number",
    "date", "effective_date", "invoice_date", "due_date", "amount",
    "total_net", "total_vat", "total_gross", "postings", "description",
    "items", "distributions", "count", "fields_changed", "file_name", "warnings",
  ]);
  for (const [key, value] of Object.entries(d)) {
    if (rendered.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === "object") continue; // skip complex nested objects
    lines.push(`**${key}:** ${escapeMarkdown(String(value))}`);
  }

  return lines.join("\n");
}

function renderEntry(entry: AuditEntry): string {
  const ts = formatTimestamp(entry.timestamp);
  const label = `${entityLabel(entry.entity_type)} ${actionLabel(entry.action).toLowerCase()}`;
  const idSuffix = entry.entity_id ? ` #${entry.entity_id}` : "";
  const heading = `### ${ts} — ${label}${idSuffix}`;

  // Machine-parseable metadata as HTML comment
  const meta = `<!-- audit:${JSON.stringify({
    t: entry.tool, a: entry.action, e: entry.entity_type, id: entry.entity_id,
  })} -->`;

  const body = renderDetails(entry);

  return `${heading}\n\n${meta}\n${body}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a single audit entry to a connection's Markdown log file.
 *
 * Default target is the currently-active connection. Pass `connectionName`
 * to direct the entry to a specific connection's log — needed when a tool
 * fails mid-switch and the audit record belongs on the ORIGINAL (interrupted)
 * connection, not the new active one.
 *
 * Concurrency guarantees:
 * - Within a single Node process: writes are serialized by the event loop
 *   (handlers can't interleave across `appendFileSync` calls).
 * - Across processes on Linux/macOS: `O_APPEND` guarantees atomicity only
 *   up to `PIPE_BUF` bytes (4096 on Linux). Entries larger than that may
 *   interleave if two MCP server processes write to the same connection
 *   log file simultaneously. We warn when an entry exceeds this bound so
 *   operators can spot corrupted records.
 */
const LINUX_PIPE_BUF_BYTES = 4096;

export function logAudit(
  entry: Omit<AuditEntry, "timestamp">,
  opts?: { connectionName?: string },
): void {
  const full: AuditEntry = { ...entry, timestamp: new Date().toISOString() };
  try {
    const filePath = opts?.connectionName
      ? getLogFilePathForConnection(opts.connectionName)
      : getLogFilePath();
    if (!existsSync(LOGS_DIR)) {
      mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
    }
    const md = renderEntry(full) + ENTRY_SEPARATOR;
    if (Buffer.byteLength(md, "utf-8") > LINUX_PIPE_BUF_BYTES) {
      // Size-warn (not block) so operators notice when cross-process writers
      // might interleave. Single-process audit logging stays atomic.
      process.stderr.write(
        `[audit] entry size ${Buffer.byteLength(md, "utf-8")}B exceeds PIPE_BUF (${LINUX_PIPE_BUF_BYTES}B); ` +
        `across-process atomicity not guaranteed for tool="${entry.tool}" action="${entry.action}"\n`,
      );
    }
    appendPrivateTextFile(filePath, md);
  } catch {
    // Audit logging is best-effort — do not crash the server
  }
}

export interface AuditLogFilter {
  entity_type?: string;
  action?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
}

function parseAuditTimestamp(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (AUDIT_TS_RE.test(trimmed)) {
    const parsed = Date.parse(trimmed.replace(" ", "T") + "Z");
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (ISO_TS_NO_TZ_RE.test(trimmed)) {
    const parsed = Date.parse(trimmed + "Z");
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFilterBoundary(value: string, kind: "from" | "to"): number {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Invalid ${kind === "from" ? "date_from" : "date_to"} filter: empty value`);
  }

  if (DATE_ONLY_RE.test(trimmed)) {
    const suffix = kind === "from" ? "T00:00:00.000Z" : "T23:59:59.999Z";
    const parsed = Date.parse(trimmed + suffix);
    if (Number.isFinite(parsed)) return parsed;
  }

  const parsed = parseAuditTimestamp(trimmed);
  if (parsed !== undefined) return parsed;

  throw new Error(
    `Invalid ${kind === "from" ? "date_from" : "date_to"} filter: "${value}". ` +
    "Expected YYYY-MM-DD or ISO 8601."
  );
}

function parseLimitFilter(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid limit filter: "${value}". Expected a positive integer.`);
  }
  return value;
}

function getAuditLogFromFile(filePath: string, filter?: AuditLogFilter): string {
  const dateFromMs = filter?.date_from ? parseFilterBoundary(filter.date_from, "from") : undefined;
  const dateToMs = filter?.date_to ? parseFilterBoundary(filter.date_to, "to") : undefined;
  const limit = parseLimitFilter(filter?.limit);

  if (!existsSync(filePath)) return "";

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }

  if (!filter?.entity_type && !filter?.action && !filter?.date_from && !filter?.date_to && !filter?.limit) {
    return content;
  }

  // Split into sections by separator
  const sections = content.split(ENTRY_SEPARATOR).filter(Boolean);
  let filtered = sections;

  if (filter?.date_from || filter?.date_to) {
    filtered = filtered.filter(section => {
      const match = section.match(/^### (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      if (!match) return true;
      const tsMs = parseAuditTimestamp(match[1]!);
      if (tsMs === undefined) return true;
      if (dateFromMs !== undefined && tsMs < dateFromMs) return false;
      if (dateToMs !== undefined && tsMs > dateToMs) return false;
      return true;
    });
  }

  if (filter?.entity_type || filter?.action) {
    filtered = filtered.filter(section => {
      const metaMatch = section.match(META_RE);
      if (!metaMatch) return true;
      try {
        const meta = JSON.parse(metaMatch[1]!) as { a?: string; e?: string };
        if (filter.entity_type && meta.e !== filter.entity_type) return false;
        if (filter.action && meta.a !== filter.action) return false;
        return true;
      } catch {
        return true;
      }
    });
  }

  if (filtered.length > limit) {
    filtered = filtered.slice(-limit);
  }

  return filtered.join(ENTRY_SEPARATOR) + (filtered.length > 0 ? ENTRY_SEPARATOR : "");
}

/** Read the current connection's audit log. Returns raw Markdown content. */
export function getAuditLog(filter?: AuditLogFilter): string {
  return getAuditLogFromFile(getLogFilePath(), filter);
}

/** Clear the current connection's audit log file. */
export function clearAuditLog(): void {
  const filePath = getLogFilePath();
  try {
    writePrivateTextFile(filePath, "");
  } catch {
    // best-effort
  }
}

/** List available audit log files with metadata. */
export function listAuditLogs(): Array<{ connection: string; file: string; entries: number; last_entry?: string }> {
  if (!existsSync(LOGS_DIR)) return [];
  try {
    const files = readdirSync(LOGS_DIR).filter(f => f.endsWith(".audit.md")).sort();
    return files.map(file => {
      const filePath = join(LOGS_DIR, file);
      const connection = file.replace(/\.audit\.md$/, "");
      let entries = 0;
      let last_entry: string | undefined;
      try {
        const content = readFileSync(filePath, "utf-8");
        const sections = splitAuditSections(content);
        entries = sections.length;
        if (sections.length > 0) {
          const match = sections[sections.length - 1]!.match(/^### (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
          if (match) last_entry = match[1];
        }
      } catch { /* ignore */ }
      return { connection, file, entries, last_entry };
    });
  } catch {
    return [];
  }
}

/** Read a specific connection's audit log (not just the active one). */
export function getAuditLogByConnection(connectionName: string, filter?: AuditLogFilter): string {
  loadAuditLabelMap();
  const mappedPath = getLogFilePathForConnection(connectionName);
  if (existsSync(mappedPath)) {
    return getAuditLogFromFile(mappedPath, filter);
  }

  return getAuditLogFromFile(getLogFilePathForLabel(normalizeAuditLabel(connectionName)), filter);
}

/** Read an audit log by its human-readable label / file stem. */
export function getAuditLogByLabel(label: string, filter?: AuditLogFilter): string {
  return getAuditLogFromFile(getLogFilePathForLabel(label), filter);
}
