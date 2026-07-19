import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { open, opendir, realpath, stat } from "fs/promises";
import { basename, extname, resolve } from "path";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { canonicalBusinessText, toMcpJson } from "../mcp-json.js";
import { desandboxText, sandboxExternalText } from "../external-text-renderer.js";
import { getToolExposureConfig, type ToolExposureConfig } from "../config.js";
import { arrayAt, isRecord, numberAt, recordAt, stringArrayAt, stringAt } from "../record-utils.js";
import { batch, mutate, readOnly } from "../annotations.js";
import { getAllowedRoots, isPathWithinRoot, resolveFilePath } from "../file-validation.js";
import { logAudit } from "../audit-log.js";
import { roundMoney } from "../money.js";
import type { AccountDimension, BankAccount, Transaction } from "../types/api.js";
import { jsonObjectInput, parseJsonObject, type ApiContext } from "./crud-tools.js";
import { DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT, DEFAULT_OWNER_PAYABLE_ACCOUNT } from "../accounting-defaults.js";
import { camtDuplicateStructuredCorroborators, registerCamtImportTools, storedBankReferenceLookupKey } from "./camt-import.js";
import { registerWiseImportTools } from "./wise-import.js";
import { registerReceiptInboxTools } from "./receipt-inbox.js";
import { registerBankReconciliationTools } from "./bank-reconciliation.js";
import type { ReviewGuidance } from "../estonian-accounting-guidance.js";
import {
  getAccountingRulesPath,
  hasAnyAutoBookingRuleActionField,
  normalizeAutoBookingRuleMatch,
  saveAutoBookingRule,
} from "../accounting-rules.js";
import { remapHiddenGranularTool, remapHiddenGranularWorkflowEnvelope, workflowFromAccountingInboxPayload } from "../workflow-response.js";
import {
  runAccountingInboxDryRunPipeline,
  type AutopilotInternalToolHandler,
} from "./accounting-inbox-autopilot-service.js";
import { assertRuntimeSafetyContext, type RuntimeSafetyContext } from "../runtime-safety-context.js";
import { FILE_REFERENCE_OPERATIONS } from "../file-reference-store.js";

const MIN_AUTO_BOOKING_RULE_MATCH_LENGTH = 3;

// The review types the resolver knows how to plan an action for. Surfaced as a
// fixed list on the unsupported-review-type contract so a caller that emitted a
// foreign review_type learns which types are actionable — without ever echoing
// the (untrusted) foreign value or the caller-supplied id back into the
// unwrapped resolution.
const SUPPORTED_REVIEW_TYPES = [
  "receipt_review",
  "classification_group",
  "camt_possible_duplicate",
] as const;

const RECEIPT_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png"]);
const DEFAULT_SCAN_DEPTH = 2;
const MAX_SCAN_DEPTH = 4;
export const MAX_SCANNED_FILES = 1500;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
]);
const AUTO_BOOKING_CATEGORIES = [
  "saas_subscriptions",
  "bank_fees",
  "tax_payments",
  "salary_payroll",
  "owner_transfers",
  "card_purchases",
  "revenue_without_invoice",
  "unknown",
] as const;

interface InboxFileCandidate {
  path: string;
  name: string;
  modified_at: string;
  size_bytes: number;
  detected_iban?: string;
}

interface ReceiptFolderCandidate {
  path: string;
  receipt_file_count: number;
  sample_files: string[];
  last_modified_at?: string;
}

interface BankDimensionCandidate {
  accounts_dimensions_id: number;
  label: string;
  iban?: string;
  match_reason: string;
}

interface RecommendedStep {
  step: number;
  tool: string;
  purpose: string;
  recommended: boolean;
  suggested_args: Record<string, unknown>;
  missing_inputs: string[];
  reason: string;
}

interface InboxQuestion {
  id: string;
  question: string;
  recommendation: string;
  candidates?: BankDimensionCandidate[];
}

interface ScannedFileInfo {
  path: string;
  name: string;
  extension: string;
  modified_at: string;
  size_bytes: number;
}

interface PreparedInboxData {
  workspacePath: string;
  scan: {
    max_depth: number;
    scanned_directories: number;
    scanned_candidate_files: number;
    inspected_entries: number;
    entry_limit: number;
    truncated: boolean;
    continuation_guidance?: string;
  };
  camtFiles: InboxFileCandidate[];
  wiseFiles: InboxFileCandidate[];
  receiptFolders: ReceiptFolderCandidate[];
  defaults: ReturnType<typeof buildBankDefaults>;
  steps: RecommendedStep[];
  questions: InboxQuestion[];
  liveApiDefaultsAvailable: boolean;
}

interface ReviewResolutionResult {
  review_type: "receipt_review" | "classification_group" | "camt_possible_duplicate" | "unknown";
  status: "ready_for_action" | "needs_answers" | "unsupported_review_type";
  recommendation: string;
  compliance_basis: string[];
  unresolved_questions: string[];
  policy_hint?: string;
  suggested_workflow?: string;
  suggested_tools?: string[];
  next_step_summary: string;
  error?: string;
  supported_review_types?: string[];
}

interface ReviewActionPreparationResult {
  status: "needs_answers" | "ready_for_approval" | "no_direct_action";
  recommendation: string;
  unresolved_questions: string[];
  proposed_action?: {
    type: "tool_call" | "rule_save";
    tool: string;
    args: Record<string, unknown>;
    approval_required: boolean;
  };
  suggested_workflow?: string;
  suggested_tools?: string[];
  next_step_summary: string;
}

function dateIso(value: Date): string {
  return value.toISOString();
}

function normalizeIban(value: string | undefined | null): string | undefined {
  const normalized = (value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return normalized || undefined;
}

function extractFirstIban(text: string): string | undefined {
  const match = text.match(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/);
  return normalizeIban(match?.[0]);
}

function isSetupModeApiError(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "mode" in error &&
    (error as { mode?: unknown }).mode === "setup";
}

async function validateWorkspacePath(workspacePath?: string): Promise<string> {
  const resolved = workspacePath ? resolveFilePath(workspacePath) : resolve(process.cwd());
  const real = await realpath(resolved);
  const info = await stat(real);
  if (!info.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${real}`);
  }

  const roots = getAllowedRoots();
  if (!roots.some(root => isPathWithinRoot(real, root))) {
    throw new Error(
      `Workspace path outside allowed directories. Allowed roots: ${roots.join(", ")}. ` +
      "Set EARVELDAJA_ALLOWED_PATHS to override.",
    );
  }

  return real;
}

async function readFileSnippet(filePath: string, maxBytes = 4096): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export interface WorkspaceScanResult {
  files: ScannedFileInfo[];
  scanned_directories: number;
  inspected_entries: number;
  entry_limit: number;
  truncated: boolean;
  continuation_guidance?: string;
}

export async function scanWorkspaceFiles(
  root: string,
  maxDepth: number,
): Promise<WorkspaceScanResult> {
  const files: ScannedFileInfo[] = [];
  let scannedDirectories = 0;
  let inspectedEntries = 0;
  let truncated = false;

  async function walk(current: string, depth: number): Promise<void> {
    if (truncated || inspectedEntries >= MAX_SCANNED_FILES) {
      truncated = true;
      return;
    }
    scannedDirectories += 1;

    // Stream the directory with opendir (lazy, buffered reads) instead of
    // readdir, which would materialize — and, with an added sort, O(n log n)
    // process — the ENTIRE directory before the budget could stop it. Streaming
    // lets a pathologically large directory be abandoned after ~the budget is
    // reached without reading the rest, which is the point of the cap. Entries
    // therefore arrive in filesystem order (no total sort is possible while
    // streaming), so which entries are inspected before truncation is not
    // ordered — acceptable: the finding is about bounding traversal, not
    // selecting a deterministic prefix. The async iterator closes the dir handle
    // on normal completion and on the early `return` below.
    const dir = await opendir(current);
    for await (const entry of dir) {
      // Count EVERY traversed entry against the budget — not only matching
      // candidate files. Otherwise a workspace full of non-matching files never
      // consumes the cap and traversal cost is unbounded.
      if (inspectedEntries >= MAX_SCANNED_FILES) {
        truncated = true;
        return;
      }
      inspectedEntries += 1;

      const entryPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (depth >= maxDepth) continue;
        if (IGNORED_DIRECTORY_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(entryPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      const extension = extname(entry.name).toLowerCase();
      if (![".xml", ".csv", ...RECEIPT_EXTENSIONS].includes(extension)) continue;

      const info = await stat(entryPath);
      files.push({
        path: entryPath,
        name: basename(entryPath),
        extension,
        modified_at: dateIso(info.mtime),
        size_bytes: info.size,
      });
    }
  }

  await walk(root, 0);
  return {
    files,
    scanned_directories: scannedDirectories,
    inspected_entries: inspectedEntries,
    entry_limit: MAX_SCANNED_FILES,
    truncated,
    ...(truncated
      ? { continuation_guidance: "Re-run accounting_inbox with a narrower workspace_path." }
      : {}),
  };
}

function looksLikeCamtFileName(name: string): boolean {
  return /(camt|statement|konto|väljavõte|valjavote)/i.test(name);
}

async function detectCamtFiles(files: ScannedFileInfo[]): Promise<InboxFileCandidate[]> {
  const candidates: InboxFileCandidate[] = [];
  for (const file of files.filter(candidate => candidate.extension === ".xml")) {
    const snippet = await readFileSnippet(file.path);
    const nameLooksRight = looksLikeCamtFileName(file.name);
    if (
      nameLooksRight ||
      /BkToCstmrStmt|urn:iso:std:iso:20022:tech:xsd:camt\.053|<Document/i.test(snippet)
    ) {
      candidates.push({
        path: file.path,
        name: file.name,
        modified_at: file.modified_at,
        size_bytes: file.size_bytes,
        detected_iban: extractFirstIban(snippet),
      });
    }
  }
  return candidates.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}

async function detectWiseCsvFiles(files: ScannedFileInfo[]): Promise<InboxFileCandidate[]> {
  const candidates: InboxFileCandidate[] = [];
  for (const file of files.filter(candidate => candidate.extension === ".csv")) {
    const lowerName = file.name.toLowerCase();
    if (lowerName === "transaction-history.csv" || lowerName.includes("wise")) {
      candidates.push({
        path: file.path,
        name: file.name,
        modified_at: file.modified_at,
        size_bytes: file.size_bytes,
      });
      continue;
    }

    const snippet = await readFileSnippet(file.path, 2048);
    if (
      snippet.includes("Source amount (after fees)") &&
      snippet.includes("Target amount (after fees)") &&
      snippet.includes("Exchange rate")
    ) {
      candidates.push({
        path: file.path,
        name: file.name,
        modified_at: file.modified_at,
        size_bytes: file.size_bytes,
      });
    }
  }
  return candidates.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}

function detectReceiptFolders(files: ScannedFileInfo[]): ReceiptFolderCandidate[] {
  const folders = new Map<string, ReceiptFolderCandidate>();
  for (const file of files) {
    if (!RECEIPT_EXTENSIONS.has(file.extension)) continue;
    const folderPath = resolve(file.path, "..");
    const existing = folders.get(folderPath);
    if (existing) {
      existing.receipt_file_count += 1;
      if (existing.sample_files.length < 5) existing.sample_files.push(file.name);
      if (!existing.last_modified_at || file.modified_at > existing.last_modified_at) {
        existing.last_modified_at = file.modified_at;
      }
    } else {
      folders.set(folderPath, {
        path: folderPath,
        receipt_file_count: 1,
        sample_files: [file.name],
        last_modified_at: file.modified_at,
      });
    }
  }

  return [...folders.values()]
    .sort((a, b) =>
      b.receipt_file_count - a.receipt_file_count ||
      (b.last_modified_at ?? "").localeCompare(a.last_modified_at ?? "")
    );
}

function buildBankDimensionCandidates(
  bankAccounts: BankAccount[],
  accountDimensions: AccountDimension[],
): BankDimensionCandidate[] {
  const dimensionById = new Map<number, AccountDimension>();
  for (const dimension of accountDimensions) {
    if (dimension.id !== undefined && !dimension.is_deleted) {
      dimensionById.set(dimension.id, dimension);
    }
  }

  return bankAccounts
    .filter(account => account.accounts_dimensions_id !== undefined)
    .map((account) => {
      const dimension = account.accounts_dimensions_id !== undefined
        ? dimensionById.get(account.accounts_dimensions_id)
        : undefined;
      return {
        accounts_dimensions_id: account.accounts_dimensions_id!,
        label: account.account_name_est || account.bank_name || dimension?.title_est || `Dimension ${account.accounts_dimensions_id}`,
        iban: account.iban_code ?? account.account_no,
        match_reason: dimension?.title_est
          ? `Linked bank account + dimension title "${dimension.title_est}"`
          : "Linked bank account dimension",
      };
    })
    .filter((candidate, index, all) =>
      all.findIndex(other => other.accounts_dimensions_id === candidate.accounts_dimensions_id) === index
    );
}

function pickSingleCandidateByPattern(
  candidates: BankDimensionCandidate[],
  pattern: RegExp,
): BankDimensionCandidate | undefined {
  const matches = candidates.filter(candidate => pattern.test(candidate.label) || pattern.test(candidate.iban ?? ""));
  return matches.length === 1 ? matches[0] : undefined;
}

function pickSingleCandidateByIban(
  candidates: BankDimensionCandidate[],
  iban: string | undefined,
): BankDimensionCandidate | undefined {
  const normalizedIban = normalizeIban(iban);
  if (!normalizedIban) return undefined;
  const matches = candidates.filter(candidate => normalizeIban(candidate.iban) === normalizedIban);
  return matches.length === 1 ? matches[0] : undefined;
}

function buildBankDefaults(
  bankAccounts: BankAccount[],
  accountDimensions: AccountDimension[],
  overrides: {
    bank_account_dimension_id?: number;
    wise_account_dimension_id?: number;
    receipt_matching_dimension_id?: number;
  },
) {
  const candidates = buildBankDimensionCandidates(bankAccounts, accountDimensions);
  const wiseCandidate = overrides.wise_account_dimension_id !== undefined
    ? candidates.find(candidate => candidate.accounts_dimensions_id === overrides.wise_account_dimension_id)
    : pickSingleCandidateByPattern(candidates, /\bwise\b/i);

  const localBankCandidates = candidates.filter(candidate => candidate.accounts_dimensions_id !== wiseCandidate?.accounts_dimensions_id);
  const uniqueLocalBank = localBankCandidates.length === 1 ? localBankCandidates[0] : undefined;

  const suggestedBankDimensionId = overrides.bank_account_dimension_id ?? uniqueLocalBank?.accounts_dimensions_id;
  const suggestedReceiptDimensionId = overrides.receipt_matching_dimension_id ?? suggestedBankDimensionId;
  const feeDimensions = accountDimensions.filter(dimension =>
    dimension.accounts_id === DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT &&
    !dimension.is_deleted &&
    dimension.id !== undefined
  );
  const suggestedWiseFeeDimensionId = feeDimensions.length === 1 ? feeDimensions[0]!.id : undefined;

  return {
    candidates,
    local_bank_candidates: localBankCandidates,
    wise_candidate: wiseCandidate,
    suggested_bank_dimension_id: suggestedBankDimensionId,
    suggested_receipt_dimension_id: suggestedReceiptDimensionId,
    suggested_wise_dimension_id: wiseCandidate?.accounts_dimensions_id,
    suggested_wise_fee_dimension_id: suggestedWiseFeeDimensionId,
    bank_dimension_from_override: overrides.bank_account_dimension_id !== undefined,
  };
}

function resolveSuggestedCamtDimensionId(
  file: InboxFileCandidate,
  defaults: ReturnType<typeof buildBankDefaults>,
): number | undefined {
  if (defaults.bank_dimension_from_override) {
    return defaults.suggested_bank_dimension_id;
  }

  return pickSingleCandidateByIban(defaults.local_bank_candidates, file.detected_iban)?.accounts_dimensions_id ??
    defaults.suggested_bank_dimension_id;
}

function buildCamtImportReason(
  file: InboxFileCandidate,
  dimensionId: number | undefined,
  defaults: ReturnType<typeof buildBankDefaults>,
): string {
  if (dimensionId === undefined) {
    return "A bank account dimension is still needed before the statement can be imported safely.";
  }

  if (defaults.bank_dimension_from_override) {
    return `Using the explicit bank dimension override ${dimensionId}. Run dry first, then ask for approval before execute=true.`;
  }

  const ibanMatch = pickSingleCandidateByIban(defaults.local_bank_candidates, file.detected_iban);
  if (ibanMatch) {
    return `Matched CAMT statement IBAN ${file.detected_iban} to ${ibanMatch.label} (${dimensionId}). Run dry first, then ask for approval before execute=true.`;
  }

  return `Recommended default bank dimension: ${dimensionId}. Run dry first, then ask for approval before execute=true.`;
}

function buildMissingDimensionQuestion(
  id: string,
  question: string,
  candidates: BankDimensionCandidate[],
): InboxQuestion {
  const topCandidates = candidates.slice(0, 3);
  const recommendation = topCandidates.length === 0
    ? "No clear default was found. Use list_bank_accounts or list_account_dimensions to choose the right bank account dimension."
    : `Recommended default: ${topCandidates[0]!.label} (${topCandidates[0]!.accounts_dimensions_id}).`;
  return {
    id,
    question,
    recommendation,
    candidates: topCandidates.length > 0 ? topCandidates : undefined,
  };
}

export function buildRecommendedSteps(params: {
  camtFiles: InboxFileCandidate[];
  wiseFiles: InboxFileCandidate[];
  receiptFolders: ReceiptFolderCandidate[];
  defaults: ReturnType<typeof buildBankDefaults>;
}): { steps: RecommendedStep[]; questions: InboxQuestion[] } {
  const { camtFiles, wiseFiles, receiptFolders, defaults } = params;
  const steps: RecommendedStep[] = [];
  const questions: InboxQuestion[] = [];
  let stepNumber = 1;

  for (const file of camtFiles) {
    steps.push({
      step: stepNumber++,
      tool: "parse_camt053",
      purpose: "Preview the bank statement safely before importing anything.",
      recommended: true,
      suggested_args: { file_path: file.path },
      missing_inputs: [],
      reason: `Detected CAMT statement ${file.name}. Start with a read-only parse so the user sees what will be imported.`,
    });

    const dimensionId = resolveSuggestedCamtDimensionId(file, defaults);
    const missingInputs = dimensionId === undefined ? ["accounts_dimensions_id"] : [];
    steps.push({
      step: stepNumber++,
      tool: "import_camt053",
      purpose: "Dry-run import of the statement after preview.",
      recommended: dimensionId !== undefined,
      suggested_args: {
        file_path: file.path,
        ...(dimensionId !== undefined ? { accounts_dimensions_id: dimensionId } : {}),
        execute: false,
      },
      missing_inputs: missingInputs,
      reason: buildCamtImportReason(file, dimensionId, defaults),
    });
  }

  if (camtFiles.some(file => resolveSuggestedCamtDimensionId(file, defaults) === undefined)) {
    questions.push(buildMissingDimensionQuestion(
      "camt_accounts_dimensions_id",
      "Which bank account dimension should be used for the detected CAMT statement(s)?",
      defaults.local_bank_candidates,
    ));
  }

  for (const file of wiseFiles) {
    const wiseDimensionId = defaults.suggested_wise_dimension_id;
    const missingInputs = wiseDimensionId === undefined ? ["accounts_dimensions_id"] : [];
    const suggestedArgs: Record<string, unknown> = {
      file_path: file.path,
      execute: false,
    };
    if (wiseDimensionId !== undefined) suggestedArgs.accounts_dimensions_id = wiseDimensionId;
    if (defaults.suggested_wise_fee_dimension_id !== undefined) {
      suggestedArgs.fee_account_dimensions_id = defaults.suggested_wise_fee_dimension_id;
    }

    steps.push({
      step: stepNumber++,
      tool: "import_wise_transactions",
      purpose: "Dry-run import of the Wise CSV.",
      recommended: wiseDimensionId !== undefined,
      suggested_args: suggestedArgs,
      missing_inputs: missingInputs,
      reason: wiseDimensionId !== undefined
        ? `Recommended Wise bank dimension: ${wiseDimensionId}. ${
            defaults.suggested_wise_fee_dimension_id !== undefined
              ? `Fee dimension ${defaults.suggested_wise_fee_dimension_id} also looks safe.`
              : "Wise fees may still need a manual fee dimension if auto-detection is not unique."
          }`
        : "A Wise bank account dimension is still needed before the CSV can be imported safely.",
    });
  }

  if (wiseFiles.length > 0 && defaults.suggested_wise_dimension_id === undefined) {
    questions.push(buildMissingDimensionQuestion(
      "wise_accounts_dimensions_id",
      "Which bank account dimension should be used for the detected Wise CSV?",
      defaults.candidates.filter(candidate => /\bwise\b/i.test(candidate.label)),
    ));
  }

  // Emit one dry-run step per discovered receipt folder, not just the first, so
  // no folder's receipts are silently skipped. Sort by path for a deterministic,
  // reproducible step order (detectReceiptFolders orders by file count, which is
  // fine for picking a "primary" but non-deterministic to depend on for output).
  const sortedReceiptFolders = [...receiptFolders].sort((a, b) => a.path.localeCompare(b.path));
  for (const [folderIndex, folder] of sortedReceiptFolders.entries()) {
    const dimensionId = defaults.suggested_receipt_dimension_id;
    const missingInputs = dimensionId === undefined ? ["accounts_dimensions_id"] : [];
    const folderScope = `Folder ${folderIndex + 1}/${sortedReceiptFolders.length} (${folder.path}): ${folder.receipt_file_count} eligible receipt file(s).`;
    steps.push({
      step: stepNumber++,
      tool: "process_receipt_batch",
      purpose: `Dry-run receipt processing for folder ${folder.path}.`,
      recommended: dimensionId !== undefined,
      suggested_args: {
        folder_path: folder.path,
        ...(dimensionId !== undefined ? { accounts_dimensions_id: dimensionId } : {}),
        execution_mode: "dry_run",
      },
      missing_inputs: missingInputs,
      reason: dimensionId !== undefined
        ? `${folderScope} Recommended receipt matching bank dimension: ${dimensionId}.`
        : `${folderScope} A bank account dimension is still needed to match receipts against outgoing bank transactions.`,
    });
  }

  if (receiptFolders.length > 0 && defaults.suggested_receipt_dimension_id === undefined) {
    questions.push(buildMissingDimensionQuestion(
      "receipt_accounts_dimensions_id",
      "Which bank account dimension should receipts be matched against by default?",
      defaults.local_bank_candidates,
    ));
  }

  if (defaults.suggested_receipt_dimension_id !== undefined) {
    steps.push({
      step: stepNumber++,
      tool: "classify_unmatched_transactions",
      purpose: "Find remaining unmatched expenses after imports and receipt processing.",
      recommended: true,
      suggested_args: {
        accounts_dimensions_id: defaults.suggested_receipt_dimension_id,
      },
      missing_inputs: [],
      reason: "Use this after bank imports and receipt processing are materially clear. The autopilot will defer it automatically if current dry runs still show pending imports, receipt matches, or review-only receipt work.",
    });
  }

  if (defaults.candidates.length >= 2) {
    steps.push({
      step: stepNumber++,
      tool: "reconcile_inter_account_transfers",
      purpose: "Dry-run inter-account transfer cleanup after bank imports.",
      recommended: true,
      suggested_args: {
        execute: false,
      },
      missing_inputs: [],
      reason: "If you import multiple bank sources, this is the safest way to clear internal transfers before reviewing true leftovers.",
    });
  }

  return { steps, questions };
}

function buildUserSummary(params: {
  camtFiles: InboxFileCandidate[];
  wiseFiles: InboxFileCandidate[];
  receiptFolders: ReceiptFolderCandidate[];
  questions: InboxQuestion[];
  steps: RecommendedStep[];
  liveApiDefaultsAvailable: boolean;
}): string {
  const parts: string[] = [];
  if (params.camtFiles.length === 0 && params.wiseFiles.length === 0 && params.receiptFolders.length === 0) {
    return "I did not find any likely CAMT statements, Wise CSV files, or receipt folders in the scanned workspace.";
  }

  parts.push(
    `Found ${params.camtFiles.length} CAMT file(s), ${params.wiseFiles.length} Wise CSV file(s), ` +
    `and ${params.receiptFolders.length} receipt folder(s).`
  );

  const readySteps = params.steps.filter(step => step.recommended && step.missing_inputs.length === 0);
  if (readySteps.length > 0) {
    parts.push(`You can start immediately with ${readySteps.length} safe dry-run step(s).`);
  }

  if (params.questions.length > 0) {
    parts.push(
      `${params.questions.length} small decision(s) are still needed. Each one includes a recommended default so the user only needs to confirm or correct it.`
    );
  } else {
    parts.push("No essential setup questions are blocking the first dry-run pass.");
  }

  if (!params.liveApiDefaultsAvailable) {
    parts.push("I could still scan the workspace, but live bank-account defaults were unavailable because credentials are not configured yet.");
  }

  return parts.join(" ");
}

function pickNextRecommendedAction(steps: RecommendedStep[]): RecommendedStep | undefined {
  return steps.find(step => step.recommended && step.missing_inputs.length === 0);
}

// The caller-facing "what to run next" fields — `recommended_steps[]` and
// `next_recommended_action` — sit OUTSIDE the workflow_action_v1 envelope, so the
// shared envelope remap (remapHiddenGranularWorkflowEnvelope) does not reach
// them. When a step names a hidden granular constituent (parse_camt053,
// import_camt053, process_receipt_batch, classify_unmatched_transactions) it
// would point the caller at a tool absent from tools/list under the default
// exposure. Rewrite such steps to the merged entry point + mode, mirroring the
// envelope remap, but only when the granular tools are actually hidden: with
// EARVELDAJA_EXPOSE_GRANULAR_TOOLS=1 the granular names are valid and the
// power-user mode prefers them. Past-tense `executed_steps` telemetry keeps the
// real internal delegate (like the envelope's informational `delegated_tool`).
function remapRecommendedStepTool<T extends { tool: string; suggested_args: Record<string, unknown> }>(step: T): T {
  const remapped = remapHiddenGranularTool(step.tool, step.suggested_args);
  return remapped ? { ...step, tool: remapped.tool, suggested_args: remapped.args } : step;
}

function publicInboxFile(
  file: InboxFileCandidate,
  runtimeSafetyContext: RuntimeSafetyContext,
  operation: string,
): Record<string, unknown> {
  return {
    display_path: sandboxExternalText(file.path),
    display_name: sandboxExternalText(file.name),
    file_ref: runtimeSafetyContext.fileReferenceStore.issue({
      canonicalPath: file.path,
      kind: "file",
      operation,
    }),
    modified_at: file.modified_at,
    size_bytes: file.size_bytes,
    ...(file.detected_iban !== undefined ? { detected_iban: file.detected_iban } : {}),
  };
}

function publicReceiptFolder(
  folder: ReceiptFolderCandidate,
  runtimeSafetyContext: RuntimeSafetyContext,
): Record<string, unknown> {
  return {
    display_path: sandboxExternalText(folder.path),
    file_ref: runtimeSafetyContext.fileReferenceStore.issue({
      canonicalPath: folder.path,
      kind: "directory",
      operation: FILE_REFERENCE_OPERATIONS.receipt,
    }),
    receipt_file_count: folder.receipt_file_count,
    sample_files: folder.sample_files.map(name => sandboxExternalText(name)),
    ...(folder.last_modified_at !== undefined ? { last_modified_at: folder.last_modified_at } : {}),
  };
}

function publicRecommendedStep(
  step: RecommendedStep,
  runtimeSafetyContext: RuntimeSafetyContext,
): RecommendedStep {
  const suggestedArgs = publicSuggestedArgs(step.tool, step.suggested_args, runtimeSafetyContext);
  return {
    ...step,
    purpose: sandboxExternalText(step.purpose),
    suggested_args: suggestedArgs,
    reason: sandboxExternalText(step.reason),
  };
}

function publicSuggestedArgs(
  tool: string,
  args: Record<string, unknown>,
  runtimeSafetyContext: RuntimeSafetyContext,
): Record<string, unknown> {
  const suggestedArgs = { ...args };
  const directFilePath = typeof suggestedArgs.file_path === "string" ? suggestedArgs.file_path : undefined;
  const directFolderPath = typeof suggestedArgs.folder_path === "string" ? suggestedArgs.folder_path : undefined;
  if (directFilePath !== undefined) {
    const operation = tool === "import_wise_transactions"
      ? FILE_REFERENCE_OPERATIONS.wise
      : FILE_REFERENCE_OPERATIONS.camt;
    delete suggestedArgs.file_path;
    suggestedArgs.file_ref = runtimeSafetyContext.fileReferenceStore.issue({
      canonicalPath: directFilePath,
      kind: "file",
      operation,
    });
  }
  if (directFolderPath !== undefined) {
    delete suggestedArgs.folder_path;
    suggestedArgs.file_ref = runtimeSafetyContext.fileReferenceStore.issue({
      canonicalPath: directFolderPath,
      kind: "directory",
      operation: FILE_REFERENCE_OPERATIONS.receipt,
    });
  }
  return suggestedArgs;
}

function publicSourceDocuments(args: Record<string, unknown>): string[] {
  return [args.file_path, args.folder_path]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(value => sandboxExternalText(value));
}

function publicQuestion(question: InboxQuestion): InboxQuestion {
  return {
    ...question,
    question: sandboxExternalText(question.question),
    recommendation: sandboxExternalText(question.recommendation),
    candidates: question.candidates?.map(candidate => ({
      ...candidate,
      label: sandboxExternalText(candidate.label),
      match_reason: sandboxExternalText(candidate.match_reason),
    })),
  };
}

const REVIEW_TYPED_DATE_KEY = /(?:^|_)(?:date|datetime|timestamp|at|date_from|date_to)$/;
const REVIEW_TYPED_DATE_VALUE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/;
function isCanonicalReviewOpaqueValue(key: string, value: string): boolean {
  if (key === "sha256") return /^[0-9a-f]{64}$/.test(value);
  if (key !== "file_ref" && key !== "plan_handle") return false;
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === 32 && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

function isReviewMachineEnum(key: string, value: string): boolean {
  switch (key) {
    case "review_type":
      return value === "receipt_review" || value === "classification_group" ||
        value === "camt_possible_duplicate" || value === "unknown";
    case "source_tool":
      return value === "receipt_batch" || value === "process_receipt_batch" ||
        value === "classify_bank_transactions" || value === "classify_unmatched_transactions" ||
        value === "import_camt053";
    case "source":
      return value === "local_rules" || value === "supplier_history" ||
        value === "keyword_match" || value === "fallback" || value === "category_default" ||
        value === "receipt_batch" || value === "process_receipt_batch" ||
        value === "classify_bank_transactions" || value === "classify_unmatched_transactions" ||
        value === "import_camt053";
    case "status":
      return value === "PROJECT" || value === "CONFIRMED" || value === "VOID" ||
        value === "UNKNOWN" || value === "ready_for_action" || value === "needs_answers" ||
        value === "unsupported_review_type" || value === "ready_for_approval" ||
        value === "no_direct_action";
    case "type":
      return value === "C" || value === "D" || value === "tool_call" || value === "rule_save";
    case "apply_mode":
      return value === "purchase_invoice" || value === "review_only";
    case "category":
      return (AUTO_BOOKING_CATEGORIES as readonly string[]).includes(value);
    case "currency":
      return /^[A-Z]{3}$/.test(value);
    case "file_type":
      return value === "pdf" || value === "jpg" || value === "png";
    case "extension":
      return value === ".pdf" || value === ".jpg" || value === ".jpeg" || value === ".png";
    default:
      return false;
  }
}

function sandboxReviewFields(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    // Review payloads originate with a caller/import. Treat every string as
    // external text, not a perpetually incomplete field-name allowlist. The
    // only exceptions are opaque server references/digests and structurally
    // typed ISO date values; numeric IDs and amounts are non-strings already.
    if (key && isCanonicalReviewOpaqueValue(key, value)) return value;
    if (key && isReviewMachineEnum(key, value)) return value;
    if (key && REVIEW_TYPED_DATE_KEY.test(key) && REVIEW_TYPED_DATE_VALUE.test(value)) return value;
    return sandboxExternalText(value);
  }
  if (Array.isArray(value)) return value.map(item => sandboxReviewFields(item, key));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    childKey,
    sandboxReviewFields(child, childKey),
  ]));
}

// Exported for focused trust-boundary tests; public MCP responses call the
// same projector below.
export const sandboxReviewFieldsForOutput = sandboxReviewFields;

function projectResolverInput(
  resolverInput: Record<string, unknown>,
  runtimeSafetyContext: RuntimeSafetyContext,
): { resolver_input: Record<string, unknown>; source_documents: string[] } {
  const projected = sandboxReviewFields(resolverInput) as Record<string, unknown>;
  const item = recordAt(resolverInput, "item");
  const file = item ? recordAt(item, "file") : undefined;
  const rawPath = file ? stringAt(file, "path") : undefined;
  const rawName = file ? stringAt(file, "name") : undefined;
  const sourceDocuments = rawPath ? [sandboxExternalText(rawPath)] : [];
  if (file && rawPath) {
    const projectedItem = recordAt(projected, "item") ?? {};
    const projectedFile = recordAt(projectedItem, "file") ?? {};
    const { path: _rawPath, name: _rawName, ...fileMetadata } = projectedFile;
    projectedItem.file = {
      ...fileMetadata,
      display_path: sandboxExternalText(rawPath),
      ...(rawName !== undefined ? { display_name: sandboxExternalText(rawName) } : {}),
      file_ref: runtimeSafetyContext.fileReferenceStore.issue({
        canonicalPath: rawPath,
        kind: "file",
        operation: FILE_REFERENCE_OPERATIONS.receipt,
      }),
    };
    projected.item = projectedItem;
  }
  return { resolver_input: projected, source_documents: sourceDocuments };
}

function publicFollowUp<T extends {
  summary: string;
  recommendation?: string;
  compliance_basis?: string[];
  follow_up_questions?: string[];
  policy_hint?: string;
  resolver_input?: Record<string, unknown>;
}>(item: T, runtimeSafetyContext: RuntimeSafetyContext): T & { source_documents?: string[] } {
  const resolverProjection = item.resolver_input
    ? projectResolverInput(item.resolver_input, runtimeSafetyContext)
    : undefined;
  return {
    ...item,
    summary: sandboxExternalText(item.summary),
    ...(item.recommendation !== undefined ? { recommendation: sandboxExternalText(item.recommendation) } : {}),
    ...(item.compliance_basis !== undefined
      ? { compliance_basis: item.compliance_basis.map(value => sandboxExternalText(value)) }
      : {}),
    ...(item.follow_up_questions !== undefined
      ? { follow_up_questions: item.follow_up_questions.map(value => sandboxExternalText(value)) }
      : {}),
    ...(item.policy_hint !== undefined ? { policy_hint: sandboxExternalText(item.policy_hint) } : {}),
    ...(resolverProjection ?? {}),
  };
}

function buildPreparedInboxPayload(
  prepared: PreparedInboxData,
  runtimeSafetyContext: RuntimeSafetyContext,
  exposure: ToolExposureConfig = getToolExposureConfig(),
): Record<string, unknown> {
  // Rewrite hidden granular tool names in the caller-facing step list to their
  // merged entry points unless the granular tools are exposed (see
  // remapRecommendedStepTool). next_recommended_action is picked from the same
  // rewritten list so the two stay consistent.
  const rawSteps = exposure.exposeGranularTools
    ? prepared.steps
    : prepared.steps.map(remapRecommendedStepTool);
  const steps = rawSteps.map(step => publicRecommendedStep(step, runtimeSafetyContext));
  const questions = prepared.questions.map(publicQuestion);
  return {
    workspace_path: sandboxExternalText(prepared.workspacePath),
    scan: prepared.scan,
    detected_inputs: {
      camt_files: prepared.camtFiles.map(file => publicInboxFile(file, runtimeSafetyContext, FILE_REFERENCE_OPERATIONS.camt)),
      wise_csv_files: prepared.wiseFiles.map(file => publicInboxFile(file, runtimeSafetyContext, FILE_REFERENCE_OPERATIONS.wise)),
      receipt_folders: prepared.receiptFolders.map(folder => publicReceiptFolder(folder, runtimeSafetyContext)),
    },
    defaults: {
      live_api_defaults_available: prepared.liveApiDefaultsAvailable,
      suggested_bank_dimension_id: prepared.defaults.suggested_bank_dimension_id,
      suggested_receipt_matching_dimension_id: prepared.defaults.suggested_receipt_dimension_id,
      suggested_wise_account_dimension_id: prepared.defaults.suggested_wise_dimension_id,
      suggested_wise_fee_dimension_id: prepared.defaults.suggested_wise_fee_dimension_id,
      bank_dimension_candidates: prepared.defaults.candidates,
    },
    recommended_steps: steps,
    questions,
    next_question: questions[0],
    next_recommended_action: pickNextRecommendedAction(steps),
    assistant_guidance: [
      "Ask only the questions listed under questions, and always start with the recommendation.",
      "Run dry-run steps before any execute=true mutation.",
      "Summarize work as: done automatically, needs one decision, and needs accountant review.",
      ...(prepared.liveApiDefaultsAvailable
        ? []
        : ["Live bank-account defaults were unavailable because credentials are not configured yet. File scanning still works, but bank dimension defaults may need manual confirmation."]),
    ],
    user_summary: buildUserSummary({
      camtFiles: prepared.camtFiles,
      wiseFiles: prepared.wiseFiles,
      receiptFolders: prepared.receiptFolders,
      questions: prepared.questions,
      steps: prepared.steps,
      liveApiDefaultsAvailable: prepared.liveApiDefaultsAvailable,
    }),
  };
}

async function prepareAccountingInbox(
  api: ApiContext,
  params: {
    workspace_path?: string;
    max_depth?: number;
    bank_account_dimension_id?: number;
    receipt_matching_dimension_id?: number;
    wise_account_dimension_id?: number;
  },
): Promise<PreparedInboxData> {
  const root = await validateWorkspacePath(params.workspace_path);
  const depth = params.max_depth ?? DEFAULT_SCAN_DEPTH;
  const { files, scanned_directories, inspected_entries, entry_limit, truncated, continuation_guidance } =
    await scanWorkspaceFiles(root, depth);
  let bankAccounts: BankAccount[] = [];
  let accountDimensions: AccountDimension[] = [];
  let liveApiDefaultsAvailable = true;
  try {
    [bankAccounts, accountDimensions] = await Promise.all([
      api.readonly.getBankAccounts(),
      api.readonly.getAccountDimensions(),
    ]);
  } catch (error) {
    if (!isSetupModeApiError(error)) throw error;
    liveApiDefaultsAvailable = false;
  }

  const [camtFiles, wiseFiles] = await Promise.all([
    detectCamtFiles(files),
    detectWiseCsvFiles(files),
  ]);
  const receiptFolders = detectReceiptFolders(files);
  const defaults = buildBankDefaults(bankAccounts, accountDimensions, {
    bank_account_dimension_id: params.bank_account_dimension_id,
    receipt_matching_dimension_id: params.receipt_matching_dimension_id,
    wise_account_dimension_id: params.wise_account_dimension_id,
  });
  const { steps, questions } = buildRecommendedSteps({
    camtFiles,
    wiseFiles,
    receiptFolders,
    defaults,
  });

  return {
    workspacePath: root,
    scan: {
      max_depth: depth,
      scanned_directories,
      scanned_candidate_files: files.length,
      inspected_entries,
      entry_limit,
      truncated,
      ...(continuation_guidance !== undefined ? { continuation_guidance } : {}),
    },
    camtFiles,
    wiseFiles,
    receiptFolders,
    defaults,
    steps,
    questions,
    liveApiDefaultsAvailable,
  };
}

function captureInternalToolHandlers(
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
): Map<string, AutopilotInternalToolHandler> {
  assertRuntimeSafetyContext(runtimeSafetyContext);
  const handlers = new Map<string, AutopilotInternalToolHandler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: AutopilotInternalToolHandler) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;

  // This registry feeds the internal autopilot pipeline, not the MCP tool
  // surface, so it must always see every tool regardless of what the operator
  // exposes in tools/list via EARVELDAJA_EXPOSE_GRANULAR_TOOLS.
  const captureEverything: ToolExposureConfig = { enableLightyear: true, exposeGranularTools: true, exposeSetupTools: true, enableTaxTools: true, enableReferenceAdmin: true, enableAnnualReport: true, enableSales: true, enableProducts: true };

  registerCamtImportTools(server, api, runtimeSafetyContext, captureEverything);
  registerWiseImportTools(server, api, runtimeSafetyContext);
  registerReceiptInboxTools(server, api, runtimeSafetyContext, captureEverything);
  registerBankReconciliationTools(server, api, runtimeSafetyContext, captureEverything);

  return handlers;
}

function reviewGuidanceFromRecord(record: Record<string, unknown>): ReviewGuidance | undefined {
  const guidance = recordAt(record, "review_guidance");
  if (!guidance) return undefined;

  const recommendation = stringAt(guidance, "recommendation");
  if (!recommendation) return undefined;

  return {
    recommendation,
    compliance_basis: stringArrayAt(guidance, "compliance_basis"),
    follow_up_questions: stringArrayAt(guidance, "follow_up_questions"),
    policy_hint: stringAt(guidance, "policy_hint"),
  };
}

const CAMT_DUPLICATE_PATCH_FIELDS = [
  "bank_ref_number",
  "ref_number",
  "bank_account_no",
  "bank_account_name",
  "description",
] as const;

/**
 * Prove that the PROJECT transaction `cleanup_camt_possible_duplicate` is about
 * to DELETE is genuinely the same bank entry as the CONFIRMED transaction it
 * keeps. The tool previously gated deletion on status alone (CONFIRMED kept /
 * PROJECT deleted), so a wrong `delete_transaction_id` — an LLM slip, or an id
 * smuggled in through prompt-injected CAMT text — would have irreversibly
 * deleted an unrelated PROJECT transaction.
 *
 * Identity has two layers, both mirroring the system's OWN possible-duplicate
 * proposal logic in camt-import.ts so the destructive gate can never accept a
 * pair the proposer would not have surfaced:
 *
 *  1. The coarse candidate key (`buildPossibleDuplicateCandidateKey`, scoped to
 *     `accounts_dimensions_id`): bank dimension + date + direction (`type`,
 *     which encodes CRDT→"D"/DBIT→"C" over a positive-magnitude `amount`, so it
 *     is the signed-amount discriminator) + currency + rounded amount. Each of
 *     these must be PRESENT on both rows and equal — a missing field can never
 *     prove identity, so it fails CLOSED (no `?? EUR`/`?? null` collapsing two
 *     different rows to one identity).
 *  2. Structured corroboration (`camtDuplicateStructuredCorroborators`): at least
 *     one of reference number / counterparty IBAN / counterparty name must match.
 *     Without this, two same-day same-amount card purchases from different
 *     merchants share the coarse key and the wrong one could be deleted. The
 *     proposer's free-text `description` corroborator is deliberately excluded
 *     (metadata-wrapped/length-capped once persisted, and the lowest-entropy
 *     signal), so the gate is strictly more conservative than the proposer.
 *  3. Bank-reference divergence: when BOTH rows resolve a bank reference —
 *     `storedBankReferenceLookupKey`, i.e. the direct `bank_ref_number` OR a
 *     trust-validated reference recovered from CAMT description metadata — and
 *     the two keys differ, that is dispositive proof of two different entries →
 *     mismatch. The reference is not a required corroborator (the kept row
 *     routinely lacks one — that is what the cleanup enriches), so this only ever
 *     tightens the gate; reusing the codebase's own key derivation keeps it from
 *     drifting from how references are compared everywhere else.
 *
 * RESIDUAL (inherent, human-gated): two genuinely distinct same-merchant,
 * same-day, same-amount purchases where the kept row resolves NO bank reference
 * (no direct field and no recoverable CAMT metadata) are indistinguishable from a
 * true duplicate by any field available here — the only discriminator is the
 * reference the kept row lacks. `cleanup_camt_possible_duplicate` is therefore
 * surfaced as an approval-required action, never auto-executed.
 */
export function compareCamtDuplicateIdentity(
  kept: Transaction,
  candidate: Transaction,
):
  | { matches: true; identity: string; corroboration: string[] }
  | { matches: false; reasons: string[] } {
  const reasons: string[] = [];

  const keptDimension = Number.isFinite(kept.accounts_dimensions_id) ? kept.accounts_dimensions_id : undefined;
  const candidateDimension = Number.isFinite(candidate.accounts_dimensions_id) ? candidate.accounts_dimensions_id : undefined;
  if (keptDimension === undefined || candidateDimension === undefined || keptDimension !== candidateDimension) {
    reasons.push("bank dimension missing or differs");
  }

  const keptDate = typeof kept.date === "string" ? kept.date.trim() : "";
  const candidateDate = typeof candidate.date === "string" ? candidate.date.trim() : "";
  if (!keptDate || !candidateDate || keptDate !== candidateDate) {
    reasons.push("date missing or differs");
  }

  const keptType = typeof kept.type === "string" ? kept.type.trim() : "";
  const candidateType = typeof candidate.type === "string" ? candidate.type.trim() : "";
  if (!keptType || !candidateType || keptType !== candidateType) {
    reasons.push("direction (type) missing or differs");
  }

  const keptCurrency = typeof kept.cl_currencies_id === "string" ? kept.cl_currencies_id.trim() : "";
  const candidateCurrency = typeof candidate.cl_currencies_id === "string" ? candidate.cl_currencies_id.trim() : "";
  if (!keptCurrency || !candidateCurrency || keptCurrency !== candidateCurrency) {
    reasons.push("currency missing or differs");
  }

  const keptAmount = Number.isFinite(kept.amount) ? roundMoney(kept.amount) : undefined;
  const candidateAmount = Number.isFinite(candidate.amount) ? roundMoney(candidate.amount) : undefined;
  if (keptAmount === undefined || candidateAmount === undefined || keptAmount !== candidateAmount) {
    reasons.push("amount missing or differs");
  }

  const keptRefKey = storedBankReferenceLookupKey(kept);
  const candidateRefKey = storedBankReferenceLookupKey(candidate);
  if (keptRefKey && candidateRefKey && keptRefKey !== candidateRefKey) {
    reasons.push("bank reference differs");
  }

  const corroboration = camtDuplicateStructuredCorroborators(kept, candidate);
  if (corroboration.length === 0) {
    reasons.push("no corroborating counterparty match (reference, IBAN, or counterparty)");
  }

  if (reasons.length > 0) return { matches: false, reasons };

  const identity = [keptDimension, keptDate, keptType, keptCurrency, keptAmount!.toFixed(2)].join("|");
  return { matches: true, identity, corroboration };
}

function hasConcreteRuleOverrideField(ruleOverride: Record<string, unknown> | undefined): boolean {
  if (!ruleOverride) return false;
  return hasAnyAutoBookingRuleActionField({
    purchase_article_id: numberAt(ruleOverride, "purchase_article_id"),
    purchase_account_id: numberAt(ruleOverride, "purchase_account_id"),
    purchase_account_dimensions_id: numberAt(ruleOverride, "purchase_account_dimensions_id"),
    liability_account_id: numberAt(ruleOverride, "liability_account_id"),
    vat_rate_dropdown: stringAt(ruleOverride, "vat_rate_dropdown"),
    reversed_vat_id: numberAt(ruleOverride, "reversed_vat_id"),
  });
}

function extractTransactionPatchFields(record: Record<string, unknown> | undefined): Partial<Transaction> {
  if (!record) return {};

  const patch: Partial<Transaction> = {};
  for (const field of CAMT_DUPLICATE_PATCH_FIELDS) {
    const value = record[field];
    // CAMT metadata is textual; allow legacy numeric references but drop structured
    // values instead of turning them into junk like "[object Object]".
    if (value === undefined || value === null) continue;
    const coerced = typeof value === "string"
      // The value round-tripped through the LLM as a sandbox-wrapped review
      // field; strip EVERY wrapper layer and any residual delimiter before it is
      // written to the ledger, otherwise a nested/forged <<UNTRUSTED_OCR_*>>
      // marker persists. desandboxText preserves internal whitespace (CAMT
      // descriptions/refs are stored verbatim apart from the markers).
      ? desandboxText(value)
      : (typeof value === "number" && Number.isFinite(value))
        ? String(value)
        : typeof value === "bigint"
          ? value.toString()
          : undefined;
    if (coerced === undefined) continue;
    if (coerced.trim()) {
      patch[field] = coerced.trim();
    }
  }
  return patch;
}

function findConfirmedPossibleDuplicateMatches(item: Record<string, unknown>): Record<string, unknown>[] {
  return arrayAt(item, "existing_transactions")
    .filter(isRecord)
    .filter(candidate => stringAt(candidate, "status") === "CONFIRMED");
}

function extractRuleBookingFields(reviewItem: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = recordAt(reviewItem, "item");
  const group = recordAt(reviewItem, "group");
  const suggestion = recordAt(group ?? item ?? {}, "suggested_booking");
  if (!suggestion) return undefined;
  const source = stringAt(suggestion, "source");
  if (source !== "supplier_history" && source !== "local_rules") {
    return undefined;
  }

  const fields: Record<string, unknown> = {};
  // `match` and `category` are intentionally absent from this whitelist — they are
  // derived from the counterparty label and group category at the call site, not
  // from the suggested_booking payload.

  // Number fields — silently drop if the value is present but not a finite number.
  for (const key of ["purchase_article_id", "purchase_account_id", "purchase_account_dimensions_id", "liability_account_id", "reversed_vat_id"] as const) {
    const value = suggestion[key];
    if (value === undefined) continue;
    if (typeof value === "number" && Number.isFinite(value)) fields[key] = value;
    // malformed (non-number, non-undefined) → silently dropped so the save flow runs with well-typed ones
  }

  // String fields — silently drop if the value is present but not a string.
  for (const key of ["vat_rate_dropdown", "reason"] as const) {
    const value = suggestion[key];
    if (value === undefined) continue;
    if (typeof value === "string") fields[key] = value;
    // malformed → silently dropped
  }

  return Object.keys(fields).length > 0 ? fields : undefined;
}

function mergeRuleOverrides(
  reviewItem: Record<string, unknown>,
  explicitOverride?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const merged = {
    ...(extractRuleBookingFields(reviewItem) ?? {}),
    ...(explicitOverride ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveReviewItemPlan(
  reviewItem: Record<string, unknown>,
  exposure: ToolExposureConfig = getToolExposureConfig(),
): ReviewResolutionResult {
  const reviewType = stringAt(reviewItem, "review_type");
  const item = recordAt(reviewItem, "item");
  const group = recordAt(reviewItem, "group");

  if (reviewType === "receipt_review" && item) {
    const guidance = reviewGuidanceFromRecord(item);
    const file = recordAt(item, "file");
    const classification = stringAt(item, "classification") ?? "needs_review";
    // Continuation accepts both the new opaque reference and legacy raw-path
    // payloads, but never echoes either caller-supplied locator into prose.
    const hasFileLocation = Boolean(
      stringAt(file ?? {}, "file_ref") ?? stringAt(file ?? {}, "path"),
    );
    const isOwnerExpense = classification === "owner_paid_expense_reimbursement";
    // create_owner_expense_reimbursement is part of the tax-tool group and is
    // unregistered when EARVELDAJA_DISABLE_TAX_TOOLS=1. Do not name a tool the
    // caller cannot invoke (same contract rule as the merged/granular remap):
    // fall back to a manual owner-payable journal via the always-registered
    // create_journal, keeping the accounting treatment explicit.
    const ownerReimbursementToolAvailable = exposure.enableTaxTools;
    const ownerExpenseTools = ownerReimbursementToolAvailable
      ? ["create_owner_expense_reimbursement"]
      : ["create_journal"];
    const ownerExpenseSummary = ownerReimbursementToolAvailable
      ? "After the missing VAT/business-use answers are known, continue with create_owner_expense_reimbursement instead of forcing this through purchase-invoice booking."
      : `After the missing VAT/business-use answers are known, book it as an owner reimbursement with create_journal — debit the business expense (net, plus non-deductible VAT) and credit the owner-payable account (default ${DEFAULT_OWNER_PAYABLE_ACCOUNT}). The Estonian tax helpers are disabled in this deployment (EARVELDAJA_DISABLE_TAX_TOOLS); do not force it through purchase-invoice booking.`;
    return {
      review_type: "receipt_review",
      status: (guidance?.follow_up_questions.length ?? 0) > 0 ? "needs_answers" : "ready_for_action",
      recommendation: guidance?.recommendation ?? "Review the receipt manually before booking.",
      compliance_basis: guidance?.compliance_basis ?? [],
      unresolved_questions: guidance?.follow_up_questions ?? [],
      policy_hint: guidance?.policy_hint,
      suggested_workflow: isOwnerExpense ? undefined : "book-invoice",
      suggested_tools: isOwnerExpense
        ? ownerExpenseTools
        : ["receipt_batch"],
      next_step_summary: isOwnerExpense
        ? ownerExpenseSummary
        : `Resolve the missing receipt facts first${hasFileLocation ? " for the referenced receipt" : ""}, then either book it via book-invoice for one document or rerun receipt_batch for the folder.`,
    };
  }

  if (reviewType === "classification_group" && group) {
    const guidance = reviewGuidanceFromRecord(group);
    return {
      review_type: "classification_group",
      status: (guidance?.follow_up_questions.length ?? 0) > 0 ? "needs_answers" : "ready_for_action",
      recommendation: guidance?.recommendation ?? "Do not auto-book this group until its real accounting treatment is clear.",
      compliance_basis: guidance?.compliance_basis ?? [],
      unresolved_questions: guidance?.follow_up_questions ?? [],
      policy_hint: guidance?.policy_hint,
      suggested_workflow: "classify-unmatched",
      suggested_tools: ["classify_bank_transactions"],
      next_step_summary: "Decide the real treatment of this transaction group first. Only after that should you either book it manually, save a stable rule, or rerun the classification/apply flow.",
    };
  }

  if (reviewType === "camt_possible_duplicate" && item) {
    const guidance = reviewGuidanceFromRecord(item);
    const newTransactionId = numberAt(item, "new_transaction_api_id");
    const confirmedMatches = findConfirmedPossibleDuplicateMatches(item);
    const confirmedMatch = confirmedMatches.length === 1 ? confirmedMatches[0] : undefined;
    const unresolvedQuestions = confirmedMatches.length > 1
      ? ["Which confirmed transaction is the authoritative older row to keep before any duplicate cleanup is executed?"]
      : [];
    return {
      review_type: "camt_possible_duplicate",
      status: unresolvedQuestions.length > 0 ? "needs_answers" : "ready_for_action",
      recommendation: guidance?.recommendation ?? "Prefer the better-documented row and avoid keeping both as duplicates.",
      compliance_basis: guidance?.compliance_basis ?? [],
      unresolved_questions: unresolvedQuestions,
      policy_hint: guidance?.policy_hint,
      suggested_workflow: "import-camt",
      suggested_tools: confirmedMatch && newTransactionId !== undefined
        ? ["cleanup_camt_possible_duplicate"]
        : newTransactionId !== undefined
          ? ["delete_transaction"]
          : ["process_camt053"],
      next_step_summary: confirmedMatches.length > 1
        ? `Multiple confirmed transactions match this CAMT row${newTransactionId !== undefined ? ` alongside new PROJECT transaction ${newTransactionId}` : ""}. Choose the authoritative older row first; only then should any metadata patching or deletion happen.`
        : confirmedMatch && newTransactionId !== undefined
        ? `Default cleanup: keep confirmed transaction ${numberAt(confirmedMatch, "id")}, use its suggested missing-field patch as reference, and delete new PROJECT transaction ${newTransactionId}.`
        : confirmedMatch
          ? `Default cleanup: keep confirmed transaction ${numberAt(confirmedMatch, "id")} and do not let the CAMT import create a duplicate row for the same bank movement.`
          : "No automatic cleanup should happen yet; compare the old row and the CAMT row, keep the one with stronger bank-reference/source-document traceability, and delete the weaker duplicate only after that choice is clear.",
    };
  }

  // A recognized review_type only reaches this fallback when its required
  // payload (`item` for receipt_review/camt_possible_duplicate, `group` for
  // classification_group) is missing. That is a supplied-data problem, not an
  // unsupported type — telling the caller to change the type would be wrong.
  // `reviewType` here is exactly one of the SUPPORTED_REVIEW_TYPES literals (the
  // `.includes` guard validated it), so naming it is safe; the caller-supplied
  // `id` is never echoed into this unwrapped response.
  if (reviewType !== undefined && (SUPPORTED_REVIEW_TYPES as readonly string[]).includes(reviewType)) {
    const requiredPayloadKey = reviewType === "classification_group" ? "group" : "item";
    return {
      review_type: reviewType as ReviewResolutionResult["review_type"],
      status: "needs_answers",
      error: `This ${reviewType} review item is missing its required "${requiredPayloadKey}" payload.`,
      supported_review_types: [...SUPPORTED_REVIEW_TYPES],
      recommendation: `Re-emit this review item from its source tool with the "${requiredPayloadKey}" payload populated.`,
      compliance_basis: [],
      unresolved_questions: [
        `Re-emit this review item with its "${requiredPayloadKey}" payload so the ${reviewType} review can be actioned.`,
      ],
      suggested_workflow: undefined,
      suggested_tools: [],
      next_step_summary: "Supply the missing review payload before preparing any action.",
    };
  }

  // Genuinely foreign / unrecognized review_type. Emit a fixed, actionable
  // contract with NO caller-supplied value interpolated — the foreign type and
  // the id are untrusted text and this response is emitted unwrapped.
  return {
    review_type: "unknown",
    status: "unsupported_review_type",
    error: "This review item has an unsupported review_type.",
    supported_review_types: [...SUPPORTED_REVIEW_TYPES],
    recommendation: "Re-emit the item from its source tool with a supported review_type before preparing any action.",
    compliance_basis: [],
    unresolved_questions: [
      `Re-emit this review item with a supported type — one of ${SUPPORTED_REVIEW_TYPES.join(", ")}.`,
    ],
    suggested_workflow: undefined,
    suggested_tools: [],
    next_step_summary: "Correct the review type before preparing any action.",
  };
}

function prepareReviewAction(
  reviewItem: Record<string, unknown>,
  options: {
    saveAsRule?: boolean;
    ruleOverride?: Record<string, unknown>;
  } = {},
  exposure: ToolExposureConfig = getToolExposureConfig(),
): ReviewActionPreparationResult {
  const resolution = resolveReviewItemPlan(reviewItem, exposure);
  if (resolution.unresolved_questions.length > 0) {
    return {
      status: "needs_answers",
      recommendation: resolution.recommendation,
      unresolved_questions: resolution.unresolved_questions,
      suggested_workflow: resolution.suggested_workflow,
      suggested_tools: resolution.suggested_tools,
      next_step_summary: resolution.next_step_summary,
    };
  }

  const reviewType = resolution.review_type;
  const item = recordAt(reviewItem, "item");
  const group = recordAt(reviewItem, "group");

  if (reviewType === "camt_possible_duplicate" && item) {
    const newTransactionId = numberAt(item, "new_transaction_api_id");
    const confirmedMatches = findConfirmedPossibleDuplicateMatches(item);
    const confirmedMatch = confirmedMatches.length === 1 ? confirmedMatches[0] : undefined;
    const keepTransactionId = confirmedMatch ? numberAt(confirmedMatch, "id") : undefined;
    if (newTransactionId !== undefined && keepTransactionId !== undefined) {
      return {
        status: "ready_for_approval",
        recommendation: resolution.recommendation,
        unresolved_questions: [],
        proposed_action: {
          type: "tool_call",
          tool: "cleanup_camt_possible_duplicate",
          args: {
            keep_transaction_id: keepTransactionId,
            delete_transaction_id: newTransactionId,
            patch_missing_fields: extractTransactionPatchFields(
              confirmedMatch ? recordAt(confirmedMatch, "suggested_patch_missing_fields") : undefined,
            ),
          },
          approval_required: true,
        },
        suggested_workflow: resolution.suggested_workflow,
        suggested_tools: ["cleanup_camt_possible_duplicate"],
        next_step_summary: `With approval, fill the missing CAMT metadata onto confirmed transaction ${keepTransactionId} where needed and then delete duplicate PROJECT transaction ${newTransactionId}.`,
      };
    }
  }

  if (options.saveAsRule) {
    const mergedRuleOverride = mergeRuleOverrides(reviewItem, options.ruleOverride);
    // Canonicalize a marker-/whitespace-only wrapped vat_rate_dropdown to nothing
    // (mergedRuleOverride is a fresh object, safe to mutate): otherwise it would
    // pass the readiness guard below as the sole "concrete" field yet canonicalize
    // to "" at persist, reporting a ready/saved rule with no effective action.
    if (mergedRuleOverride && typeof mergedRuleOverride.vat_rate_dropdown === "string") {
      const cleanedVat = canonicalBusinessText(mergedRuleOverride.vat_rate_dropdown);
      if (cleanedVat) mergedRuleOverride.vat_rate_dropdown = cleanedVat;
      else delete mergedRuleOverride.vat_rate_dropdown;
    }
    // Prefer the resolved/normalized counterparty label over the raw OCR
    // `extracted.supplier_name` so a prompt-injected supplier name can't land
    // in `accounting-rules.md` as a rule match key unless the user types it in.
    // Canonicalize: the display_counterparty can be a sandbox-wrapped value
    // round-tripped from a wrapped classify/review response, so strip markers
    // before it becomes the proposed rule KEY (saveAutoBookingRule canonicalizes
    // again at persist, but the proposed/echoed key must also be marker-free).
    const rawMatch = stringAt(mergedRuleOverride ?? {}, "match") ??
      stringAt(item ?? {}, "display_counterparty") ??
      stringAt(group ?? {}, "display_counterparty");
    const match = rawMatch !== undefined ? canonicalBusinessText(rawMatch) || undefined : undefined;
    const category = stringAt(mergedRuleOverride ?? {}, "category") ??
      stringAt(group ?? {}, "category");
    if (match) {
      const ruleArgs: Record<string, unknown> = {
        match,
        ...(category ? { category } : {}),
      };
      // The rule-override store uses the legacy singular field names, but the
      // outbound args target the public save_auto_booking_rule tool, whose
      // account params were pluralized (purchase_accounts_id / liability_accounts_id)
      // in the 1.0 contract pass. Read internal, emit the public param name.
      const PUBLIC_RULE_ARG_NAME: Record<string, string> = {
        purchase_account_id: "purchase_accounts_id",
        liability_account_id: "liability_accounts_id",
      };
      for (const key of [
        "purchase_article_id",
        "purchase_account_id",
        "purchase_account_dimensions_id",
        "liability_account_id",
        "vat_rate_dropdown",
        "reversed_vat_id",
        "reason",
      ]) {
        const value = (mergedRuleOverride ?? {})[key];
        if (value !== undefined) {
          // Canonicalize the echoed free-text so proposed_action.args carries no
          // sandbox marker (persistence is protected again in saveAutoBookingRule).
          const cleaned = (key === "reason" || key === "vat_rate_dropdown") && typeof value === "string"
            ? canonicalBusinessText(value)
            : value;
          ruleArgs[PUBLIC_RULE_ARG_NAME[key] ?? key] = cleaned;
        }
      }
      const hasConcreteRuleField = hasConcreteRuleOverrideField(mergedRuleOverride);
      return {
        status: hasConcreteRuleField ? "ready_for_approval" : "no_direct_action",
        recommendation: resolution.recommendation,
        unresolved_questions: [],
        proposed_action: hasConcreteRuleField
          ? {
              type: "rule_save",
              tool: "save_auto_booking_rule",
              args: ruleArgs,
              approval_required: true,
            }
          : undefined,
        suggested_workflow: resolution.suggested_workflow,
        suggested_tools: ["save_auto_booking_rule"],
        next_step_summary: hasConcreteRuleField
          ? `With approval, save this stable treatment into ${getAccountingRulesPath()} so the same counterparty needs fewer questions next time.`
          : "A rule could be saved here, but at least one concrete booking field still needs to be chosen first.",
      };
    }
  }

  return {
    status: "no_direct_action",
    recommendation: resolution.recommendation,
    unresolved_questions: [],
    suggested_workflow: resolution.suggested_workflow,
    suggested_tools: resolution.suggested_tools,
    next_step_summary: resolution.next_step_summary,
  };
}

const accountingInboxInputShape = {
  workspace_path: z.string().optional().describe("Optional folder to scan. Defaults to the current workspace."),
  max_depth: z.number().int().min(0).max(MAX_SCAN_DEPTH).optional().describe("Optional scan depth (default 2, max 4)."),
  bank_account_dimension_id: z.number().optional().describe("Optional default bank account dimension to reuse for CAMT and receipt suggestions."),
  receipt_matching_dimension_id: z.number().optional().describe("Optional bank account dimension to use specifically for receipt matching suggestions."),
  wise_account_dimension_id: z.number().optional().describe("Optional bank account dimension to use specifically for Wise suggestions."),
};

type AccountingInboxToolParams = {
  workspace_path?: string;
  max_depth?: number;
  bank_account_dimension_id?: number;
  receipt_matching_dimension_id?: number;
  wise_account_dimension_id?: number;
};

async function buildAccountingInboxScanResponse(
  api: ApiContext,
  params: AccountingInboxToolParams,
  runtimeSafetyContext: RuntimeSafetyContext,
  exposure: ToolExposureConfig = getToolExposureConfig(),
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const prepared = await prepareAccountingInbox(api, params);
  const payload = buildPreparedInboxPayload(prepared, runtimeSafetyContext, exposure);

  return {
    content: [{
      type: "text",
      text: toMcpJson({
        ...payload,
        workflow: remapHiddenGranularWorkflowEnvelope(workflowFromAccountingInboxPayload(payload)),
      }),
    }],
  };
}

async function buildAccountingInboxDryRunResponse(
  api: ApiContext,
  params: AccountingInboxToolParams,
  runtimeSafetyContext: RuntimeSafetyContext,
  exposure: ToolExposureConfig = getToolExposureConfig(),
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const prepared = await prepareAccountingInbox(api, params);
  const handlers = captureInternalToolHandlers(api, runtimeSafetyContext);
  const autopilot = await runAccountingInboxDryRunPipeline({ prepared, handlers });
  const publicAutopilot = {
    ...autopilot,
    executed_steps: autopilot.executed_steps.map(step => ({
      ...step,
      purpose: sandboxExternalText(step.purpose),
      summary: sandboxExternalText(step.summary),
      suggested_args: publicSuggestedArgs(step.tool, step.suggested_args, runtimeSafetyContext),
      source_documents: publicSourceDocuments(step.suggested_args),
    })),
    skipped_steps: autopilot.skipped_steps.map(step => ({
      ...step,
      purpose: sandboxExternalText(step.purpose),
      summary: sandboxExternalText(step.summary),
      suggested_args: publicSuggestedArgs(step.tool, step.suggested_args, runtimeSafetyContext),
      source_documents: publicSourceDocuments(step.suggested_args),
    })),
    needs_one_decision: autopilot.needs_one_decision.map(item => publicFollowUp(item, runtimeSafetyContext)),
    needs_accountant_review: autopilot.needs_accountant_review.map(item => publicFollowUp(item, runtimeSafetyContext)),
  };
  const preparedPayload = buildPreparedInboxPayload(prepared, runtimeSafetyContext, exposure);
  preparedPayload.next_question = autopilot.next_question
    ? publicFollowUp(autopilot.next_question, runtimeSafetyContext)
    : undefined;
  // Keep the caller-facing next step consistent with the scan payload: rewrite a
  // hidden granular tool to its merged entry point unless granular tools are exposed.
  const nextRecommendedAction = autopilot.next_recommended_action && !exposure.exposeGranularTools
    ? remapRecommendedStepTool(autopilot.next_recommended_action)
    : autopilot.next_recommended_action;
  preparedPayload.next_recommended_action = nextRecommendedAction
    ? {
        ...nextRecommendedAction,
        purpose: sandboxExternalText(nextRecommendedAction.purpose),
        suggested_args: publicSuggestedArgs(nextRecommendedAction.tool, nextRecommendedAction.suggested_args, runtimeSafetyContext),
      }
    : undefined;

  const payload = {
    prepared_inbox: preparedPayload,
    autopilot: publicAutopilot,
  };
  const workflow = remapHiddenGranularWorkflowEnvelope(workflowFromAccountingInboxPayload(payload));

  return {
    content: [{
      type: "text",
      text: toMcpJson({
        ...payload,
        workflow,
      }),
    }],
  };
}

const reviewResolutionAssistantGuidance = [
  "Start with the recommendation and keep the conversation recommendation-first.",
  "Ask only unresolved_questions, and only if the payload itself does not already answer them.",
  "Do not execute any mutating follow-up without explicit approval.",
];

const reviewActionAssistantGuidance = [
  "If proposed_action is present, ask for explicit approval before executing it.",
  "If status is needs_answers, gather only unresolved_questions before preparing the action again.",
  "Prefer saving a rule only after the treatment has been confirmed as stable and repeatable.",
];

function parseRequiredJsonObject(input: unknown, label: string): Record<string, unknown> {
  if (input === undefined) {
    throw new Error(`"${label}" is required`);
  }
  return parseJsonObject(input, label);
}

function buildReviewResolutionResponse(
  reviewItem: Record<string, unknown>,
  exposure: ToolExposureConfig = getToolExposureConfig(),
): { content: Array<{ type: "text"; text: string }> } {
  const resolution = resolveReviewItemPlan(reviewItem, exposure);
  const sandboxed = sandboxReviewFields(resolution) as ReviewResolutionResult;
  const publicResolution: ReviewResolutionResult = {
    ...sandboxed,
    // These fields are selected from server-owned literals, never echoed from
    // the caller. Keep the machine contract directly consumable.
    review_type: resolution.review_type,
    status: resolution.status,
    suggested_workflow: resolution.suggested_workflow,
    suggested_tools: resolution.suggested_tools,
    next_step_summary: resolution.next_step_summary,
    error: resolution.error,
    supported_review_types: resolution.supported_review_types,
  };

  return {
    content: [{
      type: "text",
      text: toMcpJson({
        ...publicResolution,
        assistant_guidance: reviewResolutionAssistantGuidance,
      }),
    }],
  };
}

function buildReviewActionResponse(
  reviewItem: Record<string, unknown>,
  options: {
    saveAsRule?: boolean;
    ruleOverride?: Record<string, unknown>;
  } = {},
  exposure: ToolExposureConfig = getToolExposureConfig(),
): { content: Array<{ type: "text"; text: string }> } {
  const prepared = prepareReviewAction(reviewItem, options, exposure);
  const sandboxed = sandboxReviewFields(prepared) as ReviewActionPreparationResult;
  const publicPrepared: ReviewActionPreparationResult = {
    ...sandboxed,
    status: prepared.status,
    suggested_workflow: prepared.suggested_workflow,
    suggested_tools: prepared.suggested_tools,
    next_step_summary: prepared.next_step_summary,
    ...(prepared.proposed_action && sandboxed.proposed_action
      ? {
          proposed_action: {
            ...sandboxed.proposed_action,
            type: prepared.proposed_action.type,
            tool: prepared.proposed_action.tool,
            approval_required: prepared.proposed_action.approval_required,
          },
        }
      : {}),
  };

  return {
    content: [{
      type: "text",
      text: toMcpJson({
        ...publicPrepared,
        assistant_guidance: reviewActionAssistantGuidance,
      }),
    }],
  };
}

export function registerAccountingInboxTools(
  server: McpServer,
  api: ApiContext,
  runtimeSafetyContext: RuntimeSafetyContext,
  exposure: ToolExposureConfig = getToolExposureConfig(),
): void {
  assertRuntimeSafetyContext(runtimeSafetyContext);
  // accounting_inbox is the single inbox entry point: mode="scan" plans,
  // mode="dry_run" runs the safe dry-run pipeline. (The former
  // prepare_accounting_inbox / run_accounting_inbox_dry_runs tools were exact
  // aliases of these two modes and have been removed.)
  registerTool(server,
    "accounting_inbox",
    "Merged accounting inbox. mode='scan' recommends safe next steps; mode='dry_run' also runs safe dry-run steps.",
    {
      mode: z.enum(["scan", "dry_run"]).optional().describe("Workflow phase. scan plans; dry_run runs safe dry-run steps."),
      ...accountingInboxInputShape,
    },
    { ...readOnly, openWorldHint: true, title: "Accounting Inbox" },
    async ({ mode, ...params }) => {
      return mode === "dry_run"
        ? buildAccountingInboxDryRunResponse(api, params, runtimeSafetyContext, exposure)
        : buildAccountingInboxScanResponse(api, params, runtimeSafetyContext, exposure);
    },
  );

  registerTool(server,
    "continue_accounting_workflow",
    "Continue an accounting workflow response, resolve a review item, or prepare an approval action.",
    {
      action: z.enum(["next", "resolve_review", "prepare_action"]).optional().describe("next reads workflow_state_json; resolve_review/prepare_action read review_item_json."),
      workflow_state_json: jsonObjectInput.optional().describe("Previous workflow response; required for action='next'."),
      review_item_json: jsonObjectInput.optional().describe("Review item object for action='resolve_review' or action='prepare_action'."),
      save_as_rule: z.boolean().optional().describe("For action='prepare_action', prepare save_auto_booking_rule when appropriate."),
      rule_override_json: jsonObjectInput.optional().describe("Optional explicit rule fields for action='prepare_action'."),
    },
    { ...readOnly, title: "Continue Accounting Workflow" },
    async ({ action, workflow_state_json, review_item_json, save_as_rule, rule_override_json }) => {
      if (action === "resolve_review") {
        const reviewItem = parseRequiredJsonObject(review_item_json, "review_item_json");
        return buildReviewResolutionResponse(reviewItem, exposure);
      }

      if (action === "prepare_action") {
        const reviewItem = parseRequiredJsonObject(review_item_json, "review_item_json");
        const ruleOverride = rule_override_json
          ? parseJsonObject(rule_override_json, "rule_override_json")
          : undefined;
        return buildReviewActionResponse(reviewItem, {
          saveAsRule: save_as_rule,
          ruleOverride,
        }, exposure);
      }

      const workflowState = parseRequiredJsonObject(workflow_state_json, "workflow_state_json");
      const workflow = remapHiddenGranularWorkflowEnvelope(
        isRecord(workflowState.workflow)
          ? workflowState.workflow
          : workflowFromAccountingInboxPayload(workflowState),
      );
      const nextAction = isRecord(workflow)
        ? recordAt(workflow, "recommended_next_action")
        : undefined;
      const actionLabel = nextAction
        ? stringAt(nextAction, "label") ?? stringAt(nextAction, "tool") ?? stringAt(nextAction, "kind")
        : undefined;

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            message: actionLabel
              ? `Next action: ${actionLabel}.`
              : "Next action: no workflow action is currently pending.",
            workflow,
          }),
        }],
      };
    },
  );

  // Granular constituent of continue_accounting_workflow (action="resolve_review");
  // listed in tools/list only when EARVELDAJA_EXPOSE_GRANULAR_TOOLS=1.
  if (exposure.exposeGranularTools) registerTool(server,
    "resolve_accounting_review_item",
    "Resolve one accounting review item into recommendation, questions, and next workflow/tool.",
    {
      review_item_json: jsonObjectInput.describe("Object from autopilot.needs_accountant_review[*].resolver_input or from a direct execution.needs_review / groups review item."),
    },
    { ...readOnly, title: "Resolve Accounting Review Item" },
    async ({ review_item_json }) => {
      const reviewItem = parseJsonObject(review_item_json, "review_item_json");
      return buildReviewResolutionResponse(reviewItem, exposure);
    },
  );

  // Granular constituent of continue_accounting_workflow (action="prepare_action");
  // listed in tools/list only when EARVELDAJA_EXPOSE_GRANULAR_TOOLS=1.
  if (exposure.exposeGranularTools) registerTool(server,
    "prepare_accounting_review_action",
    "Prepare the concrete approval action for one resolved accounting review item.",
    {
      review_item_json: jsonObjectInput.describe("Object from autopilot.needs_accountant_review[*].resolver_input or a direct review item payload."),
      save_as_rule: z.boolean().optional().describe("Prefer preparing save_auto_booking_rule when appropriate."),
      rule_override_json: jsonObjectInput.optional().describe("Optional explicit rule fields for save_auto_booking_rule."),
    },
    { ...readOnly, title: "Prepare Accounting Review Action" },
    async ({ review_item_json, save_as_rule, rule_override_json }) => {
      const reviewItem = parseJsonObject(review_item_json, "review_item_json");
      const ruleOverride = rule_override_json
        ? parseJsonObject(rule_override_json, "rule_override_json")
        : undefined;
      return buildReviewActionResponse(reviewItem, {
        saveAsRule: save_as_rule,
        ruleOverride,
      }, exposure);
    },
  );

  registerTool(server,
    "cleanup_camt_possible_duplicate",
    "Apply any missing CAMT metadata onto the kept older transaction and then delete the newly imported duplicate PROJECT transaction.",
    {
      keep_transaction_id: z.number().int().describe("Existing authoritative transaction ID to keep"),
      delete_transaction_id: z.number().int().describe("New duplicate PROJECT transaction ID to delete"),
      patch_missing_fields: z.object({
        bank_ref_number: z.string().optional(),
        ref_number: z.string().optional(),
        bank_account_no: z.string().optional(),
        bank_account_name: z.string().optional(),
        description: z.string().optional(),
      }).optional().describe("Optional CAMT metadata to fill only if the kept transaction still lacks those values"),
    },
    { ...batch, title: "Cleanup CAMT Possible Duplicate" },
    async ({ keep_transaction_id, delete_transaction_id, patch_missing_fields }) => {
      if (keep_transaction_id === delete_transaction_id) {
        throw new Error("keep_transaction_id and delete_transaction_id must be different transactions");
      }

      const keptTransaction = await api.transactions.get(keep_transaction_id);
      if (keptTransaction.is_deleted) {
        throw new Error(`Cannot keep transaction ${keep_transaction_id} because it is already deleted`);
      }
      if (keptTransaction.status !== "CONFIRMED") {
        throw new Error(
          `Refusing to keep transaction ${keep_transaction_id} because its status is ${keptTransaction.status ?? "UNKNOWN"} instead of CONFIRMED`,
        );
      }

      const duplicateTransaction = await api.transactions.get(delete_transaction_id);
      if (duplicateTransaction.is_deleted) {
        throw new Error(`Cannot delete transaction ${delete_transaction_id} because it is already deleted`);
      }
      if ((duplicateTransaction.status ?? "PROJECT") !== "PROJECT") {
        throw new Error(
          `Refusing to delete transaction ${delete_transaction_id} because its status is ${duplicateTransaction.status ?? "UNKNOWN"} instead of PROJECT`,
        );
      }

      const identityCheck = compareCamtDuplicateIdentity(keptTransaction, duplicateTransaction);
      if (!identityCheck.matches) {
        throw new Error(
          `Refusing to clean up transactions ${keep_transaction_id} and ${delete_transaction_id}: ` +
          `CAMT duplicate identity mismatch (${identityCheck.reasons.join("; ")}). ` +
          `Only a PROJECT transaction that matches the kept one on bank dimension, date, direction, ` +
          `currency, and amount — with at least one corroborating counterparty field — may be deleted ` +
          `as its duplicate.`,
        );
      }

      const appliedPatch: Partial<Transaction> = {};
      const requestedPatch = patch_missing_fields ?? {};
      for (const field of CAMT_DUPLICATE_PATCH_FIELDS) {
        const candidateValue = requestedPatch[field];
        if (typeof candidateValue !== "string" || !candidateValue.trim()) continue;

        const currentValue = keptTransaction[field];
        if (typeof currentValue === "string" && currentValue.trim()) continue;
        if (currentValue !== undefined && currentValue !== null && currentValue !== "") continue;

        appliedPatch[field] = candidateValue;
      }

      if (Object.keys(appliedPatch).length > 0) {
        await api.transactions.update(keep_transaction_id, appliedPatch);
        logAudit({
          tool: "cleanup_camt_possible_duplicate",
          action: "UPDATED",
          entity_type: "transaction",
          entity_id: keep_transaction_id,
          summary: `Enriched transaction ${keep_transaction_id} with missing CAMT metadata before duplicate cleanup`,
          details: appliedPatch,
        });
      }

      let deleteResult: unknown;
      let deleteError: string | undefined;
      try {
        deleteResult = await api.transactions.delete(delete_transaction_id);
      } catch (err) {
        deleteError = err instanceof Error ? err.message : String(err);
        logAudit({
          tool: "cleanup_camt_possible_duplicate",
          action: "DELETE_FAILED",
          entity_type: "transaction",
          entity_id: delete_transaction_id,
          summary: `Failed to delete duplicate CAMT transaction ${delete_transaction_id}; kept transaction ${keep_transaction_id} was already updated`,
          details: { kept_transaction_id: keep_transaction_id, error: deleteError },
        });
      }

      if (deleteError !== undefined) {
        return {
          content: [{
            type: "text",
            text: toMcpJson({
              cleaned: false,
              keep_transaction_id,
              delete_transaction_id,
              updated_keep_transaction: Object.keys(appliedPatch).length > 0,
              applied_patch: appliedPatch,
              deleted: false,
              partial: true,
              error: deleteError,
              note: "The kept transaction was updated but deleting the duplicate failed. Retry delete_transaction_id manually.",
            }),
          }],
        };
      }

      logAudit({
        tool: "cleanup_camt_possible_duplicate",
        action: "DELETED",
        entity_type: "transaction",
        entity_id: delete_transaction_id,
        summary: `Deleted duplicate CAMT transaction ${delete_transaction_id} after preserving transaction ${keep_transaction_id}`,
        details: {
          kept_transaction_id: keep_transaction_id,
          identity: identityCheck.identity,
          corroboration: identityCheck.corroboration,
        },
      });

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            cleaned: true,
            keep_transaction_id,
            delete_transaction_id,
            updated_keep_transaction: Object.keys(appliedPatch).length > 0,
            applied_patch: appliedPatch,
            deleted: true,
            partial: false,
            delete_result: deleteResult,
            note: Object.keys(appliedPatch).length > 0
              ? "The older transaction was enriched with missing CAMT metadata before deleting the duplicate PROJECT row."
              : "No missing CAMT metadata had to be added; the duplicate PROJECT row was deleted.",
          }),
        }],
      };
    },
  );

  registerTool(server,
    "save_auto_booking_rule",
    "Save or update one stable counterparty auto-booking default. Use only after the treatment has been confirmed and approved.",
    {
      match: z.string().min(1).describe("Counterparty match text, usually the supplier or counterparty name stem"),
      category: z.enum(AUTO_BOOKING_CATEGORIES).optional().describe("Optional classification category such as saas_subscriptions or bank_fees"),
      purchase_article_id: z.number().int().optional().describe("Optional purchase article ID"),
      purchase_accounts_id: z.number().int().optional().describe("Optional purchase account ID"),
      purchase_account_dimensions_id: z.number().int().optional().describe("Optional purchase account dimension ID"),
      liability_accounts_id: z.number().int().optional().describe("Optional liability account ID"),
      vat_rate_dropdown: z.string().optional().describe("Optional VAT rate dropdown value"),
      reversed_vat_id: z.number().int().optional().describe("Optional reverse-charge VAT flag"),
      reason: z.string().optional().describe("Optional short explanation for the rule"),
    },
    { ...mutate, title: "Save Auto-Booking Rule" },
    async ({ match, category, purchase_article_id, purchase_accounts_id, purchase_account_dimensions_id, liability_accounts_id, vat_rate_dropdown, reversed_vat_id, reason }) => {
      // Public params use the plural FK convention; the persisted rule store and
      // its downstream consumers keep the legacy singular field names.
      const purchase_account_id = purchase_accounts_id;
      const liability_account_id = liability_accounts_id;
      // Canonicalize the free text up front so the length guard and error message
      // operate on marker-free text (a marker-only match then fails the friendly
      // "too short" check, not an opaque schema error). saveAutoBookingRule
      // canonicalizes again at the persist boundary — this is defense in depth.
      const cleanMatch = canonicalBusinessText(match);
      const cleanReason = reason !== undefined ? canonicalBusinessText(reason) : undefined;
      // Canonicalize vat_rate_dropdown BEFORE the concrete-field guard: a
      // marker-/whitespace-only wrapped value would otherwise pass the guard as
      // the sole "concrete" field, then canonicalize to "" at persist and save a
      // rule with no effective booking action. Empty after canonicalization →
      // undefined, so it no longer counts as a concrete field.
      const cleanVatRateDropdown = vat_rate_dropdown !== undefined
        ? (canonicalBusinessText(vat_rate_dropdown) || undefined)
        : undefined;
      if (!hasConcreteRuleOverrideField({
        purchase_article_id,
        purchase_account_id,
        purchase_account_dimensions_id,
        liability_account_id,
        vat_rate_dropdown: cleanVatRateDropdown,
        reversed_vat_id,
      })) {
        throw new Error("save_auto_booking_rule requires at least one concrete booking field besides match/category/reason");
      }

      // Guard against 1–2 char stems (e.g. "AS", "OÜ") that would substring-match
      // every Estonian company. findAutoBookingRule uses String.includes, so a
      // short normalized stem silently hijacks unrelated counterparties.
      if (normalizeAutoBookingRuleMatch(cleanMatch).length < MIN_AUTO_BOOKING_RULE_MATCH_LENGTH) {
        throw new Error(
          `save_auto_booking_rule match "${cleanMatch}" is too short after normalization (need at least ${MIN_AUTO_BOOKING_RULE_MATCH_LENGTH} characters) — use a more specific counterparty stem to avoid accidental matches.`,
        );
      }

      const result = saveAutoBookingRule({
        match: cleanMatch,
        category,
        purchase_article_id,
        purchase_account_id,
        purchase_account_dimensions_id,
        liability_account_id,
        vat_rate_dropdown: cleanVatRateDropdown,
        reversed_vat_id,
        reason: cleanReason,
      });

      return {
        content: [{
          type: "text",
          text: toMcpJson({
            saved: true,
            path: result.path,
            action: result.action,
            match: result.match,
            category: result.category,
            note: "The accounting knowledge store was updated (see 'path'). Review the diff if you want to fine-tune the wording or IDs.",
          }),
        }],
      };
    },
  );
}
