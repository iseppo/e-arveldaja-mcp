/**
 * Secure, connection-scoped persistent DEFAULTS store. It makes the Task-11
 * `SavedBankDefaultPort` rung-3 live by persisting ONLY non-secret hints (a
 * previously-validated bank dimension id + the data the resolver needs to
 * re-verify it) keyed by `{connectionId(=fingerprint), environmentKind}`.
 *
 * SECURITY CONTRACT:
 *  - NEVER stores a secret. Every persisted entry is projected through an
 *    explicit allow-list (`projectStoredBankDefault`); apiKey / public-value /
 *    password can never reach disk even if smuggled into the input object.
 *  - Written 0600, atomically, via the SHARED `writePrivateFile` primitive
 *    (config.ts) — the exact path the credential .env writer uses. No hand-rolled
 *    plain `writeFileSync` (unlike the opening-/statement-balance stores).
 *  - Reads reject a symlinked / foreign-owned / group-readable target
 *    (`isSecurePrivateFile`) and are size-bound to `MAX_JSON_INPUT_SIZE` (1 MiB).
 *  - FAIL-CLOSED currency: a bank default MUST carry a currency to be persisted
 *    (F-SAVED-DEFAULT-CURRENCY-FAILCLOSED, persist side).
 *
 * Every read is only a HINT: the resolver (`resolveBankAccount` →
 * `verifySavedDefault`) re-runs active/connection/ledger/currency/IBAN/candidate
 * gates on the CURRENT fetch before a hint can influence a plan. A stale hint is
 * silently discarded and a fresh question surfaces.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  getConnectionDefaultsFile,
  isSecurePrivateFile,
  writePrivateFile,
} from "./config.js";
import { MAX_JSON_INPUT_SIZE, safeJsonParse } from "./tools/crud/shared.js";
import type { RuntimeEnvironmentKind } from "./runtime-safety-context.js";
import type {
  SavedBankDefaultPointer,
  SavedBankDefaultPort,
} from "./resolution/bank-account-resolution.js";

export const CONNECTION_DEFAULTS_MAX_ENTRIES = 200;
const DOC_VERSION = 1;

/** The scope half of a store key: which connection + which environment. */
export interface ConnectionScopeKey {
  connectionId: string;
  environmentKind: RuntimeEnvironmentKind;
}

/** Non-secret persisted bank-default hint. Currency is REQUIRED (fail-closed). */
export interface StoredBankDefault extends ConnectionScopeKey {
  kind: "bank_default";
  accounts_dimensions_id: number;
  ledgerAccountId: number;
  currency: string;
  iban?: string;
  input_type?: string;
  savedAt: string;
}

/** Caller-supplied bank default (savedAt/kind are filled in by the store). */
export interface SaveBankDefaultInput extends ConnectionScopeKey {
  accounts_dimensions_id: number;
  ledgerAccountId: number;
  currency: string;
  iban?: string;
  input_type?: string;
}

interface DefaultsDocument {
  version: number;
  entries: StoredBankDefault[];
}

export interface ConnectionDefaultsStore {
  readBankDefault(key: ConnectionScopeKey & { expectedLedgerAccountId: number }): SavedBankDefaultPointer | undefined;
  saveBankDefault(input: SaveBankDefaultInput): void;
  /** A `SavedBankDefaultPort` bound to one connection scope (env-scoped). */
  bankDefaultPort(scope: ConnectionScopeKey): SavedBankDefaultPort;
  /** Test/introspection: number of entries currently persisted. */
  entryCount(): number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Allow-list projection: the ONLY way an entry reaches disk. Any field not named
 * here (apiKey, public value, password, arbitrary smuggled keys) is dropped.
 */
function projectStoredBankDefault(input: SaveBankDefaultInput, savedAt: string): StoredBankDefault {
  if (!isNonEmptyString(input.currency)) {
    throw new Error(
      "Refusing to persist a bank default without a currency (fail-closed): the originating statement's currency is required.",
    );
  }
  if (!Number.isInteger(input.accounts_dimensions_id) || !Number.isInteger(input.ledgerAccountId)) {
    throw new Error("A bank default requires integer accounts_dimensions_id and ledgerAccountId.");
  }
  if (!isNonEmptyString(input.connectionId)) {
    throw new Error("A bank default requires a connectionId.");
  }
  const entry: StoredBankDefault = {
    kind: "bank_default",
    connectionId: input.connectionId,
    environmentKind: input.environmentKind,
    accounts_dimensions_id: input.accounts_dimensions_id,
    ledgerAccountId: input.ledgerAccountId,
    currency: input.currency,
    savedAt,
  };
  if (isNonEmptyString(input.iban)) entry.iban = input.iban;
  if (isNonEmptyString(input.input_type)) entry.input_type = input.input_type;
  return entry;
}

function isStoredBankDefault(value: unknown): value is StoredBankDefault {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    e.kind === "bank_default" &&
    isNonEmptyString(e.connectionId) &&
    (e.environmentKind === "live" || e.environmentKind === "demo" || e.environmentKind === "setup") &&
    Number.isInteger(e.accounts_dimensions_id) &&
    Number.isInteger(e.ledgerAccountId) &&
    isNonEmptyString(e.currency)
  );
}

function emptyDoc(): DefaultsDocument {
  return { version: DOC_VERSION, entries: [] };
}

export function createConnectionDefaultsStore(
  filePath: string = getConnectionDefaultsFile(),
): ConnectionDefaultsStore {
  function readDoc(): DefaultsDocument {
    if (!existsSync(filePath)) return emptyDoc();
    // Reject symlinked / foreign-owned / group-readable targets before reading.
    if (!isSecurePrivateFile(filePath, "connection-defaults file")) return emptyDoc();
    try {
      const raw = readFileSync(filePath, "utf8");
      // Size-bound: safeJsonParse throws when the input exceeds MAX_JSON_INPUT_SIZE.
      const parsed = safeJsonParse(raw, "connection-defaults") as unknown;
      if (typeof parsed !== "object" || parsed === null) return emptyDoc();
      const entries = (parsed as { entries?: unknown }).entries;
      if (!Array.isArray(entries)) return emptyDoc();
      return { version: DOC_VERSION, entries: entries.filter(isStoredBankDefault) };
    } catch {
      // Fail-safe: an unreadable / oversized / corrupt store degrades to "no
      // hints" so the resolver simply asks a fresh question.
      return emptyDoc();
    }
  }

  function writeDoc(doc: DefaultsDocument): void {
    const serialized = `${JSON.stringify(doc, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_INPUT_SIZE) {
      throw new Error("connection-defaults store exceeds the maximum size and will not be written.");
    }
    writePrivateFile(filePath, serialized);
  }

  function keyMatches(entry: StoredBankDefault, key: ConnectionScopeKey): boolean {
    return entry.connectionId === key.connectionId && entry.environmentKind === key.environmentKind;
  }

  return {
    readBankDefault(key) {
      const doc = readDoc();
      const entry = doc.entries.find(
        e => keyMatches(e, key) && e.ledgerAccountId === key.expectedLedgerAccountId,
      );
      if (!entry) return undefined;
      const pointer: SavedBankDefaultPointer = {
        accounts_dimensions_id: entry.accounts_dimensions_id,
        connectionId: entry.connectionId,
        ledgerAccountId: entry.ledgerAccountId,
        currency: entry.currency,
      };
      if (entry.iban !== undefined) pointer.iban = entry.iban;
      return pointer;
    },

    saveBankDefault(input) {
      const entry = projectStoredBankDefault(input, new Date().toISOString());
      const doc = readDoc();
      // Upsert by {connectionId, environmentKind, ledgerAccountId}.
      const remaining = doc.entries.filter(
        e => !(keyMatches(e, entry) && e.ledgerAccountId === entry.ledgerAccountId),
      );
      remaining.push(entry);
      // Cap entry count: keep the most recently saved (evict oldest by savedAt).
      remaining.sort((a, b) => a.savedAt.localeCompare(b.savedAt));
      const bounded = remaining.slice(Math.max(0, remaining.length - CONNECTION_DEFAULTS_MAX_ENTRIES));
      writeDoc({ version: DOC_VERSION, entries: bounded });
    },

    bankDefaultPort(scope) {
      return {
        async readSavedBankDefault({ connectionId, expectedLedgerAccountId }) {
          // The port re-reads fresh each call; the resolver re-verifies it.
          // Only serve a hint when the caller's connection matches this scope.
          if (connectionId !== scope.connectionId) return undefined;
          return storeReadForPort(readDoc(), scope, expectedLedgerAccountId);
        },
      };
    },

    entryCount() {
      return readDoc().entries.length;
    },
  };
}

function storeReadForPort(
  doc: DefaultsDocument,
  scope: ConnectionScopeKey,
  expectedLedgerAccountId: number,
): SavedBankDefaultPointer | undefined {
  const entry = doc.entries.find(
    e => e.connectionId === scope.connectionId &&
      e.environmentKind === scope.environmentKind &&
      e.ledgerAccountId === expectedLedgerAccountId,
  );
  if (!entry) return undefined;
  const pointer: SavedBankDefaultPointer = {
    accounts_dimensions_id: entry.accounts_dimensions_id,
    connectionId: entry.connectionId,
    ledgerAccountId: entry.ledgerAccountId,
    currency: entry.currency,
  };
  if (entry.iban !== undefined) pointer.iban = entry.iban;
  return pointer;
}
