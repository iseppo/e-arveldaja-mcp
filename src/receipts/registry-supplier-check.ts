/**
 * Supplier name ↔ registry code cross-check against the Estonian business
 * register (RIK äriregister). The register is the authority on whose name a
 * registry code is: when the extracted supplier name disagrees with it, the
 * page either named the wrong block (a bank, a buyer) or carries another
 * party's code.
 *
 * The check never changes `supplier_name` or any other field supplier
 * resolution reads: the name is evidence the resolver compares against the
 * code (a strong-identifier conflict needs it), and a replaced name can match
 * a different client by name (review 2026-11-04 r1/r2). It reports:
 *
 * - The register's name is printed on the page, under a supplier label-free
 *   read name and no other party's role label → an extraction note naming the
 *   register's company. Resolution still matches by the code, and a new client
 *   is still named by the register (P2 E1).
 * - The register's name is printed and the read name is labelled ("Müüja: X")
 *   or the register's name sits under another party's role label (bank, buyer)
 *   → both companies are on the page and the code may not be the supplier's:
 *   `supplier_identifier_ambiguous` holds it.
 * - The register's name is not on the page → an extraction note.
 * - The register names the active company itself → the buyer's code was read
 *   as the supplier's: `supplier_identifier_ambiguous` holds it with a note.
 * - No lookup (no Estonian code, own code, register unreachable or nameless)
 *   leaves the extraction exactly as it is.
 *
 * The register's name appears only inside extraction notes, which every
 * output site caps and sandbox-wraps.
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
  // The register names the active company: the buyer's own code was read as the
  // supplier's (its own code is unknown when it has no client record of its
  // own). Hold — booking on it would resolve or create the company itself.
  if (options.ownCompanyName && companyNamesAgree(registryName, options.ownCompanyName)) {
    return {
      ...extracted,
      supplier_identifier_ambiguous: true,
      extraction_notes: [
        ...(extracted.extraction_notes ?? []),
        `The Estonian business register shows that registry code ${regCode} belongs to your own company, so it is the buyer's code, not the supplier's; find the supplier's own registry code on the document before booking.`,
      ],
    };
  }
  if (companyNamesAgree(name, registryName)) return extracted;

  const printed = registryNamePrinted(extracted.raw_text ?? "", registryName);
  const nameLabelled = extracted.field_provenance?.some(entry => entry.field === "supplier_name" && entry.source === "label") ?? false;
  if (printed && (nameLabelled || printed.under_other_party)) {
    return {
      ...extracted,
      supplier_identifier_ambiguous: true,
      extraction_notes: [
        ...(extracted.extraction_notes ?? []),
        `The Estonian business register names "${registryName}" for registry code ${regCode}, a different company from the supplier read, and that company is also printed on the document (${nameLabelled ? "the supplier name is labelled" : "under another party's label"}); verify which company is the supplier and whose code this is.`,
      ],
    };
  }
  return {
    ...extracted,
    extraction_notes: [
      ...(extracted.extraction_notes ?? []),
      printed
        ? `The Estonian business register names "${registryName}" for registry code ${regCode}, and that name is printed on the document: the supplier read here is probably another line (a bank or footer). Supplier matching uses the registry code.`
        : `The Estonian business register names "${registryName}" for registry code ${regCode}, and that name is not printed on the document; check that the code is the supplier's.`,
    ],
  };
}
