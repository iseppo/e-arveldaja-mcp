import { HttpError } from "./http-client.js";

export type MutationOperation =
  | "create" | "update" | "delete" | "upload"
  | "confirm" | "invalidate" | "rollback";

export interface MutationCause {
  name: string;
  message: string;
  status?: number | "network";
  method?: string;
  path?: string;
}

export interface MutationIndeterminateContext {
  operation: MutationOperation;
  entity: string;
  entityId?: number;
  businessKey: string;
  affectedCaches: string[];
  cause: unknown;
  nextAction: string;
}

export function describeMutationCause(cause: unknown): MutationCause {
  if (cause instanceof HttpError) {
    return {
      name: cause.name,
      message: cause.message,
      status: cause.status,
      method: cause.method,
      path: cause.path,
    };
  }
  if (cause instanceof Error) return { name: cause.name, message: cause.message };
  return { name: "UnknownThrownValue", message: String(cause) };
}

export class MutationIndeterminateError extends Error {
  readonly category = "mutation_indeterminate" as const;
  readonly mutationMayHaveOccurred = true;
  readonly operation: MutationOperation;
  readonly entity: string;
  readonly entityId?: number;
  readonly businessKey: string;
  readonly affectedCaches: string[];
  readonly cause: MutationCause;
  readonly nextAction: string;

  constructor(context: MutationIndeterminateContext) {
    const serializableCause = describeMutationCause(context.cause);
    super(
      context.operation + " " + context.businessKey + " is indeterminate. " +
        context.nextAction,
      { cause: serializableCause },
    );
    this.name = "MutationIndeterminateError";
    this.operation = context.operation;
    this.entity = context.entity;
    this.entityId = context.entityId;
    this.businessKey = context.businessKey;
    this.affectedCaches = [...context.affectedCaches];
    this.cause = serializableCause;
    this.nextAction = context.nextAction;
  }
}

export function isMutationIndeterminate(
  error: unknown,
): error is MutationIndeterminateError {
  return error instanceof MutationIndeterminateError || (
    typeof error === "object" &&
    error !== null &&
    (error as { category?: unknown }).category === "mutation_indeterminate" &&
    (error as { mutationMayHaveOccurred?: unknown }).mutationMayHaveOccurred === true
  );
}
