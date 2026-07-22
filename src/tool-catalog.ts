import { createHash } from "node:crypto";

export type ToolFeature = "core" | "workflow" | "banking" | "documents" | "reports" | "audit" | "connection" | "sales" | "products" | "tax" | "annual_report" | "lightyear" | "reference_admin" | "setup";
export type ToolAudience = "guided" | "standard" | "advanced" | "admin";
export type ToolRisk = "read" | "preview" | "mutate" | "destructive" | "send";
export interface ToolMeta {
  readonly name: string;
  readonly feature: ToolFeature;
  readonly audience: ToolAudience;
  readonly risk: ToolRisk;
  readonly facade_for?: readonly string[];
  readonly granular_of?: { readonly tool: string; readonly mode?: string };
}

const NAMES = `get_setup_instructions import_apikey_credentials list_stored_credentials remove_stored_credentials list_connections switch_connection clear_cache get_session_log list_audit_logs clear_session_log list_clients get_client create_client update_client deactivate_client reactivate_client delete_client search_client find_client_by_code list_products get_product create_product update_product deactivate_product reactivate_product delete_product list_journals get_journal create_journal update_journal delete_journal confirm_journal batch_confirm_journals invalidate_journal list_transactions get_transaction create_transaction confirm_transaction update_transaction invalidate_transaction delete_transaction batch_delete_transactions list_sale_invoices get_sale_invoice create_sale_invoice update_sale_invoice delete_sale_invoice confirm_sale_invoice invalidate_sale_invoice get_sale_invoice_delivery_options send_sale_invoice get_sale_invoice_document get_sale_invoice_xml list_purchase_invoices get_purchase_invoice create_purchase_invoice update_purchase_invoice delete_purchase_invoice preview_purchase_invoice_totals_correction confirm_purchase_invoice invalidate_purchase_invoice list_accounts list_account_dimensions list_currencies list_sale_articles list_purchase_articles list_templates list_projects get_invoice_info update_invoice_info get_vat_info list_invoice_series get_invoice_series create_invoice_series update_invoice_series delete_invoice_series list_bank_accounts get_bank_account create_bank_account update_bank_account delete_bank_account compute_account_balance compute_account_dimension_balances compute_client_debt extract_pdf_invoice validate_invoice_data resolve_supplier suggest_booking create_purchase_invoice_from_pdf attach_document get_document delete_document reconcile_currency_rounding reconcile_transactions auto_confirm_exact_matches reconcile_inter_account_transfers reconcile_bank_transactions compute_trial_balance compute_balance_sheet compute_profit_and_loss month_end_close_checklist compute_receivables_aging compute_payables_aging create_recurring_sale_invoices prepare_dividend_package create_owner_expense_reimbursement check_vat_registration_threshold check_tax_free_limits prepare_year_end_close generate_annual_report_data execute_year_end_close find_missing_documents detect_duplicate_purchase_invoice import_opening_balances scan_receipt_folder process_receipt_batch receipt_batch classify_unmatched_transactions apply_transaction_classifications classify_bank_transactions parse_lightyear_statement parse_lightyear_capital_gains book_lightyear_trades book_lightyear_distributions lightyear_portfolio_summary import_wise_transactions parse_camt053 import_camt053 process_camt053 accounting_inbox continue_accounting_workflow resolve_accounting_review_item prepare_accounting_review_action cleanup_camt_possible_duplicate save_auto_booking_rule analyze_unconfirmed_transactions recommend_workflow get_execution_plan_page`.split(" ");

const DESTRUCTIVE = new Set(`remove_stored_credentials clear_session_log delete_client delete_product delete_journal confirm_journal batch_confirm_journals confirm_transaction delete_transaction batch_delete_transactions delete_sale_invoice confirm_sale_invoice send_sale_invoice delete_purchase_invoice confirm_purchase_invoice delete_invoice_series delete_bank_account delete_document auto_confirm_exact_matches reconcile_inter_account_transfers reconcile_bank_transactions create_recurring_sale_invoices execute_year_end_close process_receipt_batch receipt_batch apply_transaction_classifications classify_bank_transactions book_lightyear_trades book_lightyear_distributions import_wise_transactions import_camt053 process_camt053 cleanup_camt_possible_duplicate`.split(" "));
const READ = new Set(`get_setup_instructions list_stored_credentials list_connections clear_cache get_session_log list_audit_logs list_clients get_client search_client find_client_by_code list_products get_product list_journals get_journal list_transactions get_transaction list_sale_invoices get_sale_invoice get_sale_invoice_delivery_options get_sale_invoice_document get_sale_invoice_xml list_purchase_invoices get_purchase_invoice preview_purchase_invoice_totals_correction list_accounts list_account_dimensions list_currencies list_sale_articles list_purchase_articles list_templates list_projects get_invoice_info get_vat_info list_invoice_series get_invoice_series list_bank_accounts get_bank_account compute_account_balance compute_account_dimension_balances compute_client_debt extract_pdf_invoice validate_invoice_data suggest_booking get_document reconcile_transactions compute_trial_balance compute_balance_sheet compute_profit_and_loss month_end_close_checklist compute_receivables_aging compute_payables_aging check_vat_registration_threshold check_tax_free_limits prepare_year_end_close generate_annual_report_data find_missing_documents detect_duplicate_purchase_invoice scan_receipt_folder classify_unmatched_transactions parse_lightyear_statement parse_lightyear_capital_gains lightyear_portfolio_summary parse_camt053 accounting_inbox continue_accounting_workflow resolve_accounting_review_item prepare_accounting_review_action analyze_unconfirmed_transactions recommend_workflow get_execution_plan_page`.split(" "));

const GRANULAR: Record<string, { tool: string; mode?: string }> = {
  reconcile_transactions: { tool: "reconcile_bank_transactions", mode: "suggest" },
  auto_confirm_exact_matches: { tool: "reconcile_bank_transactions" },
  parse_camt053: { tool: "process_camt053", mode: "parse" },
  import_camt053: { tool: "process_camt053" },
  scan_receipt_folder: { tool: "receipt_batch", mode: "scan" },
  process_receipt_batch: { tool: "receipt_batch" },
  classify_unmatched_transactions: { tool: "classify_bank_transactions", mode: "classify" },
  apply_transaction_classifications: { tool: "classify_bank_transactions" },
  resolve_accounting_review_item: { tool: "continue_accounting_workflow", mode: "resolve_review" },
  prepare_accounting_review_action: { tool: "continue_accounting_workflow", mode: "prepare_action" },
};
const FACADES: Record<string, readonly string[]> = {
  reconcile_bank_transactions: ["reconcile_transactions", "auto_confirm_exact_matches"],
  process_camt053: ["parse_camt053", "import_camt053"],
  receipt_batch: ["scan_receipt_folder", "process_receipt_batch"],
  classify_bank_transactions: ["classify_unmatched_transactions", "apply_transaction_classifications"],
  continue_accounting_workflow: ["resolve_accounting_review_item", "prepare_accounting_review_action"],
};

const FEATURE_GROUPS: ReadonlyArray<readonly [ToolFeature, Set<string>]> = [
  ["setup", new Set("get_setup_instructions import_apikey_credentials list_stored_credentials remove_stored_credentials".split(" "))],
  ["connection", new Set("list_connections switch_connection clear_cache".split(" "))],
  ["audit", new Set("get_session_log list_audit_logs clear_session_log".split(" "))],
  ["products", new Set("list_products get_product create_product update_product deactivate_product reactivate_product delete_product".split(" "))],
  ["sales", new Set("list_sale_invoices get_sale_invoice create_sale_invoice update_sale_invoice delete_sale_invoice confirm_sale_invoice invalidate_sale_invoice get_sale_invoice_delivery_options send_sale_invoice get_sale_invoice_document get_sale_invoice_xml create_recurring_sale_invoices compute_receivables_aging".split(" "))],
  ["reference_admin", new Set("update_invoice_info get_invoice_series create_invoice_series update_invoice_series delete_invoice_series get_bank_account create_bank_account update_bank_account delete_bank_account".split(" "))],
  ["tax", new Set("prepare_dividend_package create_owner_expense_reimbursement check_vat_registration_threshold check_tax_free_limits".split(" "))],
  ["annual_report", new Set("prepare_year_end_close generate_annual_report_data execute_year_end_close".split(" "))],
  ["lightyear", new Set("parse_lightyear_statement parse_lightyear_capital_gains book_lightyear_trades book_lightyear_distributions lightyear_portfolio_summary".split(" "))],
  ["reports", new Set("compute_account_balance compute_account_dimension_balances compute_client_debt compute_trial_balance compute_balance_sheet compute_profit_and_loss month_end_close_checklist compute_payables_aging import_opening_balances".split(" "))],
  ["documents", new Set("extract_pdf_invoice validate_invoice_data resolve_supplier suggest_booking create_purchase_invoice_from_pdf attach_document get_document delete_document find_missing_documents detect_duplicate_purchase_invoice scan_receipt_folder process_receipt_batch receipt_batch".split(" "))],
  ["banking", new Set("list_transactions get_transaction create_transaction confirm_transaction update_transaction invalidate_transaction delete_transaction batch_delete_transactions reconcile_currency_rounding reconcile_transactions auto_confirm_exact_matches reconcile_inter_account_transfers reconcile_bank_transactions classify_unmatched_transactions apply_transaction_classifications classify_bank_transactions import_wise_transactions parse_camt053 import_camt053 process_camt053 cleanup_camt_possible_duplicate analyze_unconfirmed_transactions".split(" "))],
  ["workflow", new Set("accounting_inbox continue_accounting_workflow resolve_accounting_review_item prepare_accounting_review_action save_auto_booking_rule recommend_workflow get_execution_plan_page".split(" "))],
];

function feature(name: string): ToolFeature {
  for (const [group, names] of FEATURE_GROUPS) if (names.has(name)) return group;
  return "core";
}

const GUIDED = new Set(`recommend_workflow accounting_inbox continue_accounting_workflow receipt_batch process_camt053 import_wise_transactions reconcile_bank_transactions reconcile_inter_account_transfers classify_bank_transactions cleanup_camt_possible_duplicate save_auto_booking_rule compute_trial_balance list_connections switch_connection get_setup_instructions get_execution_plan_page get_session_log`.split(" "));

function audience(name: string): ToolAudience {
  if (GUIDED.has(name)) return "guided";
  if (name in GRANULAR) return "advanced";
  const group = feature(name);
  if (group === "setup" || group === "reference_admin" || group === "audit") return "admin";
  return "standard";
}

function risk(name: string): ToolRisk {
  if (name === "send_sale_invoice") return "send";
  if (DESTRUCTIVE.has(name)) return "destructive";
  if (new Set("preview_purchase_invoice_totals_correction reconcile_transactions prepare_year_end_close scan_receipt_folder classify_unmatched_transactions accounting_inbox continue_accounting_workflow prepare_accounting_review_action".split(" ")).has(name)) return "preview";
  if (READ.has(name)) return "read";
  return "mutate";
}

export const TOOL_CATALOG: readonly ToolMeta[] = Object.freeze(NAMES.map((name) => Object.freeze({
  name, feature: feature(name), audience: audience(name), risk: risk(name),
  ...(FACADES[name] ? { facade_for: Object.freeze([...FACADES[name]]) } : {}),
  ...(GRANULAR[name] ? { granular_of: Object.freeze({ ...GRANULAR[name] }) } : {}),
})));

const BY_NAME = new Map(TOOL_CATALOG.map((entry) => [entry.name, entry]));
if (BY_NAME.size !== TOOL_CATALOG.length) throw new Error("Duplicate tool name in TOOL_CATALOG");
for (const entry of TOOL_CATALOG) {
  for (const target of entry.facade_for ?? []) if (!BY_NAME.has(target)) throw new Error(`Unknown facade_for target: ${target}`);
  if (entry.granular_of && !BY_NAME.has(entry.granular_of.tool)) throw new Error(`Unknown granular_of target: ${entry.granular_of.tool}`);
}

export function toolMeta(name: string): ToolMeta {
  const meta = BY_NAME.get(name);
  if (!meta) throw new Error(`Missing ToolMeta for registered tool: ${name}`);
  return meta;
}

export const TOOL_CATALOG_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify(TOOL_CATALOG))
  .digest("hex");
