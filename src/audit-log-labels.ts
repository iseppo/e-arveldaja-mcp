export interface AuditLogLabelInput {
  connectionName: string;
  companyName?: string | null;
}

interface NormalizedAuditLogLabelInput {
  connectionName: string;
  companyName: string | null;
  baseLabel: string;
  baseKey: string;
}

export function normalizeAuditLabel(label: string): string {
  const collapsed = label.replace(/\s+/g, " ").trim();
  return collapsed || "default";
}

export function sanitizeAuditLogName(name: string): string {
  const normalized = normalizeAuditLabel(name)
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "")
    .substring(0, 200)
    .trim();
  return normalized || "default";
}

function normalizeAuditLogLabelInput(entry: AuditLogLabelInput): NormalizedAuditLogLabelInput {
  const connectionName = normalizeAuditLabel(entry.connectionName);
  const companyName = entry.companyName ? normalizeAuditLabel(entry.companyName) : null;
  const baseLabel = companyName ?? connectionName;

  return {
    connectionName,
    companyName,
    baseLabel,
    baseKey: sanitizeAuditLogName(baseLabel).toLowerCase(),
  };
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function pickPreferredAuditLogLabel(
  entry: NormalizedAuditLogLabelInput,
  totalWithSameBaseKey: number,
  resolvedWithSameBaseKey: number,
): string {
  if (totalWithSameBaseKey === 1) {
    return entry.baseLabel;
  }

  if (entry.companyName && resolvedWithSameBaseKey === 1) {
    return entry.companyName;
  }

  if (entry.companyName && entry.connectionName !== entry.companyName) {
    return `${entry.companyName} (${entry.connectionName})`;
  }

  return `${entry.baseLabel} (connection)`;
}

function makeUniqueAuditLogLabel(preferredLabel: string, usedKeys: Set<string>): string {
  let candidate = preferredLabel;
  let candidateKey = sanitizeAuditLogName(candidate).toLowerCase();
  let attempt = 2;

  while (usedKeys.has(candidateKey)) {
    candidate = `${preferredLabel} (${attempt})`;
    candidateKey = sanitizeAuditLogName(candidate).toLowerCase();
    attempt += 1;
  }

  usedKeys.add(candidateKey);
  return candidate;
}

export function buildAuditLogLabels(entries: AuditLogLabelInput[]): Map<string, string> {
  const normalizedEntries = entries.map(normalizeAuditLogLabelInput);
  const totalByBaseKey = new Map<string, number>();
  const resolvedByBaseKey = new Map<string, number>();

  for (const entry of normalizedEntries) {
    incrementCount(totalByBaseKey, entry.baseKey);
    if (entry.companyName) {
      incrementCount(resolvedByBaseKey, entry.baseKey);
    }
  }

  const labels = new Map<string, string>();
  const usedKeys = new Set<string>();

  for (const entry of normalizedEntries) {
    const preferredLabel = pickPreferredAuditLogLabel(
      entry,
      totalByBaseKey.get(entry.baseKey) ?? 0,
      resolvedByBaseKey.get(entry.baseKey) ?? 0,
    );
    labels.set(entry.connectionName, makeUniqueAuditLogLabel(preferredLabel, usedKeys));
  }

  return labels;
}
