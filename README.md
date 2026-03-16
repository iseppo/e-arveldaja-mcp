# e-arveldaja MCP Server

MCP (Model Context Protocol) server for the Estonian e-arveldaja (RIK e-Financials) REST API.

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
4. Find your public IP address (e.g. at [whatismyipaddress.com](https://whatismyipaddress.com/)) and enter it in the allowed IP field
5. Save — download the `apikey.txt` file and place it next to the project directory (i.e. in the parent folder)

If you don't have a static IP address, you will need to update the allowed IP in e-arveldaja settings whenever your IP changes.

**Never commit the `apikey.txt` file to git.**

For the demo server, set the environment variable `EARVELDAJA_SERVER=demo`.

## Setup

```bash
git clone https://github.com/iseppo/e-arveldaja-mcp.git
cd e-arveldaja-mcp
npm install
npm run build          # tsc -> dist/
```

### Claude Code integration

Ask Claude Code to add the e-arveldaja MCP server to your settings — it knows how to do it.

See [CLAUDE.md](CLAUDE.md) for architecture details and full documentation.

## Skills (Slash Commands)

The project includes Claude Code skills — guided workflows that orchestrate multiple MCP tools into complete accounting tasks.

### Installation

The skills live in `.claude/commands/` inside this repo. To make them available as slash commands in Claude Code:

**Option A: Work from this directory** — if you run Claude Code from the `e-arveldaja-mcp` directory, the skills are automatically available as `/book-invoice`, `/reconcile-bank`, `/month-end`, `/new-supplier`.

**Option B: Symlink into your project** — if you work from a different directory:

```bash
ln -s /path/to/e-arveldaja-mcp/.claude/commands/book-invoice.md ~/.claude/commands/book-invoice.md
ln -s /path/to/e-arveldaja-mcp/.claude/commands/reconcile-bank.md ~/.claude/commands/reconcile-bank.md
ln -s /path/to/e-arveldaja-mcp/.claude/commands/month-end.md ~/.claude/commands/month-end.md
ln -s /path/to/e-arveldaja-mcp/.claude/commands/new-supplier.md ~/.claude/commands/new-supplier.md
```

**Option C: Copy to global commands** — for access from any project:

```bash
cp .claude/commands/*.md ~/.claude/commands/
```

### Available Skills

| Command | Description |
|---|---|
| `/book-invoice <path.pdf>` | Book a purchase invoice from PDF: extract data, validate, find/create supplier, suggest accounts, create invoice, upload PDF, confirm |
| `/reconcile-bank [auto\|review\|ID]` | Match unconfirmed bank transactions to open invoices and confirm matches |
| `/month-end [YYYY-MM]` | Run month-end close checklist: blockers, missing docs, duplicates, trial balance, P&L, balance sheet |
| `/new-supplier <name\|regcode>` | Create a supplier with Estonian business registry lookup and dedup check |

## Usage Examples

Once the MCP server is connected, just talk to Claude Code in natural language. Here are some things you can do:

### Enter purchase invoices from PDF files

Copy a folder of invoice PDFs into your project directory, then tell Claude Code:

> "Lisa need arved e-arveldajasse ja seo tasumistega"
> (Add these invoices to e-arveldaja and link them to payments)

Claude will extract invoice data from the PDFs, create purchase invoices with the correct accounts and VAT rates, and match them to existing bank transactions.

### Book Lightyear investment trades

Download your Lightyear account statement CSV and capital gains report, place them in the project directory, then:

> "Tee nende põhjal e-arveldaja kanded"
> (Create e-arveldaja journal entries based on these)

Claude will parse the trades, pair foreign currency conversions, calculate capital gains from the FIFO report, and create journal entries with the correct securities accounts.

### Generate financial reports

> "Koosta kasumiaruanne ja bilanss seisuga 28.02.2026"
> (Generate a P&L and balance sheet as of 28.02.2026)

### Reconcile bank transactions

> "Seo kinnitamata pangaliikumised arvetega"
> (Match unconfirmed bank transactions to invoices)

### VAT reporting

> "Koosta KMD ja KMD INF veebruari kohta"
> (Generate VAT return and partner annex for February)

## License

[The Unlicense](LICENSE) — public domain. Do whatever you want with it.
