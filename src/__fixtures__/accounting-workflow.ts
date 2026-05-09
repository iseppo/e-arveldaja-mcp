import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, writeFileSync } from "fs";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";
import type { ApiContext } from "../tools/crud-tools.js";
import type { Account, AccountDimension, BankAccount, Client, Transaction } from "../types/api.js";

export type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

export interface MockToolServer {
  registerTool: ReturnType<typeof vi.fn>;
}

export interface MockAccountingWorkflowApi {
  clients: {
    findByCode: ReturnType<typeof vi.fn>;
    findByName: ReturnType<typeof vi.fn>;
    listAll: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  journals: {
    listAllWithPostings: ReturnType<typeof vi.fn>;
  };
  products: Record<string, never>;
  saleInvoices: {
    listAll: ReturnType<typeof vi.fn>;
  };
  purchaseInvoices: {
    listAll: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    createAndSetTotals: ReturnType<typeof vi.fn>;
    confirmWithTotals: ReturnType<typeof vi.fn>;
    invalidate: ReturnType<typeof vi.fn>;
  };
  transactions: {
    listAll: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
  };
  readonly: {
    getBankAccounts: ReturnType<typeof vi.fn>;
    getAccountDimensions: ReturnType<typeof vi.fn>;
    getAccounts: ReturnType<typeof vi.fn>;
    getPurchaseArticles: ReturnType<typeof vi.fn>;
    getVatInfo: ReturnType<typeof vi.fn>;
    getInvoiceInfo: ReturnType<typeof vi.fn>;
  };
}

export interface AccountingWorkflowApiOptions {
  clientRows?: unknown[];
  transactionRows?: unknown[];
  transactionDetails?: Record<number, unknown>;
  missingTransactionDetail?: "confirmed_stub" | "undefined";
  purchaseInvoiceRows?: unknown[];
  purchaseInvoiceDetails?: Record<number, unknown>;
  saleInvoiceRows?: unknown[];
  bankAccounts?: unknown[];
  accountDimensions?: unknown[];
  accounts?: unknown[];
  purchaseArticles?: unknown[];
  clients?: Partial<MockAccountingWorkflowApi["clients"]>;
  journals?: Partial<MockAccountingWorkflowApi["journals"]>;
  saleInvoices?: Partial<MockAccountingWorkflowApi["saleInvoices"]>;
  purchaseInvoices?: Partial<MockAccountingWorkflowApi["purchaseInvoices"]>;
  transactions?: Partial<MockAccountingWorkflowApi["transactions"]>;
  readonly?: Partial<MockAccountingWorkflowApi["readonly"]>;
}

export function createMockToolServer(): MockToolServer & McpServer {
  return { registerTool: vi.fn() } as unknown as MockToolServer & McpServer;
}

export function getRegisteredToolHandler(server: MockToolServer, toolName: string): ToolHandler {
  const registration = server.registerTool.mock.calls.find(([name]) => name === toolName) as
    | [string, unknown, ToolHandler]
    | undefined;
  if (!registration) throw new Error(`Tool '${toolName}' was not registered`);
  return registration[2];
}

export function createAccountingWorkflowApi(options: AccountingWorkflowApiOptions = {}): MockAccountingWorkflowApi & ApiContext {
  const api: MockAccountingWorkflowApi = {
    clients: {
      findByCode: vi.fn().mockResolvedValue(undefined),
      findByName: vi.fn().mockResolvedValue([]),
      listAll: vi.fn().mockResolvedValue(options.clientRows ?? []),
      create: vi.fn().mockResolvedValue({ id: 7001 }),
      ...options.clients,
    },
    journals: {
      listAllWithPostings: vi.fn().mockResolvedValue([]),
      ...options.journals,
    },
    products: {},
    saleInvoices: {
      listAll: vi.fn().mockResolvedValue(options.saleInvoiceRows ?? []),
      ...options.saleInvoices,
    },
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue(options.purchaseInvoiceRows ?? []),
      get: vi.fn().mockImplementation(async (id: number) => {
        const detail = options.purchaseInvoiceDetails?.[id];
        if (!detail) throw new Error(`Missing purchase invoice ${id}`);
        return detail;
      }),
      createAndSetTotals: vi.fn().mockResolvedValue({ id: 9001 }),
      confirmWithTotals: vi.fn().mockResolvedValue({}),
      invalidate: vi.fn().mockResolvedValue({}),
      ...options.purchaseInvoices,
    },
    transactions: {
      listAll: vi.fn().mockResolvedValue(options.transactionRows ?? []),
      get: vi.fn().mockImplementation(async (id: number) => {
        const detail = options.transactionDetails?.[id];
        if (detail) return detail;
        return options.transactionRows?.find((transaction) =>
          typeof transaction === "object" && transaction !== null && "id" in transaction && transaction.id === id
        ) ?? (options.missingTransactionDetail === "undefined"
          ? undefined
          : { id, status: "CONFIRMED", is_deleted: false });
      }),
      create: vi.fn().mockResolvedValue({ created_object_id: 9001 }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      confirm: vi.fn().mockResolvedValue({}),
      ...options.transactions,
    },
    readonly: {
      getBankAccounts: vi.fn().mockResolvedValue(options.bankAccounts ?? []),
      getAccountDimensions: vi.fn().mockResolvedValue(options.accountDimensions ?? []),
      getAccounts: vi.fn().mockResolvedValue(options.accounts ?? []),
      getPurchaseArticles: vi.fn().mockResolvedValue(options.purchaseArticles ?? []),
      getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
      getInvoiceInfo: vi.fn().mockResolvedValue({ invoice_company_name: "Seppo AI OÜ" }),
      ...options.readonly,
    },
  };

  return api as MockAccountingWorkflowApi & ApiContext;
}

export function fixtureBankAccount(overrides: Partial<BankAccount> = {}): BankAccount {
  return {
    accounts_dimensions_id: 101,
    account_name_est: "LHV põhikonto",
    account_no: "EE637700771011212909",
    iban_code: "EE637700771011212909",
    ...overrides,
  };
}

export function fixtureAccountDimension(overrides: Partial<AccountDimension> = {}): AccountDimension {
  return {
    id: 101,
    accounts_id: 1020,
    title_est: "LHV põhikonto",
    is_deleted: false,
    ...overrides,
  };
}

export function fixtureAccount(overrides: Partial<Account> & Pick<Account, "id" | "name_est">): Account {
  return {
    balance_type: "D",
    account_type_est: "Kulud",
    account_type_eng: "Expenses",
    name_eng: overrides.name_est,
    is_valid: true,
    allows_deactivation: false,
    is_vat_account: false,
    is_fixed_asset: false,
    transaction_in_bindable: false,
    transaction_out_bindable: false,
    transaction_in_user_bindable: false,
    transaction_out_user_bindable: false,
    is_product_account: false,
    cl_account_groups: [],
    default_disabled: false,
    ...overrides,
  };
}

export function fixtureClient(overrides: Partial<Client> & Pick<Client, "id" | "name">): Client {
  return {
    is_client: false,
    is_supplier: true,
    cl_code_country: "EE",
    is_member: false,
    send_invoice_to_email: false,
    send_invoice_to_accounting_email: false,
    is_deleted: false,
    ...overrides,
  };
}

export function fixtureTransaction(overrides: Partial<Transaction> & Pick<Transaction, "id" | "amount" | "date">): Transaction {
  return {
    accounts_dimensions_id: 100,
    type: "C",
    cl_currencies_id: "EUR",
    status: "PROJECT",
    description: "",
    bank_account_name: "",
    bank_account_no: "",
    ref_number: "",
    bank_ref_number: "",
    is_deleted: false,
    ...overrides,
  };
}

export interface AccountingWorkflowWorkspaceOptions {
  includeCamt?: boolean;
  includeWise?: boolean;
  includeReceipts?: boolean;
  camtIban?: string;
}

export function fixtureCamtXml(options: { iban?: string } = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>stmt-1</Id>
      <Acct>
        <Id><IBAN>${options.iban ?? "EE637700771011212909"}</IBAN></Id>
        <Ccy>EUR</Ccy>
      </Acct>
      <Ntry>
        <Amt Ccy="EUR">10.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-02-01</Dt></BookgDt>
        <AcctSvcrRef>REF-VOID-1</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <Refs>
              <AcctSvcrRef>REF-VOID-1</AcctSvcrRef>
            </Refs>
            <AmtDtls>
              <TxAmt><Amt Ccy="EUR">10.00</Amt></TxAmt>
            </AmtDtls>
            <RltdPties>
              <Cdtr><Nm>Vendor OÜ</Nm></Cdtr>
            </RltdPties>
            <RmtInf>
              <Ustrd>Test payment</Ustrd>
            </RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
}

export function fixtureCamtStatementXml(options: { iban?: string } = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Acct>
        <Id><IBAN>${options.iban ?? "EE637700771011212909"}</IBAN></Id>
      </Acct>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
}

export function fixtureWiseCsv(): string {
  return [
    "Source amount (after fees),Target amount (after fees),Exchange rate",
    "10,10,1",
  ].join("\n");
}

export async function createAccountingWorkflowWorkspace(
  options: AccountingWorkflowWorkspaceOptions = {},
): Promise<string> {
  const root = await mkdirTemp("accounting-inbox-");

  if (options.includeCamt !== false) {
    await writeFile(join(root, "statement.xml"), fixtureCamtStatementXml({ iban: options.camtIban }));
  }

  if (options.includeWise !== false) {
    const wiseDir = join(root, "wise");
    await mkdir(wiseDir, { recursive: true });
    await writeFile(join(wiseDir, "transaction-history.csv"), fixtureWiseCsv());
  }

  if (options.includeReceipts !== false) {
    const receiptsDir = join(root, "receipts");
    await mkdir(receiptsDir, { recursive: true });
    await writeFile(join(receiptsDir, "receipt-1.pdf"), "fake pdf");
    await writeFile(join(receiptsDir, "receipt-2.jpg"), "fake jpg");
  }

  return root;
}

export function createReceiptFolder(files: Record<string, string> = { "receipt.pdf": "%PDF-1.4\n" }): string {
  const root = mkdtempSync(join(tmpdir(), "receipt-batch-wrapper-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents, "utf-8");
  }
  return root;
}

async function mkdirTemp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
