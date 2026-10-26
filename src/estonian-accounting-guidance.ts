import type { InvoiceExtractionFallback } from "./invoice-extraction-fallback.js";
import { classifyExpenseForVat } from "./estonian-tax-rules.js";
import { capUntrustedText, wrapUntrustedOcr } from "./mcp-json.js";
import { currentToolProfile, isToolVisibleForProfile } from "./tool-profile.js";
import type {
  ExtractedReceiptFields,
  ReceiptClassification,
  TransactionClassificationCategory,
} from "./tools/receipt-extraction.js";

export interface ReviewGuidance {
  recommendation: string;
  compliance_basis: string[];
  follow_up_questions: string[];
  policy_hint?: string;
}

const BASIS_RPS_DOCUMENT = "RPS § 6–7: every entry must rest on a source document (algdokument) and be booked by the actual substance of the transaction.";
const BASIS_RPS_SUBSTANCE = "RPS § 4: follow the economic substance of the transaction and be conservative while the supporting evidence or the treatment is not yet clear enough.";
const BASIS_RPS_MATCHING = "RPS § 4: revenue and expenses must be recognised according to their actual economic substance and in the correct period.";
const BASIS_KMS_DEDUCTION = "KMS § 29 lg 1 and 4: input VAT may be deducted only to the extent the purchase is used for taxable business activity.";
const BASIS_KMS_RESTRICTIONS = "KMS § 30: input VAT on guest reception (külaliste vastuvõtt) and on catering or accommodation of the company's own employees is generally not deductible, except accommodation on a business trip (töölähetus).";
const BASIS_KMS_INVOICE = "KMS § 31 and § 37: deducting an Estonian supplier's input VAT generally requires a compliant invoice; without an adequate source document, do not deduct it.";
const BASIS_KMS_FOREIGN_SERVICE = "KMS § 29 lg 3 p 3, § 31 lg 3 and § 10: a service received from a foreign business may be subject to reverse charge (pöördmaksustamine) in Estonia, but the deduction still depends on business use and evidence.";
const BASIS_KMS_PARTIAL = "KMS § 32 and the EMTA passenger-car guidance (EMTA sõiduauto juhis): with mixed use or VAT-exempt turnover only the taxable business share may be deducted; passenger-car costs are generally subject to the 50% cap.";

function normalizedText(...parts: Array<string | undefined | null>): string {
  return parts
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" ")
    .toLowerCase();
}

function hasAnyKeyword(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map(item => item.trim()).filter(Boolean))];
}

function formatMissingField(field: string): string {
  switch (field) {
    case "supplier_name":
      return "supplier name";
    case "invoice_number":
      return "invoice number";
    case "invoice_date":
      return "invoice date";
    case "total_gross":
      return "gross total";
    case "total_vat":
      return "VAT amount";
    case "total_net":
      return "net total";
    case "supplier_reg_code":
      return "registry code";
    case "supplier_vat_no":
      return "VAT number (KMKR)";
    case "supplier_iban":
      return "IBAN";
    case "ref_number":
      return "reference number";
    case "due_date":
      return "due date";
    default:
      return field.replaceAll("_", " ");
  }
}

function buildMissingFieldQuestions(missingFields: string[]): string[] {
  const questions: string[] = [];
  if (missingFields.includes("supplier_name")) {
    questions.push("What is the supplier's exact name on the document, and is its registry code or VAT number (KMKR) readable?");
  }
  if (missingFields.includes("invoice_number") || missingFields.includes("invoice_date")) {
    questions.push("What are the invoice number and invoice date exactly as written on the source document?");
  }
  if (missingFields.includes("total_gross") || missingFields.includes("total_net") || missingFields.includes("total_vat")) {
    questions.push("What are the document's net total, VAT amount and gross total, and do they add up?");
  }
  return dedupe(questions);
}

// Owner-expense review questions. Each carries server-owned answer semantics
// (OWNER_EXPENSE_QUESTION_EFFECTS) so the inbox continuation can tell a "no"
// that only limits the VAT deduction from one that stops the booking.
const Q_OWNER_CAR_M1 = "Is the cost related to an M1-category passenger car or its use?";
const Q_OWNER_CAR_PRIVATE_USE_EXCLUDED = "Is the vehicle used exclusively for business, and is private driving actually excluded?";
const Q_OWNER_CAR_EXEMPT_TURNOVER = "Does the company also have VAT-exempt turnover or other non-business use that would reduce the deductible share further?";
const Q_OWNER_HOSPITALITY_GUEST_RECEPTION = "Is this a guest-reception cost (külaliste vastuvõtt: hosting customers, partners or other guests)?";
const Q_OWNER_HOSPITALITY_STAFF = "Is this catering, accommodation or other personal consumption of the company's own employees (excluding business-trip accommodation)? A taxable fringe benefit (erisoodustus) is a separate case that this flow does not book.";
const Q_OWNER_HOSPITALITY_TRIP_ACCOMMODATION = "Is this accommodation for an employee's business trip (töölähetus)?";
const Q_OWNER_HOSPITALITY_BUSINESS_LINK = "Can the business purpose of the cost be evidenced (for a business trip: is there a basis for the trip)?";
const Q_OWNER_BUSINESS_ONLY = "Was the cost incurred solely for business, or is there also personal / non-business use?";
const Q_OWNER_DOCUMENT_COMPLETE = "Are the supplier, date, amount and VAT clearly identifiable on the source document?";

/**
 * What a true/false answer to an owner-expense review question means:
 * - `proceed`: the booking may go ahead as answered;
 * - `limit_vat`: the booking may go ahead, but input VAT is not fully
 *   deductible (KMS § 29 lg 4, § 30 lg 4, § 32), so vat_deduction_mode
 *   must be "partial" or "none";
 * - `no_vat`: the booking may go ahead with NO input-VAT deduction (KMS § 30
 *   lg 1, e.g. guest reception), so vat_deduction_mode must be "none";
 * - `block`: the booking must not be prepared (e.g. no valid source document).
 */
export type OwnerExpenseAnswerEffect = "proceed" | "limit_vat" | "no_vat" | "block";

export interface OwnerExpenseQuestionEffect {
  readonly on_true: OwnerExpenseAnswerEffect;
  readonly on_false: OwnerExpenseAnswerEffect;
}

const OWNER_EXPENSE_QUESTION_EFFECTS: ReadonlyMap<string, OwnerExpenseQuestionEffect> = new Map([
  // Not an M1 car → the passenger-car cap does not apply.
  [Q_OWNER_CAR_M1, { on_true: "proceed", on_false: "proceed" }],
  // Private use not excluded → 50% cap (KMS § 30 lg 4).
  [Q_OWNER_CAR_PRIVATE_USE_EXCLUDED, { on_true: "proceed", on_false: "limit_vat" }],
  // Exempt / non-business turnover → deductible share shrinks (KMS § 32).
  [Q_OWNER_CAR_EXEMPT_TURNOVER, { on_true: "limit_vat", on_false: "proceed" }],
  // Guest reception → input VAT is not deductible at all (KMS § 30 lg 1).
  [Q_OWNER_HOSPITALITY_GUEST_RECEPTION, { on_true: "no_vat", on_false: "proceed" }],
  // Staff catering / accommodation / personal consumption → not deductible
  // (KMS § 30; conservative — a taxed fringe benefit is handled outside this flow).
  [Q_OWNER_HOSPITALITY_STAFF, { on_true: "no_vat", on_false: "proceed" }],
  // Business-trip accommodation is the deductible exception; any other
  // hospitality cost defaults to a limited deduction (the recommendation's
  // conservative default).
  [Q_OWNER_HOSPITALITY_TRIP_ACCOMMODATION, { on_true: "proceed", on_false: "limit_vat" }],
  // Business link not provable → do not book as a business expense.
  [Q_OWNER_HOSPITALITY_BUSINESS_LINK, { on_true: "proceed", on_false: "block" }],
  // Mixed business/private use → only the business share is deductible.
  [Q_OWNER_BUSINESS_ONLY, { on_true: "proceed", on_false: "limit_vat" }],
  // Source document incomplete → no valid basis (RPS § 6–7, KMS § 31).
  [Q_OWNER_DOCUMENT_COMPLETE, { on_true: "proceed", on_false: "block" }],
]);

// Server-owned semantics for one owner-expense review question, matched on the
// exact server question text. Unknown questions have no semantics (undefined):
// the caller treats a "no" to them conservatively as blocking.
export function ownerExpenseQuestionEffect(question: string): OwnerExpenseQuestionEffect | undefined {
  return OWNER_EXPENSE_QUESTION_EFFECTS.get(question.trim());
}

export function buildOwnerExpenseVatReviewGuidance(params: {
  description: string;
  accountName?: string;
}): ReviewGuidance {
  const text = normalizedText(params.accountName, params.description);
  const expenseClass = classifyExpenseForVat(text);

  if (expenseClass.isPassengerCar) {
    return {
      recommendation: "Recommendation: do not assume a full deduction. If this is an ordinary M1 passenger car or its cost and private driving is not excluded, use a partial deduction as the conservative default and start from the 50% cap.",
      compliance_basis: [
        BASIS_KMS_DEDUCTION,
        BASIS_KMS_PARTIAL,
      ],
      follow_up_questions: [
        Q_OWNER_CAR_M1,
        Q_OWNER_CAR_PRIVATE_USE_EXCLUDED,
        Q_OWNER_CAR_EXEMPT_TURNOVER,
      ],
      policy_hint: "If the same car or expense-type policy recurs, save it as a rule (save_auto_booking_rule, owner_expense_reimbursement) so fewer questions are asked next time.",
    };
  }

  if (expenseClass.isEntertainmentOrHospitality) {
    return {
      recommendation: "Recommendation: treat the input VAT as non-deductible by default, unless this is evidenced accommodation on an employee's business trip or another clearly deductible exception.",
      compliance_basis: [
        BASIS_KMS_DEDUCTION,
        BASIS_KMS_RESTRICTIONS,
        BASIS_KMS_INVOICE,
      ],
      follow_up_questions: [
        Q_OWNER_HOSPITALITY_GUEST_RECEPTION,
        Q_OWNER_HOSPITALITY_STAFF,
        Q_OWNER_HOSPITALITY_TRIP_ACCOMMODATION,
        Q_OWNER_HOSPITALITY_BUSINESS_LINK,
      ],
      policy_hint: "If the company treats this type of cost the same way every time, save it as a rule (save_auto_booking_rule, owner_expense_reimbursement).",
    };
  }

  return {
    recommendation: "Recommendation: if the cost is solely for business and the source document exists, treat the input VAT as deductible by default. If the use is mixed or partly personal, reduce the deductible share.",
    compliance_basis: [
      BASIS_KMS_DEDUCTION,
      BASIS_KMS_INVOICE,
    ],
    follow_up_questions: [
      Q_OWNER_BUSINESS_ONLY,
      Q_OWNER_DOCUMENT_COMPLETE,
    ],
    policy_hint: "If the VAT treatment of this expense type recurs, save it as a rule (save_auto_booking_rule, owner_expense_reimbursement).",
  };
}

export function buildReceiptReviewGuidance(params: {
  classification: ReceiptClassification;
  notes: string[];
  extracted?: Partial<ExtractedReceiptFields>;
  llmFallback?: InvoiceExtractionFallback;
  /** Journals that may already book this receipt's cash outflow (receipt_batch hold). */
  possibleDuplicateJournalIds?: readonly number[];
  /** Live journals already referencing this receipt's invoice number (receipt_batch hold). */
  referencingJournalIds?: readonly number[];
  /** The journal reference scan was unavailable twice (receipt_batch hold). */
  journalReferenceScanUnavailable?: boolean;
}): ReviewGuidance | undefined {
  const text = normalizedText(
    params.extracted?.supplier_name,
    params.extracted?.description,
    params.notes.join(" "),
  );
  const missingFields = params.llmFallback?.missing_required_fields ?? [];

  if (params.referencingJournalIds && params.referencingJournalIds.length > 0) {
    const ids = params.referencingJournalIds.join(", ");
    const cashIds = params.possibleDuplicateJournalIds && params.possibleDuplicateJournalIds.length > 0
      ? params.possibleDuplicateJournalIds.join(", ")
      : undefined;
    return {
      recommendation: `Recommendation: do not create this invoice. Journal(s) ${ids} already reference this document's invoice number, so it may already be booked. ` +
        "If so, attach the document to that journal (attach_document entity_type=journal on the standard surface, or in the e-arveldaja UI) instead of creating an invoice." +
        (cashIds !== undefined ? ` The same cash outflow may also be booked by journal(s) ${cashIds}.` : ""),
      compliance_basis: [BASIS_RPS_DOCUMENT],
      follow_up_questions: [
        `Is journal ${ids} this document's booking?`,
      ],
    };
  }

  if (params.possibleDuplicateJournalIds && params.possibleDuplicateJournalIds.length > 0) {
    const ids = params.possibleDuplicateJournalIds.join(", ");
    return {
      recommendation: `Recommendation: do not create this invoice yet. The same cash outflow may already be booked by journal(s) ${ids}. ` +
        "If that journal is this payment, attach the document to it instead; if this is a separate payment, book this one document on its own (process_accounting_document, or create_purchase_invoice_from_pdf on the standard surface).",
      compliance_basis: [BASIS_RPS_DOCUMENT],
      follow_up_questions: [
        `Is journal ${ids} the payment for this document, or a separate payment of the same amount?`,
      ],
    };
  }

  if (params.journalReferenceScanUnavailable) {
    return {
      recommendation: "Recommendation: do not create this invoice yet. The journal list could not be read, so journals that may already book this invoice number were not checked. " +
        "Re-run the batch when the journal list is readable, or book this document on its own (process_accounting_document, or create_purchase_invoice_from_pdf on the standard surface).",
      compliance_basis: [BASIS_RPS_DOCUMENT],
      follow_up_questions: [
        "Is this document already booked by a journal?",
      ],
    };
  }

  if (params.classification === "owner_paid_expense_reimbursement") {
    const ownerExpenseGuidance = buildOwnerExpenseVatReviewGuidance({
      description: params.extracted?.description ?? params.extracted?.supplier_name ?? "Owner-paid expense",
    });
    return {
      recommendation: "Recommendation: do not turn this into a purchase invoice automatically. Use the owner expense reimbursement flow and decide the VAT deduction after checking the business use.",
      compliance_basis: dedupe([
        BASIS_RPS_DOCUMENT,
        ...ownerExpenseGuidance.compliance_basis,
      ]),
      follow_up_questions: ownerExpenseGuidance.follow_up_questions,
      policy_hint: ownerExpenseGuidance.policy_hint,
    };
  }

  if (params.classification !== "purchase_invoice") {
    return {
      recommendation: "Recommendation: do not book this as a purchase invoice until the document type and its economic substance are clear. If it is not a supplier invoice, use the separate workflow that fits it.",
      compliance_basis: [
        BASIS_RPS_DOCUMENT,
        BASIS_RPS_SUBSTANCE,
      ],
      follow_up_questions: [
        "Is this a supplier invoice at all, or rather a receipt, a contract annex, an owner expense or other evidence?",
        "What is the actual economic substance of this document: a purchase, an owner expense reimbursement, a business-trip cost or something else?",
      ],
    };
  }

  if (missingFields.length > 0 || params.notes.some(note => note.includes("Missing supplier name"))) {
    const readableFields = missingFields.map(formatMissingField);
    return {
      recommendation: readableFields.length > 0
        ? `Recommendation: do not auto-book until confirmed from the source document: ${readableFields.join(", ")}.`
        : "Recommendation: do not auto-book until the supplier, invoice date, number and amounts are reliably confirmed from the source document.",
      compliance_basis: [
        BASIS_RPS_DOCUMENT,
        BASIS_KMS_INVOICE,
      ],
      follow_up_questions: buildMissingFieldQuestions(missingFields),
      policy_hint: "If OCR keeps missing the same fields for this supplier, reuse its earlier confirmed invoices or a booking-rule default (save_auto_booking_rule), but only once the core data is confirmed.",
    };
  }

  if (params.notes.some(note => note.includes("Supplier could not be resolved"))) {
    return {
      recommendation: "Recommendation: link or create the supplier only after the supplier name and, where possible, the registry code, VAT number (KMKR) or IBAN are confirmed from the source document.",
      compliance_basis: [
        BASIS_RPS_DOCUMENT,
        BASIS_KMS_INVOICE,
      ],
      follow_up_questions: [
        "What is the supplier's official name on the document, and is the registry code or VAT number (KMKR) readable?",
        "Does the document show an IBAN or another identifier that reliably links the supplier to an existing client?",
      ],
      policy_hint: "Once the supplier is confirmed, its default treatment can be stored in the company booking rules (save_auto_booking_rule), or the system can reuse an earlier confirmed invoice.",
    };
  }

  if (params.notes.some(note => note.includes("Could not find a purchase article / account suggestion"))) {
    const foreignService = hasAnyKeyword(text, /\b(openai|google|microsoft|zoom|slack|github|hosting|cloud|subscription|software)\b/u);
    return {
      recommendation: foreignService
        ? "Recommendation: treat this as a service purchase by default and confirm whether it is a service from a foreign business that needs reverse charge (pöördmaksustamine). Only then choose the account/article or save it as a rule."
        : "Recommendation: choose the account and article by the actual substance of the cost, using an earlier confirmed invoice from the same supplier as the default precedent where available.",
      compliance_basis: foreignService
        ? [
            BASIS_RPS_SUBSTANCE,
            BASIS_KMS_DEDUCTION,
            BASIS_KMS_FOREIGN_SERVICE,
          ]
        : [
            BASIS_RPS_SUBSTANCE,
            BASIS_RPS_DOCUMENT,
          ],
      follow_up_questions: foreignService
        ? [
            "Is the supplier a foreign business, and is the place of supply of the service in Estonia?",
            "Is the service used for taxable business activity, and is there a basis for reverse charge?",
            "Which expense account should this service go to by default from now on?",
          ]
        : [
            "What is the actual economic substance of these goods or this service, to choose the account by?",
            "Is there an earlier confirmed invoice from the same supplier whose treatment could be adopted as the default?",
          ],
      policy_hint: "If the treatment of this supplier or expense type recurs, save it in the company booking rules as an auto-booking rule (save_auto_booking_rule).",
    };
  }

  return undefined;
}

export function buildClassificationReviewGuidance(params: {
  category: TransactionClassificationCategory;
  displayCounterparty: string;
  /** Set when the group's suggestion comes from the counterparty's booking history. */
  history?: { accountId: number; dimensionId: number | null; streak: number; historyTotal: number };
}): ReviewGuidance | undefined {
  // The counterparty is bank-statement text a remitter controls (bank_account_name,
  // falling back to description), and it is interpolated into server-authored prose
  // that the model reads as guidance. The presenter wraps display_counterparty and
  // the transaction fields but copies review_guidance through a `...group` spread,
  // so the sandbox has to be applied here, where untrusted text enters the prose.
  // Display-only: review_guidance never feeds a plan fingerprint.
  const displayCounterparty = wrapUntrustedOcr(
    capUntrustedText(params.displayCounterparty, 200).text,
  ) ?? params.displayCounterparty;
  // A history hint replaces the category text: the category guess (e.g. revenue
  // for any incoming row) contradicts how this counterparty was actually booked.
  if (params.history) {
    const { accountId, dimensionId, streak, historyTotal } = params.history;
    const target = dimensionId !== null ? `account ${accountId} with dimension ${dimensionId}` : `account ${accountId}`;
    const distribution = dimensionId !== null
      ? `{ related_table: "accounts", related_id: ${accountId}, related_sub_id: ${dimensionId}, amount: <transaction amount> }`
      : `{ related_table: "accounts", related_id: ${accountId}, amount: <transaction amount> }`;
    // Name confirm_transaction only where it is registered (not on guided).
    let confirmVisible = false;
    try {
      confirmVisible = isToolVisibleForProfile("confirm_transaction", currentToolProfile());
    } catch {
      confirmVisible = false;
    }
    const howToBook = confirmVisible
      ? `confirm each transaction separately via confirm_transaction with the distribution ${distribution}`
      : `confirm each transaction separately with the distribution ${distribution}; this profile has no single-transaction confirmation, which needs the standard or full profile (EARVELDAJA_PROFILE)`;
    return {
      recommendation: `Recommendation: the last ${streak} confirmed bank entries of counterparty ${displayCounterparty} (${historyTotal} in total) were all booked to ${target}. If this transaction has the same substance, ${howToBook}. This is only a hint based on earlier entries: check the transaction's substance and source document before confirming.`,
      compliance_basis: [
        BASIS_RPS_DOCUMENT,
        BASIS_RPS_SUBSTANCE,
      ],
      follow_up_questions: [
        "Does this transaction have the same substance and source document (e.g. the same contract, invoice or service fee) as the earlier entries?",
      ],
    };
  }
  switch (params.category) {
    case "tax_payments":
      return {
        recommendation: "Recommendation: do not create a purchase invoice for this. A transfer to EMTA tops up the EMTA prepayment account (ettemaksukonto) — book the payment to the EMTA prepayment account (debit prepayment account / credit bank). The actual tax expenses (VAT, payroll taxes, income tax, etc.) are created by e-arveldaja itself from the prepayment-account statement (Aruandlus → EMTA ettemaksukonto kanded).",
        compliance_basis: [
          BASIS_RPS_DOCUMENT,
          BASIS_RPS_SUBSTANCE,
        ],
        follow_up_questions: [
          `Is the ${displayCounterparty} payment a top-up of the EMTA prepayment account or some other tax-related movement?`,
          "Has the EMTA prepayment-account statement been imported into e-arveldaja so that the matching tax-expense entries are created?",
        ],
      };
    case "salary_payroll":
      return {
        recommendation: "Recommendation: do not create a purchase invoice for this. Salaries, payroll taxes and payments to employees must be booked from the payroll or wage source documents.",
        compliance_basis: [
          BASIS_RPS_DOCUMENT,
          BASIS_RPS_SUBSTANCE,
          BASIS_RPS_MATCHING,
        ],
        follow_up_questions: [
          "Is this transfer a net salary, a payroll tax, a business-trip allowance or another staff cost?",
          "Which payroll or other source document does this payment relate to?",
        ],
      };
    case "owner_transfers":
      return {
        recommendation: "Recommendation: do not create a purchase invoice for this. An owner-related payment must be classified by its substance as a loan, a capital contribution, an expense reimbursement, a dividend or private consumption.",
        compliance_basis: [
          BASIS_RPS_DOCUMENT,
          BASIS_RPS_SUBSTANCE,
        ],
        follow_up_questions: [
          "Is this movement an owner loan, a capital contribution, an expense reimbursement, a dividend or the owner's private consumption?",
          "Is there a loan agreement, a shareholder resolution, an expense document or other source document for it?",
        ],
      };
    case "revenue_without_invoice":
      return {
        recommendation: "Recommendation: do not create a purchase invoice for this. Link the incoming payment to the source document of the sale, prepayment or other income, and make sure a sale invoice or other evidence exists.",
        compliance_basis: [
          BASIS_RPS_DOCUMENT,
          BASIS_RPS_SUBSTANCE,
          BASIS_RPS_MATCHING,
        ],
        follow_up_questions: [
          "Is this incoming payment backed by a sale invoice, a prepayment, a grant or something else?",
          "Does the income belong to this period, and does the required sales document already exist?",
        ],
      };
    case "unknown":
      return {
        recommendation: "Recommendation: do not auto-book until the actual substance and source document of the transaction are clear. For an uncertain transaction a conservative, rule-compliant treatment is better than a wrong automatic entry.",
        compliance_basis: [
          BASIS_RPS_DOCUMENT,
          BASIS_RPS_SUBSTANCE,
        ],
        follow_up_questions: [
          "What is the actual economic substance of this transaction, and which source document does it relate to?",
          "Should this be treated as a purchase, an owner movement, a payroll cost, a payment to EMTA or something else?",
        ],
      };
    default:
      return undefined;
  }
}

export function buildCamtDuplicateReviewGuidance(params: {
  hasConfirmedMatch: boolean;
}): ReviewGuidance {
  return params.hasConfirmedMatch
    ? {
        recommendation: "Recommendation: by default keep the older, already confirmed entry, add the CAMT bank_ref_number and any other missing bank metadata to it, and do not duplicate the same bank movement with a new record.",
        compliance_basis: [
          BASIS_RPS_DOCUMENT,
          BASIS_RPS_SUBSTANCE,
        ],
        follow_up_questions: [],
      }
    : {
        recommendation: "Recommendation: do not delete or confirm anything automatically until it is clear which entry is the more reliable one tied to source documents. If the old entry is still PROJECT or a low-quality manual entry, usually prefer the row that came from the CAMT source.",
        compliance_basis: [
          BASIS_RPS_DOCUMENT,
          BASIS_RPS_SUBSTANCE,
        ],
        follow_up_questions: [],
      };
}
