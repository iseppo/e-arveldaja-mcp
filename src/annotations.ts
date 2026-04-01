/** MCP tool annotation presets for e-arveldaja tools. */

const closedWorld = { openWorldHint: false } as const;
const openWorld = { openWorldHint: true } as const;

/** Read-only data retrieval — safe to auto-approve. */
export const readOnly = { ...closedWorld, readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

/** Creates a new record (draft). Not destructive but not idempotent. */
export const create = { ...closedWorld, readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;

/** Updates an existing record. Reversible. */
export const mutate = { ...closedWorld, readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const;

/** Irreversible action: confirm, delete. Requires user confirmation and should not be auto-retried. */
export const destructive = { ...closedWorld, readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const;

/** Sends data externally (email, e-invoice). Irreversible and not idempotent. */
export const send = { ...openWorld, readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const;

/** Batch operation that modifies multiple records. Not idempotent. */
export const batch = { ...closedWorld, readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const;
