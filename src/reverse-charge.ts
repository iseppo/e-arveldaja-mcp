import { EU_COUNTRIES_EXCEPT_EST, type SupplierFacts } from "./limited-vat.js";

const EU_VAT_PREFIXES = new Set("AT BE BG CY CZ DE DK EE EL ES FI FR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK XI".split(" "));

/** Suggestions only: an explicit caller/local-rule option must bypass this mapping. */
export function reverseChargeSuggestion(id: number, supplier: SupplierFacts | null | undefined): { id: number; note: string } {
  const vat = supplier?.invoice_vat_no?.replace(/\s+/g, "").toUpperCase();
  const prefix = vat?.match(/^[A-Z]{2}/)?.[0];
  const country = supplier?.cl_code_country?.trim().toUpperCase();
  const region = vat
    ? prefix ? EU_VAT_PREFIXES.has(prefix) ? "eu" : "non_eu" : "unknown"
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
