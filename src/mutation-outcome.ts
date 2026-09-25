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

/**
 * Shared outcome classifier for a failed mutating request (POST/PATCH/PUT/DELETE).
 *
 * - "definitive": the server answered with a 4xx status (except 408), i.e. it
 *   rejected the request before committing anything. 429 counts as definitive:
 *   rate limiting is applied before the request is processed, so nothing was
 *   written (HttpClient already retries 429 for every method on that basis).
 * - "indeterminate": everything else — 5xx (the server may have committed the
 *   write and failed afterwards), 408 (the server gave up on a request it may
 *   have partly processed), network drops / timeouts / aborts / body-read
 *   failures (surfaced by HttpClient as `status: "network"`), an already
 *   classified MutationIndeterminateError, and any unknown thrown value.
 *
 * An indeterminate outcome must never be blindly retried: re-read the entity
 * first, or the retry can double-book.
 */
export type MutationFailureClass = "definitive" | "indeterminate";

export function classifyMutationFailure(error: unknown): MutationFailureClass {
  try {
    if (isMutationIndeterminate(error)) return "indeterminate";
  } catch {
    return "indeterminate";
  }
  if (
    error instanceof HttpError &&
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408
  ) {
    return "definitive";
  }
  return "indeterminate";
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
