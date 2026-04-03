import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { open, readdir, realpath, stat } from "fs/promises";
import { basename, extname, resolve } from "path";
import { z } from "zod";
import { registerTool } from "../mcp-compat.js";
import { parseMcpResponse, toMcpJson } from "../mcp-json.js";
import { readOnly } from "../annotations.js";
import { getAllowedRoots, isPathWithinRoot, resolveFilePath } from "../file-validation.js";
import type { AccountDimension, BankAccount } from "../types/api.js";
import type { ApiContext } from "./crud-tools.js";
import { DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT } from "../accounting-defaults.js";
import { registerCamtImportTools } from "./camt-import.js";
import { registerWiseImportTools } from "./wise-import.js";
import { registerReceiptInboxTools } from "./receipt-inbox.js";
import { registerBankReconciliationTools } from "./bank-reconciliation.js";
import {
  buildCamtDuplicateReviewGuidance,
  type ReviewGuidance,
} from "../estonian-accounting-guidance.js";

const RECEIPT_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png"]);
const DEFAULT_SCAN_DEPTH = 2;
const MAX_SCAN_DEPTH = 4;
const MAX_SCANNED_FILES = 1500;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
]);

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
    truncated: boolean;
  };
  camtFiles: InboxFileCandidate[];
  wiseFiles: InboxFileCandidate[];
  receiptFolders: ReceiptFolderCandidate[];
  defaults: ReturnType<typeof buildBankDefaults>;
  steps: RecommendedStep[];
  questions: InboxQuestion[];
  liveApiDefaultsAvailable: boolean;
}

interface AutopilotStepResult {
  step: number;
  tool: string;
  status: "completed" | "skipped" | "failed";
  purpose: string;
  summary: string;
  suggested_args: Record<string, unknown>;
  preview?: Record<string, unknown>;
}

interface AutopilotFollowUp {
  source: string;
  summary: string;
  recommendation?: string;
  compliance_basis?: string[];
  follow_up_questions?: string[];
  policy_hint?: string;
}

type InternalToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }> }>;

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

async function scanWorkspaceFiles(
  root: string,
  maxDepth: number,
): Promise<{ files: ScannedFileInfo[]; scanned_directories: number; truncated: boolean }> {
  const files: ScannedFileInfo[] = [];
  let scannedDirectories = 0;
  let truncated = false;

  async function walk(current: string, depth: number): Promise<void> {
    if (files.length >= MAX_SCANNED_FILES || truncated) {
      truncated = true;
      return;
    }
    scannedDirectories += 1;

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_SCANNED_FILES) {
        truncated = true;
        return;
      }

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
  return { files, scanned_directories: scannedDirectories, truncated };
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

function buildRecommendedSteps(params: {
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

  const primaryReceiptFolder = receiptFolders[0];
  if (primaryReceiptFolder) {
    const dimensionId = defaults.suggested_receipt_dimension_id;
    const missingInputs = dimensionId === undefined ? ["accounts_dimensions_id"] : [];
    steps.push({
      step: stepNumber++,
      tool: "process_receipt_batch",
      purpose: "Dry-run receipt processing for the most likely receipt folder.",
      recommended: dimensionId !== undefined,
      suggested_args: {
        folder_path: primaryReceiptFolder.path,
        ...(dimensionId !== undefined ? { accounts_dimensions_id: dimensionId } : {}),
        execute: false,
      },
      missing_inputs: missingInputs,
      reason: dimensionId !== undefined
        ? `Recommended receipt matching bank dimension: ${dimensionId}. Start with the folder that has the most receipt files.`
        : "A bank account dimension is still needed to match receipts against outgoing bank transactions.",
    });
  }

  if (primaryReceiptFolder && defaults.suggested_receipt_dimension_id === undefined) {
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
      reason: "After imports and receipt processing, this is the next low-friction step to surface only the remaining exceptions.",
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

function buildPreparedInboxPayload(prepared: PreparedInboxData): Record<string, unknown> {
  return {
    workspace_path: prepared.workspacePath,
    scan: prepared.scan,
    detected_inputs: {
      camt_files: prepared.camtFiles,
      wise_csv_files: prepared.wiseFiles,
      receipt_folders: prepared.receiptFolders,
    },
    defaults: {
      live_api_defaults_available: prepared.liveApiDefaultsAvailable,
      suggested_bank_dimension_id: prepared.defaults.suggested_bank_dimension_id,
      suggested_receipt_matching_dimension_id: prepared.defaults.suggested_receipt_dimension_id,
      suggested_wise_account_dimension_id: prepared.defaults.suggested_wise_dimension_id,
      suggested_wise_fee_dimension_id: prepared.defaults.suggested_wise_fee_dimension_id,
      bank_dimension_candidates: prepared.defaults.candidates,
    },
    recommended_steps: prepared.steps,
    questions: prepared.questions,
    next_question: prepared.questions[0],
    next_recommended_action: pickNextRecommendedAction(prepared.steps),
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
  const { files, scanned_directories, truncated } = await scanWorkspaceFiles(root, depth);
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
      truncated,
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

function captureInternalToolHandlers(api: ApiContext): Map<string, InternalToolHandler> {
  const handlers = new Map<string, InternalToolHandler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: InternalToolHandler) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;

  registerCamtImportTools(server, api);
  registerWiseImportTools(server, api);
  registerReceiptInboxTools(server, api);
  registerBankReconciliationTools(server, api);

  return handlers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberAt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function stringAt(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function arrayAt(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function recordAt(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function stringArrayAt(record: Record<string, unknown>, key: string): string[] {
  return arrayAt(record, key).filter((value): value is string => typeof value === "string");
}

function toAutopilotFollowUp(
  source: string,
  summary: string,
  guidance?: Partial<ReviewGuidance> & { recommendation?: string },
): AutopilotFollowUp {
  return {
    source,
    summary,
    recommendation: guidance?.recommendation,
    compliance_basis: guidance?.compliance_basis,
    follow_up_questions: guidance?.follow_up_questions,
    policy_hint: guidance?.policy_hint,
  };
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

async function invokeInternalTool(
  handlers: Map<string, InternalToolHandler>,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const handler = handlers.get(tool);
  if (!handler) {
    throw new Error(`Internal inbox autopilot could not find tool handler for ${tool}`);
  }

  const result = await handler(args);
  const text = result.content[0]?.text;
  if (!text) {
    throw new Error(`Internal inbox autopilot received no text payload from ${tool}`);
  }

  const parsed = parseMcpResponse(text);
  if (!isRecord(parsed)) {
    throw new Error(`Internal inbox autopilot expected an object payload from ${tool}`);
  }
  return parsed;
}

function summarizeAutopilotToolResult(
  tool: string,
  payload: Record<string, unknown>,
): { summary: string; preview?: Record<string, unknown>; followUps: AutopilotFollowUp[] } {
  switch (tool) {
    case "parse_camt053": {
      const summary = recordAt(payload, "summary") ?? {};
      return {
        summary: `Parsed CAMT preview with ${numberAt(summary, "entry_count") ?? 0} entries and ${numberAt(summary, "duplicate_count") ?? 0} duplicate hint(s) inside the statement.`,
        preview: {
          entry_count: numberAt(summary, "entry_count") ?? 0,
          duplicate_count: numberAt(summary, "duplicate_count") ?? 0,
          iban: recordAt(payload, "statement_metadata") ? stringAt(recordAt(payload, "statement_metadata")!, "iban") : undefined,
        },
        followUps: [],
      };
    }
    case "import_camt053": {
      const execution = recordAt(payload, "execution") ?? {};
      const summary = recordAt(execution, "summary") ?? {};
      const reviewItems = arrayAt(execution, "needs_review").filter(isRecord);
      const reviewCount = reviewItems.length;
      const hasConfirmedMatch = reviewItems.some((item) =>
        arrayAt(item, "existing_transactions").some((candidate) =>
          isRecord(candidate) && stringAt(candidate, "status") === "CONFIRMED"
        )
      );
      const duplicateGuidance = reviewCount > 0
        ? buildCamtDuplicateReviewGuidance({ hasConfirmedMatch })
        : undefined;
      return {
        summary: `CAMT dry run would create ${numberAt(summary, "created_count") ?? 0} transaction(s), skip ${numberAt(summary, "skipped_count") ?? 0}, raise ${reviewCount} possible duplicate review item(s), and report ${numberAt(summary, "error_count") ?? 0} error(s).`,
        preview: {
          created_count: numberAt(summary, "created_count") ?? 0,
          skipped_count: numberAt(summary, "skipped_count") ?? 0,
          possible_duplicate_count: reviewCount,
          error_count: numberAt(summary, "error_count") ?? 0,
        },
        followUps: reviewCount > 0
          ? [toAutopilotFollowUp(
              tool,
              `${reviewCount} CAMT row(s) look like possible duplicates against older manual transactions.`,
              duplicateGuidance,
            )]
          : [],
      };
    }
    case "import_wise_transactions": {
      const execution = recordAt(payload, "execution") ?? {};
      const summary = recordAt(execution, "summary") ?? {};
      const errorCount = numberAt(summary, "error_count") ?? 0;
      return {
        summary: `Wise dry run would create ${numberAt(summary, "created") ?? 0} transaction(s), skip ${numberAt(summary, "skipped") ?? 0}, and report ${errorCount} error(s).`,
        preview: {
          created: numberAt(summary, "created") ?? 0,
          skipped: numberAt(summary, "skipped") ?? 0,
          error_count: errorCount,
        },
        followUps: errorCount > 0
          ? [{
              source: tool,
              summary: `${errorCount} Wise CSV row(s) still failed preview.`,
              recommendation: "Review the Wise import errors before execute=true.",
            }]
          : [],
      };
    }
    case "process_receipt_batch": {
      const execution = recordAt(payload, "execution") ?? {};
      const summary = recordAt(execution, "summary") ?? {};
      const reviewCount = numberAt(summary, "needs_review") ?? 0;
      const failedCount = numberAt(summary, "failed") ?? 0;
      const followUps: AutopilotFollowUp[] = arrayAt(execution, "needs_review")
        .filter(isRecord)
        .slice(0, 5)
        .map((item) => {
          const file = recordAt(item, "file");
          const fileName = stringAt(file ?? {}, "name") ?? "receipt";
          const classification = stringAt(item, "classification") ?? "needs review";
          return toAutopilotFollowUp(
            tool,
            `${fileName} jäi dry-runis ülevaatuseks (${classification}).`,
            reviewGuidanceFromRecord(item) ?? {
              recommendation: "Vaata üle ainult see märgitud kviitung ning kinnita puudu olevad andmed või korrektne maksukäsitlus enne teostust.",
            },
          );
        });
      if (failedCount > 0) {
        followUps.push(toAutopilotFollowUp(
          tool,
          `${failedCount} receipt(s) failed the dry run completely.`,
          {
            recommendation: "Kontrolli esmalt täpset extraction- või booking-viga; ilma piisava alusdokumendi või korrektse käsitluseta ei tohiks neid automaatselt läbi lasta.",
          },
        ));
      }
      return {
        summary: `Receipt dry run would create ${numberAt(summary, "created") ?? 0} invoice(s), match ${numberAt(summary, "matched") ?? 0}, skip ${numberAt(summary, "skipped_duplicate") ?? 0} duplicate(s), leave ${reviewCount} in review, and fail ${failedCount}.`,
        preview: {
          created: numberAt(summary, "created") ?? 0,
          matched: numberAt(summary, "matched") ?? 0,
          skipped_duplicate: numberAt(summary, "skipped_duplicate") ?? 0,
          needs_review: reviewCount,
          failed: failedCount,
        },
        followUps,
      };
    }
    case "classify_unmatched_transactions": {
      const groups = arrayAt(payload, "groups");
      const reviewGroups = groups.filter((group) =>
        isRecord(group) && stringAt(group, "apply_mode") !== "purchase_invoice"
      );
      return {
        summary: `Classified ${numberAt(payload, "total_unmatched") ?? 0} unmatched transaction(s) into ${groups.length} group(s), of which ${reviewGroups.length} still need accounting judgement instead of auto-booking.`,
        preview: {
          total_unmatched: numberAt(payload, "total_unmatched") ?? 0,
          group_count: groups.length,
          category_counts: recordAt(payload, "category_counts") ?? {},
        },
        followUps: reviewGroups.slice(0, 5).map((group) => {
          const record = group as Record<string, unknown>;
          const displayCounterparty = stringAt(record, "display_counterparty") ?? "transaction group";
          const category = stringAt(record, "category") ?? "review_only";
          return toAutopilotFollowUp(
            tool,
            `${displayCounterparty} jäi ülevaatuseks kategoorias ${category}.`,
            reviewGuidanceFromRecord(record) ?? {
              recommendation: "Ära auto-booki seda gruppi ostuarvena enne, kui tehingu sisu ja alusdokumendid on kinnitatud.",
            },
          );
        }),
      };
    }
    case "reconcile_inter_account_transfers": {
      const execution = recordAt(payload, "execution") ?? {};
      const summary = recordAt(execution, "summary") ?? {};
      const ambiguous = numberAt(summary, "skipped_ambiguous") ?? 0;
      const followUps = ambiguous > 0
        ? [{
            source: tool,
            summary: `${ambiguous} inter-account transfer candidate(s) were ambiguous.`,
            recommendation: "Review only the ambiguous transfer pairs before confirming anything.",
          }]
        : [];
      return {
        summary: `Inter-account transfer dry run found ${numberAt(summary, "matched_pairs") ?? 0} matched pair(s), ${numberAt(summary, "matched_one_sided") ?? 0} one-sided match(es), ${ambiguous} ambiguous case(s), and ${numberAt(summary, "error_count") ?? 0} error(s).`,
        preview: {
          matched_pairs: numberAt(summary, "matched_pairs") ?? 0,
          matched_one_sided: numberAt(summary, "matched_one_sided") ?? 0,
          skipped_ambiguous: ambiguous,
          skipped_already_handled: numberAt(summary, "skipped_already_handled") ?? 0,
          error_count: numberAt(summary, "error_count") ?? 0,
        },
        followUps,
      };
    }
    default:
      return {
        summary: `${tool} completed successfully.`,
        preview: undefined,
        followUps: [],
      };
  }
}

function isAutopilotRunnableStep(step: RecommendedStep, liveApiDefaultsAvailable: boolean): boolean {
  if (step.missing_inputs.length > 0) return false;
  if (!step.recommended) return false;
  if (liveApiDefaultsAvailable) return true;
  return step.tool === "parse_camt053";
}

export function registerAccountingInboxTools(server: McpServer, api: ApiContext): void {
  registerTool(server,
    "prepare_accounting_inbox",
    "Scan a workspace for likely CAMT statements, Wise CSV exports, and receipt folders, then recommend the next dry-run steps with sensible defaults and the fewest necessary questions.",
    {
      workspace_path: z.string().optional().describe("Optional folder to scan. Defaults to the current workspace."),
      max_depth: z.number().int().min(0).max(MAX_SCAN_DEPTH).optional().describe("Optional scan depth (default 2, max 4)."),
      bank_account_dimension_id: z.number().optional().describe("Optional default bank account dimension to reuse for CAMT and receipt suggestions."),
      receipt_matching_dimension_id: z.number().optional().describe("Optional bank account dimension to use specifically for receipt matching suggestions."),
      wise_account_dimension_id: z.number().optional().describe("Optional bank account dimension to use specifically for Wise suggestions."),
    },
    { ...readOnly, openWorldHint: true, title: "Prepare Accounting Inbox" },
    async ({ workspace_path, max_depth, bank_account_dimension_id, receipt_matching_dimension_id, wise_account_dimension_id }) => {
      const prepared = await prepareAccountingInbox(api, {
        workspace_path,
        max_depth,
        bank_account_dimension_id,
        receipt_matching_dimension_id,
        wise_account_dimension_id,
      });

      return {
        content: [{
          type: "text",
          text: toMcpJson(buildPreparedInboxPayload(prepared)),
        }],
      };
    },
  );

  registerTool(server,
    "run_accounting_inbox_dry_runs",
    "Scan a workspace, then automatically run the safe recommended dry-run accounting steps and return one consolidated preview for a non-accountant-friendly first pass.",
    {
      workspace_path: z.string().optional().describe("Optional folder to scan. Defaults to the current workspace."),
      max_depth: z.number().int().min(0).max(MAX_SCAN_DEPTH).optional().describe("Optional scan depth (default 2, max 4)."),
      bank_account_dimension_id: z.number().optional().describe("Optional default bank account dimension to reuse for CAMT and receipt suggestions."),
      receipt_matching_dimension_id: z.number().optional().describe("Optional bank account dimension to use specifically for receipt matching suggestions."),
      wise_account_dimension_id: z.number().optional().describe("Optional bank account dimension to use specifically for Wise suggestions."),
    },
    { ...readOnly, openWorldHint: true, title: "Run Accounting Inbox Dry Runs" },
    async ({ workspace_path, max_depth, bank_account_dimension_id, receipt_matching_dimension_id, wise_account_dimension_id }) => {
      const prepared = await prepareAccountingInbox(api, {
        workspace_path,
        max_depth,
        bank_account_dimension_id,
        receipt_matching_dimension_id,
        wise_account_dimension_id,
      });
      const handlers = captureInternalToolHandlers(api);

      const executedSteps: AutopilotStepResult[] = [];
      const skippedSteps: AutopilotStepResult[] = [];
      const doneAutomatically: string[] = [];
      const needsOneDecision: AutopilotFollowUp[] = prepared.questions.map(question => ({
        source: question.id,
        summary: question.question,
        recommendation: question.recommendation,
      }));
      const needsAccountantReview: AutopilotFollowUp[] = [];

      for (const step of prepared.steps) {
        if (!isAutopilotRunnableStep(step, prepared.liveApiDefaultsAvailable)) {
          skippedSteps.push({
            step: step.step,
            tool: step.tool,
            status: "skipped",
            purpose: step.purpose,
            summary: step.missing_inputs.length > 0
              ? `Skipped because ${step.missing_inputs.join(", ")} is still missing.`
              : (!prepared.liveApiDefaultsAvailable && step.tool !== "parse_camt053")
                ? "Skipped because live API-backed dry runs are unavailable until credentials are configured."
                : "Skipped because this step is not currently marked as a safe default.",
            suggested_args: step.suggested_args,
          });
          continue;
        }

        try {
          const payload = await invokeInternalTool(handlers, step.tool, step.suggested_args);
          const summarized = summarizeAutopilotToolResult(step.tool, payload);
          executedSteps.push({
            step: step.step,
            tool: step.tool,
            status: "completed",
            purpose: step.purpose,
            summary: summarized.summary,
            suggested_args: step.suggested_args,
            preview: summarized.preview,
          });
          doneAutomatically.push(summarized.summary);
          needsAccountantReview.push(...summarized.followUps);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          executedSteps.push({
            step: step.step,
            tool: step.tool,
            status: "failed",
            purpose: step.purpose,
            summary: message,
            suggested_args: step.suggested_args,
          });
          needsAccountantReview.push({
            source: step.tool,
            summary: `${step.tool} failed during autopilot dry run: ${message}`,
            recommendation: "Inspect this specific step before relying on the automatic first pass.",
          });
        }
      }

      const nextQuestion = needsOneDecision[0];
      const nextRecommendedAction = needsOneDecision.length === 0 && needsAccountantReview.length === 0
        ? skippedSteps.find(step => !step.summary.startsWith("Skipped because"))
        : undefined;

      const payload = {
        prepared_inbox: buildPreparedInboxPayload(prepared),
        autopilot: {
          executed_step_count: executedSteps.length,
          skipped_step_count: skippedSteps.length,
          executed_steps: executedSteps,
          skipped_steps: skippedSteps,
          done_automatically: doneAutomatically,
          needs_one_decision: needsOneDecision,
          needs_accountant_review: needsAccountantReview,
          next_question: nextQuestion,
          next_recommended_action: nextRecommendedAction,
          user_summary: doneAutomatically.length > 0
            ? `Ran ${executedSteps.length} safe dry-run step(s) automatically. ${needsOneDecision.length} small decision(s) and ${needsAccountantReview.length} review item(s) remain.`
            : `No safe dry-run steps could be completed automatically yet. ${needsOneDecision.length} small decision(s) and ${needsAccountantReview.length} review item(s) remain.`,
        },
      };

      return {
        content: [{
          type: "text",
          text: toMcpJson(payload),
        }],
      };
    },
  );
}
