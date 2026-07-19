export type BankTransactionDirection = "incoming" | "outgoing" | "unknown";

export function bankTransactionDirection(transaction: {
  type?: string | null;
  description?: string | null;
}): BankTransactionDirection {
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
  if (transaction.type === "D") return "incoming";
  if (transaction.type === "C") return "outgoing";
  return "unknown";
}
