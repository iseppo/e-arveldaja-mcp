/** MCP tool annotation presets for e-arveldaja tools. */

const base = { openWorldHint: true } as const;

/** Read-only data retrieval — safe to auto-approve. */
export const readOnly = { ...base, readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

/** Creates a new record (draft). Not destructive but not idempotent. */
export const create = { ...base, readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;

/** Updates an existing record. Reversible. */
export const mutate = { ...base, readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const;

/** Irreversible action: confirm, delete. Requires user confirmation. */
export const destructive = { ...base, readOnlyHint: false, destructiveHint: true, idempotentHint: true } as const;

/** Sends data externally (email, e-invoice). Irreversible and not idempotent. */
export const send = { ...base, readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const;

/** Batch operation that modifies multiple records. Not idempotent. */
export const batch = { ...base, readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const;
