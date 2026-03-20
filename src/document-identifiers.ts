function isValidIban(value: string): boolean {
  const compact = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;

  const rearranged = `${compact.slice(4)}${compact.slice(0, 4)}`;
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

export function extractRegistryCode(text: string): string | undefined {
  return text.match(/(?:Reg\.?\s*(?:nr|kood|code)|Registrikood|Registry code)[:\s]*(\d{8})/i)?.[1];
}

export function extractVatNumber(text: string): string | undefined {
  const matches = [...text.matchAll(/(?:KMKR|VAT(?:\s*(?:nr|number|no\.?))?|KM\s*nr|KM-number|Tax ID)[:\s]*([A-Z]{2}[0-9A-Z]{6,})/gi)];
  if (matches.length === 0) return undefined;

  const buyerSectionIndex = text.search(/\b(bill to|invoice to|arve saaja|klient|client)\b/i);
  if (buyerSectionIndex >= 0) {
    const supplierSideMatch = matches.find(match => (match.index ?? Number.MAX_SAFE_INTEGER) < buyerSectionIndex);
    if (supplierSideMatch?.[1]) {
      return supplierSideMatch[1].toUpperCase();
    }
  }

  return matches[0]?.[1]?.toUpperCase();
}

export function extractIban(text: string): string | undefined {
  const match = text.match(/\b([A-Z]{2}\d{2}(?:[ \t]*[A-Z0-9]){11,30})\b/i);
  const normalized = match?.[1]?.replace(/\s+/g, "").toUpperCase();
  if (!normalized) return undefined;
  return isValidIban(normalized) ? normalized : undefined;
}

export function extractReferenceNumber(text: string): string | undefined {
  return text.match(/(?:Viitenumber|Viitenr|Ref\.?\s*(?:nr|number)|Reference|viitenumbrit)[:\s]*(\d+)/i)?.[1];
}
