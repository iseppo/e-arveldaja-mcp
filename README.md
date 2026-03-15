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
5. Save — you will receive an API Key ID, public value, and password

If you don't have a static IP address, you will need to update the allowed IP in e-arveldaja settings whenever your IP changes.

Create an `apikey.txt` file next to the project directory (i.e. in the parent folder) with the following format:

```
ApiKey ID: <your_key_id>
ApiKey public value: <your_public_value>
Password: <your_password>
```

**Never commit this file to git.**

For the demo server, set the environment variable `EARVELDAJA_SERVER=demo`.

## Setup

```bash
npm install
npm run build          # tsc -> dist/
npm run start          # node dist/index.js (stdio transport)
npm run dev            # tsx src/index.ts (development)
```

### Claude Code integration

Add to your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "e-arveldaja": {
      "command": "node",
      "args": ["/path/to/e-arveldaja-mcp/dist/index.js"]
    }
  }
}
```

See [CLAUDE.md](CLAUDE.md) for architecture details and full documentation.

## License

Private / All rights reserved.
