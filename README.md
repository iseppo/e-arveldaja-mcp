# e-arveldaja MCP Server

[![npm](https://img.shields.io/npm/v/e-arveldaja-mcp)](https://www.npmjs.com/package/e-arveldaja-mcp)

MCP server for the Estonian e-arveldaja (RIK e-Financials) REST API. 113 tools, 15 workflow prompts, 12 resources. Works with any MCP client — Claude Code, Codex CLI, Gemini CLI, Cursor, Windsurf, Cline, and others.

> **Guided workflow actions.** `recommend_workflow` suggests the safest accounting flow for a natural-language goal, and key workflow/batch tools return a `workflow_action_v1` envelope with `recommended_next_action`, review questions, and approval previews. `accounting_inbox` is the preferred merged entry point for workspace triage, `continue_accounting_workflow` is the preferred merged continuation tool, and bank work now has `reconcile_bank_transactions` plus `classify_bank_transactions` as mode-based entry points. Older focused tools such as `run_accounting_inbox_dry_runs`, `resolve_accounting_review_item`, `prepare_accounting_review_action`, `reconcile_transactions`, and `apply_transaction_classifications` remain available as compatibility primitives. See the [changelog](CHANGELOG.md) for full details.
>
> **v0.10.0 is a major update.** Large parts of the codebase have been rewritten — credential management, bank reconciliation, audit logging, and batch workflows all received significant changes. **You may need to re-add your API credentials** after updating, as the credential storage has moved from reading `apikey*.txt` directly to `.env` files. Your existing `apikey*.txt` files will be detected automatically and the server will offer to import them on first start.

> **Active development.** This package is under active development and has not seen extensive real-world testing yet. If you encounter a bug or unexpected behaviour, please let me know via [GitHub Issues](https://github.com/iseppo/e-arveldaja-mcp/issues) or email at indrek.seppo@gmail.com.

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

### 2. Add your API credentials

Put the downloaded `apikey.txt` in the working directory where you run your AI assistant. On the first start, the server detects it and offers to verify and import it into a `.env` file — either locally (just this folder) or globally (works from any folder).

You can also import manually at any time by asking your AI assistant:

> "Import my API key from apikey.txt"

For multiple companies, place multiple files (`apikey.txt`, `apikey-company2.txt`, etc.) and use `list_connections` / `switch_connection` to switch between them.

### 3. Optional: define company-specific accounting rules

If your company has stable booking conventions that cannot always be derived from the ledger alone, create an optional local file:

`accounting-rules.md`

This file is human-editable Markdown, not JSON. It is meant for:
- counterparty-specific auto-booking defaults when supplier history is missing
- owner-expense VAT deduction defaults or account-specific overrides
- annual-report overrides for liability maturity and cash-flow category classification

The server reads this file from the project root by default. You can point to another location with `EARVELDAJA_RULES_FILE=/path/to/accounting-rules.md`.

Confirmed supplier history still wins over local rules for purchase booking defaults.

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

The server includes 15 built-in workflow prompts that any MCP client can discover and use. These guide the AI through multi-step accounting tasks:

| Prompt | Description |
|---|---|
| `accounting-inbox` | Start here: scan a workspace, detect likely inputs, suggest the next safe dry-run steps, and ask only the smallest necessary follow-up questions |
| `resolve-accounting-review` | Turn one accounting review item into a concrete next-step plan with compliance references |
| `prepare-accounting-review-action` | Prepare the concrete next action for a resolved review item (delete duplicate, save rule, etc.) |
| `book-invoice` | Book a purchase invoice from PDF: extract, validate, resolve supplier, preview, create, upload, confirm |
| `receipt-batch` | Scan receipts and classify unmatched bank transactions through `classify_bank_transactions`, then apply after approval |
| `import-camt` | Parse CAMT.053 XML, preview imported bank transactions, then create after approval |
| `import-wise` | Preview Wise CSV import results, fees, duplicates, and Jar skips before execution |
| `classify-unmatched` | Group unmatched bank transactions, preview suggested booking actions, then apply after approval |
| `reconcile-bank` | Match bank transactions through `reconcile_bank_transactions`, then auto-confirm or review manually |
| `month-end-close` | Blockers, missing docs, duplicates, trial balance, P&L, balance sheet |
| `new-supplier` | Create supplier with Estonian business registry lookup |
| `company-overview` | Financial dashboard: balance sheet, P&L, receivables, payables |
| `lightyear-booking` | Book Lightyear investment trades and distributions from CSV |
| `setup-credentials` | Verify and import API credentials from `apikey.txt` into `.env` storage |
| `setup-e-arveldaja` | Explain how to configure API credentials when running in setup mode |

**Claude Code** also has these as slash commands: `/accounting-inbox`, `/resolve-accounting-review`, `/prepare-accounting-review-action`, `/book-invoice`, `/receipt-batch`, `/import-camt`, `/import-wise`, `/classify-unmatched`, `/reconcile-bank`, `/month-end`, `/new-supplier`, `/company-overview`, `/lightyear-booking`, `/setup-credentials`, `/setup-e-arveldaja`.

## Usage Examples

Once the MCP server is connected, just talk to your AI assistant in natural language:

### Start from one inbox-style overview

> "Scan this workspace and tell me what can be done automatically, what needs one decision, and what needs accountant review"

This is the recommended first step for non-accountants. The assistant will use the accounting inbox flow to detect likely CAMT files, Wise CSV exports, and receipt folders, propose safe `dry-run` steps in the right order, and ask only the smallest missing follow-up questions with recommended defaults first.

Accounting inbox and workflow recommendation responses include a `workflow` block with `done`, `needs_decision`, `needs_review`, `recommended_next_action`, `available_actions`, and `approval_previews` so clients can continue from one compact next step instead of choosing among all tools manually.

### Enter purchase invoices from PDF files

> "Book this invoice PDF into e-arveldaja and match it to the bank payment"

The assistant will extract invoice data from the PDF, reuse booking treatment from similar confirmed invoices by the same supplier when available, and otherwise fall back to purchase articles / local accounting rules before creating the invoice and matching it to bank transactions.

### Batch-process a folder of invoices and receipts

> "Process all the invoices in the arved/ folder and book them into e-arveldaja"

The assistant will scan the folder, OCR-parse each PDF/JPG/PNG, extract invoice data, resolve suppliers, detect duplicates, create purchase invoices, upload source documents, confirm, and match to bank transactions — all in one pass. Purchase booking defaults come from confirmed supplier history first, then from `accounting-rules.md` if present. Dry run by default so you can review before committing.
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

For owner-paid expenses, the server now tries to give sensible defaults:
- ordinary VAT-registered business receipts default to full input-VAT deduction
- likely restricted or mixed-use categories such as passenger-car / fuel / representation-like costs ask for clarification instead of guessing
- if you have a stable internal policy, you can encode it in `accounting-rules.md`


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

### Releasing to the MCP Registry

Claude Cowork discovers public MCP servers through the [MCP Registry](https://registry.modelcontextprotocol.io). Pushing to GitHub is not enough: publish the same version to npm first, then publish this repo's `server.json` metadata to the registry.

Before publishing, make sure these versions all match:

- `package.json` `version`
- `package-lock.json` root package `version`
- `server.json` top-level `version`
- `server.json` `packages[0].version`

Also make sure `package.json` `mcpName` exactly matches `server.json` `name`; the registry uses that to verify npm package ownership.

Run the normal checks before publishing:

```bash
npm run validate:release
npm run build
npm test
npm run test:integration
```

Publish the npm package:

```bash
npm login
npm publish
```

Use the official `mcp-publisher` binary from the [`modelcontextprotocol/registry` GitHub releases](https://github.com/modelcontextprotocol/registry/releases) rather than third-party snap/brew packages. Unofficial channels can lag behind the current schema and reject the `$schema` version as "deprecated". A one-liner to install the latest official binary into `~/.local/bin` (make sure that directory is on your `PATH`):

```bash
mkdir -p ~/.local/bin
curl -sSL "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" \
  | tar xz -C /tmp mcp-publisher
install -m 0755 /tmp/mcp-publisher ~/.local/bin/mcp-publisher
rm -f /tmp/mcp-publisher
```

Then authenticate and publish the registry entry:

```bash
npm run registry:login
npm run registry:publish
```

Verify the published entry:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.iseppo/e-arveldaja-mcp"
```

## Good to know

- **Dry run by default.** Batch operations (bank import, Wise import, Lightyear booking, receipt processing, auto-confirm) preview results first. You must explicitly confirm before mutating records. Receipt batches use `execution_mode="create"` to create/upload unconfirmed PROJECT invoices; confirmation is a separate approval step.
- **Accounting choices prefer evidence.** For purchase booking, the server prefers treatment from similar confirmed supplier invoices. If that history is missing, it can use `accounting-rules.md`. For unmatched bank-transaction auto-booking, it no longer invents VAT treatment from weak heuristics alone.
- **Large datasets need date filters.** The server loads up to 200 pages of data per query. Companies with thousands of invoices or transactions should narrow reporting and reconciliation tools with date ranges — otherwise the tool will ask you to.
- **Caching.** API responses are cached for 2–5 minutes and automatically invalidated when you create, update, or delete records through the server. Changes made directly in the e-arveldaja web UI may take a few minutes to appear.
- **EUR by default.** All amounts are EUR unless a different currency is specified.
- **Multi-company.** Place multiple `apikey*.txt` files and use `list_connections` / `switch_connection`. Switching clears all cached data to prevent cross-company leaks.
- **Node.js 18+** required.
- **File access scope.** By default, file-reading tools can access supported files under the working directory and `/tmp`. Set `EARVELDAJA_ALLOWED_PATHS` (colon-separated) to allow additional directories, or `EARVELDAJA_ALLOW_HOME=true` to allow the entire home directory.
- **Human-editable local accounting rules.** `accounting-rules.md` lets you store company-specific booking defaults and annual-report overrides in Markdown instead of code or JSON.
- **Session audit log.** Every mutating operation (create, update, delete, confirm, import) is logged to a human-readable Markdown file at `logs/{connection}.audit.md` in the working directory. Each entry includes timestamps, tool name, entity details, account postings, and financial amounts. Use `get_session_log` to view, `list_audit_logs` to browse all companies, and `clear_session_log` to reset. The log persists across sessions and is company-specific. Set `EARVELDAJA_AUDIT_LANG=en` for English labels (default: Estonian).
- **Tag MCP-created invoices.** Set `EARVELDAJA_TAG_NOTES=true` to append `(e-arveldaja-mcp)` to the notes field of all invoices created by the server. Off by default.
- **Debug log file.** Set `EARVELDAJA_LOG_FILE=/path/to/mcp.err.log` to tee everything the server writes to stderr (warnings, fatal errors, and — once the MCP transport is up — the structured logger output) into the given file in append mode. Off by default. Cross-platform (Linux, macOS, Windows). Useful when the MCP host swallows stderr; example: `EARVELDAJA_LOG_FILE=/tmp/mcp.err.log`.
- **OCR text is sandboxed.** Raw OCR output from PDFs and images (`raw_text`, receipt-line `description`) is wrapped in per-call nonce delimiters (`<<UNTRUSTED_OCR_START:{nonce}>>` / `<<UNTRUSTED_OCR_END:{nonce}>>`) before being returned to the LLM, so a scanned receipt cannot smuggle tool-call instructions into your agent's context.
- **Cross-system file input.** When the MCP server runs on a different host from your client (e.g. Claude desktop, Cowork, Cursor, or a remote container), file-reading tools also accept a `file_path` of the form `base64:<b64data>` (for PDF / PNG / JPEG / CAMT XML) or `base64:<ext>:<b64data>` (e.g. `base64:csv:QSxCLEMK...`) so files on the client side no longer need to exist on the server's filesystem.

## Privacy

Document parsing (PDF, JPG, PNG) uses LiteParse OCR locally by default. If you set `EARVELDAJA_LITEPARSE_OCR_SERVER_URL`, the server will send documents to that configured OCR endpoint instead of staying fully local for OCR. Remote OCR endpoints must use `https`; plain `http` is only accepted for localhost / loopback OCR services. By default, the server may also read supported document files anywhere under your home directory and `/tmp`; set `EARVELDAJA_ALLOWED_PATHS` if you want a narrower local file boundary. In all cases, the extracted text is returned to your AI assistant via the MCP protocol, so it will be processed by whichever LLM you are using (Claude, Codex, Gemini, etc.). The server's own outbound connections are therefore limited to the e-arveldaja API (`rmp-api.rik.ee`), optionally the Estonian Business Registry (`ariregister.rik.ee`) for supplier lookups, and optionally your configured OCR server.

## Feedback and Bug Reports

Feature requests, bug reports, and invoices that don't parse correctly are welcome on the [GitHub Issues page](https://github.com/iseppo/e-arveldaja-mcp/issues).

If you'd rather not upload your invoice publicly, email it directly to indrek.seppo@gmail.com.

## License

[Apache License 2.0](LICENSE)
