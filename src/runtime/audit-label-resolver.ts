import type { NamedConfig } from "../config.js";
import type { ApiContext } from "../tools/crud-tools.js";
import { setAuditLogLabels, getCurrentAuditLogLabel } from "../audit-log.js";
import { buildAuditLogLabels } from "../audit-log-labels.js";
import { log } from "../logger.js";

export function normalizeAuditCompanyName(companyName: string | null | undefined): string | null {
  if (typeof companyName !== "string") return null;
  const normalized = companyName.replace(/\s+/g, " ").trim();
  return normalized || null;
}

export interface AuditLabelResolver {
  /** Recompute + apply audit-log labels from the currently-resolved company names. */
  applyAuditLogLabels(): void;
  /** Resolve (once, on first use) the audit-log company name for a connection index. */
  ensureAuditLogLabelResolved(index: number): Promise<void>;
  /** Verified company identity for a connection index, or null if not yet resolved. */
  getVerifiedCompanyIdentity(index: number): string | null;
}

/**
 * Owns the resolve-on-first-use audit-label machinery: the per-connection
 * resolved-company-name map (seeded from any pre-verified name on the config),
 * the label-application step, and the deduped async resolution that fills in a
 * company name from the connection's first real API read.
 *
 * Moved verbatim from `createMcpServer`; the timing (lazy resolve, then
 * `applyAuditLogLabels`) is unchanged — only its file location.
 */
export function createAuditLabelResolver(opts: {
  allConfigs: readonly NamedConfig[];
  connectionContexts: ApiContext[];
  setupMode: boolean;
}): AuditLabelResolver {
  const { allConfigs, connectionContexts, setupMode } = opts;
  const resolvedAuditCompanyNames = new Map<number, string | null>();
  allConfigs.forEach((config, index) => {
    const verifiedCompanyName = normalizeAuditCompanyName(config.verifiedCompanyName);
    if (verifiedCompanyName) resolvedAuditCompanyNames.set(index, verifiedCompanyName);
  });
  const auditLabelResolutionPromises = new Map<number, Promise<void>>();

  function applyAuditLogLabels(): void {
    const labels = buildAuditLogLabels(allConfigs.map((config, index) => ({
      connectionName: config.name,
      companyName: resolvedAuditCompanyNames.get(index) ?? undefined,
      currentLabel: resolvedAuditCompanyNames.has(index)
        ? config.name
        : getCurrentAuditLogLabel(config.name),
    })));

    setAuditLogLabels(allConfigs.map((config) => {
      return {
        connectionName: config.name,
        label: labels.get(config.name) ?? getCurrentAuditLogLabel(config.name),
      };
    }));
  }

  async function ensureAuditLogLabelResolved(index: number): Promise<void> {
    if (setupMode || index < 0 || index >= connectionContexts.length) return;
    if (resolvedAuditCompanyNames.has(index)) return;

    const existing = auditLabelResolutionPromises.get(index);
    if (existing) {
      await existing;
      return;
    }

    const pending = (async () => {
      try {
        const invoiceInfo = await connectionContexts[index]!.readonly.getInvoiceInfo();
        const hadPrevious = resolvedAuditCompanyNames.has(index);
        const previousCompanyName = resolvedAuditCompanyNames.get(index);
        resolvedAuditCompanyNames.set(index, normalizeAuditCompanyName(invoiceInfo.invoice_company_name));
        try {
          applyAuditLogLabels();
        } catch (error) {
          if (hadPrevious) {
            resolvedAuditCompanyNames.set(index, previousCompanyName ?? null);
          } else {
            resolvedAuditCompanyNames.delete(index);
          }
          throw error;
        }
      } catch (error) {
        log(
          "warning",
          `Failed to resolve audit log company name for connection "${allConfigs[index]!.name}": ` +
          `${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        auditLabelResolutionPromises.delete(index);
      }
    })();

    auditLabelResolutionPromises.set(index, pending);
    await pending;
  }

  return {
    applyAuditLogLabels,
    ensureAuditLogLabelResolved,
    getVerifiedCompanyIdentity: (index) => resolvedAuditCompanyNames.get(index) ?? null,
  };
}
