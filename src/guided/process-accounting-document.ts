import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { batch, create as createAnnotation } from "../annotations.js";
import { toMcpJson, wrapUntrustedOcr } from "../mcp-json.js";
import { type ApiContext, coerceId, jsonObjectArrayInput } from "../tools/crud-tools.js";
import { assertRuntimeSafetyContext, type RuntimeSafetyContext } from "../runtime-safety-context.js";
import {
  captureFileInputSnapshot,
  FileInputSnapshotError,
  type FileInputSnapshot,
  type FileInputSource,
} from "../file-input-snapshot.js";
import { FILE_REFERENCE_OPERATIONS } from "../file-reference-store.js";
import { createAccountingDocumentOperations } from "../documents/operations.js";
import { formatDuplicatePostingWarnings } from "../bank-posting-duplicate-guard.js";
import type { AccountingDocumentPreview } from "../documents/types.js";
import type { Resolution } from "../resolution/types.js";
import type { SupplierRef } from "../resolution/supplier-default-resolution.js";
import type { Elicitor } from "../elicitation.js";

// GUIDED FAÇADE. `process_accounting_document` unifies the single-document
// purchase-invoice booking flow (extract → validate → resolve supplier → check
// duplicates → suggest booking → create → confirm) behind ONE guided-visible
// tool over the typed AccountingDocumentOperations. It captures the immutable
// source ONCE under the receipt_input operation and threads the snapshot by
// identity. It calls NO MCP handler, never parses an MCP response, and never
// surfaces a delegated granular tool name/args. Untrusted OCR / supplier text is
// OCR-sandbox-wrapped at THIS boundary (F-RESOLVER-FACADE-WRAP); the typed op and
// resolvers stay unwrapped. The compact preview carries NO raw OCR.

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const INVOICE_DOCUMENT_MAX_FILE_SIZE = 50 * 1024 * 1024;
const INVOICE_DOCUMENT_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png"];

function textResult(payload: Record<string, unknown>, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: toMcpJson(payload) }],
  };
}

// F-RESOLVER-FACADE-WRAP: the pure resolver returns a question / choice labels
// embedding supplier text; wrap them HERE, at the façade boundary.
function supplierNeedsInput(resolution: Exclude<Resolution<SupplierRef>, { status: "resolved" }>) {
  if (resolution.status === "ambiguous") {
    return {
      status: "needs_input" as const,
      category: "supplier_resolution_required",
      question: wrapUntrustedOcr(resolution.question),
      choices: resolution.choices.map(choice => ({ id: choice.id, label: wrapUntrustedOcr(choice.label) })),
    };
  }
  return {
    status: "needs_input" as const,
    category: "supplier_resolution_required",
    question: wrapUntrustedOcr(resolution.question),
  };
}

// Compact, OCR-sandboxed projection of the typed preview. NO raw OCR text; only
// structured fields, with every untrusted supplier/OCR string wrapped here.
function renderPreview(preview: AccountingDocumentPreview) {
  const fields = preview.extraction.fields as Record<string, unknown>;
  const supplier = preview.supplierResolution.status === "resolved"
    ? {
        status: "resolved" as const,
        client_id: preview.supplierResolution.value.client.id,
        name: wrapUntrustedOcr(preview.supplierResolution.value.client.name ?? undefined),
        match_type: preview.supplierResolution.value.match_type,
      }
    : supplierNeedsInput(preview.supplierResolution);

  const duplicate = preview.duplicate as {
    candidate_duplicate_risk?: boolean;
    candidate_invoice_number_matches?: { count?: number };
    candidate_same_amount_date_matches?: { count?: number };
    candidate_invalidated_matches?: { count?: number };
  };

  const proposedBooking = preview.proposedBooking
    ? {
        supplier_id: preview.proposedBooking.supplier_id,
        tax_notes: preview.proposedBooking.tax_notes,
        dimension_notes: preview.proposedBooking.dimension_notes,
        past_invoices: preview.proposedBooking.past_invoices.map(inv => ({
          ...inv,
          items: inv.items?.map(item => ({ ...item, custom_title: wrapUntrustedOcr(item.custom_title ?? undefined) })),
        })),
      }
    : undefined;

  const status = supplier.status === "needs_input" || preview.blockers.length > 0
    ? "needs_input"
    : "ready_for_approval";

  return {
    summary: {
      status,
      plan_handle: preview.planHandle,
      supplier,
      extraction: {
        source_sha256: preview.extraction.source_sha256,
        page_count: preview.extraction.page_count,
        ...(preview.extraction.min_ocr_confidence !== undefined ? { min_ocr_confidence: preview.extraction.min_ocr_confidence } : {}),
        ...(preview.extraction.partial_ocr_failure ? { partial_ocr_failure: true } : {}),
        confidence_signals: preview.extraction.confidence_signals,
        supplier_name: wrapUntrustedOcr((fields.supplier_name as string | undefined) ?? undefined),
        description: wrapUntrustedOcr((fields.description as string | undefined) ?? undefined),
        supplier_reg_code: fields.supplier_reg_code,
        supplier_vat_no: fields.supplier_vat_no,
        invoice_number: fields.invoice_number,
        invoice_date: fields.invoice_date,
        due_date: fields.due_date,
        total_net: fields.total_net,
        total_vat: fields.total_vat,
        total_gross: fields.total_gross,
        currency: fields.currency,
        warnings: preview.extraction.warnings,
        // Compact extraction-quality evidence only (no raw OCR text / no
        // raw-text field references). Full text is only on the advanced path.
        extraction_quality: {
          recommended_manual_review: preview.extraction.llm_fallback.recommended,
          confidence: preview.extraction.llm_fallback.confidence,
          missing_required_fields: preview.extraction.llm_fallback.missing_required_fields,
        },
      },
      vat_validation: preview.vatValidation,
      duplicate: {
        candidate_duplicate_risk: Boolean(duplicate.candidate_duplicate_risk),
        candidate_invoice_number_matches: duplicate.candidate_invoice_number_matches?.count ?? 0,
        candidate_same_amount_date_matches: duplicate.candidate_same_amount_date_matches?.count ?? 0,
        candidate_invalidated_matches: duplicate.candidate_invalidated_matches?.count ?? 0,
      },
      ...(proposedBooking ? { proposed_booking: proposedBooking } : {}),
      ...(preview.possibleDuplicatePostings && preview.possibleDuplicatePostings.length > 0
        ? {
            possible_duplicate_postings: preview.possibleDuplicatePostings.map(s => ({
              journal_id: s.journal_id,
              journal_title: wrapUntrustedOcr(s.journal_title) ?? "",
              date: s.date,
              amount: s.amount,
            })),
          }
        : {}),
      blockers: preview.blockers,
      warnings: preview.warnings,
      next_step: status === "ready_for_approval"
        ? "Review this preview. After explicit approval, call process_accounting_document with mode='create' and this plan_handle to create the DRAFT invoice; confirm it separately afterward."
        : "Resolve the flagged items (supplier/validation) before booking.",
    },
    mutation_occurred: false,
  };
}

interface DocArgs {
  mode?: "prepare" | "create";
  file_ref?: string;
  file_path?: string;
  plan_handle?: string;
  source_sha256?: string;
  supplier_client_id?: number;
  invoice_number?: string;
  invoice_date?: string;
  journal_date?: string;
  term_days?: number;
  items?: unknown;
  vat_price?: number;
  gross_price?: number;
  liability_accounts_id?: number;
  notes?: string;
  ref_number?: string;
  bank_account_no?: string;
  currency?: string;
  currency_rate?: number;
  base_net_price?: number;
  base_vat_price?: number;
  base_gross_price?: number;
  block_on_duplicate?: boolean;
}

export interface ProcessAccountingDocumentDeps {
  /** Capability-aware elicitor. Absent (tests) ⇒ text needs_input only. */
  elicit?: Elicitor;
}

export function registerProcessAccountingDocumentTool(
  server: McpServer,
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  deps: ProcessAccountingDocumentDeps = {},
): void {
  assertRuntimeSafetyContext(runtimeSafetyContext);
  const { elicit } = deps;
  const operations = createAccountingDocumentOperations(api, runtimeSafetyContext);

  registerTool(server,
    "process_accounting_document",
    "Unified single-document purchase-invoice entry point. Give it one supplier invoice (PDF/JPG/PNG) and it extracts the data, validates totals, safely resolves the supplier, checks duplicate risk, and proposes a booking. Use mode='prepare' (default) to preview and get a plan handle; after explicit approval use mode='create' with that plan handle to create the DRAFT invoice and upload the document. Confirmation is a separate, later step. If the supplier is uniquely identifiable it resolves automatically.",
    {
      mode: z.enum(["prepare", "create"]).optional().describe("Workflow phase. Defaults to prepare (preview)."),
      file_ref: z.string().optional().describe("Opaque Accounting Inbox receipt_input file reference. Provide exactly one of file_ref or file_path."),
      file_path: z.string().optional().describe("Advanced: absolute path / base64 input to the invoice document. Provide exactly one of file_ref or file_path."),
      plan_handle: z.string().optional().describe("Execution-plan handle from the reviewed preview. Required for mode='create'."),
      source_sha256: z.string().optional().describe("mode='create': the source_sha256 from the reviewed preview; binds the booking to the reviewed bytes."),
      supplier_client_id: coerceId.optional().describe("mode='create': the resolved supplier client ID."),
      invoice_number: z.string().optional().describe("mode='create': invoice number."),
      invoice_date: z.string().optional().describe("mode='create': invoice date (YYYY-MM-DD)."),
      journal_date: z.string().optional().describe("mode='create': turnover/booking date (YYYY-MM-DD)."),
      term_days: z.number().optional().describe("mode='create': payment term days."),
      items: jsonObjectArrayInput.optional().describe("mode='create': reviewed invoice items."),
      vat_price: z.number().optional().describe("mode='create': EXACT total VAT from the invoice; never recalculate."),
      gross_price: z.number().optional().describe("mode='create': EXACT total gross from the invoice; never recalculate."),
      liability_accounts_id: z.number().optional().describe("mode='create': liability account (default 2310)."),
      notes: z.string().optional().describe("mode='create': optional notes. Do NOT use the source document filename."),
      ref_number: z.string().optional().describe("mode='create': reference number."),
      bank_account_no: z.string().optional().describe("mode='create': supplier bank account."),
      currency: z.string().optional().describe("mode='create': currency code (default EUR)."),
      currency_rate: z.number().positive().optional().describe("mode='create': EUR per 1 foreign unit; required when currency != EUR."),
      base_net_price: z.number().optional().describe("mode='create': EUR equivalent of net_price."),
      base_vat_price: z.number().optional().describe("mode='create': EUR equivalent of vat_price."),
      base_gross_price: z.number().optional().describe("mode='create': actual settled EUR gross total."),
      block_on_duplicate: z.boolean().optional().describe("mode='create': refuse creation when the cash outflow looks like an already-booked duplicate (default false: warn only)."),
    },
    { ...createAnnotation, ...batch, openWorldHint: true, title: "Process Accounting Document" },
    async (args: DocArgs) => {
      const mode = args.mode ?? "prepare";
      if (args.invoice_date && !ISO_DATE_REGEX.test(args.invoice_date)) {
        return textResult({ error: "invoice_date must be YYYY-MM-DD", category: "invalid_date", mutation_occurred: false }, true);
      }

      const source: FileInputSource = {
        ...(args.file_path !== undefined ? { file_path: args.file_path } : {}),
        ...(args.file_ref !== undefined ? { file_ref: args.file_ref } : {}),
      };

      // CAPTURE ONCE under the receipt_input operation. A receipt_input ref
      // resolves only here; a camt_input/wise_input/bank_input ref cannot, so the
      // op-mismatch guard fires and this rejects without any second read.
      let snapshot: FileInputSnapshot;
      try {
        snapshot = await captureFileInputSnapshot(source, {
          runtimeSafetyContext,
          operation: FILE_REFERENCE_OPERATIONS.receipt,
          allowedExtensions: INVOICE_DOCUMENT_EXTENSIONS,
          maxSize: INVOICE_DOCUMENT_MAX_FILE_SIZE,
        });
      } catch (error) {
        if (error instanceof FileInputSnapshotError) {
          return textResult({ error: error.message, category: error.code, mutation_occurred: false }, true);
        }
        throw error;
      }

      if (mode === "prepare") {
        const outcome = await operations.prepare({
          source,
          snapshot,
          ...(args.supplier_client_id !== undefined ? { overrides: { supplier_client_id: args.supplier_client_id } } : {}),
        });
        if (!outcome.ok) return textResult({ error: outcome.error.message, category: outcome.error.code, mutation_occurred: false }, true);

        // Capability-aware supplier elicitation: when the supplier is ambiguous
        // and no override was supplied, offer the bounded choice as a form. On an
        // answer, RE-RUN prepare with the chosen supplier_client_id override (the
        // answer is never trusted straight into a booking); on an unsupported
        // client, fall through to the existing compact needs_input preview. No
        // secret is ever elicited, and no supplier default is persisted.
        let preview = outcome.value;
        const supplierResolution = preview.supplierResolution;
        // Only offer a form when the resolver produced BOUNDED choices. Supplier
        // resolution currently surfaces `ambiguous` as an empty-choice "resolve
        // manually" conflict (or `not_found`) — nothing to pick from — so this is
        // dormant for suppliers and falls through to the existing needs_input
        // question. It engages if/when a resolver offers concrete candidates.
        if (
          elicit &&
          args.supplier_client_id === undefined &&
          supplierResolution.status === "ambiguous" &&
          supplierResolution.choices.length > 0
        ) {
          const choices = supplierResolution.choices;
          const elicited = await elicit({
            message: "Which supplier is this invoice from?",
            fields: {
              supplier_client_id: {
                type: "enum",
                title: "Supplier",
                choices: choices.map(choice => ({ const: choice.id, title: wrapUntrustedOcr(choice.label) ?? choice.id })),
              },
            },
            required: ["supplier_client_id"],
            needsInput: supplierNeedsInput(supplierResolution),
          });
          if (elicited.kind === "answered") {
            const chosenRaw = elicited.content.supplier_client_id;
            const chosen = typeof chosenRaw === "string" || typeof chosenRaw === "number" ? Number(chosenRaw) : NaN;
            if (Number.isInteger(chosen) && choices.some(c => c.id === String(chosen))) {
              const reRun = await operations.prepare({ source, snapshot, overrides: { supplier_client_id: chosen } });
              if (reRun.ok) preview = reRun.value;
            }
          }
          // declined / unsupported ⇒ keep the original preview (its needs_input
          // question is the text fallback).
        }

        const rendered = renderPreview(preview);
        return textResult(rendered.summary.status === "needs_input"
          ? { status: "needs_input", ...rendered }
          : rendered);
      }

      // mode === "create"
      const missing: string[] = [];
      if (args.supplier_client_id === undefined) missing.push("supplier_client_id");
      if (args.invoice_number === undefined) missing.push("invoice_number");
      if (args.invoice_date === undefined) missing.push("invoice_date");
      if (args.journal_date === undefined) missing.push("journal_date");
      if (args.term_days === undefined) missing.push("term_days");
      if (args.items === undefined) missing.push("items");
      if (args.source_sha256 === undefined) missing.push("source_sha256");
      if (missing.length > 0) {
        return textResult({ error: `Missing required fields for mode='create': ${missing.join(", ")}`, category: "missing_required_fields", mutation_occurred: false }, true);
      }

      const outcome = await operations.create({
        source,
        snapshot,
        planHandle: args.plan_handle,
        sourceSha256: args.source_sha256!,
        supplierClientId: args.supplier_client_id!,
        invoiceNumber: args.invoice_number!,
        invoiceDate: args.invoice_date!,
        journalDate: args.journal_date!,
        termDays: args.term_days!,
        items: args.items,
        vatPrice: args.vat_price,
        grossPrice: args.gross_price,
        liabilityAccountsId: args.liability_accounts_id,
        notes: args.notes,
        refNumber: args.ref_number,
        bankAccountNo: args.bank_account_no,
        currency: args.currency,
        currencyRate: args.currency_rate,
        baseNetPrice: args.base_net_price,
        baseVatPrice: args.base_vat_price,
        baseGrossPrice: args.base_gross_price,
        blockOnDuplicate: args.block_on_duplicate,
      });
      if (!outcome.ok) {
        return textResult({ error: outcome.error.message, category: outcome.error.code, mutation_occurred: outcome.error.code === "document_upload_failed" }, true);
      }
      const execution = outcome.value;
      // F-RESOLVER-FACADE-WRAP: format the STRUCTURED duplicate scan into
      // warning lines HERE, wrapping each untrusted journal title with
      // wrapUntrustedOcr — the op carries only unwrapped domain data. Mirrors
      // create_purchase_invoice_from_pdf: skipped_no_eur_amount keeps its own
      // safe note (scan_available stays true there, so the formatter would emit
      // no line for it).
      const warnings = execution.duplicateScan.skipped_no_eur_amount
        ? [execution.duplicateScan.scan_note ?? "Duplicate scan skipped: no EUR-equivalent gross amount available."]
        : formatDuplicatePostingWarnings(execution.duplicateScan, execution.duplicateCandidate, t => wrapUntrustedOcr(t) ?? "");
      return textResult({
        result: {
          created_invoice_id: execution.createdInvoiceId,
          document_uploaded: execution.documentUploaded,
          status: execution.result.status,
        },
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(execution.possibleDuplicatePostings && execution.possibleDuplicatePostings.length > 0
          ? {
              possible_duplicate_postings: execution.possibleDuplicatePostings.map(s => ({
                journal_id: s.journal_id,
                journal_title: wrapUntrustedOcr(s.journal_title) ?? "",
                date: s.date,
                amount: s.amount,
              })),
            }
          : {}),
        note: "Purchase invoice created as DRAFT and the source document uploaded. This is APPROVAL ONE (create/upload). Confirmation is a SEPARATE step — review, then confirm the invoice using its confirm plan handle below.",
        ...(execution.confirmPlan
          ? { confirm_plan: { plan_handle: execution.confirmPlan.planHandle, invoice_id: execution.confirmPlan.invoiceId } }
          : {}),
        mutation_occurred: true,
      });
    },
  );
}
