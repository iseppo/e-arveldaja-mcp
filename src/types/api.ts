// API response types

export interface ApiResponse {
  code: number;
  created_object_id?: number;
  messages: string[];
}

export interface PaginatedResponse<T> {
  current_page: number;
  total_pages: number;
  items: T[];
}

export interface ApiFile {
  name: string;
  contents: string; // base64
}

// === Clients ===

export interface Client {
  id?: number;
  is_client: boolean;
  is_supplier: boolean;
  is_staff?: boolean;
  name: string;
  alt_name?: string | null;
  code?: string | null;
  address_ads_oid?: string | null;
  address_adr_id?: string | null;
  address_text?: string | null;
  postal_address_text?: string | null;
  email?: string | null;
  accounting_email?: string | null;
  telephone?: string | null;
  contact_person?: string | null;
  bank_account_no?: string | null;
  notes?: string | null;
  invoice_electronic_opts?: Record<string, string>;
  invoice_days?: number | null;
  invoice_overdue_charge?: number | null;
  invoice_vat_no?: string | null;
  cl_invoice_country?: string | null;
  cl_purchase_articles_id?: number | null;
  purchase_accounts_id?: number | null;
  purchase_accounts_dimensions_id?: number | null;
  is_physical_entity?: boolean;
  is_juridical_entity?: boolean;
  cl_code_country: string;
  is_member: boolean;
  send_invoice_to_email: boolean;
  send_invoice_to_accounting_email: boolean;
  bank_ref_number_sales?: string | null;
  bank_ref_number_purchases?: string | null;
  bank_account_custom_name?: string | null;
  is_deleted?: boolean;
  is_associate_company?: boolean;
  is_parent_company_group?: boolean;
  is_related_party?: boolean;
}

// === Products ===

export interface Product {
  id?: number;
  name: string;
  foreign_names?: Record<string, string>;
  cl_sale_articles_id?: number | null;
  cl_sale_accounts_dimensions_id?: number | null;
  sale_accounts_id?: number | null;
  sale_accounts_dimensions_id?: number | null;
  cl_purchase_articles_id?: number | null;
  purchase_accounts_id?: number | null;
  purchase_accounts_dimensions_id?: number | null;
  code: string;
  description?: string | null;
  sales_price?: number | null;
  net_price?: number | null;
  price_currency?: string;
  notes?: string | null;
  translations?: Record<string, string>;
  activity_text?: string | null;
  emtak_code?: string | null;
  emtak_version?: string | null;
  unit?: string | null;
  amount?: number | null;
  is_deleted?: boolean;
}

// === Projects ===

export interface Project {
  id?: number;
  parent_id?: number | null;
  name: string;
  notes?: string | null;
  cl_projects_type: string;
  is_disabled: boolean;
  is_deleted?: boolean;
  create_date?: string;
  deprecated_parent_id?: number | null;
}

// === Journals & Postings ===

export interface Posting {
  id?: number;
  journals_id?: number;
  accounts_id: number;
  accounts_dimensions_id?: number | null;
  type?: "D" | "C";
  amount: number;
  base_amount?: number;
  cl_currencies_id?: string;
  projects_project_id?: number | null;
  projects_location_id?: number | null;
  projects_person_id?: number | null;
  is_deleted?: boolean;
}

export interface Journal {
  id?: number;
  parent_id?: number | null;
  clients_id?: number | null;
  subclients_id?: number | null;
  number?: number;
  amendment_number?: number;
  title?: string;
  effective_date: string;
  registered?: boolean;
  operations_id?: number;
  operation_type?: string;
  document_number?: string | null;
  cl_currencies_id?: string;
  currency_rate?: number | null;
  base_document_files_id?: number | null;
  is_xls_imported?: boolean;
  is_deleted?: boolean;
  insert_date?: string;
  register_date?: string;
  postings: Posting[];
}

// === Transactions ===

export interface TransactionItem {
  id?: number;
  accounts_id: number;
  accounts_dimensions_id?: number | null;
  relation_table?: string;
  relation_id?: number;
  amount?: number;
  base_amount?: number;
  currency_rate?: number | null;
  cl_currencies_id?: string;
}

export interface Transaction {
  id?: number;
  uploaded_files_id?: number | null;
  accounts_id?: number;
  accounts_dimensions_id: number;
  status?: string;
  bank_accounts_id?: number | null;
  bank_ref_number?: string | null;
  bank_subtype?: string | null;
  type: string;
  clients_id?: number | null;
  bank_code?: string | null;
  bank_account_no?: string | null;
  bank_account_name?: string | null;
  ref_number?: string | null;
  amount: number;
  base_amount?: number;
  currency_rate?: number | null;
  cl_currencies_id: string;
  description?: string | null;
  date: string;
  transactions_files_id?: number | null;
  export_format?: string | null;
  is_deleted?: boolean;
  operation_type?: string | null;
  items?: TransactionItem[];
}

export interface TransactionDistribution {
  related_table: string;
  related_id?: number;
  related_sub_id?: number;
  amount: number;
}

// === Sale Invoices ===

export interface SaleInvoiceItem {
  id?: number;
  products_id: number;
  cl_sale_articles_id?: number;
  sale_accounts_id?: number;
  sale_accounts_dimensions_id?: number;
  amount: number;
  unit?: string;
  unit_net_price?: number;
  total_net_price?: number;
  base_total_net_price?: number;
  vat_accounts_id?: number;
  vat_rate?: number;
  discount_percent?: number;
  discount_amount?: number;
  custom_title: string;
  projects_project_id?: number | null;
  projects_location_id?: number | null;
  projects_person_id?: number | null;
  vat_amount?: number;
}

export interface SaleInvoiceDelivery {
  create_date?: string;
  destination_type?: string;
  invoice_type?: string;
  receiver_address?: string;
  receiver_name?: string;
  send_method?: number;
  sender_person_code?: string;
  sender_person_name?: string;
  status_date?: string;
  transfer_status_code?: number;
}

export interface SaleInvoice {
  id?: number;
  credit_sale_invoices_id?: number | null;
  credit_invoice_payment_type?: string | null;
  sale_invoice_type: string;
  cl_templates_id: number;
  clients_id: number;
  client_name?: string;
  cl_countries_id: string;
  number_prefix?: string;
  number_suffix: string;
  number?: string;
  create_date: string;
  journal_date: string;
  status?: string;
  payment_status?: string;
  net_price?: number;
  vat5_price?: number;
  vat9_price?: number;
  vat20_price?: number;
  gross_price?: number;
  bank_ref_number?: string;
  term_days: number;
  overdue_charge?: number;
  notes?: string | null;
  base_document_files_id?: number | null;
  files_id?: number | null;
  is_doubtful?: boolean;
  is_hopeless?: boolean;
  use_per_item_rounding?: boolean;
  paid_in_cash?: boolean;
  cash_accounts_id?: number | null;
  cash_accounts_dimensions_id?: number | null;
  invoice_info?: string | null;
  payment_description?: string | null;
  cl_currencies_id: string;
  currency_rate?: number | null;
  base_gross_price?: number;
  base_net_price?: number;
  base_vat5_price?: number;
  base_vat9_price?: number;
  base_vat20_price?: number;
  cash_payment_date?: string | null;
  trade_secret?: boolean;
  receivable_accounts_id?: number;
  receivable_accounts_dimensions_id?: number | null;
  intra_community_supply?: boolean;
  client_vat_no?: string | null;
  triangulation?: boolean;
  assembled_in_member_state?: boolean;
  show_client_balance: boolean;
  subclients_id?: number | null;
  is_xls_imported?: boolean;
  recipient_clients_id?: number | null;
  recipient_subclients_id?: number | null;
  contract_number?: string | null;
  invoice_content_code?: string | null;
  invoice_content_text?: string | null;
  period_start_date?: string | null;
  period_end_date?: string | null;
  additional_info_content?: string | null;
  bank_payment_orders_id?: number | null;
  bank_accounts_id?: number | null;
  is_deleted?: boolean;
  items?: SaleInvoiceItem[];
  deliveries?: SaleInvoiceDelivery[];
  credit_invoices?: number[];
  journals?: number[];
  settlements?: number[];
  transactions?: number[];
}

export interface SaleInvoiceDeliveryOptions {
  can_send_einvoice: boolean;
  can_send_einvoice_reason?: string;
  can_send_email: boolean;
  can_send_email_addresses?: string;
}

export interface SaleInvoiceDeliveryRequest {
  send_einvoice?: boolean;
  send_email?: boolean;
  email_addresses?: string;
  email_subject?: string;
  email_body?: string;
}

// === Purchase Invoices ===

export interface PurchaseInvoiceItem {
  id?: number;
  cl_purchase_articles_id?: number;
  purchase_accounts_id?: number;
  purchase_accounts_dimensions_id?: number | null;
  cl_fringe_benefits_id?: number | null;
  amount?: number;
  unit?: string;
  unit_net_price?: number;
  total_net_price?: number;
  base_total_net_price?: number;
  cl_vat_articles_id?: number | null;
  vat_accounts_id?: number | null;
  vat_accounts_dimensions_id?: number | null;
  vat_rate_dropdown?: string;
  vat_rate?: number;
  vat_amount?: number;
  custom_title: string;
  projects_project_id?: number | null;
  projects_location_id?: number | null;
  projects_person_id?: number | null;
  reversed_vat_id?: number | null;
  products_id?: number | null;
  project_no_vat_gross_price?: number | null;
}

export interface PurchaseInvoice {
  id?: number;
  base_document_files_id?: number | null;
  bank_payment_orders_id?: number | null;
  clients_id: number;
  client_name: string;
  number: string;
  create_date: string;
  journal_date: string;
  status?: string;
  payment_status?: string;
  net_price?: number;
  vat_price?: number;
  gross_price?: number;
  payment_type?: string | null;
  bank_ref_number?: string | null;
  bank_account_no?: string | null;
  term_days: number;
  overdue_charge?: number | null;
  notes?: string | null;
  paid_in_cash?: boolean;
  cash_accounts_id?: number | null;
  cash_accounts_dimensions_id?: number | null;
  liability_accounts_id?: number;
  liability_accounts_dimensions_id?: number | null;
  cl_currencies_id: string;
  currency_rate?: number | null;
  base_net_price?: number;
  base_vat_price?: number;
  base_gross_price?: number;
  cash_payment_date?: string | null;
  subclients_id?: number | null;
  is_xls_imported?: boolean;
  items?: PurchaseInvoiceItem[];
  journals?: number[];
  settlements?: number[];
  transactions?: number[];
}

export interface CreatePurchaseInvoiceData extends Pick<PurchaseInvoice,
  "clients_id" |
  "client_name" |
  "number" |
  "create_date" |
  "journal_date" |
  "term_days" |
  "cl_currencies_id" |
  "currency_rate" |
  "base_net_price" |
  "base_vat_price" |
  "base_gross_price" |
  "liability_accounts_id" |
  "bank_ref_number" |
  "bank_account_no" |
  "notes" |
  "overdue_charge"
> {
  items: PurchaseInvoiceItem[];
}

// === Invoice Series ===

export interface InvoiceSeries {
  id?: number;
  is_active: boolean;
  is_default: boolean;
  number_prefix: string;
  number_start_value: number;
  term_days: number;
  overdue_charge?: number;
}

// === Bank Accounts ===

export interface BankAccount {
  id?: number;
  account_name_est: string;
  account_name_eng?: string;
  account_no: string;
  cl_banks_id?: number;
  bank_name?: string | null;
  bank_regcode?: string | null;
  iban_code?: string;
  swift_code?: string;
  start_sum?: number | null;
  day_limit?: number | null;
  credit_limit?: number | null;
  show_in_sale_invoices?: boolean;
  default_salary_account?: boolean;
  beneficiary_name?: string | null;
  accounts_dimensions_id?: number;
  clients_id?: number;
}

// === Chart of Accounts ===

export interface Account {
  id: number;
  balance_type: string;
  account_type_est: string;
  account_type_eng: string;
  name_est: string;
  name_eng: string;
  is_valid: boolean;
  allows_dimensions?: boolean;
  allows_deactivation: boolean;
  is_vat_account: boolean;
  is_fixed_asset: boolean;
  expenditure_accounts_id?: number | null;
  amortization_accounts_id?: number | null;
  transaction_in_bindable: boolean;
  transaction_out_bindable: boolean;
  priority?: number;
  cl_account_groups: string[];
  default_disabled: boolean;
  requires_client?: boolean;
  requires_positive_balance?: boolean;
  transaction_in_user_bindable: boolean;
  transaction_out_user_bindable: boolean;
  is_product_account: boolean;
  is_disabled?: boolean;
}

// === Account Dimensions ===

export interface AccountDimension {
  id?: number;
  accounts_id: number;
  title_est: string;
  title_eng?: string;
  cl_currencies_id?: string;
  is_deleted?: boolean;
  expenditure_accounts_dimensions_id?: number | null;
  amortization_accounts_dimensions_id?: number | null;
}

// === Currencies ===

export interface Currency {
  id: string;
  name_est: string;
  name_eng: string;
}

// === Sale Articles ===

export interface SaleArticle {
  id: number;
  group_est: string;
  group_eng: string;
  name_est: string;
  name_eng: string;
  accounts_id: number;
  vat_accounts_id?: number | null;
  vat_rate?: number | null;
  vat_type: number;
  is_valid: boolean;
  start_date?: string | null;
  end_date?: string | null;
  priority?: number;
  cl_account_groups: string[];
  description_est?: string | null;
  description_eng?: string | null;
}

// === Purchase Articles ===

export interface PurchaseArticle {
  id: number;
  level: number;
  name_est: string;
  name_eng: string;
  accounts_id?: number;
  vat_accounts_id?: number | null;
  cl_vat_articles_id?: number | null;
  vat_rate_dropdown?: string | null;
  vat_rate?: number | null;
  priority?: number;
  cl_account_groups: string[];
  is_disabled?: boolean;
}

// === Templates ===

export interface Template {
  id: number;
  name: string;
  is_default: boolean;
  cl_languages_id?: string;
}

// === Company Info ===

export interface CompanyInvoiceInfo {
  address?: string;
  email?: string;
  phone?: string;
  fax?: string;
  webpage?: string;
  cl_templates_id?: number;
  invoice_company_name?: string | null;
  invoice_email_subject?: string;
  invoice_email_body?: string;
  balance_email_subject?: string;
  balance_email_body?: string;
  balance_document_footer?: string;
}

export interface CompanyVatInfo {
  vat_number?: string;
  tax_refnumber?: string;
}
