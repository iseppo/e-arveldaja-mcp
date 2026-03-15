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
npm install
npm run build          # tsc -> dist/
npm run start          # node dist/index.js (stdio transport)
npm run dev            # tsx src/index.ts (development)
```

### Claude Code integration

Ask Claude Code to add the e-arveldaja MCP server to your settings — it knows how to do it.

See [CLAUDE.md](CLAUDE.md) for architecture details and full documentation.

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
