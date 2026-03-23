# e-arveldaja MCP Server

[![npm](https://img.shields.io/npm/v/e-arveldaja-mcp)](https://www.npmjs.com/package/e-arveldaja-mcp)

MCP server for the Estonian e-arveldaja (RIK e-Financials) REST API. 90 tools, 10 workflow prompts, 12 resources. Works with any MCP client — Claude Code, Codex CLI, Gemini CLI, Cursor, Windsurf, Cline, and others.

## Disclaimer

**This is an experimental, unofficial project.** It is not affiliated with, endorsed by, or in any way officially connected to RIK (Registrite ja Infosüsteemide Keskus) or the e-arveldaja / e-Financials service.

**Use entirely at your own risk.** This software interacts with live financial data and can create, modify, confirm, and delete accounting records (invoices, journal entries, transactions, etc.). The authors accept no responsibility for any data loss, incorrect bookings, or other damages resulting from the use of this software.

By using this software you acknowledge that:
- You are solely responsible for verifying all data and operations
- You should test thoroughly on the demo server before using with live data
- This is experimental software with no warranty of any kind

## Getting an API Key

1. Log in to [e-arveldaja](https://e-arveldaja.rik.ee/)
2. Go to **Seadistused** → **Üldised seadistused** → **Lisa uus juurdepääsuluba** (Settings → General settings → Add new access token)
3. Enter any name for the token
4. Find your public IP address (e.g. at [api.ipify.org](https://api.ipify.org)) and enter it in the allowed IP field. Multiple IPs can be separated by `;`
5. Save — download the `apikey.txt` file and place it in the working directory where you run your AI assistant

If you don't have a static IP address, you will need to update the allowed IP in e-arveldaja settings whenever your IP changes.

If requests later start failing with `401 Unauthorized`, the most common cause is that your public IP changed and no longer matches the allowed IP list. Check the current public IP yourself in a browser (for example, `https://api.ipify.org`) and update the whitelist in e-arveldaja if needed.

**Never commit the `apikey.txt` file to git.**

For the demo server, set the environment variable `EARVELDAJA_SERVER=demo`.

## Setup

### 1. Add the MCP server

Most AI assistants can set this up for you — just ask:

> "Add e-arveldaja-mcp as an MCP server using npx. The package is on npm."

If you prefer to do it manually:

**Claude Code:**
```bash
claude mcp add e-arveldaja -- npx -y e-arveldaja-mcp
```

**Other tools** (Cursor, Windsurf, Cline, Gemini CLI, Codex CLI, Antigravity) — add to your MCP config:
```json
{
  "mcpServers": {
    "e-arveldaja": {
      "command": "npx",
      "args": ["-y", "e-arveldaja-mcp"]
    }
  }
}
```

<details>
<summary>Config file locations by tool</summary>

| Tool | Config file |
|---|---|
| **Claude Code** | `~/.claude/settings.json` or project `.claude/settings.json` |
| **Codex CLI** | `~/.codex/config.toml` (TOML format) |
| **Gemini CLI** | `~/.gemini/settings.json` |
| **Google Antigravity** | MCP Store UI → Manage MCP Servers → raw config |
| **Cursor** | `.cursor/mcp.json` in your project |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |
| **Cline** | VS Code settings under `cline.mcpServers` |

</details>

### 2. Place your API key

Put the downloaded `apikey.txt` in the working directory where you run your AI assistant. That's it — the server finds it automatically.

For multiple companies, place multiple files (`apikey.txt`, `apikey-company2.txt`, etc.) and use `list_connections` / `switch_connection` to switch between them.

<details>
<summary>Alternative: environment variables</summary>

```bash
export EARVELDAJA_API_KEY_ID=...
export EARVELDAJA_API_PUBLIC_VALUE=...
export EARVELDAJA_API_PASSWORD=...
```

</details>

<details>
<summary>Building from source</summary>

```bash
git clone https://github.com/iseppo/e-arveldaja-mcp.git
cd e-arveldaja-mcp
npm install && npm run build
# Then use: "node", "/path/to/e-arveldaja-mcp/dist/index.js" instead of npx
```

</details>

## Workflows (MCP Prompts)

The server includes 10 built-in workflow prompts that any MCP client can discover and use. These guide the AI through multi-step accounting tasks:

| Prompt | Description |
|---|---|
| `book-invoice` | Book a purchase invoice from PDF: extract, validate, resolve supplier, preview, create, upload, confirm |
| `receipt-batch` | Scan a receipt folder, preview auto-bookable items, then batch-create after approval |
| `import-camt` | Parse CAMT.053 XML, preview imported bank transactions, then create after approval |
| `import-wise` | Preview Wise CSV import results, fees, duplicates, and Jar skips before execution |
| `classify-unmatched` | Group unmatched bank transactions, preview suggested booking actions, then apply after approval |
| `reconcile-bank` | Match bank transactions to invoices, auto-confirm or review manually |
| `month-end-close` | Blockers, missing docs, duplicates, trial balance, P&L, balance sheet |
| `new-supplier` | Create supplier with Estonian business registry lookup |
| `company-overview` | Financial dashboard: balance sheet, P&L, receivables, payables |
| `lightyear-booking` | Book Lightyear investment trades and distributions from CSV |

**Claude Code** also has these as slash commands: `/book-invoice`, `/receipt-batch`, `/import-camt`, `/import-wise`, `/classify-unmatched`, `/reconcile-bank`, `/month-end`, `/new-supplier`.

## Usage Examples

Once the MCP server is connected, just talk to your AI assistant in natural language:

### Enter purchase invoices from PDF files

> "Book this invoice PDF into e-arveldaja and match it to the bank payment"

The assistant will extract invoice data from the PDF, create a purchase invoice with the correct accounts and VAT rates, and match it to existing bank transactions.

### Batch-process a folder of invoices and receipts

> "Process all the invoices in the arved/ folder and book them into e-arveldaja"

The assistant will scan the folder, OCR-parse each PDF/JPG/PNG, extract invoice data, resolve suppliers, detect duplicates, create purchase invoices with correct VAT treatment, upload source documents, confirm, and match to bank transactions — all in one pass. Dry run by default so you can review before committing.
If invoice creation succeeds but a later step like document upload or confirmation fails, the tool now auto-invalidates the created purchase invoice and reports that file as failed instead of leaving a stray draft behind.

### Book Lightyear investment trades and income

Download your Lightyear account statement CSV and capital gains report, then:

> "Create e-arveldaja journal entries from these Lightyear CSVs"

The assistant will parse the trades, pair foreign currency conversions, calculate capital gains from the FIFO report, and create journal entries with the correct securities accounts. Dividends, fund distributions, and cash interest are also imported from the account statement CSV.

### Import bank statements (CAMT.053)

Download your bank statement as a CAMT.053 XML file (supported by LHV, Swedbank, SEB, Coop, Luminor), then:

> "Import bank transactions from my LHV statement XML into e-arveldaja"

The assistant will parse the ISO 20022 XML, create bank transactions with correct amounts and counterparties, detect duplicates by bank reference, and handle batched entries and mixed currencies. Dry run by default.

### Import Wise bank transactions

Download the regular Wise transactions CSV from the Transactions view, then:

> "Import my Wise transactions from transaction-history.csv into e-arveldaja"

The assistant will parse the CSV, create incoming and outgoing bank transactions from Wise's `Direction` field, and separate Wise fees into their own entries for proper expense accounting. Supports EUR and foreign currency card payments (USD etc.).

For now, this expects the normal transactions CSV export from Wise Transactions, not the special statement/report exports under Statements or Reports. Wise support is still lightly tested; if you hit an import issue, please open an issue or report it.

### Generate financial reports

> "Generate a P&L and balance sheet as of 28.02.2026"

### Reconcile bank transactions

> "Match unconfirmed bank transactions to invoices"

Inter-account transfer reconciliation is conservative: if multiple candidate matches have the same top confidence, it reports the transfer as ambiguous and skips confirmation instead of guessing.

### Month-end close

> "Run the month-end close checklist for February 2026"

### Estonian tax: dividends and owner expenses

> "Prepare a dividend package for 5000 EUR"

The assistant will compute the 22/78 corporate income tax, check retained earnings sufficiency and net assets against share capital (ÄS §157), and create the journal entry with correct postings.

> "Reimburse my business expense of 45.50 EUR from Bolt"


## Updating

How you update depends on how you set up the server:

### Using `npx`

If your MCP config runs `npx -y e-arveldaja-mcp`, you usually just need to restart your AI assistant or reload the MCP server. On the next start, `npx` will fetch the latest published version.

If your client keeps using an older cached version, force-refresh it once:

```bash
npx -y e-arveldaja-mcp@latest
```

Then restart the MCP server in your client.

### Running from a local git checkout

Pull the latest changes, reinstall dependencies if needed, rebuild, then restart your AI assistant:

```bash
git pull
npm install
npm run build
```

If your MCP config points to `dist/index.js`, the rebuild step is required after updating the source.

## Development

Run the integration suite with:

```bash
npm run test:integration
```

This now runs self-contained MCP surface checks by default against a locally spawned server process with fake test credentials. The live API integration checks remain opt-in and require real credentials plus:

```bash
EARVELDAJA_INTEGRATION_TEST=true npm run test:integration
```


## Good to know

- **Dry run by default.** Batch operations (bank import, Wise import, Lightyear booking, receipt processing, auto-confirm) preview results first. You must explicitly confirm or pass `execute=true` to create records.
- **Large datasets need date filters.** The server loads up to 200 pages of data per query. Companies with thousands of invoices or transactions should narrow reporting and reconciliation tools with date ranges — otherwise the tool will ask you to.
- **Caching.** API responses are cached for 2–5 minutes and automatically invalidated when you create, update, or delete records through the server. Changes made directly in the e-arveldaja web UI may take a few minutes to appear.
- **EUR by default.** All amounts are EUR unless a different currency is specified.
- **Multi-company.** Place multiple `apikey*.txt` files and use `list_connections` / `switch_connection`. Switching clears all cached data to prevent cross-company leaks.
- **Node.js 18+** required.
- **File access scope.** By default, file-reading tools can access supported files under the working directory and `/tmp`. Set `EARVELDAJA_ALLOWED_PATHS` (colon-separated) to allow additional directories, or `EARVELDAJA_ALLOW_HOME=true` to allow the entire home directory.

## Privacy

Document parsing (PDF, JPG, PNG) uses LiteParse OCR locally by default. If you set `EARVELDAJA_LITEPARSE_OCR_SERVER_URL`, the server will send documents to that configured OCR endpoint instead of staying fully local for OCR. Remote OCR endpoints must use `https`; plain `http` is only accepted for localhost / loopback OCR services. By default, the server may also read supported document files anywhere under your home directory and `/tmp`; set `EARVELDAJA_ALLOWED_PATHS` if you want a narrower local file boundary. In all cases, the extracted text is returned to your AI assistant via the MCP protocol, so it will be processed by whichever LLM you are using (Claude, Codex, Gemini, etc.). The server's own outbound connections are therefore limited to the e-arveldaja API (`rmp-api.rik.ee`), optionally the Estonian Business Registry (`ariregister.rik.ee`) for supplier lookups, and optionally your configured OCR server.

## Feedback and Bug Reports

Feature requests, bug reports, and invoices that don't parse correctly are welcome on the [GitHub Issues page](https://github.com/iseppo/e-arveldaja-mcp/issues).

If you'd rather not upload your invoice publicly, email it directly to indrek.seppo@gmail.com.

## License

[The Unlicense](LICENSE) — public domain. Do whatever you want with it.
