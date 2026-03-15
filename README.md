# e-arveldaja MCP Server

MCP (Model Context Protocol) server for the Estonian e-arveldaja (RIK e-Financials) REST API.

## Disclaimer

**This is an experimental, unofficial project.** It is not affiliated with, endorsed by, or in any way officially connected to RIK (Registrite ja Infosüsteemide Keskus) or the e-arveldaja / e-Financials service.

**Use entirely at your own risk.** This software interacts with live financial data and can create, modify, confirm, and delete accounting records (invoices, journal entries, transactions, etc.). The authors accept no responsibility for any data loss, incorrect bookings, or other damages resulting from the use of this software.

By using this software you acknowledge that:
- You are solely responsible for verifying all data and operations
- You should test thoroughly on the demo server before using with live data
- This is experimental software with no warranty of any kind

## Setup

See [CLAUDE.md](CLAUDE.md) for architecture, credentials, and usage details.

```bash
npm run build          # tsc -> dist/
npm run start          # node dist/index.js (stdio transport)
npm run dev            # tsx src/index.ts (development)
```

## License

Private / All rights reserved.
