import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactReviewItem, CompactWarning, MutatedObject, OperationOutcome } from "../operation-outcome.js";
import type { ExecutionPlanInput, PlanData, PlanRecord } from "../plan-store.js";
import type { ApiContext } from "../tools/crud-tools.js";
import type { RuntimeSafetyContext } from "../runtime-safety-context.js";
import {
  captureFileInputSnapshot,
  type FileInputSnapshot,
  type FileInputSource,
} from "../file-input-snapshot.js";
import { FILE_REFERENCE_OPERATIONS } from "../file-reference-store.js";
import { parseDocument } from "../document-parser.js";
import type { LayoutTextItem } from "../document-identifiers.js";
import {
  computeMinOcrConfidence,
  extractReceiptFieldsFromText,
  inferSupplierCountry,
  LOW_OCR_CONFIDENCE_THRESHOLD,
  type ExtractedReceiptFields,
} from "../tools/receipt-extraction.js";
import { summarizeInvoiceExtraction, type ExtractionConfidenceSignals } from "../invoice-extraction-fallback.js";
import { resolveOwnCompanyIdentifiers } from "../tools/own-company-identity.js";
import { detectSelfRegCodeOnly, detectSelfVatOnly } from "../tools/receipt-inbox.js";
import { resolveSupplierDefault } from "../resolution/supplier-default-resolution.js";
import {
  computeBookingSuggestion,
  validateInvoiceData,
} from "../tools/pdf-workflow.js";
import { detectDuplicatePurchaseInvoice } from "../tools/document-audit.js";
import {
  checkIntakeCashDuplicates,
  type DuplicatePostingCandidate,
} from "../bank-posting-duplicate-guard.js";
import { applyPurchaseVatDefaults, getPurchaseArticlesWithVat } from "../tools/purchase-vat-defaults.js";
import { validateItemDimensions } from "../account-validation.js";
import { isCompanyVatRegistered, parsePurchaseInvoiceItems, tagNotes } from "../tools/crud-tools.js";
import { InvoiceCreationError } from "../api/purchase-invoices.api.js";
import { DEFAULT_LIABILITY_ACCOUNT } from "../accounting-defaults.js";
import { logAudit } from "../audit-log.js";
import { desandboxAllStrings, desandboxText } from "../external-text-renderer.js";
import { canonicalPlanJson, stripUndefinedDeep } from "../tools/camt-plan.js";
import type { CreatePurchaseInvoiceData } from "../types/api.js";
import type {
  AccountingDocumentBookingFields,
  AccountingDocumentConfirmation,
  AccountingDocumentExecution,
  AccountingDocumentOperations,
  AccountingDocumentPreview,
  ConfirmAccountingDocumentInput,
  ExecuteAccountingDocumentInput,
  PrepareAccountingDocumentInput,
} from "./types.js";

// The execution-plan domain that binds a reviewed accounting-document dry run to
// its create. Distinct from the confirm-plan domain minted AFTER create for the
// SEPARATE confirm/link step (Step 3 — the op NEVER confirms/registers).
export const ACCOUNTING_DOCUMENT_PLAN_DOMAIN = "accounting_document";
export const ACCOUNTING_DOCUMENT_CONFIRM_DOMAIN = "accounting_document_confirm";

const INVOICE_DOCUMENT_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png"] as const;
const MAX_INVOICE_DOCUMENT_SIZE = 50 * 1024 * 1024; // 50 MB

function ok<T>(value: T): OperationOutcome<T> {
  return { ok: true, value, warnings: [], blockers: [] };
}

function fail<T>(
  code: string,
  message: string,
  retry: "never" | "safe" | "unknown",
  mutation?: Readonly<{ mutationOccurred: boolean; mutatedObjects?: readonly MutatedObject[] }>,
): OperationOutcome<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      retry,
      ...(mutation?.mutationOccurred ? { mutationOccurred: true } : {}),
      ...(mutation?.mutatedObjects !== undefined ? { mutatedObjects: mutation.mutatedObjects } : {}),
    },
    blockers: [],
  };
}

interface MaterializedSnapshot {
  readonly path: string;
  readonly fileName: string;
  readonly contentsBase64: string;
  readonly source_sha256: string;
  readonly cleanup: () => Promise<void>;
}

// Materialize an immutable in-memory snapshot to a private temp file so the
// document parser (which reads a path) and the uploader run over the exact
// reviewed bytes — the source is never read a second time. `source_sha256` is
// the snapshot's own digest, so a swapped file cannot slip past prepare→create.
async function materializeSnapshot(snapshot: FileInputSnapshot): Promise<MaterializedSnapshot> {
  const bytes = snapshot.bytes();
  const dir = await mkdtemp(join(tmpdir(), "e-arveldaja-document-"));
  const fileName = `document${snapshot.identity.extension}`;
  const path = join(dir, fileName);
  await writeFile(path, bytes, { mode: 0o600 });
  return {
    path,
    fileName,
    contentsBase64: bytes.toString("base64"),
    source_sha256: snapshot.identity.digest_sha256,
    cleanup: async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); },
  };
}

async function loadSnapshot(
  source: FileInputSource,
  runtimeSafetyContext: RuntimeSafetyContext,
  provided?: FileInputSnapshot,
): Promise<FileInputSnapshot> {
  if (provided) return provided;
  return captureFileInputSnapshot(source, {
    runtimeSafetyContext,
    operation: FILE_REFERENCE_OPERATIONS.receipt,
    allowedExtensions: [...INVOICE_DOCUMENT_EXTENSIONS],
    maxSize: MAX_INVOICE_DOCUMENT_SIZE,
  });
}

function textItemsWithPageNums(
  pages: NonNullable<Awaited<ReturnType<typeof parseDocument>>["result"]>["pages"] | undefined,
): LayoutTextItem[] {
  return pages?.flatMap(page =>
    (page.textItems ?? []).map(item => ({ ...item, pageNum: page.pageNum })),
  ) ?? [];
}

/** The canonical effective write model shared by prepare (bind) and create
 * (recompute + compare). Everything here is post-desandbox, post-default,
 * post-validation — the ACTUAL write model, never the raw caller payload. */
interface EffectiveBookingModel {
  readonly fingerprint: PlanRecord;
  readonly invoiceData: CreatePurchaseInvoiceData;
  readonly isVatReg: boolean;
  readonly supplierName: string;
  readonly currencyCode: string;
  readonly blockOnDuplicate: boolean;
  readonly grossAmountEur?: number;
}

class AccountingDocumentOperationsImpl implements AccountingDocumentOperations {
  constructor(
    private readonly api: ApiContext,
    private readonly runtimeSafetyContext: RuntimeSafetyContext,
  ) {}

  // P0-1: compute the canonical effective booking model. Called IDENTICALLY at
  // prepare (to bind the fingerprint into the plan) and at create (to recompute
  // fresh and drift-compare) so the plan proves the exact effect the operator
  // reviewed: supplier canonical name is read from the server, items go through
  // parse → desandbox → VAT defaults → dimension validation, and every default
  // (currency, liability account, block_on_duplicate) is applied BEFORE the
  // fingerprint — an omitted default and its explicit value never drift apart.
  private async computeEffectiveBooking(
    booking: AccountingDocumentBookingFields,
    sourceSha256: string,
    fileName: string,
  ): Promise<OperationOutcome<EffectiveBookingModel>> {
    const supplier = await this.api.clients.get(booking.supplierClientId);
    const supplierName = desandboxText(supplier.name);
    const isVatReg = await isCompanyVatRegistered(this.api);
    const purchaseArticles = await getPurchaseArticlesWithVat(this.api);
    const rawItems = desandboxAllStrings(parsePurchaseInvoiceItems(booking.items));
    const items = rawItems.map(item => applyPurchaseVatDefaults(purchaseArticles, item, isVatReg));

    const [accounts, accountDimensions] = await Promise.all([
      this.api.readonly.getAccounts(),
      this.api.readonly.getAccountDimensions(),
    ]);
    const dimErrors = validateItemDimensions(items, accounts, accountDimensions);
    if (dimErrors.length > 0) {
      return fail("account_validation_failed", `Account validation failed: ${dimErrors.join("; ")}`, "never");
    }

    const currencyCode = (booking.currency ?? "EUR").toUpperCase();
    if (currencyCode !== "EUR" && (booking.currencyRate === undefined || booking.currencyRate === null)) {
      return fail("currency_rate_required", `currency_rate is required when currency="${currencyCode}".`, "never");
    }

    // Write-boundary canonicalization of every free-text field (matches the
    // former inline create logic): only defined strings are desandboxed.
    const invoiceNumber = desandboxText(booking.invoiceNumber);
    const refNumber = booking.refNumber === undefined ? undefined : desandboxText(booking.refNumber);
    const bankAccountNo = booking.bankAccountNo === undefined ? undefined : desandboxText(booking.bankAccountNo);
    const notes = booking.notes === undefined ? undefined : desandboxText(booking.notes);
    const liabilityAccountsId = booking.liabilityAccountsId ?? DEFAULT_LIABILITY_ACCOUNT;
    const blockOnDuplicate = booking.blockOnDuplicate === true;
    // The actual settled EUR gross when known, else the nominal gross only for
    // an EUR-native invoice — never a guessed conversion.
    const grossAmountEur = booking.baseGrossPrice ?? (currencyCode === "EUR" ? booking.grossPrice : undefined);

    const invoiceData: CreatePurchaseInvoiceData = {
      clients_id: booking.supplierClientId,
      client_name: supplierName,
      number: invoiceNumber,
      create_date: booking.invoiceDate,
      journal_date: booking.journalDate,
      term_days: booking.termDays,
      cl_currencies_id: currencyCode,
      currency_rate: booking.currencyRate,
      base_net_price: booking.baseNetPrice,
      base_vat_price: booking.baseVatPrice,
      base_gross_price: booking.baseGrossPrice,
      liability_accounts_id: liabilityAccountsId,
      bank_ref_number: refNumber,
      bank_account_no: bankAccountNo,
      notes: tagNotes(notes),
      items,
    };

    // Every material write value is bound: source identity, supplier id +
    // canonical name, number, dates, term, EFFECTIVE items (accounts,
    // dimensions, VAT config), exact totals, currency/rate/base amounts,
    // liability account, reference/bank/notes, duplicate policy, and the
    // create + upload command pair. stripUndefinedDeep sorts keys and drops
    // undefined so the JSON form is stable for canonicalPlanJson comparison.
    const fingerprint = stripUndefinedDeep({
      source_sha256: sourceSha256,
      file_name: fileName,
      supplier_client_id: booking.supplierClientId,
      supplier_name: supplierName,
      invoice_number: invoiceNumber,
      invoice_date: booking.invoiceDate,
      journal_date: booking.journalDate,
      term_days: booking.termDays,
      items,
      vat_price: booking.vatPrice,
      gross_price: booking.grossPrice,
      currency: currencyCode,
      currency_rate: booking.currencyRate,
      base_net_price: booking.baseNetPrice,
      base_vat_price: booking.baseVatPrice,
      base_gross_price: booking.baseGrossPrice,
      liability_accounts_id: liabilityAccountsId,
      ref_number: refNumber,
      bank_account_no: bankAccountNo,
      notes,
      block_on_duplicate: blockOnDuplicate,
      // Explicit bind: isVatReg already shapes the effective items/totals, but
      // binding it directly keeps it covered even if a future refactor stops
      // feeding it into the item defaults.
      vat_registered: isVatReg,
      commands: ["purchase_invoice_create", "purchase_invoice_upload_document"],
    }) as PlanRecord;

    return ok({
      fingerprint,
      invoiceData,
      isVatReg,
      supplierName,
      currencyCode,
      blockOnDuplicate,
      ...(grossAmountEur !== undefined ? { grossAmountEur } : {}),
    });
  }

  async prepare(input: PrepareAccountingDocumentInput): Promise<OperationOutcome<AccountingDocumentPreview>> {
    const snapshot = await loadSnapshot(input.source, this.runtimeSafetyContext, input.snapshot);
    const material = await materializeSnapshot(snapshot);
    try {
      const parsedDocument = await parseDocument(material.path);
      const allTextItems = textItemsWithPageNums(parsedDocument.result?.pages);
      const minOcrConfidence = computeMinOcrConfidence(allTextItems);

      // Resolve the active company's own identifiers so extraction excludes
      // them from supplier fields. Best-effort — offline extraction still runs.
      let ownCompanyVat: string | undefined;
      let ownCompanyRegistryCode: string | undefined;
      const allClients = await this.api.clients.listAll().catch(() => []);
      try {
        ({ ownCompanyVat, ownCompanyRegistryCode } = await resolveOwnCompanyIdentifiers(this.api, allClients));
      } catch {
        // Offline / unconfigured — extract without self-exclusions.
      }

      const extracted = extractReceiptFieldsFromText(parsedDocument.text, material.fileName, {
        textItems: allTextItems,
        ownCompanyVat,
        ownCompanyRegistryCode,
      });

      const signals: ExtractionConfidenceSignals = {};
      if (parsedDocument.ocrPartialFailure) signals.partial_ocr_failure = true;
      if (minOcrConfidence !== undefined && minOcrConfidence < LOW_OCR_CONFIDENCE_THRESHOLD) signals.low_ocr_confidence = true;
      if (detectSelfVatOnly(extracted, ownCompanyVat)) signals.self_vat_detected = true;
      if (detectSelfRegCodeOnly(extracted, ownCompanyRegistryCode)) signals.self_reg_code_detected = true;
      if (
        extracted.reg_code_rationale === "coordinate_confirmed_echo" ||
        extracted.vat_no_rationale === "coordinate_confirmed_echo"
      ) {
        signals.supplier_identifier_echo_unconfirmed = true;
      }
      const llmFallback = summarizeInvoiceExtraction(extracted, signals, "advanced_detail.raw_text", inferSupplierCountry(extracted));

      const extractionWarnings: string[] = [];
      const rawCurrency = extracted.currency?.toUpperCase();
      const detectedCurrency = rawCurrency && /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : undefined;
      if (detectedCurrency && detectedCurrency !== "EUR") {
        extractionWarnings.push(
          `Invoice in ${detectedCurrency}. Booking uses currency="${detectedCurrency}" plus currency_rate (EUR per 1 ${detectedCurrency}); pass base_gross_price when known to lock the EUR settlement.`,
        );
      }

      // Compact preview carries NO raw OCR — omit raw_text entirely.
      const { raw_text: _rawText, ...fieldsWithoutRawText } = extracted;

      // VAT validation over the regex-extracted totals (advisory pre-review).
      const vatValidationRaw = validateInvoiceData({
        total_net: extracted.total_net ?? 0,
        total_vat: extracted.total_vat ?? 0,
        total_gross: extracted.total_gross ?? 0,
        items: [],
        invoice_date: extracted.invoice_date,
        due_date: extracted.due_date,
        cl_currencies_id: detectedCurrency,
        reg_code: extracted.supplier_reg_code,
        vat_no: extracted.supplier_vat_no,
      });
      const vatValid = Boolean(vatValidationRaw.valid);

      // Supplier resolution — three-way; NEVER guesses a tie (self-match /
      // strong-identifier conflict / tied name → ambiguous; miss → not_found).
      // An explicit supplier_client_id override wins silently when present.
      const overrideId = input.overrides?.supplier_client_id;
      let supplierResolution;
      if (overrideId !== undefined) {
        const overridden = allClients.find(client => client.id === overrideId);
        supplierResolution = overridden
          ? resolveSupplierDefault([overridden], { supplier_reg_code: overridden.code ?? undefined, supplier_name: overridden.name })
          : resolveSupplierDefault(allClients, {
              supplier_name: extracted.supplier_name,
              supplier_reg_code: extracted.supplier_reg_code,
              supplier_vat_no: extracted.supplier_vat_no,
              supplier_iban: extracted.supplier_iban,
            }, { ownCompanyVat, ownCompanyRegistryCode });
      } else {
        supplierResolution = resolveSupplierDefault(allClients, {
          supplier_name: extracted.supplier_name,
          supplier_reg_code: extracted.supplier_reg_code,
          supplier_vat_no: extracted.supplier_vat_no,
          supplier_iban: extracted.supplier_iban,
        }, { ownCompanyVat, ownCompanyRegistryCode });
      }

      const resolvedClientId = supplierResolution.status === "resolved"
        ? supplierResolution.value.client.id
        : undefined;

      // Duplicate detection over the whole purchase-invoice history.
      const allPurchases = await this.api.purchaseInvoices.listAll();
      const duplicate = detectDuplicatePurchaseInvoice(allPurchases, {
        ...(resolvedClientId !== undefined ? { clients_id: resolvedClientId } : {}),
        invoice_number: extracted.invoice_number,
        gross_price: extracted.total_gross,
      });

      // Cross-mechanism intake cash-duplicate scan (real EUR gross only).
      const grossAmountEur = input.overrides?.base_gross_price
        ?? ((detectedCurrency === undefined || detectedCurrency === "EUR") ? extracted.total_gross : undefined);
      const intakeScan = await checkIntakeCashDuplicates(this.api, {
        grossAmountEur,
        invoiceDate: extracted.invoice_date ?? "",
      });

      // Proposed booking — ONLY when the supplier resolved uniquely.
      const proposedBooking = resolvedClientId !== undefined
        ? await computeBookingSuggestion(this.api, { clients_id: resolvedClientId, description: extracted.description })
        : undefined;

      // Blockers / warnings surfaced compactly.
      const blockers: CompactReviewItem[] = [];
      const warnings: CompactWarning[] = [];
      if (!vatValid) {
        // Regex-extracted totals are frequently incomplete (net/VAT often absent),
        // so this is advisory — the operator supplies the reviewed totals at
        // create, where createAndSetTotals enforces gross/VAT consistency.
        warnings.push({ code: "vat_validation", message: "The auto-extracted totals did not validate; supply the reviewed totals before booking." });
      }
      if (signals.partial_ocr_failure || signals.low_ocr_confidence) {
        warnings.push({ code: "ocr_quality", message: "OCR quality is low; verify extracted fields before booking." });
      }
      if (signals.self_vat_detected || signals.self_reg_code_detected) {
        warnings.push({ code: "self_supplier_signal", message: "An identifier matched the active company itself; verify the supplier." });
      }
      if (supplierResolution.status === "ambiguous") {
        warnings.push({ code: "supplier_ambiguous", message: "The supplier is ambiguous; resolve it before booking." });
      }
      if (Array.isArray(proposedBooking?.dimension_notes) && proposedBooking.dimension_notes.length > 0) {
        warnings.push({ code: "ambiguous_dimension", message: "A historical account maps to more than one dimension; confirm the dimension." });
      }

      const planProjection: PlanData = {
        source_sha256: material.source_sha256,
        supplier_resolved: resolvedClientId !== undefined,
        vat_valid: vatValid,
        candidate_duplicate_risk: Boolean((duplicate as { candidate_duplicate_risk?: unknown }).candidate_duplicate_risk),
        booking_bound: input.booking !== undefined,
      };

      // P0-1: mint the create plan ONLY when the FINAL reviewed booking fields
      // are supplied. An extraction preview alone is NOT create approval — it
      // issues NO handle, so a create can never run off a mere OCR preview.
      // With booking present, the canonical effective model is computed and its
      // fingerprint becomes the plan's normalizedArgs; create recomputes the
      // same model fresh and drift-compares before any write.
      let planHandle: string | undefined;
      let bookingProjection: PlanData | undefined;
      if (input.booking !== undefined) {
        const effective = await this.computeEffectiveBooking(input.booking, material.source_sha256, material.fileName);
        if (!effective.ok) return effective;
        bookingProjection = effective.value.fingerprint;
        const planInput: ExecutionPlanInput = {
          normalizedArgs: effective.value.fingerprint,
          sourceIdentities: [{ ...snapshot.identity } as unknown as PlanRecord],
          liveSnapshot: planProjection,
          commands: [
            { id: "accounting-document-create", category: "purchase_invoice_create", reviewProjection: bookingProjection },
            { id: "accounting-document-upload", category: "purchase_invoice_upload", reviewProjection: { file_name: material.fileName, source_sha256: material.source_sha256 } },
          ],
          counts: { blockers: blockers.length, warnings: warnings.length },
          totals: {
            ...(input.booking.vatPrice !== undefined ? { vat_price: input.booking.vatPrice } : {}),
            ...(input.booking.grossPrice !== undefined ? { gross_price: input.booking.grossPrice } : {}),
          },
          exclusions: [],
          reviews: [],
          privatePayload: { source_sha256: material.source_sha256 },
        };
        // ...but a bound booking is not by itself approval. When the supplier
        // did not resolve, or a blocker stands, the preview reports
        // "needs_input" and tells the operator to resolve it BEFORE booking —
        // so minting here handed back a fully usable create credential attached
        // to a preview that says it is not ready. (computeEffectiveBooking can
        // resolve the supplier through clients.get while the preview's own
        // resolution failed, e.g. a transient clients.listAll error, so the two
        // genuinely disagree.) The projection is still computed and shown for
        // review; only the credential is withheld. Mirrors the sale-invoice
        // façade, which issues no handle on needs_input.
        const approvable = supplierResolution.status === "resolved" && blockers.length === 0;
        if (approvable) {
          planHandle = this.runtimeSafetyContext.planStore.issue(ACCOUNTING_DOCUMENT_PLAN_DOMAIN, planInput);
        }
      }

      const preview: AccountingDocumentPreview = {
        extraction: {
          source_sha256: material.source_sha256,
          page_count: parsedDocument.pageCount,
          ...(minOcrConfidence !== undefined ? { min_ocr_confidence: minOcrConfidence } : {}),
          ...(parsedDocument.ocrPartialFailure ? { partial_ocr_failure: true } : {}),
          confidence_signals: signals,
          fields: fieldsWithoutRawText as Omit<ExtractedReceiptFields, "raw_text">,
          llm_fallback: llmFallback,
          warnings: extractionWarnings,
        },
        vatValidation: {
          valid: Boolean(vatValidationRaw.valid),
          errors: (vatValidationRaw.errors as string[] | undefined) ?? [],
          warnings: (vatValidationRaw.warnings as string[] | undefined) ?? [],
          ...(vatValidationRaw.summary ? { summary: vatValidationRaw.summary as Record<string, unknown> } : {}),
        },
        supplierResolution,
        duplicate,
        ...(proposedBooking ? { proposedBooking } : {}),
        ...(intakeScan.scan_available && !intakeScan.skipped_no_eur_amount && intakeScan.suspects.length > 0
          ? { possibleDuplicatePostings: intakeScan.suspects }
          : {}),
        blockers,
        warnings,
        planProjection,
        ...(planHandle !== undefined ? { planHandle } : {}),
        ...(bookingProjection !== undefined ? { bookingProjection } : {}),
      };
      return ok(preview);
    } finally {
      await material.cleanup();
    }
  }

  async create(input: ExecuteAccountingDocumentInput): Promise<OperationOutcome<AccountingDocumentExecution>> {
    if (!/^[0-9a-f]{64}$/.test(input.sourceSha256 ?? "")) {
      return fail("source_sha256_required", "source_sha256 from the reviewed preview is required", "never");
    }

    // Consume the reviewed plan (consume-once). The handle is REQUIRED for
    // create: every create must follow a mode='prepare' in the same scope
    // (profile + catalog + connection), giving mandatory replay + scope
    // protection. A missing/replayed/out-of-scope handle is a hard failure —
    // the handle is not itself approval, and source_sha256 still binds the
    // reviewed bytes, but a create with no prepared handle is refused outright.
    if (input.planHandle === undefined) {
      return fail("plan_handle_required", "mode='create' requires the plan_handle from the reviewed mode='prepare'.", "never");
    }
    let storedPlan;
    try {
      storedPlan = this.runtimeSafetyContext.planStore.consume(input.planHandle, ACCOUNTING_DOCUMENT_PLAN_DOMAIN);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "plan_handle_invalid";
      return fail(code, "The reviewed execution plan could not be consumed.", "never");
    }

    const snapshot = await loadSnapshot(input.source, this.runtimeSafetyContext, input.snapshot);
    // Re-verify the reviewed bytes BEFORE any API mutation (H15 TOCTOU close).
    if (snapshot.identity.digest_sha256 !== input.sourceSha256) {
      return fail("digest_mismatch", "The document no longer matches the reviewed source bytes.", "never");
    }
    const material = await materializeSnapshot(snapshot);
    try {
      // P0-1 drift gate: recompute the canonical effective model FRESH (live
      // supplier name, live VAT defaults, live dimension validation) and
      // compare it byte-for-byte against the model the operator reviewed at
      // prepare. ANY material difference — source bytes, supplier, number,
      // dates, items, accounts, dimensions, VAT config, totals, currency,
      // rate, base amounts, liability account, references, notes, duplicate
      // policy — rejects as plan_drift with ZERO API writes.
      const effective = await this.computeEffectiveBooking(input, material.source_sha256, material.fileName);
      if (!effective.ok) return effective;
      if (canonicalPlanJson(storedPlan.normalizedArgs) !== canonicalPlanJson(effective.value.fingerprint)) {
        return fail("plan_drift", "The reviewed booking plan no longer matches the requested create model. Re-run mode='prepare' with the final booking fields and review again.", "never");
      }
      const { invoiceData, isVatReg, blockOnDuplicate, grossAmountEur } = effective.value;
      const supplierName = effective.value.supplierName;
      const invoiceNumber = invoiceData.number;
      const items = invoiceData.items;

      // Cross-mechanism intake duplicate guard — BEFORE any invoice/document
      // mutation.
      const duplicateScan = await checkIntakeCashDuplicates(this.api, {
        grossAmountEur,
        invoiceDate: input.invoiceDate,
      });
      if (
        blockOnDuplicate
        && duplicateScan.scan_available === true
        && !duplicateScan.skipped_no_eur_amount
        && duplicateScan.suspects.length > 0
      ) {
        return fail("possible_duplicate_posting", `Possible duplicate bank posting: journal(s) ${duplicateScan.suspects.map(s => s.journal_id).join(", ")}.`, "never");
      }

      let result;
      try {
        result = await this.api.purchaseInvoices.createAndSetTotals(invoiceData, input.vatPrice, input.grossPrice, isVatReg);
      } catch (error: unknown) {
        if (error instanceof InvoiceCreationError) {
          // Thrown only AFTER the invoice exists (it carries the id). The draft
          // is still in e-arveldaja — possibly with wrong invoice-level totals,
          // since automatic invalidation is what failed here.
          return fail("invoice_creation_failed", error.message, "never", {
            mutationOccurred: true,
            mutatedObjects: [{ type: "purchase_invoice", id: error.invoiceId }],
          });
        }
        throw error;
      }
      if (!result.id) {
        // Same post-mutation shape: the create call returned without an id, so
        // a record may exist that we cannot name.
        return fail("invoice_id_missing", "Purchase invoice was created but no invoice ID was returned.", "never", {
          mutationOccurred: true,
        });
      }

      // APPROVAL ONE (create + upload). Upload failure invalidates the draft.
      try {
        await this.api.purchaseInvoices.uploadDocument(result.id, material.fileName, material.contentsBase64);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await this.api.purchaseInvoices.invalidate(result.id);
        } catch (invalidateError: unknown) {
          const invalidateMessage = invalidateError instanceof Error ? invalidateError.message : String(invalidateError);
          return fail("document_upload_failed", `Purchase invoice ${result.id} was created but source document upload failed: ${message}. Automatic invalidation also failed: ${invalidateMessage}`, "never", {
            mutationOccurred: true,
            mutatedObjects: [{ type: "purchase_invoice", id: result.id }],
          });
        }
        return fail("document_upload_failed", `Purchase invoice ${result.id} was created but source document upload failed and the draft was invalidated: ${message}`, "never", {
          mutationOccurred: true,
          mutatedObjects: [{ type: "purchase_invoice", id: result.id }],
        });
      }

      logAudit({
        tool: "process_accounting_document", action: "CREATED", entity_type: "purchase_invoice",
        entity_id: result.id,
        summary: `Created purchase invoice "${invoiceNumber}" from document`,
        details: {
          supplier_name: supplierName, invoice_number: invoiceNumber,
          invoice_date: input.invoiceDate, total_vat: input.vatPrice, total_gross: input.grossPrice,
          items: items.map(i => ({ title: i.custom_title, cl_purchase_articles_id: i.cl_purchase_articles_id, total_net_price: i.total_net_price })),
          file_name: material.fileName,
        },
      });
      logAudit({
        tool: "process_accounting_document", action: "UPLOADED", entity_type: "purchase_invoice",
        entity_id: result.id,
        summary: `Uploaded document to purchase invoice ${result.id}`,
        details: { file_name: material.fileName },
      });

      // Advisory duplicate candidate (invoice already created above). The op
      // exposes the STRUCTURED scan + candidate UNWRAPPED; the guided façade —
      // the sole wrapUntrustedOcr site — formats the warning lines and wraps
      // the untrusted journal titles there (F-RESOLVER-FACADE-WRAP).
      const duplicateCandidate: DuplicatePostingCandidate = {
        accountId: -1, dimensionId: null, amount: grossAmountEur ?? 0, direction: "C", date: input.invoiceDate,
      };

      // SECOND plan (Step 3): a fresh handle bound to {invoiceId} for the
      // SEPARATE confirm/link step. The op NEVER confirms/registers here.
      let confirmPlanHandle: string | undefined;
      try {
        confirmPlanHandle = this.runtimeSafetyContext.planStore.issue(ACCOUNTING_DOCUMENT_CONFIRM_DOMAIN, {
          normalizedArgs: { invoice_id: result.id },
          sourceIdentities: [],
          liveSnapshot: { invoice_id: result.id },
          commands: [{ id: "accounting-document-confirm", category: "purchase_invoice_confirm", reviewProjection: { invoice_id: result.id } }],
          counts: {},
          totals: {},
          exclusions: [],
          reviews: [],
          privatePayload: { invoice_id: result.id },
        });
      } catch {
        // Fail-safe: the invoice already exists; a plan-mint failure degrades to
        // no confirm handle rather than failing a completed mutation.
        confirmPlanHandle = undefined;
      }

      const execution: AccountingDocumentExecution = {
        createdInvoiceId: result.id,
        documentUploaded: true,
        result,
        duplicateScan,
        duplicateCandidate,
        ...(duplicateScan.suspects.length > 0 ? { possibleDuplicatePostings: duplicateScan.suspects } : {}),
        ...(confirmPlanHandle ? { confirmPlan: { planHandle: confirmPlanHandle, invoiceId: result.id } } : {}),
      };
      return ok(execution);
    } finally {
      await material.cleanup();
    }
  }

  // Step 3 — the SEPARATE confirm/link step. Consumes the confirm plan minted by
  // create (ACCOUNTING_DOCUMENT_CONFIRM_DOMAIN) and registers the DRAFT invoice.
  // Confirm operates purely on the reviewed invoice id: it NEVER re-reads the
  // source or re-runs extraction. Mirrors the consume-once + plan-drift-binding
  // template in src/sales/invoice-operations.ts execute().
  async confirmDraft(input: ConfirmAccountingDocumentInput): Promise<OperationOutcome<AccountingDocumentConfirmation>> {
    // Consume the reviewed confirm plan (consume-once). A missing/replayed/invalid
    // handle is a HARD fail-closed error — the plan handle is NOT itself approval.
    if (input.planHandle === undefined) {
      return fail("plan_handle_required", "mode='confirm' requires the plan_handle from the create step's confirm_plan.", "never");
    }
    let storedPlan;
    try {
      storedPlan = this.runtimeSafetyContext.planStore.consume(input.planHandle, ACCOUNTING_DOCUMENT_CONFIRM_DOMAIN);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "plan_handle_invalid";
      return fail(code, "The reviewed confirm plan could not be consumed.", "never");
    }

    // Plan-drift binding: the confirm plan's normalizedArgs is { invoice_id }.
    // Bind the consumed plan to the requested invoice_id — without this, one
    // approved create's confirm handle could confirm an arbitrary invoice id.
    // Rejected with ZERO API side effect BEFORE any register call.
    if (canonicalPlanJson(storedPlan.normalizedArgs) !== canonicalPlanJson({ invoice_id: input.invoiceId })) {
      return fail("plan_drift", "The reviewed confirm plan no longer matches the requested invoice_id.", "never");
    }

    // Register via the same API confirm_purchase_invoice uses (PATCH .../register).
    const result = await this.api.purchaseInvoices.confirm(input.invoiceId);
    logAudit({
      tool: "process_accounting_document", action: "CONFIRMED", entity_type: "purchase_invoice",
      entity_id: input.invoiceId,
      summary: `Confirmed purchase invoice ${input.invoiceId} from document`,
      details: {},
    });

    // Best-effort confirm receipt: read the registered invoice back so the
    // ledger-affecting approval names the supplier + gross, not a bare id.
    // Reading the stored invoice entity is trusted ledger state (NOT a re-read of
    // the OCR source), and it is FAIL-SAFE — the registration already succeeded,
    // so a read-back error degrades to an id-only receipt, never a failure.
    let echoedSupplierName: string | undefined;
    let echoedGross: number | undefined;
    let echoedCurrency: string | undefined;
    let echoedBaseGross: number | undefined;
    try {
      const registered = await this.api.purchaseInvoices.get(input.invoiceId);
      echoedSupplierName = registered.client_name !== undefined ? desandboxText(registered.client_name) : undefined;
      echoedGross = registered.gross_price;
      echoedCurrency = registered.cl_currencies_id;
      echoedBaseGross = registered.base_gross_price;
    } catch {
      echoedSupplierName = undefined;
      echoedGross = undefined;
      echoedCurrency = undefined;
      echoedBaseGross = undefined;
    }
    return ok({
      confirmedInvoiceId: input.invoiceId,
      status: "CONFIRMED",
      mutationOccurred: true,
      result,
      ...(echoedSupplierName !== undefined ? { echoedSupplierName } : {}),
      ...(echoedGross !== undefined ? { echoedGross } : {}),
      ...(echoedCurrency !== undefined ? { echoedCurrency } : {}),
      ...(echoedBaseGross !== undefined ? { echoedBaseGross } : {}),
    });
  }
}

export function createAccountingDocumentOperations(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
): AccountingDocumentOperations {
  return new AccountingDocumentOperationsImpl(api, runtimeSafetyContext);
}
