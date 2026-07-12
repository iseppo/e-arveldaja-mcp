import { roundMoney } from "./money.js";

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

/** True for a strict, real calendar date in YYYY-MM-DD (rejects 2025-13-99, 2025-02-31). */
function isStrictIsoDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const parsed = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
}

/** Standard VAT rate (%) in force on the given ISO date, or null if not a valid calendar date. */
export function standardVatRateOn(dateISO: string | undefined | null): number | null {
  const d = dateISO?.slice(0, 10);
  if (!d || !isStrictIsoDate(d)) return null;
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

export interface RepresentationMonthlyLimitPeriod {
  /** Inclusive start date (YYYY-MM-DD). */
  from: string;
  /** Inclusive end date (YYYY-MM-DD), or null while still in force. */
  to: string | null;
  /** Tax-free allowance in euros per calendar month. */
  amount: number;
}

/**
 * Representation/entertainment tax-free monthly allowance (TuMS § 49 lg 4). The
 * per-calendar-month figure was 32 € through 2024 and rose to 50 € on
 * 2025-01-01; the separate 2% year-to-date payroll component is unchanged. Kept
 * as a date-gated timeline so a cumulative limit is computed at the rate that
 * was actually in force for the reporting date's year (a 2024 filing must use
 * 32 €/month, not the current 50 €).
 */
export const REPRESENTATION_MONTHLY_LIMIT_TIMELINE: readonly RepresentationMonthlyLimitPeriod[] = [
  { from: "2000-01-01", to: "2024-12-31", amount: 32 },
  { from: "2025-01-01", to: null, amount: 50 },
];

/** Representation tax-free allowance (€/calendar month) in force on the given ISO date, or null if not a valid calendar date. */
export function representationMonthlyLimitOn(dateISO: string | undefined | null): number | null {
  const d = dateISO?.slice(0, 10);
  if (!d || !isStrictIsoDate(d)) return null;
  const period = REPRESENTATION_MONTHLY_LIMIT_TIMELINE.find(p => d >= p.from && (p.to === null || d <= p.to));
  return period ? period.amount : null;
}

// ---------------------------------------------------------------------------
// Corporate income tax (CIT) on distributed profits — TuMS § 50.
// ---------------------------------------------------------------------------

export interface CitRatePeriod {
  /** Inclusive start date (YYYY-MM-DD). */
  from: string;
  /** Inclusive end date (YYYY-MM-DD), or null while still in force. */
  to: string | null;
  /** Numerator of the net-basis rate (e.g. 22 in 22/78). */
  num: number;
  /** Denominator of the net-basis rate (e.g. 78 in 22/78). */
  den: number;
}

/**
 * CIT rate timeline on distributed profits (TuMS § 50, rate per TuMS § 4).
 * 21/79 → 20/80 (1.01.2015) → 22/78 (1.01.2025). The tax is computed on the
 * NET distribution (rate × net) and is the company's own current-period
 * income-tax expense — it is not part of the distribution itself.
 */
export const CIT_RATE_TIMELINE: readonly CitRatePeriod[] = [
  { from: "2015-01-01", to: "2024-12-31", num: 20, den: 80 },
  { from: "2025-01-01", to: null, num: 22, den: 78 },
];

export interface CitRate {
  num: number;
  den: number;
  formatted: string;
}

/**
 * Estonian corporate income tax rate on distributed profits (TuMS § 50) in
 * force on the given date. ISO-date string compare is only safe for strict
 * YYYY-MM-DD, so anything else is rejected defensively — a DD.MM.YYYY value
 * would compare lexically wrong and silently pick 20/80 for a 2025
 * distribution. Dates before the first timeline period use the earliest
 * period's rate (pre-2015 distributions are out of scope for this server).
 */
export function getCitRateForDate(effective_date: string): CitRate {
  if (!isStrictIsoDate(effective_date)) {
    throw new Error(`getCitRateForDate requires YYYY-MM-DD; got ${JSON.stringify(effective_date)}`);
  }
  const period =
    CIT_RATE_TIMELINE.find(p => effective_date >= p.from && (p.to === null || effective_date <= p.to))
    ?? CIT_RATE_TIMELINE[0];
  return { num: period.num, den: period.den, formatted: `${period.num}/${period.den}` };
}

/** The CIT rate currently in force (the timeline's open-ended period). Used to render tool descriptions from data. */
export function currentCitRate(): CitRate {
  const period = CIT_RATE_TIMELINE[CIT_RATE_TIMELINE.length - 1];
  return { num: period.num, den: period.den, formatted: `${period.num}/${period.den}` };
}

/** The representation monthly allowance (€/month) currently in force. Used to render tool descriptions from data. */
export function currentRepresentationMonthlyLimit(): number {
  return REPRESENTATION_MONTHLY_LIMIT_TIMELINE[REPRESENTATION_MONTHLY_LIMIT_TIMELINE.length - 1].amount;
}

/**
 * VAT registration threshold (KMS § 19 lg 1): registration duty arises when
 * taxable/0% turnover (plus non-incidental real-estate, insurance, and
 * financial turnover under the 2025 composition rules) exceeds this within a
 * calendar year.
 */
export const VAT_REGISTRATION_THRESHOLD_EUR = 40000;

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
      "Vastuvõtukulud on tulumaksuvabad kuni 50 € kalendrikuus (kuni 2024: 32 €/kuu) + 2% samal kalendriaastal sotsiaalmaksuga maksustatud väljamaksetest (arvestatakse kalendriaasta algusest kasvavalt). Piirmäära ületav osa maksustatakse tulumaksuga 22/78.",
    basis: "TuMS § 49 lg 4",
  },
  {
    code: "TuMS § 49 lg 2",
    title: "Kingituste ja annetuste maksuvaba piirmäär",
    summary:
      "Tulumaksusoodustusega nimekirja kantud ühingutele tehtud kingitused/annetused on maksuvabad kuni 3% kalendriaasta sotsiaalmaksuga maksustatud väljamaksetest VÕI 10% eelmise majandusaasta kasumist (maksumaksja valib ühe piirmäära). Ületav osa maksustatakse 22/78. Soodustust on pikendatud kuni 31.12.2027.",
    basis: "TuMS § 49 lg 2",
  },
  {
    code: "TuMS § 48",
    title: "Erisoodustused — töötajale antud rahaliselt hinnatav hüve maksustatakse",
    summary:
      "Töötajale antud rahaliselt hinnatav hüve (nt tööandja auto erakasutus, töötajate toitlustus, kingitused töötajale) on erisoodustus: tööandja maksab tulumaksu 22/78 ja sotsiaalmaksu 33%. Sõiduauto erakasutuse hind on 1,96 €/kW kuus (üle 5 aasta vanusel autol 1,47 €/kW). Deklareeritakse TSD lisal 4. Nõuandev viide — erisoodustuse arvestust see server ei tee.",
    basis: "TuMS § 48",
  },
];

/**
 * Profit-distribution (dividend) rules. Surfaced read-only via the
 * `earveldaja://tax_rules` resource and enforced/echoed by
 * `prepare_dividend_package`: the retained-earnings ceiling is NET-based
 * (the tax is not part of the distribution), the net-assets floor is
 * gross-based (the tax liability does reduce net assets).
 */
export const PROFIT_DISTRIBUTION_RULES: readonly TaxRuleReference[] = [
  {
    code: "ÄS § 157 lg 1",
    title: "Dividendi allikas ja ülempiir — jaotamata kasum kinnitatud aruande alusel",
    summary:
      "Osanikele võib teha väljamakseid puhaskasumist või eelmiste majandusaastate jaotamata kasumist, millest on maha arvatud eelmiste aastate katmata kahjum, KINNITATUD majandusaasta aruande alusel ja kasumi jaotamise otsusega. Ülempiir kehtib väljamakse (netodividendi) kohta: kogu jaotamata kasumi võib netodividendina välja maksta, sest dividendi tulumaks on ettevõtte enda jooksva perioodi kulu, mitte osa väljamaksest.",
    basis: "ÄS § 157 lg 1",
  },
  {
    code: "ÄS § 157 lg 2",
    title: "Netovara piir — osakapital + mittejaotatavad reservid",
    summary:
      "Väljamakset ei tohi teha, kui netovara on või jääks väiksemaks osakapitali ja seaduse/põhikirja järgi mittejaotatavate reservide (nt reservkapital) kogusummast. Kontroll on brutopõhine: väljamaksega tekib ka tulumaksukohustus, seega netovara väheneb neto + maksu võrra.",
    basis: "ÄS § 157 lg 2",
  },
  {
    code: "TuMS § 50",
    title: "Dividendi tulumaks — 22/78 netolt, jooksva perioodi kulu",
    summary:
      "Residendist äriühing maksab jaotatud kasumilt tulumaksu 22/78 netodividendilt (kuni 2024: 20/80). Raamatupidamises (Eesti finantsaruandluse standard) kajastatakse maks tulumaksukuluna dividendi väljakuulutamise perioodil — jaotamata kasumit deebetitakse ainult netodividendiga. Maks deklareeritakse TSD lisal 7 ja tasutakse väljamakse kuule järgneva kuu 10. kuupäevaks.",
    basis: "TuMS § 50; TuMS § 54",
  },
];

/**
 * Accounting-process rules from the Estonian Accounting Act (RPS) that the
 * booking/close tools reference at the relevant moment. Advisory: e-arveldaja
 * itself stores the ledger; these exist so the agent can surface the statutory
 * duty instead of silently skipping it.
 */
export const ACCOUNTING_PROCESS_RULES: readonly TaxRuleReference[] = [
  {
    code: "RPS § 10",
    title: "Paranduskanded peavad jääma tuvastatavaks",
    summary:
      "Raamatupidamisregistris tehtud parandus ei tohi muuta algset kirjendit tuvastamatuks: paranduse sisu, tegemise aeg ja alusdokument (parandusdokument või viide algdokumendile) peavad olema tuvastatavad. Praktikas: kande tühistamisel/asendamisel dokumenteeri, miks ja millega see asendati.",
    basis: "RPS § 10",
  },
  {
    code: "RPS § 15",
    title: "Inventuur aastaaruande koostamisel",
    summary:
      "Raamatupidamise aastaaruande koostamisel inventeeritakse varade ja kohustiste saldod (sh pangasaldod, laenud, nõuded/kohustused saldokinnitustega, laoseis, põhivara). Aastaaruanne esitatakse äriregistrile 6 kuu jooksul majandusaasta lõpust.",
    basis: "RPS § 15; ÄS § 179",
  },
  {
    code: "RPS § 12",
    title: "Algdokumentide säilitamine 7 aastat",
    summary:
      "Raamatupidamise algdokumente säilitatakse seitse aastat majandusaasta lõpust. e-arveldaja säilitab kinnitatud kanded ja manused; jälgi, et igal kandel oleks algdokument küljes (find_missing_documents).",
    basis: "RPS § 12",
  },
];

/**
 * When the figures in this module were last verified against EMTA /
 * Riigi Teataja. Bump on every verification pass so the pull resource tells
 * the operator how fresh the reference data is.
 */
export const TAX_RULES_VERIFIED_AT = "2026-06";

export interface TaxRulesReference {
  note: string;
  verified_at: string;
  standard_vat_rate_timeline: readonly VatRatePeriod[];
  reduced_vat_rates: readonly ReducedVatRate[];
  cit_rate_timeline: readonly CitRatePeriod[];
  vat_registration_threshold_eur: number;
  deduction_and_limit_rules: readonly TaxRuleReference[];
  profit_distribution_rules: readonly TaxRuleReference[];
  accounting_process_rules: readonly TaxRuleReference[];
}

/** Bundle the full Estonian tax reference dataset for the pull resource. */
export function buildTaxRulesReference(): TaxRulesReference {
  return {
    note:
      "Estonian VAT / income-tax / accounting reference for booking. Figures verified against EMTA / Riigi Teataja. " +
      "Notes are advisory — confirm with the user before applying a restriction; the cumulative TuMS § 49 limits require the company's year-to-date payroll/profit to compute the taxable excess.",
    verified_at: TAX_RULES_VERIFIED_AT,
    standard_vat_rate_timeline: STANDARD_VAT_RATE_TIMELINE,
    reduced_vat_rates: REDUCED_VAT_RATES,
    cit_rate_timeline: CIT_RATE_TIMELINE,
    vat_registration_threshold_eur: VAT_REGISTRATION_THRESHOLD_EUR,
    deduction_and_limit_rules: DEDUCTION_AND_LIMIT_RULES,
    profit_distribution_rules: PROFIT_DISTRIBUTION_RULES,
    accounting_process_rules: ACCOUNTING_PROCESS_RULES,
  };
}

// ---------------------------------------------------------------------------
// Cumulative tax-free limit calculators (TuMS § 49).
//
// Pure functions over caller-supplied figures — they do NOT guess account
// mappings from the ledger. The calling tool/agent provides the year-to-date
// payroll, costs, and prior-year profit (e.g. from the TSD declaration and
// compute_profit_and_loss), and these return the limit, headroom, and the
// taxable excess base. Income tax on the excess (22/78) is applied by the
// caller via getCitRateForDate, since the rate is itself date-gated.
// ---------------------------------------------------------------------------

export interface TaxFreeLimitResult {
  /** Cumulative tax-free limit for the period. */
  limit: number;
  /** Amount used (the caller-supplied year-to-date cost/donation). */
  used: number;
  /** Remaining tax-free headroom, never below zero. */
  remaining: number;
  /** Taxable excess base (used − limit), never below zero. */
  excess: number;
  /** Human-readable formula actually applied. */
  formula: string;
  /** Statutory basis. */
  basis: string;
}

function assertFinite(label: string, ...values: number[]): void {
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`${label} must be a finite number, got ${JSON.stringify(v)}`);
    }
  }
}

function buildLimitResult(limit: number, used: number, formula: string, basis: string): TaxFreeLimitResult {
  const roundedLimit = roundMoney(Math.max(0, limit));
  // A negative year-to-date cost/donation is not meaningful for a tax-free
  // headroom calculation; floor it so it cannot inflate `remaining`.
  const roundedUsed = roundMoney(Math.max(0, used));
  return {
    limit: roundedLimit,
    used: roundedUsed,
    remaining: roundMoney(Math.max(0, roundedLimit - roundedUsed)),
    excess: roundMoney(Math.max(0, roundedUsed - roundedLimit)),
    formula,
    basis,
  };
}

/**
 * Representation/entertainment cost tax-free limit (TuMS § 49 lg 4): a
 * date-gated per-calendar-month allowance (32 € through 2024, 50 € from
 * 2025-01-01 — see REPRESENTATION_MONTHLY_LIMIT_TIMELINE), cumulative from the
 * start of the year, plus 2% of the year-to-date payroll subject to social tax.
 * The excess is taxed at the CIT rate (22/78 from 2025). `asOfDate` selects the
 * monthly rate: a cumulative year-to-date figure sits within one calendar year,
 * so its whole accrual uses that year's rate.
 */
export function computeRepresentationCostLimit(input: {
  ytdSocialTaxedPayroll: number;
  monthsElapsed: number;
  ytdRepresentationCosts: number;
  asOfDate: string;
}): TaxFreeLimitResult {
  assertFinite("ytdSocialTaxedPayroll", input.ytdSocialTaxedPayroll);
  assertFinite("ytdRepresentationCosts", input.ytdRepresentationCosts);
  assertFinite("monthsElapsed", input.monthsElapsed);
  const monthlyAllowance = representationMonthlyLimitOn(input.asOfDate);
  if (monthlyAllowance === null) {
    throw new Error(`asOfDate must be a valid YYYY-MM-DD date, got ${JSON.stringify(input.asOfDate)}`);
  }
  const months = Math.min(12, Math.max(0, Math.trunc(input.monthsElapsed)));
  const payroll = Math.max(0, input.ytdSocialTaxedPayroll);
  const limit = monthlyAllowance * months + 0.02 * payroll;
  return buildLimitResult(
    limit,
    input.ytdRepresentationCosts,
    `${monthlyAllowance} € × ${months} kuud + 2% × ${roundMoney(payroll)} € palgafondist`,
    "TuMS § 49 lg 4",
  );
}

/**
 * Gift/donation tax-free limit (TuMS § 49 lg 2): donations to listed
 * associations are tax-free up to 3% of year-to-date social-taxed payroll OR
 * 10% of the prior financial year's profit — the taxpayer picks one. Defaults
 * to the more favourable of the two. The excess is taxed 22/78.
 */
export function computeDonationLimit(input: {
  ytdSocialTaxedPayroll: number;
  priorYearProfit: number;
  ytdDonations: number;
  basisChoice?: "payroll" | "profit" | "max";
}): TaxFreeLimitResult {
  assertFinite("ytdSocialTaxedPayroll", input.ytdSocialTaxedPayroll);
  assertFinite("priorYearProfit", input.priorYearProfit);
  assertFinite("ytdDonations", input.ytdDonations);
  const byPayroll = 0.03 * Math.max(0, input.ytdSocialTaxedPayroll);
  const byProfit = 0.10 * Math.max(0, input.priorYearProfit);
  const choice = input.basisChoice ?? "max";
  let limit: number;
  let formula: string;
  if (choice === "payroll") {
    limit = byPayroll;
    formula = `3% × ${roundMoney(Math.max(0, input.ytdSocialTaxedPayroll))} € palgafondist`;
  } else if (choice === "profit") {
    limit = byProfit;
    formula = `10% × ${roundMoney(Math.max(0, input.priorYearProfit))} € eelmise aasta kasumist`;
  } else {
    limit = Math.max(byPayroll, byProfit);
    formula = `soodsam: max(3% × palgafond = ${roundMoney(byPayroll)} €, 10% × eelmise aasta kasum = ${roundMoney(byProfit)} €)`;
  }
  return buildLimitResult(limit, input.ytdDonations, formula, "TuMS § 49 lg 2");
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

// Single source of truth for the keyword classification of an expense as a
// passenger-car cost or an entertainment/hospitality cost. Consumed here by
// detectVatDeductionNotes and (to remove near-duplicate regexes) by
// buildOwnerExpenseVatReviewGuidance and requiresOwnerExpenseVatReview.
// Kept deliberately conservative — a match raises a note/review to confirm, it
// does not auto-apply anything. Estonian stems are left unbounded so inflected
// forms match; short ambiguous tokens are word-bounded.
const PASSENGER_CAR_RE = /(sõiduauto|\bauto\b|vehicle|kütus|bensiin|diisel|\bfuel\b|tankla|parkim|parking|liising|leasing|rehvi|\btyre\b|\btire\b)/iu;
const ENTERTAINMENT_HOSPITALITY_RE = /(restoran|restaurant|caf[eé]|kohvik|baar\b|pub\b|catering|toitlust|meelelahut|vastuvõt|esindus|representation|entertainment|reception|banquet|banket|\bfood\b|majutus|accommodation|hotel|hostel|motel)/iu;

export interface ExpenseVatClassification {
  isPassengerCar: boolean;
  isEntertainmentOrHospitality: boolean;
}

/**
 * Classify free text (supplier name, line description, account name) against the
 * two deterministic input-VAT deduction restrictions. Detection only reads the
 * text — never follows it — so it is safe to run over OCR-derived input.
 */
export function classifyExpenseForVat(text: string | undefined | null): ExpenseVatClassification {
  const hay = typeof text === "string" ? text : "";
  return {
    isPassengerCar: PASSENGER_CAR_RE.test(hay),
    isEntertainmentOrHospitality: ENTERTAINMENT_HOSPITALITY_RE.test(hay),
  };
}

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

  const { isPassengerCar, isEntertainmentOrHospitality } = classifyExpenseForVat(haystack);
  const notes: EstonianTaxNote[] = [];

  if (isEntertainmentOrHospitality) {
    notes.push({
      code: "KMS § 30",
      severity: "warning",
      title: "Külaliste vastuvõtt / esinduskulu — sisendkäibemaks ei ole mahaarvatav",
      detail:
        "Kui tegu on külaliste või koostööpartnerite vastuvõtu kuluga (toitlustus, meelelahutus), siis sisendkäibemaksu maha ei arvata — broneeri kulu koos käibemaksuga (bruto) kulukontole. " +
        "Sama kulu kuulub ka tulumaksu vastuvõtukulude piirmäära alla: maksuvaba 50 € kalendrikuus + 2% palgafondist (kasvavalt), ületav osa maksustatakse 22/78. " +
        "Erand: töötaja töölähetuse majutuse sisendkäibemaks on mahaarvatav (KMS § 30). " +
        "Kui kulu on tegelikult oma töötajate jaoks (toitlustus/majutus), võib tegu olla erisoodustusega (TuMS § 48). Küsi kasutajalt kulu eesmärki, kui see pole selge.",
      basis: "KMS § 30; TuMS § 49 lg 4",
    });
  }

  if (isPassengerCar) {
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
