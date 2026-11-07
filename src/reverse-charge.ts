import { EU_COUNTRIES_EXCEPT_EST, type SupplierFacts } from "./limited-vat.js";

const EU_VAT_PREFIXES = new Set("AT BE BG CY CZ DE DK EE EL ES FI FR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK XI".split(" "));

const vatPrefix = (vat: string | null | undefined): string | undefined =>
  vat?.replace(/\s+/g, "").toUpperCase().match(/^[A-Z]{2}/)?.[0];

/**
 * Suggestions only: an explicit caller/local-rule option must bypass this mapping.
 * Region: an EU VAT prefix on the document OR on the supplier record always means an
 * EU company (KMD row 6), whatever the supplier's country; otherwise a non-EU VAT
 * prefix, then the supplier country, decides.
 */
export function reverseChargeSuggestion(
  id: number,
  supplier: SupplierFacts | null | undefined,
  documentVatNo?: string | null,
): { id: number; note: string } {
  const prefixes = [vatPrefix(documentVatNo), vatPrefix(supplier?.invoice_vat_no)].filter((p): p is string => !!p);
  const country = supplier?.cl_code_country?.trim().toUpperCase();
  const region = prefixes.some(p => EU_VAT_PREFIXES.has(p)) ? "eu"
    : prefixes.length > 0 ? "non_eu"
    : country ? country === "EST" || EU_COUNTRIES_EXCEPT_EST.has(country) ? "eu" : "non_eu" : "unknown";
  const mapped = region === "non_eu" ? ({ 1: 7, 2: 8, 3: 9 } as Record<number, number>)[id]
    : region === "eu" ? ({ 7: 1, 8: 2, 9: 3 } as Record<number, number>)[id] : undefined;
  const chosen = mapped ?? id;
  const row = [1, 2, 3, 4].includes(chosen) ? "6" : [6, 7, 8, 9].includes(chosen) ? "7" : undefined;
  return {
    id: chosen,
    note: `Reverse-charge option ${chosen}${row ? `: KMD row ${row} chosen` : " kept"}` +
      (region === "unknown" ? "; supplier region is unknown — verify the KMD row." : ` (supplier region: ${region === "eu" ? "EU" : "non-EU"}).`),
  };
}
