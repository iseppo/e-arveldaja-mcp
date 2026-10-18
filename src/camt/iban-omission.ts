import type { BankAccount } from "../types/api.js";

// Positive proof that a counterparty IBAN is NOT one of the company's own bank
// accounts, the only condition under which the CAMT marker may leave the IBAN
// out (`x=i`) to keep the full description. PURE.
//
// Not buildBankAccountLookups: it skips accounts without a dimension and lets
// an empty `iban_code` hide `account_no`. Here every bank account row counts,
// with both identifiers, and anything short of complete evidence is "unknown",
// which keeps the IBAN.

const IBAN_SHAPE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;

export type CamtIbanOmissionEvidence =
  | { readonly kind: "complete"; readonly ownIdentifiers: ReadonlySet<string>; readonly localIdentifiers: readonly string[] }
  | { readonly kind: "unknown" };

function normalizeAccountIdentifier(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return normalized || undefined;
}

/**
 * `complete` only when every bank account row has at least one IBAN-shaped
 * identifier; no rows (or no snapshot) is `unknown`. The own identifier set is
 * every row's `iban_code` and `account_no` plus the statement's own IBAN.
 */
export function camtIbanOmissionEvidence(
  bankAccounts: ReadonlyArray<Pick<BankAccount, "iban_code" | "account_no">> | undefined,
  statementIban: string | undefined,
): CamtIbanOmissionEvidence {
  if (!bankAccounts || bankAccounts.length === 0) return { kind: "unknown" };
  const ownIdentifiers = new Set<string>();
  const localIdentifiers: string[] = [];
  for (const account of bankAccounts) {
    const identifiers = [account.iban_code, account.account_no]
      .map(normalizeAccountIdentifier)
      .filter((identifier): identifier is string => identifier !== undefined);
    if (!identifiers.some((identifier) => IBAN_SHAPE.test(identifier))) return { kind: "unknown" };
    for (const identifier of identifiers) {
      ownIdentifiers.add(identifier);
      if (!IBAN_SHAPE.test(identifier)) localIdentifiers.push(identifier);
    }
  }
  const statement = normalizeAccountIdentifier(statementIban);
  if (statement) ownIdentifiers.add(statement);
  return { kind: "complete", ownIdentifiers, localIdentifiers };
}

/**
 * The counterparty IBAN may be left out: evidence is complete, the
 * counterparty is IBAN-shaped, equals no own identifier, and no own local
 * account number (BBAN) is a suffix of it.
 */
export function isCamtIbanOmissionEligible(
  evidence: CamtIbanOmissionEvidence,
  counterpartyIban: string | undefined,
): boolean {
  if (evidence.kind !== "complete") return false;
  const counterparty = normalizeAccountIdentifier(counterpartyIban);
  if (!counterparty || !IBAN_SHAPE.test(counterparty)) return false;
  if (evidence.ownIdentifiers.has(counterparty)) return false;
  return !evidence.localIdentifiers.some((local) => counterparty.endsWith(local));
}
