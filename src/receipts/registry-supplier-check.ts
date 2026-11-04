/**
 * Supplier name ↔ registry code cross-check against the Estonian business
 * register (RIK äriregister). The register is the authority on whose name a
 * registry code is: when the extracted supplier name disagrees with it, the
 * page either named the wrong block (a bank, a buyer) or carries another
 * party's code.
 *
 * - The register's name is printed on the page, the read name has no supplier
 *   label and the register's name sits under no other party's role label → the
 *   supplier name becomes the register's name.
 * - The register's name is printed but either condition fails (a labelled
 *   "Müüja: X" against a bank's or buyer's code) → both companies are on the
 *   page and the code is not X's: `supplier_identifier_ambiguous` holds it.
 * - The register's name is not on the page → an extraction note only. The
 *   page's name may be OCR noise or a brand; supplier resolution still matches
 *   by the code and names a new client from the register (P2 E1).
 * - No lookup (no Estonian code, own code, register unreachable or nameless)
 *   leaves the extraction exactly as it is.
 */
import { distance } from "fastest-levenshtein";
import { normalizeCompanyName } from "../company-name.js";
import { isValidEeRegistryCode } from "../document-identifiers.js";
import { inferSupplierCountry, type ExtractedReceiptFields } from "../tools/receipt-extraction.js";
import { fetchRegistryData } from "../tools/supplier-resolution.js";
import { cachedRegistryName, cacheRegistryName } from "./registry-name-cache.js";

export type RegistryLookup = (regCode: string) => Promise<{ name: string } | null>;

async function lookupRegistryName(regCode: string): Promise<{ name: string } | null> {
  const cached = cachedRegistryName(regCode);
  if (cached !== undefined) return { name: cached };
  const data = await fetchRegistryData(regCode, "EST");
  if (!data || data.name_source !== "registry" || !data.name?.trim()) return null;
  cacheRegistryName(regCode, data.name.trim());
  return { name: data.name.trim() };
}

/** Same company name up to legal form, punctuation, a one-glyph misread or a missing trailing word. */
export function companyNamesAgree(left: string, right: string): boolean {
  const a = normalizeCompanyName(left);
  const b = normalizeCompanyName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length >= 4 && ` ${longer} `.startsWith(` ${shorter} `)) return true;
  return 1 - distance(a, b) / Math.max(a.length, b.length) >= 0.85;
}

// A label naming a party other than the supplier: buyer, payer, manager, bank
// or payment agent.
const OTHER_PARTY_LABEL_RE =
  /^(?:maksja|ostja|arve\s+saaja|saaja|klient|buyer|bill\s+to|invoice\s+to|recipient|client|haldaja|haldur|valitseja|administrator|manager|property\s+manager|pank|bank|panga\s+\p{L}+|teenindav\s+pank|pangarekvisiidid|bank\s+details|maksevahendaja|maksete\s+vahendaja|makseagent|payment\s+(?:agent|provider|institution))\b/iu;

const segmentsOf = (line: string) => [line, ...line.split(/\s{2,}/)].map(segment => segment.trim()).filter(Boolean);

/**
 * Where the register's name is printed on the page: one line or whitespace
 * column (a leading "Label:" ignored). `under_other_party` when that label, or
 * a column of one of the two lines above, is another party's role label.
 */
export function registryNamePrinted(rawText: string, registryName: string): { under_other_party: boolean } | undefined {
  const key = normalizeCompanyName(registryName);
  if (key.length < 3) return undefined;
  const lines = rawText.split(/\r?\n/).filter(line => line.trim() !== "");
  let found: { under_other_party: boolean } | undefined;
  lines.forEach((line, index) => {
    for (const segment of segmentsOf(line)) {
      const label = /^([^:]{1,40}):\s*/u.exec(segment);
      const text = label ? segment.slice(label[0].length) : segment;
      if (!text || normalizeCompanyName(text) !== key) continue;
      const underOtherParty = (label !== null && OTHER_PARTY_LABEL_RE.test(label[1]!.trim())) ||
        [index - 1, index - 2].some(at => at >= 0 && segmentsOf(lines[at]!).some(above => OTHER_PARTY_LABEL_RE.test(above)));
      found = { under_other_party: (found?.under_other_party ?? false) || underOtherParty };
    }
  });
  return found;
}

export async function crossCheckSupplierWithRegistry(
  extracted: ExtractedReceiptFields,
  options: { ownCompanyRegistryCode?: string; ownCompanyName?: string; lookup?: RegistryLookup } = {},
): Promise<ExtractedReceiptFields> {
  const regCode = extracted.supplier_reg_code?.trim();
  const name = extracted.supplier_name?.trim();
  if (!regCode || !name || !isValidEeRegistryCode(regCode)) return extracted;
  if (regCode === options.ownCompanyRegistryCode?.trim()) return extracted;
  if ((inferSupplierCountry(extracted) ?? "EST") !== "EST") return extracted;

  let registry: { name: string } | null;
  try {
    registry = await (options.lookup ?? lookupRegistryName)(regCode);
  } catch {
    registry = null;
  }
  const registryName = registry?.name.trim();
  if (!registryName) return extracted;
  if (options.ownCompanyName && companyNamesAgree(registryName, options.ownCompanyName)) return extracted;
  if (companyNamesAgree(name, registryName)) return extracted;

  const printed = registryNamePrinted(extracted.raw_text ?? "", registryName);
  const nameLabelled = extracted.field_provenance?.some(entry => entry.field === "supplier_name" && entry.source === "label") ?? false;
  if (printed && (nameLabelled || printed.under_other_party)) {
    return {
      ...extracted,
      supplier_identifier_ambiguous: true,
      extraction_notes: [
        ...(extracted.extraction_notes ?? []),
        `Registry code ${regCode} belongs to another company in the Estonian business register, and that company is also printed on the document (${nameLabelled ? "the supplier name is labelled" : "under another party's label"}); verify which company is the supplier and whose code this is.`,
      ],
    };
  }
  if (printed) {
    return {
      ...extracted,
      supplier_name: registryName,
      field_provenance: [
        ...(extracted.field_provenance ?? []).filter(entry => entry.field !== "supplier_name"),
        { field: "supplier_name", value: registryName, source: "registry", rationale: "registry_name_on_page" },
      ],
      extraction_notes: [
        ...(extracted.extraction_notes ?? []),
        `Supplier name taken from the Estonian business register for registry code ${regCode}: the register's name is printed on the document, the line first read as the supplier is not that company.`,
      ],
    };
  }
  return {
    ...extracted,
    extraction_notes: [
      ...(extracted.extraction_notes ?? []),
      `Registry code ${regCode} belongs to another company in the Estonian business register, and that company's name is not printed on the document; check that the code is the supplier's.`,
    ],
  };
}
