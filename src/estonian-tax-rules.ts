// Date-gated Estonian tax reference data + deterministic detectors.
//
// This is the "knowledge as data" layer: a single, maintainable source for the
// Estonian VAT/income-tax rules the booking flow surfaces. Code detects when a
// rule applies and pushes a structured note into the tool response at the exact
// moment it is relevant — the agent does not have to remember the rules, and the
// always-loaded tool list stays lean.
//
// Figures verified against EMTA / Riigi Teataja (June 2026 state). When the law
// changes, update the values here and keep the effective dates — every consumer
// reads from this module.

export interface VatRatePeriod {
  /** Inclusive start date (YYYY-MM-DD). */
  from: string;
  /** Inclusive end date (YYYY-MM-DD), or null while still in force. */
  to: string | null;
  /** Rate in percent. */
  rate: number;
}

/**
 * Standard VAT rate timeline (KMS § 15 lg 1). 20% → 22% (1.01.2024) →
 * 24% (1.07.2025). Used to book historical/future invoices at the rate that was
 * actually in force on the invoice date.
 */
export const STANDARD_VAT_RATE_TIMELINE: readonly VatRatePeriod[] = [
  { from: "2009-07-01", to: "2023-12-31", rate: 20 },
  { from: "2024-01-01", to: "2025-06-30", rate: 22 },
  { from: "2025-07-01", to: null, rate: 24 },
];

/** Standard VAT rate (%) in force on the given ISO date, or null if unparseable. */
export function standardVatRateOn(dateISO: string | undefined | null): number | null {
  const d = dateISO?.slice(0, 10);
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const period = STANDARD_VAT_RATE_TIMELINE.find(p => d >= p.from && (p.to === null || d <= p.to));
  return period ? period.rate : null;
}

export interface ReducedVatRate {
  rate: number;
  /** What the rate applies to. */
  applies: string;
  /** Effective from (YYYY-MM-DD), or null if long-standing. */
  from: string | null;
  basis: string;
}

/**
 * Reduced VAT rates currently in force (KMS § 15). Accommodation rose 9% → 13%
 * and press 5% → 9% on 1.01.2025.
 */
export const REDUCED_VAT_RATES: readonly ReducedVatRate[] = [
  { rate: 13, applies: "majutus / majutus hommikusöögiga (accommodation)", from: "2025-01-01", basis: "KMS § 15" },
  { rate: 9, applies: "raamatud, perioodika/ajakirjandus, ravimid, meditsiiniseadmed", from: "2025-01-01", basis: "KMS § 15" },
  { rate: 0, applies: "eksport, ühendusesisene käive jms", from: null, basis: "KMS § 15 lg 3–4" },
];

export interface TaxRuleReference {
  /** Statutory code, e.g. "TuMS § 49 lg 4". */
  code: string;
  /** Short headline. */
  title: string;
  /** Plain-language summary of the rule and the figures. */
  summary: string;
  /** Statutory / EMTA basis. */
  basis: string;
}

/**
 * Reference catalogue of the deterministic deduction restrictions and the
 * tax-free limits an Estonian micro-company hits most often. Surfaced read-only
 * via the `earveldaja://tax_rules` resource. Figures verified against EMTA
 * (no 2026 changes to VAT rates, representation or donation limits).
 */
export const DEDUCTION_AND_LIMIT_RULES: readonly TaxRuleReference[] = [
  {
    code: "KMS § 30",
    title: "Külaliste vastuvõtt / esinduskulu — sisendkäibemaks ei ole mahaarvatav",
    summary:
      "Külaliste või koostööpartnerite vastuvõtu kulude (toitlustus, meelelahutus) sisendkäibemaksu üldjuhul maha ei arvata. Oma töötajate toitlustus/majutus võib olla erisoodustus (v.a töölähetuse majutus).",
    basis: "KMS § 30",
  },
  {
    code: "KMS § 30 lg 4",
    title: "Sõiduauto (M1) sisendkäibemaksu 50% piirang",
    summary:
      "M1-kategooria sõiduauto soetuse ja kasutuse sisendkäibemaksust võib üldjuhul maha arvata 50%. 100% eeldab erandit (tõendatud 100% ärikasutus EMTA teavitusega, takso, õppesõit, edasimüük/rent).",
    basis: "KMS § 30 lg 4; KMS § 29 lg 1",
  },
  {
    code: "TuMS § 49 lg 4",
    title: "Vastuvõtukulude maksuvaba piirmäär",
    summary:
      "Vastuvõtukulud on tulumaksuvabad kuni 50 € kalendrikuus + 2% samal kalendriaastal sotsiaalmaksuga maksustatud väljamaksetest (arvestatakse kalendriaasta algusest kasvavalt). Piirmäära ületav osa maksustatakse tulumaksuga 22/78.",
    basis: "TuMS § 49 lg 4",
  },
  {
    code: "TuMS § 49 lg 2",
    title: "Kingituste ja annetuste maksuvaba piirmäär",
    summary:
      "Tulumaksusoodustusega nimekirja kantud ühingutele tehtud kingitused/annetused on maksuvabad kuni 3% kalendriaasta sotsiaalmaksuga maksustatud väljamaksetest VÕI 10% eelmise majandusaasta kasumist (maksumaksja valib ühe piirmäära). Ületav osa maksustatakse 22/78. Soodustust on pikendatud kuni 31.12.2027.",
    basis: "TuMS § 49 lg 2",
  },
];

export interface TaxRulesReference {
  note: string;
  standard_vat_rate_timeline: readonly VatRatePeriod[];
  reduced_vat_rates: readonly ReducedVatRate[];
  deduction_and_limit_rules: readonly TaxRuleReference[];
}

/** Bundle the full Estonian tax reference dataset for the pull resource. */
export function buildTaxRulesReference(): TaxRulesReference {
  return {
    note:
      "Estonian VAT / income-tax reference for booking. Figures verified against EMTA / Riigi Teataja. " +
      "Notes are advisory — confirm with the user before applying a restriction; the cumulative TuMS § 49 limits require the company's year-to-date payroll/profit to compute the taxable excess.",
    standard_vat_rate_timeline: STANDARD_VAT_RATE_TIMELINE,
    reduced_vat_rates: REDUCED_VAT_RATES,
    deduction_and_limit_rules: DEDUCTION_AND_LIMIT_RULES,
  };
}

export type TaxNoteSeverity = "warning" | "info";

export interface EstonianTaxNote {
  /** Statutory code, e.g. "KMS § 30 lg 4". */
  code: string;
  severity: TaxNoteSeverity;
  /** Short headline of the rule that was triggered. */
  title: string;
  /** What to do about it when booking. */
  detail: string;
  /** Statutory / EMTA basis for the rule. */
  basis: string;
}

// Deterministic keyword triggers. Kept deliberately conservative — a match
// raises a note to confirm, it does not auto-apply anything.
const ENTERTAINMENT_RE = /(restoran|restaurant|cafe|caf[eé]|kohvik|baar\b|pub\b|catering|toitlust|meelelahut|vastuvõt|esinduskulu|entertainment|reception|banquet|banket)/iu;
const CAR_RE = /(sõiduauto|\bauto\b|vehicle|kütus|bensiin|diisel|\bfuel\b|tankla|parkim|parking|liising|leasing|rehvi|\btyre\b|\btire\b)/iu;

/**
 * Detect deterministic input-VAT deduction restrictions for a purchase booking
 * from the supplier name and line descriptions. Returns structured notes the
 * booking flow surfaces as `tax_notes`.
 *
 * Inputs may be OCR-derived; detection only runs regexes over them (it never
 * follows their content), so the resulting note text is server-authored and safe.
 */
export function detectVatDeductionNotes(input: {
  supplierName?: string | null;
  descriptions?: (string | undefined | null)[];
}): EstonianTaxNote[] {
  const haystack = [input.supplierName, ...(input.descriptions ?? [])]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" • ");
  if (!haystack) return [];

  const notes: EstonianTaxNote[] = [];

  if (ENTERTAINMENT_RE.test(haystack)) {
    notes.push({
      code: "KMS § 30",
      severity: "warning",
      title: "Külaliste vastuvõtt / esinduskulu — sisendkäibemaks ei ole mahaarvatav",
      detail:
        "Kui tegu on külaliste või koostööpartnerite vastuvõtu kuluga (toitlustus, meelelahutus), siis sisendkäibemaksu maha ei arvata — broneeri kulu koos käibemaksuga (bruto) kulukontole. " +
        "Sama kulu kuulub ka tulumaksu vastuvõtukulude piirmäära alla: maksuvaba 50 € kalendrikuus + 2% palgafondist (kasvavalt), ületav osa maksustatakse 22/78. " +
        "Kui kulu on tegelikult oma töötajate jaoks, võib tegu olla erisoodustusega (TuMS § 48). Küsi kasutajalt kulu eesmärki, kui see pole selge.",
      basis: "KMS § 30; TuMS § 49 lg 4",
    });
  }

  if (CAR_RE.test(haystack)) {
    notes.push({
      code: "KMS § 30 lg 4",
      severity: "warning",
      title: "Sõiduauto kulu — sisendkäibemaksu 50% piirang",
      detail:
        "M1-kategooria sõiduauto soetuse ja kasutuse sisendkäibemaksust tohib üldjuhul maha arvata ainult 50%, kui erasõite ei ole välistatud. " +
        "100% mahaarvamine eeldab erandit (nt tõendatud 100% ärikasutus koos EMTA teavitusega, takso, õppesõit, edasimüük või rent). " +
        "Kahtluse korral kasuta konservatiivset 50% mahaarvamist ja küsi kasutajalt kinnitust.",
      basis: "KMS § 30 lg 4; KMS § 29 lg 1",
    });
  }

  return notes;
}
