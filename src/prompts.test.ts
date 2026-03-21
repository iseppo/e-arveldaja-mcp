import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { registerPrompts } from "./prompts.js";
import { getProjectRoot } from "./paths.js";

function setupPromptServer() {
  const server = { registerPrompt: vi.fn() } as any;
  registerPrompts(server);
  return server;
}

function readPromptSurface(relativePath: string): string {
  return readFileSync(resolve(getProjectRoot(), relativePath), "utf8");
}

function getPromptText(
  server: { registerPrompt: ReturnType<typeof vi.fn> },
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const registration = server.registerPrompt.mock.calls.find(([promptName]) => promptName === name);
  if (!registration) {
    throw new Error(`Prompt ${name} was not registered`);
  }

  const handler = registration[2] as (args: Record<string, unknown>) => Promise<{
    messages: Array<{ content: { text: string } }>;
  }>;

  return handler(args).then(result => result.messages[0]!.content.text);
}

describe("registerPrompts", () => {
  it("registers the current prompt set without a VAT filing workflow", () => {
    const server = setupPromptServer();

    const names = server.registerPrompt.mock.calls.map(([name]) => name);
    expect(names).toEqual([
      "book-invoice",
      "reconcile-bank",
      "month-end-close",
      "new-supplier",
      "company-overview",
      "lightyear-booking",
    ]);
  });

  it("keeps the book-invoice prompt aligned with real tool parameters and output fields", async () => {
    const server = setupPromptServer();
    const text = await getPromptText(server, "book-invoice", { file_path: "/tmp/invoice.pdf" });

    expect(text).toContain("hints.raw_text");
    expect(text).toContain("llm_fallback");
    expect(text).toContain("source of truth");
    expect(text).toContain("clients_id: supplier_client_id");
    expect(text).toContain("supplier_client_id");
    expect(text).toContain("invoice_id: the invoice ID returned in step 11");
    expect(text).toContain("term_days");
    expect(text).toContain("api_response.created_object_id");
    expect(text).toContain("invoice_number: extracted invoice number");
    expect(text).toContain("gross_price: extracted gross total");
    expect(text).toContain("candidate_invoice_number_matches");
    expect(text).toContain("vat_accounts_id");
    expect(text).toContain("cl_vat_articles_id");
    expect(text).not.toContain("client_id: the supplier's client_id");
  });

  it("uses the real reconciliation execution flags and confirm_transaction payload", async () => {
    const server = setupPromptServer();
    const autoText = await getPromptText(server, "reconcile-bank", { mode: "auto" });
    const reviewText = await getPromptText(server, "reconcile-bank", { mode: "review" });

    expect(autoText).toContain("execute: false");
    expect(autoText).toContain("execute: true");
    expect(reviewText).toContain("distributions: JSON.stringify([match.distribution])");
    expect(reviewText).toContain("distribution_ready=false");
    expect(reviewText).toContain("prepare the distribution manually");
  });

  it("uses the real reporting tool parameter names in month-end and overview prompts", async () => {
    const server = setupPromptServer();
    const monthEndText = await getPromptText(server, "month-end-close", { month: "2026-03" });
    const overviewText = await getPromptText(server, "company-overview");

    expect(monthEndText).toContain('date_from: "2026-03-01"');
    expect(monthEndText).toContain('date_to: "2026-03-31"');
    expect(monthEndText).toContain("compute_balance_sheet` with:");
    expect(overviewText).toContain("compute_balance_sheet` with date_to:");
    expect(overviewText).toContain("date_from:");
    expect(overviewText).toContain("as_of_date:");
    expect(overviewText).not.toContain("start_date:");
    expect(overviewText).not.toContain("end_date:");
  });

  it("keeps new-supplier honest about what registry and VAT data is actually available", async () => {
    const server = setupPromptServer();
    const text = await getPromptText(server, "new-supplier", { identifier: "Acme OU" });

    expect(text).toContain('search_client` with name: "Acme OU"');
    expect(text).toContain("bank_account_no");
    expect(text).toContain("is_client: false");
    expect(text).toContain("is_supplier: true");
    expect(text).toContain("name-only lookup does not fetch Estonian Business Registry data");
    expect(text).toContain("does not fetch a VAT number from the registry lookup");
    expect(text).not.toContain("query:");
    expect(text).not.toContain("iban:");
    expect(text).not.toContain("VAT number if any");
  });

  it("keeps the Lightyear workflow explicit that portfolio value means accounting cost basis", async () => {
    const server = setupPromptServer();
    const text = await getPromptText(server, "lightyear-booking", {
      statement_path: "/tmp/statement.csv",
      investment_account: 1520,
      broker_account: 1120,
    });

    expect(text).toContain("ask the user for it before booking sells");
    expect(text).toContain("gain_loss_account");
    expect(text).toContain("tax_account");
    expect(text).toContain("If there are distributions in the statement, ask the user for an income_account number");
    expect(text).toContain("current accounting carrying value / cost basis");
    expect(text).toContain("Current portfolio carrying value / remaining cost basis");
    expect(text).not.toContain("Current portfolio value (from step 3)");
  });

  it("keeps shipped book-invoice markdown prompts aligned with MCP prompt safety rails", () => {
    for (const relativePath of ["workflows/book-invoice.md", ".claude/commands/book-invoice.md"]) {
      const text = readPromptSurface(relativePath);
      expect(text).toContain("hints.raw_text");
      expect(text).toContain("llm_fallback");
      expect(text).toContain("source of truth");
      expect(text).toContain("candidate_invoice_number_matches");
      expect(text).toContain("auto_create: false");
      expect(text).toContain("auto_create: true");
      expect(text).not.toMatch(/Read tool|visually/i);
      expect(text).not.toContain("Call `detect_duplicate_purchase_invoice` (no parameters needed)");
    }
  });

  it("keeps shipped reconcile-bank markdown prompts aligned with distribution_ready handling", () => {
    for (const relativePath of ["workflows/reconcile-bank.md", ".claude/commands/reconcile-bank.md"]) {
      const text = readPromptSurface(relativePath);
      expect(text).toContain("distribution_ready=false");
      expect(text).toContain("match.distribution");
      expect(text).toContain("prepare the distribution manually");
      expect(text).not.toContain("Call `get_transaction`");
    }
  });

  it("keeps shipped new-supplier markdown prompts duplicate-safe and registry-accurate", () => {
    for (const relativePath of ["workflows/new-supplier.md", ".claude/commands/new-supplier.md"]) {
      const text = readPromptSurface(relativePath);
      const lower = text.toLowerCase();
      expect(lower).toContain("do not create a duplicate");
      expect(lower).toContain("name-only lookup does not");
      expect(lower).toContain("does not fetch a vat number");
      expect(text).not.toContain("create a new one anyway");
    }
  });
});
