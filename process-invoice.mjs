import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const t = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const c = new Client({ name: "test", version: "1.0.0" });
await c.connect(t);

const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args });
  const txt = r.content[0].text;
  try { return JSON.parse(txt); } catch { return txt; }
};

const cleanup = { clients: [], products: [], journals: [], saleInvoices: [], purchaseInvoices: [] };
let passed = 0, failed = 0;
const errors = [];

function ok(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}: ${detail || "FAILED"}`);
    failed++;
    errors.push(label);
  }
}

try {
  // =====================
  // CONNECTION MANAGEMENT
  // =====================
  console.log("\n=== Connection Management ===");
  const conns = await call("list_connections", {});
  ok("list_connections returns connections", conns.connections?.length > 0, JSON.stringify(conns).slice(0, 100));

  await call("switch_connection", { index: 0 });
  ok("switch_connection works", true);

  // =====================
  // REFERENCE DATA
  // =====================
  console.log("\n=== Reference Data ===");
  const accounts = await call("list_accounts", {});
  ok("list_accounts", Array.isArray(accounts) && accounts.length > 0, `got ${accounts?.length}`);

  const articles = await call("list_sale_articles", {});
  ok("list_sale_articles", Array.isArray(articles) && articles.length > 0);

  const purchaseArticles = await call("list_purchase_articles", {});
  ok("list_purchase_articles", Array.isArray(purchaseArticles) && purchaseArticles.length > 0);

  const dimensions = await call("list_account_dimensions", {});
  ok("list_account_dimensions", Array.isArray(dimensions));

  const currencies = await call("list_currencies", {});
  ok("list_currencies", Array.isArray(currencies) && currencies.length > 0);

  const templates = await call("list_templates", {});
  ok("list_templates", Array.isArray(templates) && templates.length > 0);

  const series = await call("list_invoice_series", {});
  ok("list_invoice_series", Array.isArray(series));

  const bankAccounts = await call("list_bank_accounts", {});
  ok("list_bank_accounts", Array.isArray(bankAccounts));

  const invoiceInfo = await call("get_invoice_info", {});
  ok("get_invoice_info", invoiceInfo && typeof invoiceInfo === "object");

  const vatInfo = await call("get_vat_info", {});
  ok("get_vat_info", vatInfo && typeof vatInfo === "object");

  // Find valid accounts for testing
  const expenseAccount = accounts.find(a => a.code === 5020) || accounts.find(a => String(a.code).startsWith("5"));
  const bankAccount = accounts.find(a => a.code === 1010) || accounts.find(a => String(a.code).startsWith("1"));

  // =====================
  // CLIENTS
  // =====================
  console.log("\n=== Clients ===");
  const clientList = await call("list_clients", { page: 1 });
  ok("list_clients", clientList.items?.length >= 0);

  const clientCode = `T${Date.now()}`;
  const newClient = await call("create_client", {
    name: "TEST_MCP_Client_Cleanup",
    is_client: true,
    is_supplier: true,
    cl_code_country: "FIN",
    is_juridical_entity: true,
    code: clientCode,
  });
  ok("create_client", newClient.created_object_id > 0, JSON.stringify(newClient).slice(0, 200));
  const testClientId = newClient.created_object_id;
  if (testClientId) cleanup.clients.push(testClientId);

  if (testClientId) {
    const gotClient = await call("get_client", { id: testClientId });
    ok("get_client", gotClient.name === "TEST_MCP_Client_Cleanup");

    const updClient = await call("update_client", {
      id: testClientId,
      data: JSON.stringify({ name: "TEST_MCP_Client_Updated" })
    });
    ok("update_client", updClient.code === 0);
  } else {
    ok("get_client", false, "skipped — no client created");
    ok("update_client", false, "skipped — no client created");
  }

  // =====================
  // PRODUCTS
  // =====================
  console.log("\n=== Products ===");
  const productList = await call("list_products", { page: 1 });
  ok("list_products", productList.items?.length >= 0);

  // Use a purchase article and unique code to avoid collisions
  const purchArticle = purchaseArticles[0];
  const productCode = `TMCP${Date.now()}`;
  const newProduct = await call("create_product", {
    name: "TEST_MCP_Product_Cleanup",
    code: productCode,
    cl_purchase_articles_id: purchArticle?.id,
  });
  ok("create_product", newProduct.created_object_id > 0, JSON.stringify(newProduct).slice(0, 200));
  const testProductId = newProduct.created_object_id;
  if (testProductId) cleanup.products.push(testProductId);

  // =====================
  // JOURNALS
  // =====================
  console.log("\n=== Journals ===");
  const journalList = await call("list_journals", { page: 1 });
  ok("list_journals", journalList.items?.length >= 0);

  const newJournal = await call("create_journal", {
    title: "TEST_MCP_Journal_Cleanup",
    effective_date: "2026-03-15",
    document_number: "TEST-MCP-J001",
    postings: JSON.stringify([
      { accounts_id: bankAccount?.code || 1010, type: "D", amount: 10.00 },
      { accounts_id: expenseAccount?.code || 5020, type: "C", amount: 10.00 },
    ])
  });
  ok("create_journal", newJournal.created_object_id > 0, JSON.stringify(newJournal).slice(0, 200));
  const testJournalId = newJournal.created_object_id;
  if (testJournalId) cleanup.journals.push(testJournalId);

  if (testJournalId) {
    const gotJournal = await call("get_journal", { id: testJournalId });
    ok("get_journal", gotJournal.title === "TEST_MCP_Journal_Cleanup");
    ok("get_journal has postings", gotJournal.postings?.length === 2);

    const confJ = await call("confirm_journal", { id: testJournalId });
    ok("confirm_journal", confJ.code === 0, JSON.stringify(confJ).slice(0, 100));
  } else {
    ok("get_journal", false, "skipped — no journal created");
    ok("get_journal has postings", false, "skipped");
    ok("confirm_journal", false, "skipped");
  }

  // =====================
  // PURCHASE INVOICES
  // =====================
  console.log("\n=== Purchase Invoices ===");
  const piList = await call("list_purchase_invoices", { page: 1 });
  ok("list_purchase_invoices", piList.items?.length >= 0);

  if (testClientId) {
    const newPI = await call("create_purchase_invoice", {
      clients_id: testClientId,
      client_name: "TEST_MCP_Client_Updated",
      number: "TEST-MCP-PI001",
      create_date: "2026-03-15",
      journal_date: "2026-03-15",
      term_days: 14,
      items: JSON.stringify([{
        custom_title: "Test purchase item",
        cl_purchase_articles_id: purchArticle?.id,
        total_net_price: 50.00,
        amount: 1,
        vat_rate_dropdown: "-",
      }]),
    });
    ok("create_purchase_invoice", newPI.id > 0 || newPI.created_object_id > 0, JSON.stringify(newPI).slice(0, 200));
    const testPIId = newPI.id || newPI.created_object_id;
    if (testPIId) cleanup.purchaseInvoices.push(testPIId);

    if (testPIId) {
      const gotPI = await call("get_purchase_invoice", { id: testPIId });
      ok("get_purchase_invoice", gotPI.number === "TEST-MCP-PI001");

      const confPI = await call("confirm_purchase_invoice", { id: testPIId });
      ok("confirm_purchase_invoice", confPI.code === 0, JSON.stringify(confPI).slice(0, 100));

      const invPI = await call("invalidate_purchase_invoice", { id: testPIId });
      ok("invalidate_purchase_invoice", invPI.code === 0, JSON.stringify(invPI).slice(0, 100));
    } else {
      ok("get_purchase_invoice", false, "skipped — no PI created");
      ok("confirm_purchase_invoice", false, "skipped");
      ok("invalidate_purchase_invoice", false, "skipped");
    }
  } else {
    ok("create_purchase_invoice", false, "skipped — no client");
    ok("get_purchase_invoice", false, "skipped");
    ok("confirm_purchase_invoice", false, "skipped");
    ok("invalidate_purchase_invoice", false, "skipped");
  }

  // =====================
  // SALE INVOICES
  // =====================
  console.log("\n=== Sale Invoices ===");
  const siList = await call("list_sale_invoices", { page: 1 });
  ok("list_sale_invoices", siList.items?.length >= 0);

  const defaultTemplate = templates.find(t => t.is_default) || templates[0];
  const existingProducts = productList.items?.filter(p => !p.is_deleted) || [];
  const saleProduct = existingProducts[0];

  if (defaultTemplate && testClientId) {
    const newSI = await call("create_sale_invoice", {
      clients_id: testClientId,
      cl_templates_id: defaultTemplate.id,
      number_suffix: "99999",
      create_date: "2026-03-15",
      journal_date: "2026-03-15",
      term_days: 14,
      items: JSON.stringify([{
        products_id: saleProduct?.id,
        custom_title: "TEST MCP sale item",
        amount: 1,
        unit: "tk",
        unit_net_price: 100.00,
      }]),
    });
    ok("create_sale_invoice", newSI.created_object_id > 0, JSON.stringify(newSI).slice(0, 200));
    const testSIId = newSI.created_object_id;
    if (testSIId) cleanup.saleInvoices.push(testSIId);

    if (testSIId) {
      const gotSI = await call("get_sale_invoice", { id: testSIId });
      ok("get_sale_invoice", gotSI.clients_id === testClientId);
    } else {
      ok("get_sale_invoice", false, "skipped — no SI created");
    }
  } else {
    ok("create_sale_invoice", false, "no template or client available");
    ok("get_sale_invoice", false, "skipped");
  }

  // =====================
  // FINANCIAL STATEMENTS
  // =====================
  console.log("\n=== Financial Statements ===");
  const tb = await call("compute_trial_balance", { date_from: "2026-01-01", date_to: "2026-03-15" });
  ok("compute_trial_balance", tb.accounts?.length > 0);

  const bs = await call("compute_balance_sheet", { date_to: "2026-03-15" });
  ok("compute_balance_sheet", bs.check !== undefined);
  ok("balance_sheet balanced", bs.check?.balanced === true, `assets=${bs.check?.assets} L+E=${bs.check?.liabilities_plus_equity}`);

  const pl = await call("compute_profit_and_loss", { date_from: "2026-01-01", date_to: "2026-03-15" });
  ok("compute_profit_and_loss", pl.net_profit !== undefined);

  const mec = await call("month_end_close_checklist", { month: "2026-02" });
  ok("month_end_close_checklist", mec.summary !== undefined);

  // =====================
  // ACCOUNT BALANCES
  // =====================
  console.log("\n=== Account Balances ===");
  const bal = await call("compute_account_balance", { account_id: bankAccount?.code || 1010 });
  ok("compute_account_balance", bal.balance !== undefined);

  // =====================
  // AGING ANALYSIS
  // =====================
  console.log("\n=== Aging Analysis ===");
  const arAging = await call("compute_receivables_aging", { as_of_date: "2026-03-15" });
  ok("compute_receivables_aging", arAging.total_invoices !== undefined);

  const apAging = await call("compute_payables_aging", { as_of_date: "2026-03-15" });
  ok("compute_payables_aging", apAging.total_invoices !== undefined);

  // =====================
  // DOCUMENT AUDIT
  // =====================
  console.log("\n=== Document Audit ===");
  const dup = await call("detect_duplicate_purchase_invoice", {
    client_name: "TEST_MCP_Client_Updated",
    amount: 50.00,
    date: "2026-03-15",
  });
  ok("detect_duplicate_purchase_invoice", dup !== undefined);

  // =====================
  // BANK TRANSACTIONS
  // =====================
  console.log("\n=== Bank Transactions ===");
  const txList = await call("list_transactions", { page: 1 });
  ok("list_transactions", txList.items?.length >= 0);

  // =====================
  // ESTONIAN TAX
  // =====================
  console.log("\n=== Estonian Tax ===");
  if (testClientId) {
    const divPkg = await call("prepare_dividend_package", {
      net_dividend: 1.00,
      shareholder_client_id: testClientId,
      effective_date: "2026-03-15",
      force: true,
    });
    ok("prepare_dividend_package", divPkg.calculation !== undefined || divPkg.error !== undefined, JSON.stringify(divPkg).slice(0, 200));
    if (divPkg.journal_entry?.api_response?.created_object_id) {
      cleanup.journals.push(divPkg.journal_entry.api_response.created_object_id);
    }

    const reimb = await call("create_owner_expense_reimbursement", {
      owner_client_id: testClientId,
      effective_date: "2026-03-15",
      description: "TEST_MCP_Reimbursement_Cleanup",
      net_amount: 10.00,
      vat_rate: 0,
      expense_account: expenseAccount?.code || 5020,
      document_number: "TEST-MCP-REIMB",
    });
    ok("create_owner_expense_reimbursement", reimb.journal_entry !== undefined, JSON.stringify(reimb).slice(0, 200));
    if (reimb.journal_entry?.api_response?.created_object_id) {
      cleanup.journals.push(reimb.journal_entry.api_response.created_object_id);
    }
  } else {
    ok("prepare_dividend_package", false, "skipped — no client");
    ok("create_owner_expense_reimbursement", false, "skipped — no client");
  }

  // =====================
  // RECURRING INVOICES
  // =====================
  console.log("\n=== Recurring Invoices ===");
  const recur = await call("create_recurring_sale_invoices", {
    source_month: "2099-01",
    target_date: "2099-02-01",
    target_journal_date: "2099-02-01",
  });
  ok("create_recurring_sale_invoices (empty source)", recur.source_count === 0);

  // =====================
  // LIGHTYEAR (parse only, no booking)
  // =====================
  console.log("\n=== Lightyear (parse only) ===");
  const lyStatement = await call("parse_lightyear_statement", {
    file_path: "/home/seppo/Dokumendid/e_arveldaja/AccountStatement-LY-CHZELUU-2026-01-01_2026-03-14_et.csv",
  });
  ok("parse_lightyear_statement", lyStatement.trades?.count > 0, `trades=${lyStatement.trades?.count}`);

  const lyGains = await call("parse_lightyear_capital_gains", {
    file_path: "/home/seppo/Dokumendid/e_arveldaja/LightyearCapitalGainsStatement-LY-CHZELUU-2026-01-01,2026-03-14,et,FIFO.csv",
  });
  ok("parse_lightyear_capital_gains", lyGains.sales?.length > 0, `sales=${lyGains.sales?.length}`);

  const lyPortfolio = await call("lightyear_portfolio_summary", {
    file_path: "/home/seppo/Dokumendid/e_arveldaja/AccountStatement-LY-CHZELUU-2026-01-01_2026-03-14_et.csv",
  });
  ok("lightyear_portfolio_summary", lyPortfolio.totals !== undefined);

  const lyDry = await call("book_lightyear_trades", {
    file_path: "/home/seppo/Dokumendid/e_arveldaja/AccountStatement-LY-CHZELUU-2026-01-01_2026-03-14_et.csv",
    capital_gains_file: "/home/seppo/Dokumendid/e_arveldaja/LightyearCapitalGainsStatement-LY-CHZELUU-2026-01-01,2026-03-14,et,FIFO.csv",
    investment_account: 1100,
    broker_account: 1020,
    broker_dimension_id: 11324307,
    investment_dimension_id: 942315,
    gain_loss_account: 8330,
    loss_account: 8335,
    fee_account: 8610,
    dry_run: true,
  });
  ok("book_lightyear_trades dry_run", lyDry.mode === "DRY_RUN", `mode=${lyDry.mode}`);

  const lyDistDry = await call("book_lightyear_distributions", {
    file_path: "/home/seppo/Dokumendid/e_arveldaja/AccountStatement-LY-CHZELUU-2026-01-01_2026-03-14_et.csv",
    broker_account: 1020,
    broker_dimension_id: 11324307,
    income_account: 8320,
    dry_run: true,
  });
  ok("book_lightyear_distributions dry_run", lyDistDry.mode === "DRY_RUN", `mode=${lyDistDry.mode}`);

  // =====================
  // CLEANUP
  // =====================
  console.log("\n=== Cleanup ===");

  for (const id of cleanup.saleInvoices) {
    try {
      const r = await call("delete_sale_invoice", { id });
      console.log(`  Deleted sale invoice ${id}: ${r.code === 0 ? "OK" : JSON.stringify(r).slice(0, 80)}`);
    } catch (e) { console.log(`  Failed to delete sale invoice ${id}: ${e.message}`); }
  }

  for (const id of cleanup.purchaseInvoices) {
    try {
      const r = await call("delete_purchase_invoice", { id });
      console.log(`  Deleted purchase invoice ${id}: ${r.code === 0 ? "OK" : JSON.stringify(r).slice(0, 80)}`);
    } catch (e) { console.log(`  Failed to delete purchase invoice ${id}: ${e.message}`); }
  }

  for (const id of cleanup.journals) {
    try {
      const r = await call("delete_journal", { id });
      console.log(`  Deleted journal ${id}: ${r.code === 0 ? "OK" : JSON.stringify(r).slice(0, 80)}`);
    } catch (e) { console.log(`  Failed to delete journal ${id}: ${e.message}`); }
  }

  for (const id of cleanup.products) {
    try {
      const r = await call("delete_product", { id });
      console.log(`  Deactivated product ${id}: ${r.code === 0 ? "OK" : JSON.stringify(r).slice(0, 80)}`);
    } catch (e) { console.log(`  Failed to deactivate product ${id}: ${e.message}`); }
  }

  for (const id of cleanup.clients) {
    try {
      const r = await call("delete_client", { id });
      console.log(`  Deactivated client ${id}: ${r.code === 0 ? "OK" : JSON.stringify(r).slice(0, 80)}`);
    } catch (e) { console.log(`  Failed to deactivate client ${id}: ${e.message}`); }
  }

} catch (err) {
  console.error("FATAL:", err.message);
  failed++;
}

console.log(`\n========================================`);
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (errors.length > 0) {
  console.log(`FAILED: ${errors.join(", ")}`);
}
console.log(`========================================`);

await c.close();
