import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactReviewItem, CompactWarning, OperationOutcome } from "../operation-outcome.js";
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
import { canonicalPlanJson } from "../tools/camt-plan.js";
import type { CreatePurchaseInvoiceData } from "../types/api.js";
import type {
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

function fail<T>(code: string, message: string, retry: "never" | "safe" | "unknown"): OperationOutcome<T> {
  return { ok: false, error: { code, message, retry }, blockers: [] };
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

class AccountingDocumentOperationsImpl implements AccountingDocumentOperations {
  constructor(
    private readonly api: ApiContext,
    private readonly runtimeSafetyContext: RuntimeSafetyContext,
  ) {}

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

      // Mint the immutable execution plan the operator reviews before create.
      const normalizedArgs: PlanRecord = {
        ...(input.source.file_ref !== undefined ? { file_ref: input.source.file_ref } : {}),
        ...(input.source.file_ref === undefined && input.source.file_path !== undefined && !input.source.file_path.toLowerCase().startsWith("base64:")
          ? { file_path: input.source.file_path }
          : {}),
        source_sha256: material.source_sha256,
      };
      const planProjection: PlanData = {
        source_sha256: material.source_sha256,
        supplier_resolved: resolvedClientId !== undefined,
        vat_valid: vatValid,
        candidate_duplicate_risk: Boolean((duplicate as { candidate_duplicate_risk?: unknown }).candidate_duplicate_risk),
      };
      const planInput: ExecutionPlanInput = {
        normalizedArgs,
        sourceIdentities: [{ ...snapshot.identity } as unknown as PlanRecord],
        liveSnapshot: planProjection,
        commands: [{ id: "accounting-document-create", category: "purchase_invoice_create", reviewProjection: planProjection }],
        counts: { blockers: blockers.length, warnings: warnings.length },
        totals: {
          total_net: extracted.total_net ?? 0,
          total_vat: extracted.total_vat ?? 0,
          total_gross: extracted.total_gross ?? 0,
        },
        exclusions: [],
        reviews: [],
        privatePayload: { source_sha256: material.source_sha256 },
      };
      const planHandle = this.runtimeSafetyContext.planStore.issue(ACCOUNTING_DOCUMENT_PLAN_DOMAIN, planInput);

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
        planHandle,
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
    try {
      this.runtimeSafetyContext.planStore.consume(input.planHandle, ACCOUNTING_DOCUMENT_PLAN_DOMAIN);
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
      const supplier = await this.api.clients.get(input.supplierClientId);
      const supplierName = desandboxText(supplier.name);
      const isVatReg = await isCompanyVatRegistered(this.api);
      const purchaseArticles = await getPurchaseArticlesWithVat(this.api);
      const rawItems = desandboxAllStrings(parsePurchaseInvoiceItems(input.items));
      const items = rawItems.map(item => applyPurchaseVatDefaults(purchaseArticles, item, isVatReg));

      const [accounts, accountDimensions] = await Promise.all([
        this.api.readonly.getAccounts(),
        this.api.readonly.getAccountDimensions(),
      ]);
      const dimErrors = validateItemDimensions(items, accounts, accountDimensions);
      if (dimErrors.length > 0) {
        return fail("account_validation_failed", `Account validation failed: ${dimErrors.join("; ")}`, "never");
      }

      const currencyCode = (input.currency ?? "EUR").toUpperCase();
      if (currencyCode !== "EUR" && (input.currencyRate === undefined || input.currencyRate === null)) {
        return fail("currency_rate_required", `currency_rate is required when currency="${currencyCode}".`, "never");
      }

      // Cross-mechanism intake duplicate guard — BEFORE any invoice/document
      // mutation. EUR figure: the actual settled EUR gross when known, else the
      // nominal gross only for an EUR-native invoice — never a guessed conversion.
      const grossAmountEur = input.baseGrossPrice ?? (currencyCode === "EUR" ? input.grossPrice : undefined);
      const duplicateScan = await checkIntakeCashDuplicates(this.api, {
        grossAmountEur,
        invoiceDate: input.invoiceDate,
      });
      if (
        input.blockOnDuplicate === true
        && duplicateScan.scan_available === true
        && !duplicateScan.skipped_no_eur_amount
        && duplicateScan.suspects.length > 0
      ) {
        return fail("possible_duplicate_posting", `Possible duplicate bank posting: journal(s) ${duplicateScan.suspects.map(s => s.journal_id).join(", ")}.`, "never");
      }

      // Write-boundary canonicalization: strip any sandbox markers a wrapped
      // preview value could have carried into these free-text fields (matches
      // the sibling create_purchase_invoice_from_pdf desandboxAllStrings up
      // front). Only defined strings are desandboxed; undefined passes through.
      const invoiceNumber = desandboxText(input.invoiceNumber);
      const refNumber = input.refNumber === undefined ? undefined : desandboxText(input.refNumber);
      const bankAccountNo = input.bankAccountNo === undefined ? undefined : desandboxText(input.bankAccountNo);
      const notes = input.notes === undefined ? undefined : desandboxText(input.notes);

      const invoiceData: CreatePurchaseInvoiceData = {
        clients_id: input.supplierClientId,
        client_name: supplierName,
        number: invoiceNumber,
        create_date: input.invoiceDate,
        journal_date: input.journalDate,
        term_days: input.termDays,
        cl_currencies_id: currencyCode,
        currency_rate: input.currencyRate,
        base_net_price: input.baseNetPrice,
        base_vat_price: input.baseVatPrice,
        base_gross_price: input.baseGrossPrice,
        liability_accounts_id: input.liabilityAccountsId ?? DEFAULT_LIABILITY_ACCOUNT,
        bank_ref_number: refNumber,
        bank_account_no: bankAccountNo,
        notes: tagNotes(notes),
        items,
      };

      let result;
      try {
        result = await this.api.purchaseInvoices.createAndSetTotals(invoiceData, input.vatPrice, input.grossPrice, isVatReg);
      } catch (error: unknown) {
        if (error instanceof InvoiceCreationError) {
          return fail("invoice_creation_failed", error.message, "never");
        }
        throw error;
      }
      if (!result.id) {
        return fail("invoice_id_missing", "Purchase invoice was created but no invoice ID was returned.", "never");
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
          return fail("document_upload_failed", `Purchase invoice ${result.id} was created but source document upload failed: ${message}. Automatic invalidation also failed: ${invalidateMessage}`, "never");
        }
        return fail("document_upload_failed", `Purchase invoice ${result.id} was created but source document upload failed and the draft was invalidated: ${message}`, "never");
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
    return ok({ confirmedInvoiceId: input.invoiceId, status: "CONFIRMED", mutationOccurred: true, result });
  }
}

export function createAccountingDocumentOperations(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
): AccountingDocumentOperations {
  return new AccountingDocumentOperationsImpl(api, runtimeSafetyContext);
}
