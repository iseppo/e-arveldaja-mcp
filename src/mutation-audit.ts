import {
  AuditEntityType,
  logAudit,
  type AuditEntry,
} from "./audit-log.js";
import { z } from "zod";
import { log } from "./logger.js";
import { toolError } from "./tool-error.js";

const MutationAuditRecovery = z.object({
  category: z.literal("mutation_indeterminate"),
  mutationMayHaveOccurred: z.literal(true),
  operation: z.enum([
    "create",
    "update",
    "delete",
    "upload",
    "confirm",
    "invalidate",
    "rollback",
  ]),
  entity: AuditEntityType,
  entityId: z.number().finite().int().optional(),
  businessKey: z.string().trim().min(1),
  affectedCaches: z.array(z.enum([
    "/clients",
    "/products",
    "/journals",
    "/transactions",
    "/sale_invoices",
    "/purchase_invoices",
  ])).min(1),
  cause: z.object({
    name: z.string(),
    message: z.string(),
    status: z.union([z.number().finite(), z.string()]).optional(),
    method: z.string().optional(),
    path: z.string().optional(),
  }),
  nextAction: z.string().trim().min(1),
});

type MutationAuditRecovery = z.infer<typeof MutationAuditRecovery>;

function parseMutationAuditRecovery(error: unknown): MutationAuditRecovery | undefined {
  try {
    const parsed = MutationAuditRecovery.safeParse(error);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export type MutationAuditWriter = (
  entry: Omit<AuditEntry, "timestamp">,
  opts?: { connectionName?: string },
) => boolean;

export interface AuditMutationIndeterminateOptions {
  toolName: string;
  error: unknown;
  connectionName: string;
  writeAudit?: MutationAuditWriter;
}

export interface SerializeToolMutationErrorOptions {
  toolName: string;
  error: unknown;
  trackMutation: boolean;
  snapshotIndex: number;
  connectionNames: readonly string[];
  writeAudit?: MutationAuditWriter;
  logError?: (message: string) => void;
}

function writeMutationIndeterminateAudit(
  options: AuditMutationIndeterminateOptions,
  recovery: MutationAuditRecovery,
): boolean {
  const affectedCaches = [...new Set(recovery.affectedCaches)].sort().join(",");
  const writeAudit = options.writeAudit ?? logAudit;

  return writeAudit({
    tool: options.toolName,
    action: "MUTATION_INDETERMINATE",
    entity_type: recovery.entity,
    entity_id: recovery.entityId,
    summary: "Mutation outcome is indeterminate; inspect remote state before retrying.",
    details: {
      category: recovery.category,
      mutation_may_have_occurred: recovery.mutationMayHaveOccurred,
      operation: recovery.operation,
      business_key: recovery.businessKey,
      affected_caches: affectedCaches,
      cause_name: recovery.cause.name,
      cause_message: recovery.cause.message,
      cause_status: recovery.cause.status,
      cause_method: recovery.cause.method,
      cause_path: recovery.cause.path,
      next_action: recovery.nextAction,
    },
  }, { connectionName: options.connectionName });
}

export function auditMutationIndeterminate(
  options: AuditMutationIndeterminateOptions,
): boolean {
  const recovery = parseMutationAuditRecovery(options.error);
  if (!recovery) return false;
  return writeMutationIndeterminateAudit(options, recovery);
}

export function serializeToolMutationError(
  options: SerializeToolMutationErrorOptions,
) {
  const recovery = options.trackMutation
    ? parseMutationAuditRecovery(options.error)
    : undefined;
  if (
    recovery &&
    Number.isInteger(options.snapshotIndex) &&
    options.snapshotIndex >= 0 &&
    options.snapshotIndex < options.connectionNames.length
  ) {
    const connectionName = options.connectionNames[options.snapshotIndex];
    if (typeof connectionName === "string" && connectionName.trim() !== "") {
      try {
        const persisted = writeMutationIndeterminateAudit({
          toolName: options.toolName,
          error: options.error,
          connectionName,
          writeAudit: options.writeAudit,
        }, recovery);
        if (!persisted) {
          (options.logError ?? ((message: string) => log("error", message)))(
            "Failed to persist MUTATION_INDETERMINATE audit entry",
          );
        }
      } catch {
        (options.logError ?? ((message: string) => log("error", message)))(
          "Failed to persist MUTATION_INDETERMINATE audit entry",
        );
      }
    }
  }
  return toolError(options.error);
}
