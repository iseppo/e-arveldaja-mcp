import { types as utilTypes } from "node:util";
import { cloneAndFreezePlanData } from "./plan-store.js";

const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
const CATEGORY_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/;
const MAX_COMMANDS = 5_000;
const MAX_KNOWN_OBJECTS_PER_COMMAND = 100;
const MAX_KNOWN_OBJECTS_TOTAL = 5_000;

export type KnownObjectOutcome = "created" | "confirmed" | "updated" | "invalidated" | "deleted" | "uploaded";

export interface PlanExecutionCommand {
  readonly id: string;
  readonly category: string;
  /** Maximum known object IDs this command may return; defaults to one. */
  readonly known_object_limit?: number;
  readonly [key: string]: unknown;
}

export type PrepareCommandResult =
  | { readonly outcome: "ready" }
  | { readonly outcome: "skipped"; readonly reason_code: string }
  | { readonly outcome: "drift"; readonly error_code: string };

export interface KnownObjectResult {
  readonly entity_type: string;
  readonly entity_id: string | number;
  readonly outcome: KnownObjectOutcome;
}

export type MutateCommandResult =
  | { readonly outcome: "completed"; readonly known_objects?: readonly KnownObjectResult[] }
  | { readonly outcome: "failed"; readonly error_code: string; readonly mutation_occurred: boolean; readonly known_objects?: readonly KnownObjectResult[] }
  | { readonly outcome: "indeterminate"; readonly error_code: string; readonly known_objects?: readonly KnownObjectResult[] };

export interface CommandPartitionItem {
  readonly command_id: string;
  readonly category: string;
  readonly code?: string;
  readonly mutation_occurred?: boolean;
}

export interface KnownObjectId extends KnownObjectResult {
  readonly command_id: string;
}

export type PlanExecutionStatus = "completed" | "plan_drift" | "mutation_failed" | "partial_execution";

export interface PlanExecutionReport {
  readonly contract: "plan_execution_report_v1";
  readonly status: PlanExecutionStatus;
  readonly command_partitions: Readonly<{
    completed: readonly CommandPartitionItem[];
    skipped: readonly CommandPartitionItem[];
    failed: readonly CommandPartitionItem[];
    indeterminate: readonly CommandPartitionItem[];
    not_attempted: readonly CommandPartitionItem[];
  }>;
  readonly known_object_ids: readonly KnownObjectId[];
  readonly mutation_may_have_occurred: boolean;
  readonly automatic_retry_forbidden: true;
  readonly fresh_preview_required: boolean;
  readonly stop_reason: Readonly<{
    command_id: string;
    category: "plan_drift" | "mutation_failed" | "mutation_indeterminate";
    code: string;
  }> | null;
}

export type PlanExecutionErrorCode = "plan_commands_invalid";

export class PlanExecutionError extends Error {
  readonly code: PlanExecutionErrorCode;

  constructor(code: PlanExecutionErrorCode) {
    super("The execution plan contains invalid commands.");
    this.name = "PlanExecutionError";
    this.code = code;
  }
}

function isExactPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    !utilTypes.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function plainDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isExactPlainRecord(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key === "symbol") || keys.some(key => {
    const descriptor = descriptors[key as string];
    return !descriptor || !("value" in descriptor) || !descriptor.enumerable;
  })) return undefined;
  return value;
}

function exactArrayValues(value: unknown, maxItems: number): readonly unknown[] | undefined {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const keys = Reflect.ownKeys(value);
  const lengthValue = descriptors.length?.value;
  if (typeof lengthValue !== "number" || !Number.isSafeInteger(lengthValue) || lengthValue < 0 || lengthValue > maxItems ||
    keys.some(key => typeof key === "symbol") || keys.length !== lengthValue + 1) return undefined;
  const output: unknown[] = [];
  for (let index = 0; index < lengthValue; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    output.push(descriptor.value);
  }
  return Object.freeze(output);
}

function isCode(value: unknown): value is string {
  return typeof value === "string" && CODE_PATTERN.test(value);
}

function freezeItem(item: CommandPartitionItem): CommandPartitionItem {
  return Object.freeze(item);
}

function commandItem(command: PlanExecutionCommand, extra: Partial<CommandPartitionItem> = {}): CommandPartitionItem {
  return freezeItem({ command_id: command.id, category: command.category, ...extra });
}

function validateCommands<TCommand extends PlanExecutionCommand>(commands: readonly TCommand[]): readonly TCommand[] {
  let cloned: unknown;
  try {
    cloned = cloneAndFreezePlanData(commands);
  } catch {
    throw new PlanExecutionError("plan_commands_invalid");
  }
  if (!Array.isArray(cloned) || cloned.length > MAX_COMMANDS) throw new PlanExecutionError("plan_commands_invalid");
  const ids = new Set<string>();
  let totalKnownObjectLimit = 0;
  for (const candidate of cloned) {
    if (candidate === null || Array.isArray(candidate) || typeof candidate !== "object") {
      throw new PlanExecutionError("plan_commands_invalid");
    }
    const command = candidate as Record<string, unknown>;
    const id = command.id;
    const category = command.category;
    if (typeof id !== "string" || !COMMAND_ID_PATTERN.test(id) || typeof category !== "string" ||
      !CATEGORY_PATTERN.test(category) || ids.has(id)) throw new PlanExecutionError("plan_commands_invalid");
    const knownObjectLimit = command.known_object_limit ?? 1;
    if (typeof knownObjectLimit !== "number" || !Number.isSafeInteger(knownObjectLimit) ||
      knownObjectLimit < 0 || knownObjectLimit > MAX_KNOWN_OBJECTS_PER_COMMAND) {
      throw new PlanExecutionError("plan_commands_invalid");
    }
    totalKnownObjectLimit += knownObjectLimit;
    if (totalKnownObjectLimit > MAX_KNOWN_OBJECTS_TOTAL) throw new PlanExecutionError("plan_commands_invalid");
    ids.add(id);
  }
  return cloned as readonly TCommand[];
}

function validatePrepare(value: unknown): PrepareCommandResult | undefined {
  const record = plainDataRecord(value);
  if (!record || typeof record.outcome !== "string") return undefined;
  const keys = Object.keys(record);
  if (record.outcome === "ready" && keys.length === 1) return record as unknown as PrepareCommandResult;
  if (record.outcome === "skipped" && keys.length === 2 && isCode(record.reason_code)) return record as unknown as PrepareCommandResult;
  if (record.outcome === "drift" && keys.length === 2 && isCode(record.error_code)) return record as unknown as PrepareCommandResult;
  return undefined;
}

function validateKnownObjects(value: unknown): readonly KnownObjectResult[] | undefined {
  if (value === undefined) return Object.freeze([]);
  const values = exactArrayValues(value, MAX_KNOWN_OBJECTS_PER_COMMAND);
  if (!values) return undefined;
  const output: KnownObjectResult[] = [];
  for (const candidate of values) {
    const item = plainDataRecord(candidate);
    if (!item || Object.keys(item).length !== 3 ||
      typeof item.entity_type !== "string" || !CATEGORY_PATTERN.test(item.entity_type) ||
      !["created", "confirmed", "updated", "invalidated", "deleted", "uploaded"].includes(String(item.outcome)) ||
      !((typeof item.entity_id === "number" && Number.isSafeInteger(item.entity_id) && item.entity_id > 0) ||
        (typeof item.entity_id === "string" && ENTITY_ID_PATTERN.test(item.entity_id)))) return undefined;
    output.push(Object.freeze({
      entity_type: item.entity_type,
      entity_id: item.entity_id as string | number,
      outcome: item.outcome as KnownObjectOutcome,
    }));
  }
  return Object.freeze(output);
}

function validateMutation(value: unknown): MutateCommandResult | undefined {
  const record = plainDataRecord(value);
  if (!record || typeof record.outcome !== "string") return undefined;
  const keys = Object.keys(record);
  if (record.outcome === "completed" && keys.every(key => key === "outcome" || key === "known_objects")) {
    const knownObjects = validateKnownObjects(record.known_objects);
    if (!knownObjects) return undefined;
    return Object.freeze({ outcome: "completed", ...(knownObjects.length ? { known_objects: knownObjects } : {}) });
  }
  if (record.outcome === "failed" && keys.every(key => ["outcome", "error_code", "mutation_occurred", "known_objects"].includes(key)) &&
    keys.length >= 3 && isCode(record.error_code) && typeof record.mutation_occurred === "boolean") {
    const knownObjects = validateKnownObjects(record.known_objects);
    if (!knownObjects || (knownObjects.length > 0 && record.mutation_occurred !== true)) return undefined;
    return Object.freeze({ outcome: "failed", error_code: record.error_code, mutation_occurred: record.mutation_occurred,
      ...(knownObjects.length ? { known_objects: knownObjects } : {}) });
  }
  if (record.outcome === "indeterminate" && keys.every(key => ["outcome", "error_code", "known_objects"].includes(key)) &&
    keys.length >= 2 && isCode(record.error_code)) {
    const knownObjects = validateKnownObjects(record.known_objects);
    if (!knownObjects) return undefined;
    return Object.freeze({ outcome: "indeterminate", error_code: record.error_code,
      ...(knownObjects.length ? { known_objects: knownObjects } : {}) });
  }
  return undefined;
}

function buildReport(args: {
  commands: readonly PlanExecutionCommand[];
  completed: CommandPartitionItem[];
  skipped: CommandPartitionItem[];
  failed: CommandPartitionItem[];
  indeterminate: CommandPartitionItem[];
  knownObjectIds: KnownObjectId[];
  stoppedAt: number | undefined;
  stopKind?: "plan_drift" | "mutation_failed" | "mutation_indeterminate";
  stopCode?: string;
  mutationMayHaveOccurred: boolean;
}): PlanExecutionReport {
  const notAttempted = args.stoppedAt === undefined
    ? []
    : args.commands.slice(args.stoppedAt + 1).map(command => commandItem(command));
  let status: PlanExecutionStatus;
  if (args.stopKind === undefined) status = "completed";
  else if (args.stopKind === "plan_drift" && !args.mutationMayHaveOccurred) status = "plan_drift";
  else if (args.stopKind === "mutation_failed" && !args.mutationMayHaveOccurred) status = "mutation_failed";
  else status = "partial_execution";
  const command = args.stoppedAt === undefined ? undefined : args.commands[args.stoppedAt];
  const stopReason = command && args.stopKind && args.stopCode
    ? Object.freeze({ command_id: command.id, category: args.stopKind, code: args.stopCode })
    : null;
  const partitions = Object.freeze({
    completed: Object.freeze(args.completed),
    skipped: Object.freeze(args.skipped),
    failed: Object.freeze(args.failed),
    indeterminate: Object.freeze(args.indeterminate),
    not_attempted: Object.freeze(notAttempted),
  });
  return Object.freeze({
    contract: "plan_execution_report_v1",
    status,
    command_partitions: partitions,
    known_object_ids: Object.freeze(args.knownObjectIds),
    mutation_may_have_occurred: args.mutationMayHaveOccurred,
    automatic_retry_forbidden: true,
    fresh_preview_required: status !== "completed",
    stop_reason: stopReason,
  });
}

export async function runPlanCommands<TCommand extends PlanExecutionCommand>(options: {
  readonly commands: readonly TCommand[];
  readonly prepare: (command: TCommand, index: number) => Promise<PrepareCommandResult>;
  readonly mutate: (command: TCommand, index: number) => Promise<MutateCommandResult>;
}): Promise<PlanExecutionReport> {
  const commands = validateCommands(options.commands);
  const completed: CommandPartitionItem[] = [];
  const skipped: CommandPartitionItem[] = [];
  const failed: CommandPartitionItem[] = [];
  const indeterminate: CommandPartitionItem[] = [];
  const knownObjectIds: KnownObjectId[] = [];
  let mutationMayHaveOccurred = false;

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index]!;
    let prepared: PrepareCommandResult | undefined;
    try {
      prepared = validatePrepare(await options.prepare(command, index));
    } catch {
      prepared = undefined;
    }
    if (!prepared) {
      failed.push(commandItem(command, { code: "preparation_failed" }));
      return buildReport({ commands, completed, skipped, failed, indeterminate, knownObjectIds,
        stoppedAt: index, stopKind: "mutation_failed", stopCode: "preparation_failed", mutationMayHaveOccurred });
    }
    if (prepared.outcome === "skipped") {
      skipped.push(commandItem(command, { code: prepared.reason_code }));
      continue;
    }
    if (prepared.outcome === "drift") {
      failed.push(commandItem(command, { code: prepared.error_code }));
      return buildReport({ commands, completed, skipped, failed, indeterminate, knownObjectIds,
        stoppedAt: index, stopKind: "plan_drift", stopCode: prepared.error_code, mutationMayHaveOccurred });
    }

    let mutation: MutateCommandResult | undefined;
    try {
      mutation = validateMutation(await options.mutate(command, index));
    } catch {
      indeterminate.push(commandItem(command, { code: "mutation_outcome_unknown" }));
      return buildReport({ commands, completed, skipped, failed, indeterminate, knownObjectIds,
        stoppedAt: index, stopKind: "mutation_indeterminate", stopCode: "mutation_outcome_unknown", mutationMayHaveOccurred: true });
    }
    if (!mutation) {
      indeterminate.push(commandItem(command, { code: "mutation_result_invalid" }));
      return buildReport({ commands, completed, skipped, failed, indeterminate, knownObjectIds,
        stoppedAt: index, stopKind: "mutation_indeterminate", stopCode: "mutation_result_invalid", mutationMayHaveOccurred: true });
    }
    const knownObjects = mutation.known_objects ?? [];
    const declaredKnownObjectLimit = typeof command.known_object_limit === "number" ? command.known_object_limit : 1;
    if (knownObjects.length > declaredKnownObjectLimit) {
      for (const known of knownObjects) {
        knownObjectIds.push(Object.freeze({ command_id: command.id, ...known }));
      }
      indeterminate.push(commandItem(command, { code: "mutation_result_limit_exceeded" }));
      return buildReport({ commands, completed, skipped, failed, indeterminate, knownObjectIds,
        stoppedAt: index, stopKind: "mutation_indeterminate", stopCode: "mutation_result_limit_exceeded", mutationMayHaveOccurred: true });
    }
    if (mutation.outcome === "completed") {
      mutationMayHaveOccurred = true;
      completed.push(commandItem(command));
      for (const known of mutation.known_objects ?? []) {
        knownObjectIds.push(Object.freeze({ command_id: command.id, ...known }));
      }
      continue;
    }
    if (mutation.outcome === "indeterminate") {
      for (const known of mutation.known_objects ?? []) {
        knownObjectIds.push(Object.freeze({ command_id: command.id, ...known }));
      }
      indeterminate.push(commandItem(command, { code: mutation.error_code }));
      return buildReport({ commands, completed, skipped, failed, indeterminate, knownObjectIds,
        stoppedAt: index, stopKind: "mutation_indeterminate", stopCode: mutation.error_code, mutationMayHaveOccurred: true });
    }
    mutationMayHaveOccurred ||= mutation.mutation_occurred;
    for (const known of mutation.known_objects ?? []) {
      knownObjectIds.push(Object.freeze({ command_id: command.id, ...known }));
    }
    failed.push(commandItem(command, { code: mutation.error_code, mutation_occurred: mutation.mutation_occurred }));
    return buildReport({ commands, completed, skipped, failed, indeterminate, knownObjectIds,
      stoppedAt: index, stopKind: "mutation_failed", stopCode: mutation.error_code, mutationMayHaveOccurred });
  }

  return buildReport({ commands, completed, skipped, failed, indeterminate, knownObjectIds,
    stoppedAt: undefined, mutationMayHaveOccurred });
}
