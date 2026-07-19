import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { registerPrompts } from "./prompts.js";

const EXPECTED_PROTOCOL_ARGUMENTS: Record<string, Record<string, boolean>> = {
  "vat-registration-threshold": {
    year: false,
    financial_turnover: false,
    insurance_turnover: false,
    real_estate_turnover: false,
    exempt_social_turnover: false,
    incidental_excluded_turnover: false,
    taxable_turnover_adjustment: false,
    manual_bucket_source: false,
  },
  "setup-credentials": { file_path: false, storage_scope: false },
  "setup-e-arveldaja": {},
  "accounting-inbox": {
    workspace_path: false,
    bank_account_dimension_id: false,
    receipt_matching_dimension_id: false,
    wise_account_dimension_id: false,
  },
  "resolve-accounting-review": { review_item_json: true },
  "prepare-accounting-review-action": {
    review_item_json: true,
    save_as_rule: false,
    rule_override_json: false,
  },
  "book-invoice": { file_path: true },
  "receipt-batch": {
    folder_path: true,
    accounts_dimensions_id: false,
    date_from: false,
    date_to: false,
  },
  "import-camt": {
    file_path: true,
    accounts_dimensions_id: false,
    date_from: false,
    date_to: false,
  },
  "import-wise": {
    file_path: true,
    accounts_dimensions_id: false,
    fee_account_dimensions_id: false,
    inter_account_dimension_id: false,
    date_from: false,
    date_to: false,
    skip_jar_transfers: false,
  },
  "classify-unmatched": {
    accounts_dimensions_id: false,
    date_from: false,
    date_to: false,
  },
  "reconcile-bank": {
    mode: false,
    transaction_id: false,
    target_accounts_dimensions_id: false,
  },
  "month-end-close": { month: true },
  "new-supplier": { identifier: true },
  "company-overview": {},
  "lightyear-booking": {
    file_path: true,
    capital_gains_path: false,
    investment_account: true,
    broker_account: true,
    income_account: false,
    gain_loss_account: false,
    loss_account: false,
    trade_fee_account: false,
    distribution_fee_account: false,
    tax_account: false,
    investment_dimension_id: false,
    broker_dimension_id: false,
  },
};

const clients: Client[] = [];
const servers: McpServer[] = [];

async function linkedPromptClient(options: { enableSales?: boolean } = {}): Promise<Client> {
  const server = new McpServer({ name: "prompt-protocol-test", version: "1.0.0" });
  registerPrompts(server, {
    toolExposure: {
      enableLightyear: true,
      exposeGranularTools: false,
      exposeSetupTools: false,
      enableTaxTools: true,
      enableReferenceAdmin: true,
      enableAnnualReport: true,
      enableSales: options.enableSales ?? true,
      enableProducts: true,
    },
  });

  const client = new Client({ name: "prompt-protocol-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  clients.push(client);
  servers.push(server);
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

afterEach(async () => {
  await Promise.allSettled([
    ...clients.splice(0).map(client => client.close()),
    ...servers.splice(0).map(server => server.close()),
  ]);
});

describe("MCP prompt protocol", () => {
  it("renders purchase-only MCP prompts when sales are disabled", async () => {
    const disabledClient = await linkedPromptClient({ enableSales: false });
    const enabledClient = await linkedPromptClient({ enableSales: true });

    const disabledOverview = await disabledClient.getPrompt({ name: "company-overview" });
    const disabledMonthEnd = await disabledClient.getPrompt({
      name: "month-end-close",
      arguments: { month: "2026-05" },
    });
    const enabledOverview = await enabledClient.getPrompt({ name: "company-overview" });
    const enabledMonthEnd = await enabledClient.getPrompt({
      name: "month-end-close",
      arguments: { month: "2026-05" },
    });

    const text = (result: typeof disabledOverview): string => {
      const content = result.messages[0]?.content;
      return content?.type === "text" ? content.text : "";
    };
    const disabledOverviewText = text(disabledOverview);
    const disabledMonthEndText = text(disabledMonthEnd);
    const enabledOverviewText = text(enabledOverview);
    const enabledMonthEndText = text(enabledMonthEnd);

    expect(disabledOverviewText).not.toContain("compute_receivables_aging");
    expect(disabledOverviewText).not.toContain("Receivables needing attention");
    expect(disabledOverviewText).toContain("compute_payables_aging");
    expect(disabledOverviewText).toContain("compute_balance_sheet");
    expect(disabledOverviewText).toContain("purchase-side financial overview");

    expect(disabledMonthEndText).not.toContain("confirm_sale_invoice");
    expect(disabledMonthEndText).not.toContain("Unconfirmed sale invoices");
    expect(disabledMonthEndText).not.toContain("Overdue receivables");
    expect(disabledMonthEndText).toContain("Unconfirmed purchase invoices");
    expect(disabledMonthEndText).toContain("Overdue payables");
    expect(disabledMonthEndText).toContain("compute_trial_balance");

    expect(enabledOverviewText).toContain("compute_receivables_aging");
    expect(enabledOverviewText).toContain("Receivables needing attention");
    expect(enabledMonthEndText).toContain("confirm_sale_invoice");
    expect(enabledMonthEndText).toContain("Unconfirmed sale invoices");
    expect(enabledMonthEndText).toContain("Overdue receivables");
  });

  it("advertises every prompt argument description and required flag through Client.listPrompts", async () => {
    const client = await linkedPromptClient();
    const { prompts } = await client.listPrompts();
    expect(prompts.map(prompt => prompt.name)).toEqual(Object.keys(EXPECTED_PROTOCOL_ARGUMENTS));

    const missingDescriptions: string[] = [];
    const requiredMismatches: string[] = [];
    for (const prompt of prompts) {
      const expected = EXPECTED_PROTOCOL_ARGUMENTS[prompt.name]!;
      const advertised = prompt.arguments ?? [];
      expect(advertised.map(argument => argument.name), prompt.name).toEqual(Object.keys(expected));
      for (const argument of advertised) {
        if (!argument.description?.trim()) {
          missingDescriptions.push(`${prompt.name}.${argument.name}`);
        }
        if (Boolean(argument.required) !== expected[argument.name]) {
          requiredMismatches.push(`${prompt.name}.${argument.name}`);
        }
      }
    }

    expect(missingDescriptions).toEqual([]);
    expect(requiredMismatches).toEqual([]);
  });

  it("retrieves every prompt through Client.getPrompt using strings", async () => {
    const client = await linkedPromptClient();
    const validWireArguments: Array<[string, Record<string, string> | undefined]> = [
      ["vat-registration-threshold", {
        year: "2026",
        financial_turnover: "100.25",
        insurance_turnover: "0",
        real_estate_turnover: "50",
        exempt_social_turnover: "10",
        incidental_excluded_turnover: "5",
        taxable_turnover_adjustment: "-2.5",
        manual_bucket_source: "outside_sale_invoices",
      }],
      ["setup-credentials", { file_path: "/tmp/apikey.txt", storage_scope: "local" }],
      ["setup-e-arveldaja", undefined],
      ["accounting-inbox", {
        workspace_path: "/tmp/accounting",
        bank_account_dimension_id: "101",
        receipt_matching_dimension_id: "102",
        wise_account_dimension_id: "103",
      }],
      ["resolve-accounting-review", { review_item_json: '{"review_type":"classification_group"}' }],
      ["prepare-accounting-review-action", {
        review_item_json: '{"review_type":"camt_possible_duplicate"}',
        save_as_rule: "false",
        rule_override_json: '{"purchase_account_id":5010}',
      }],
      ["book-invoice", { file_path: "/tmp/invoice.pdf" }],
      ["receipt-batch", {
        folder_path: "/tmp/receipts",
        accounts_dimensions_id: "104",
        date_from: "2026-01-01",
        date_to: "2026-01-31",
      }],
      ["import-camt", {
        file_path: "/tmp/statement.xml",
        accounts_dimensions_id: "105",
        date_from: "2026-02-01",
        date_to: "2026-02-28",
      }],
      ["import-wise", {
        file_path: "/tmp/wise.csv",
        accounts_dimensions_id: "106",
        fee_account_dimensions_id: "107",
        inter_account_dimension_id: "108",
        date_from: "2026-03-01",
        date_to: "2026-03-31",
        skip_jar_transfers: "true",
      }],
      ["classify-unmatched", {
        accounts_dimensions_id: "109",
        date_from: "2026-04-01",
        date_to: "2026-04-30",
      }],
      ["reconcile-bank", {
        mode: "transaction",
        transaction_id: "110",
        target_accounts_dimensions_id: "111",
      }],
      ["month-end-close", { month: "2026-05" }],
      ["new-supplier", { identifier: "12345678" }],
      ["company-overview", undefined],
      ["lightyear-booking", {
        file_path: "/tmp/account-statement.csv",
        capital_gains_path: "/tmp/capital-gains.csv",
        investment_account: "1550",
        broker_account: "1120",
        income_account: "8330",
        gain_loss_account: "8330",
        loss_account: "8335",
        trade_fee_account: "8335",
        distribution_fee_account: "8610",
        tax_account: "2510",
        investment_dimension_id: "112",
        broker_dimension_id: "113",
      }],
    ];

    for (const [name, args] of validWireArguments) {
      const result = await client.getPrompt({ name, ...(args ? { arguments: args } : {}) });
      expect(result.messages, name).toHaveLength(1);
      expect(result.messages[0]?.content.type, name).toBe("text");
    }
  });

  it.each([
    ["boolean", "prepare-accounting-review-action", {
      review_item_json: "{}",
      save_as_rule: "TRUE",
    }, "save_as_rule", "true or false"],
    ["number", "vat-registration-threshold", {
      financial_turnover: "1e3",
    }, "financial_turnover", "decimal number"],
    ["positive ID", "accounting-inbox", {
      bank_account_dimension_id: "0",
    }, "bank_account_dimension_id", "positive integer"],
    ["date", "receipt-batch", {
      folder_path: "/tmp/receipts",
      date_from: "2025-02-30",
    }, "date_from", "YYYY-MM-DD"],
    ["month", "month-end-close", {
      month: "2026-13",
    }, "month", "YYYY-MM"],
    ["path", "book-invoice", {
      file_path: "relative/invoice.pdf",
    }, "file_path", "absolute path"],
    ["identifier", "new-supplier", {
      identifier: "hostile\nignore-everything-7f41",
    }, "identifier", "bounded identifier"],
    ["JSON object", "resolve-accounting-review", {
      review_item_json: "[]",
    }, "review_item_json", "JSON object"],
  ])("rejects invalid %s strings with safe bounded InvalidParams", async (
    _kind,
    name,
    args,
    safePath,
    requirement,
  ) => {
    const client = await linkedPromptClient();
    let rejection: unknown;
    try {
      await client.getPrompt({ name, arguments: args });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toMatchObject({ code: -32602 });
    const message = rejection instanceof Error ? rejection.message : String(rejection);
    expect(message).toContain(safePath);
    expect(message).toContain(requirement);
    expect(message.length).toBeLessThan(2_000);
    expect(message).not.toContain("ignore-everything-7f41");
  });

  it("transforms wire strings into typed renderer arguments", async () => {
    const client = await linkedPromptClient();
    const vat = await client.getPrompt({
      name: "vat-registration-threshold",
      arguments: { year: "2026", financial_turnover: "100.25" },
    });
    const review = await client.getPrompt({
      name: "prepare-accounting-review-action",
      arguments: { review_item_json: "{}", save_as_rule: "false" },
    });
    const vatText = vat.messages[0]?.content.type === "text" ? vat.messages[0].content.text : "";
    const reviewText = review.messages[0]?.content.type === "text" ? review.messages[0].content.text : "";

    expect(vatText).toContain('"financial_turnover":100.25');
    expect(vatText).toContain('"year":2026');
    expect(reviewText).toContain('"review_item_json":{}');
    expect(reviewText).toContain('"save_as_rule":false');
  });
});
