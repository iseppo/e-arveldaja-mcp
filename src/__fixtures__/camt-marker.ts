import { buildCamtDescriptionWithMetadata, isTrustedCamtDescriptionMetadata } from "../camt/duplicate-identity.js";

type MarkedRow = {
  id?: number;
  amount: number;
  date: string;
  description?: string | null;
  bank_account_name?: string | null;
  bank_account_no?: string | null;
  ref_number?: string | null;
  cl_currencies_id?: string;
};

/**
 * Give a test row a genuine, checksum-valid CAMT marker built from its own
 * fields (an existing marker line is replaced). Only a checksummed marker
 * proves a direction, so rows that must book or classify by direction need it.
 * Re-sign after changing any signed field (amount, date, name, reference…).
 */
export function withSignedCamtMarker<T extends MarkedRow>(
  row: T,
  direction: "CRDT" | "DBIT",
  bankReference = `REF${row.id ?? "X"}`,
): T {
  const text = (row.description ?? "").replace(/\n?\[e-arveldaja-mcp:camt [^\]]*\]\s*$/, "") || undefined;
  const description = buildCamtDescriptionWithMetadata(text, {
    date: row.date,
    amount: row.amount,
    currency: row.cl_currencies_id || "EUR",
    direction,
    counterparty_name: row.bank_account_name ?? undefined,
    counterparty_iban: row.bank_account_no ?? undefined,
    reference_number: row.ref_number ?? undefined,
    bank_reference: bankReference,
    description: text,
  });
  const signed = { ...row, description };
  const check = {
    type: "C",
    cl_currencies_id: "EUR",
    bank_ref_number: null,
    bank_account_no: null,
    bank_account_name: null,
    ref_number: null,
    ...signed,
  } as Parameters<typeof isTrustedCamtDescriptionMetadata>[0];
  if (!isTrustedCamtDescriptionMetadata(check)) throw new Error("withSignedCamtMarker: the marker does not verify");
  return signed;
}
