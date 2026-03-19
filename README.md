# e-arveldaja MCP Server

[![npm](https://img.shields.io/npm/v/e-arveldaja-mcp)](https://www.npmjs.com/package/e-arveldaja-mcp)

MCP server for the Estonian e-arveldaja (RIK e-Financials) REST API. 90 tools, 7 workflow prompts, 12 resources. Works with any MCP client — Claude Code, Codex CLI, Gemini CLI, Cursor, Windsurf, Cline, and others.

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
4. Find your public IP address (e.g. at [whatismyipaddress.com](https://whatismyipaddress.com/)) and enter it in the allowed IP field. Multiple IPs can be separated by `;`
5. Save — download the `apikey.txt` file and place it in the working directory where you run your AI assistant

If you don't have a static IP address, you will need to update the allowed IP in e-arveldaja settings whenever your IP changes.

**Never commit the `apikey.txt` file to git.**

For the demo server, set the environment variable `EARVELDAJA_SERVER=demo`.

## Setup

### 1. Add the MCP server

Most AI assistants can set this up for you — just ask:

> "Add the e-arveldaja-mcp npm package as an MCP server"

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

The server includes 7 built-in workflow prompts that any MCP client can discover and use. These guide the AI assistant through multi-step accounting tasks:

| Prompt | Description |
|---|---|
| `book-invoice` | Book a purchase invoice from PDF: extract, validate, resolve supplier, create, upload, confirm |
| `reconcile-bank` | Match bank transactions to invoices, auto-confirm or review manually |
| `month-end-close` | Blockers, missing docs, duplicates, trial balance, P&L, balance sheet |
| `new-supplier` | Create supplier with Estonian business registry lookup |
| `company-overview` | Financial dashboard: balance sheet, P&L, receivables, payables |
| `quarterly-vat` | Prepare KMD (VAT return) data for a quarter |
| `lightyear-booking` | Book Lightyear investment trades and distributions from CSV |

**Claude Code** also has these as slash commands: `/book-invoice`, `/reconcile-bank`, `/month-end`, `/new-supplier`.

## Usage Examples

Once the MCP server is connected, just talk to your AI assistant in natural language:

### Enter purchase invoices from PDF files

> "Book this invoice PDF into e-arveldaja and match it to the bank payment"

The assistant will extract invoice data from the PDF, create a purchase invoice with the correct accounts and VAT rates, and match it to existing bank transactions.

### Book Lightyear investment trades

Download your Lightyear account statement CSV and capital gains report, then:

> "Create e-arveldaja journal entries from these Lightyear CSVs"

The assistant will parse the trades, pair foreign currency conversions, calculate capital gains from the FIFO report, and create journal entries with the correct securities accounts.

### Import Wise bank transactions

Download your Wise transaction history CSV (Account → Statements → CSV), then:

> "Import my Wise transactions from transaction-history.csv into e-arveldaja"

The assistant will parse the CSV, create bank transactions with correct amounts, and separate Wise fees into their own entries for proper expense accounting. Supports EUR and foreign currency card payments (USD etc.).

### Generate financial reports

> "Generate a P&L and balance sheet as of 28.02.2026"

### Reconcile bank transactions

> "Match unconfirmed bank transactions to invoices"

### Month-end close

> "Run the month-end close checklist for February 2026"

## License

[The Unlicense](LICENSE) — public domain. Do whatever you want with it.
