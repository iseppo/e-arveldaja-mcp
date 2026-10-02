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

/**
 * Direction of a bank transaction as far as it can be proven: the signed
 * importer marker, else "unknown". The stored `type` is NOT a fallback — the
 * live API reads every transaction back as "C" whatever was stored (verified
 * 2026-10), so a `type`-based guess would call every unsigned incoming row
 * outgoing. Callers must treat "unknown" as "could be either".
 */
export function bankTransactionDirection(transaction: {
  description?: string | null;
}): BankTransactionDirection {
  return signedBankTransactionDirection(transaction) ?? "unknown";
}

/**
 * Bank-account posting side for a transaction matched to an invoice: the
 * signed direction when there is one, else the invoice kind (a sale invoice is
 * settled by money in, a purchase invoice by money out).
 */
export function bankPostingSideForInvoiceMatch(
  transaction: { description?: string | null },
  invoiceType: "sale_invoice" | "purchase_invoice",
): "D" | "C" {
  const direction = bankTransactionDirection(transaction);
  if (direction === "incoming") return "D";
  if (direction === "outgoing") return "C";
  return invoiceType === "sale_invoice" ? "D" : "C";
}
