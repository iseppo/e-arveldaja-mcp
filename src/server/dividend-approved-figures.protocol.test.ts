import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./create-server.js";
import { resetApiCaches } from "../__fixtures__/nondeductible-vat.js";
import { makeAccount, makeJournal, makePosting } from "../__fixtures__/accounting.js";
import { parseToolPayload } from "../__fixtures__/mcp-response.js";
import type { DividendPackagePayload } from "../tools/estonian-tax.js";

vi.mock("../audit-log.js", async importOriginal => ({ ...await importOriginal<typeof import("../audit-log.js")>(), logAudit: vi.fn() }));

// The approved-report figures are optional in the schema and required by the
// handler: a real MCP request without them reaches the handler (strict input
// proxy included) and gets the business error with a ledger diagnostic.

const accounts = [
  makeAccount(1000, "D", "Varad", "Pangakonto"),
  makeAccount(2650, "C", "Kohustused", "Dividendivõlad"),
  makeAccount(2656, "C", "Kohustused", "Dividenditulumaksu võlg"),
  makeAccount(2900, "C", "Omakapital", "Osakapital või aktsiakapital nimiväärtuses"),
  makeAccount(2960, "C", "Omakapital", "Eelmiste perioodide jaotamata kasum (kahjum)"),
  makeAccount(4000, "C", "Tulud", "Müügitulu"),
  makeAccount(8900, "D", "Kulud", "Tulumaks"),
];
const journals = [
  makeJournal("2023-01-01", [makePosting(1000, "D", 2500), makePosting(2900, "C", 2500)], { id: 1 }),
  makeJournal("2024-01-01", [makePosting(1000, "D", 5000), makePosting(2960, "C", 5000)], { id: 2 }),
  makeJournal("2025-06-01", [makePosting(1000, "D", 20000), makePosting(4000, "C", 20000)], { id: 3 }),
];

function fetchAdapter() {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    let data: unknown;
    if (method === "GET" && path === "/invoice_info") data = { invoice_company_name: "Synthetic Dividend" };
    else if (method === "GET" && path === "/vat_info") data = { vat_number: null, tax_refnumber: "12345678" };
    else if (method === "GET" && path === "/accounts") data = accounts;
    else if (method === "GET" && path === "/clients/1") data = { id: 1, name: "Synthetic Shareholder" };
    else if (method === "GET" && path === "/journals") data = { items: journals, current_page: 1, total_pages: 1 };
    else throw new Error(`Unexpected synthetic fetch ${method} ${path}`);
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  });
}

async function connect() {
  const bootstrap = await createMcpServer({
    configs: [{ name: "synthetic", verifiedCompanyName: "Synthetic Dividend", config: {
      apiKeyId: "synthetic-id", apiPublicValue: "synthetic-public", apiPassword: "synthetic-secret", baseUrl: "https://demo-rmp-api.rik.ee/v1",
    } }],
    toolProfile: "standard",
    connect: false,
  });
  const client = new Client({ name: "dividend-approved-figures-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), bootstrap.server.connect(st)]);
  return { client, close: () => Promise.allSettled([client.close(), bootstrap.server.close()]) };
}

describe("prepare_dividend_package over MCP", () => {
  beforeEach(resetApiCaches);
  afterEach(() => vi.unstubAllGlobals());

  it("answers a request without the approved figures with approved_annual_report_figures_required and a diagnostic", async () => {
    const fetchMock = fetchAdapter();
    vi.stubGlobal("fetch", fetchMock);
    const { client, close } = await connect();
    try {
      const response = await client.callTool({
        name: "prepare_dividend_package",
        arguments: { net_dividend: 1000, shareholder_client_id: 1, effective_date: "2026-06-01", dry_run: false },
      });
      expect(response.isError).toBe(true);
      const data = parseToolPayload<DividendPackagePayload>((response.content as Array<{ text: string }>)[0]!.text);
      expect(data).toMatchObject({
        error_code: "approved_annual_report_figures_required",
        missing: ["approved_report_year", "approved_retained_earnings", "approved_profit_for_year"],
        diagnostic: { report_year_end: "2025-12-31", ledger_position_at_report_end: 25000 },
      });
      const writes = fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") !== "GET");
      expect(writes).toEqual([]);
    } finally {
      await close();
    }
  });

  it("refuses an undeclared argument but accepts the declared approved-report fields", async () => {
    vi.stubGlobal("fetch", fetchAdapter());
    const { client, close } = await connect();
    try {
      const unknown = await client.callTool({
        name: "prepare_dividend_package",
        arguments: { net_dividend: 1000, shareholder_client_id: 1, effective_date: "2026-06-01", approved_total: 25000 },
      });
      expect(unknown.isError).toBe(true);
      expect((unknown.content as Array<{ text: string }>)[0]!.text).toContain("Input validation error");
      const preview = await client.callTool({
        name: "prepare_dividend_package",
        arguments: {
          net_dividend: 1000, shareholder_client_id: 1, effective_date: "2026-06-01",
          approved_report_year: 2025, approved_retained_earnings: 5000, approved_profit_for_year: 20000,
        },
      });
      expect(preview.isError ?? false).toBe(false);
      const data = parseToolPayload<DividendPackagePayload>((preview.content as Array<{ text: string }>)[0]!.text);
      expect(data.lg1_components).toMatchObject({ distributable_profit: 25000, ledger_position_at_report_end: 25000 });
    } finally {
      await close();
    }
  });
});
