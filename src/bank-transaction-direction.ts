export type BankTransactionDirection = "incoming" | "outgoing" | "unknown";

/**
 * The direction carried by a signed importer marker (Wise `[source_direction=…]`
 * or a signed CAMT metadata line), or `undefined` when the row has none. Unlike
 * `bankTransactionDirection`, this never falls back to the stored `type`, so a
 * caller can tell a statement-proven direction from a legacy `D`/`C` guess.
 */
export function signedBankTransactionDirection(transaction: {
  description?: string | null;
}): "incoming" | "outgoing" | undefined {
  const description = transaction.description ?? "";
  const wiseSourceDirection = description.match(/^WISE:(?:FEE:)?\S+[\s\S]*\[source_direction=(IN|OUT)\]\s*$/i)?.[1];
  const camtMarker = description.match(/(?:^|\n)\[e-arveldaja-mcp:camt\s+([^\]\r\n]+)\]\s*$/i)?.[1];
  const camtIsSigned = camtMarker !== undefined && /(?:^|\s)(?:sig|s)=[a-f0-9]{16,64}(?=\s|$)/i.test(camtMarker);
  const camtSourceDirection = camtIsSigned
    ? camtMarker.match(/(?:^|\s)(?:source_direction|dir|d)=(CRDT|DBIT)(?=\s|$)/i)?.[1]
    : undefined;
  const sourceDirection = (wiseSourceDirection ?? camtSourceDirection)?.toUpperCase();
  if (sourceDirection === "CRDT" || sourceDirection === "IN") return "incoming";
  if (sourceDirection === "DBIT" || sourceDirection === "OUT") return "outgoing";
  return undefined;
}

export function bankTransactionDirection(transaction: {
  type?: string | null;
  description?: string | null;
}): BankTransactionDirection {
  const signed = signedBankTransactionDirection(transaction);
  if (signed) return signed;
  if (transaction.type === "D") return "incoming";
  if (transaction.type === "C") return "outgoing";
  return "unknown";
}

/**
 * True when a signed importer marker proves a direction the stored `type`
 * contradicts. The backend books the cash leg from `type`, so confirming such a
 * row would post the bank side backwards.
 */
export function storedTypeContradictsSignedDirection(transaction: {
  type?: string | null;
  description?: string | null;
}): boolean {
  const signed = signedBankTransactionDirection(transaction);
  if (signed === "incoming") return transaction.type === "C";
  if (signed === "outgoing") return transaction.type === "D";
  return false;
}
