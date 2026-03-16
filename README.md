# e-arveldaja MCP Server

[![npm](https://img.shields.io/npm/v/e-arveldaja-mcp)](https://www.npmjs.com/package/e-arveldaja-mcp)

MCP (Model Context Protocol) server for the Estonian e-arveldaja (RIK e-Financials) REST API. Works with any MCP-compatible AI assistant — Claude Code, Codex CLI, Gemini CLI, Google Antigravity, Cursor, Windsurf, Cline, and others.

## Disclaimer

**This is an experimental, unofficial project.** It is not affiliated with, endorsed by, or in any way officially connected to RIK (Registrite ja Infosüsteemide Keskus) or the e-arveldaja / e-Financials service.

**Use entirely at your own risk.** This software interacts with live financial data and can create, modify, confirm, and delete accounting records (invoices, journal entries, transactions, etc.). The authors accept no responsibility for any data loss, incorrect bookings, or other damages resulting from the use of this software.

By using this software you acknowledge that:
- You are solely responsible for verifying all data and operations
- You should test thoroughly on the demo server before using with live data
- This is experimental software with no warranty of any kind

## Getting an API Key

1. Log in to [e-arveldaja](https://www.earveldaja.ee/)
2. Go to **Seadistused** → **Üldised seadistused** → **Lisa uus juurdepääsuluba** (Settings → General settings → Add new access token)
3. Enter any name for the token
4. Find your public IP address (e.g. at [whatismyipaddress.com](https://whatismyipaddress.com/)) and enter it in the allowed IP field. Multiple IPs can be separated by `;`
5. Save — download the `apikey.txt` file and place it in the working directory where you run your AI assistant

If you don't have a static IP address, you will need to update the allowed IP in e-arveldaja settings whenever your IP changes.

**Never commit the `apikey.txt` file to git.**

For the demo server, set the environment variable `EARVELDAJA_SERVER=demo`.

## Setup

### Option A: npx (no install needed)

Just reference `npx e-arveldaja-mcp` in your MCP config — no cloning or building required. See configuration examples below.

### Option B: From source

```bash
git clone https://github.com/iseppo/e-arveldaja-mcp.git
cd e-arveldaja-mcp
npm install
npm run build          # tsc -> dist/
```

### Connecting to your AI assistant

This is a standard MCP server using stdio transport. Most AI assistants can set this up themselves — just ask:

> "Add the e-arveldaja-mcp npm package as an MCP server to my configuration, using npx"

The assistant will add `{"command": "npx", "args": ["-y", "e-arveldaja-mcp"]}` to its MCP config. No cloning or paths needed.

If you prefer to configure manually:

**JSON-based config** (Claude Code, Cursor, Windsurf, Cline, Gemini CLI, Antigravity):

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

**TOML-based config** (Codex CLI):

```toml
[mcp_servers.e-arveldaja]
command = "npx"
args = ["-y", "e-arveldaja-mcp"]
```

If running from source, replace `"npx", "-y", "e-arveldaja-mcp"` with `"node", "/path/to/e-arveldaja-mcp/dist/index.js"`.

Where this config file lives depends on your tool:

| Tool | Config file |
|---|---|
| **Claude Code** | `~/.claude/settings.json` or project `.claude/settings.json` |
| **Codex CLI** | `~/.codex/config.toml` or project `.codex/config.toml` |
| **Gemini CLI** | `~/.gemini/settings.json` or project `.gemini/settings.json` |
| **Google Antigravity** | MCP Store UI → Manage MCP Servers → View raw config (`mcp_config.json`) |
| **Cursor** | `.cursor/mcp.json` in your project |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |
| **Cline** | VS Code settings under `cline.mcpServers` |

See [CLAUDE.md](CLAUDE.md) for architecture details and full API documentation.

## Workflows

The project includes step-by-step workflow guides in [`workflows/`](workflows/) that orchestrate multiple MCP tools into complete accounting tasks. These work with any MCP client — just paste the workflow into your AI assistant's prompt or follow the steps manually.

| Workflow | Description |
|---|---|
| [book-invoice](workflows/book-invoice.md) | Book a purchase invoice from PDF: extract data, validate, find/create supplier, suggest accounts, create invoice, upload PDF, confirm |
| [reconcile-bank](workflows/reconcile-bank.md) | Match unconfirmed bank transactions to open invoices and confirm matches |
| [month-end](workflows/month-end.md) | Run month-end close checklist: blockers, missing docs, duplicates, trial balance, P&L, balance sheet |
| [new-supplier](workflows/new-supplier.md) | Create a supplier with Estonian business registry lookup and dedup check |

### Claude Code slash commands

If you use Claude Code, the same workflows are also available as slash commands in `.claude/commands/`. To install:

**Option A:** Run Claude Code from the `e-arveldaja-mcp` directory — skills are auto-detected.

**Option B:** Symlink or copy to your global commands:

```bash
# Symlink (stays up to date)
ln -s /path/to/e-arveldaja-mcp/.claude/commands/*.md ~/.claude/commands/

# Or copy
cp /path/to/e-arveldaja-mcp/.claude/commands/*.md ~/.claude/commands/
```

Then use `/book-invoice`, `/reconcile-bank`, `/month-end`, `/new-supplier` in any conversation.

## Usage Examples

Once the MCP server is connected, just talk to your AI assistant in natural language:

### Enter purchase invoices from PDF files

> "Book this invoice PDF into e-arveldaja and match it to the bank payment"

The assistant will extract invoice data from the PDF, create a purchase invoice with the correct accounts and VAT rates, and match it to existing bank transactions.

### Book Lightyear investment trades

Download your Lightyear account statement CSV and capital gains report, then:

> "Create e-arveldaja journal entries from these Lightyear CSVs"

The assistant will parse the trades, pair foreign currency conversions, calculate capital gains from the FIFO report, and create journal entries with the correct securities accounts.

### Generate financial reports

> "Generate a P&L and balance sheet as of 28.02.2026"

### Reconcile bank transactions

> "Match unconfirmed bank transactions to invoices"

### Month-end close

> "Run the month-end close checklist for February 2026"

## License

[The Unlicense](LICENSE) — public domain. Do whatever you want with it.
