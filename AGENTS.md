# AGENTS.md - Codex Instructions for e-arveldaja-mcp

## Project

This repository is `e-arveldaja-mcp`, a TypeScript MCP server for the Estonian e-arveldaja / RIK e-Financials REST API.

The actual git repo root is:

`/home/seppo/Dokumendid/e_arveldaja/e-arveldaja-mcp`

Do not treat `/home/seppo/Dokumendid/e_arveldaja` as the repo root for git, tests, builds, or diffs.

## How To Work Here

- Read the existing code before changing behavior. Prefer local patterns over new abstractions.
- Keep changes scoped to the user request. Do not rewrite unrelated accounting workflows or generated metadata.
- This project touches live accounting data. Preserve dry-run defaults, approval gates, audit logging, path validation, and untrusted-text sandboxing unless the user explicitly asks for a reviewed change.
- Never commit credentials or local accounting inputs. In particular, do not add `.env`, `apikey*.txt`, company exports, bank statements, receipts, or local `accounting-rules.md` unless the user explicitly asks and the file is safe.
- Use `rg` / `rg --files` for search.
- Use `apply_patch` for manual edits.
- If a command fails because of sandboxing or network restrictions, rerun with the proper approval request rather than working around it.

## Verification

For normal code changes, run:

```bash
npm test
npm run build
npm run test:integration
```

For release or publish work, also run:

```bash
npm run validate:release
```

Useful focused checks:

```bash
npm test -- src/tools/accounting-inbox.test.ts
npm test -- src/tools/receipt-inbox.test.ts
npm test -- src/tools/bank-reconciliation.test.ts
```

Do not claim completion, commit, tag, publish, or push until the relevant verification commands have completed successfully. If a verification command cannot be run, report that explicitly.

## Git Workflow

- Check `git status --short --branch` before editing, before staging, and before final reporting.
- The worktree may contain user changes. Do not revert changes you did not make.
- Stage only files relevant to the completed task.
- When the user asks for a code review, use a review-first stance: findings first, ordered by severity, with file and line references. Do not silently fix during a review unless the user asks.
- When the user asks to commit and push, review the diff first, run verification, commit with a concrete message, push the current branch, then verify the final branch state.
- If the user says to pull first, run `git pull` from the actual repo root before reviewing or changing code.

## Architecture Map

- `src/index.ts` wires the MCP server, tools, prompts, resources, startup messages, and session behavior.
- `src/config.ts` handles credential loading, setup mode, `.env` import, server selection, and multi-connection setup.
- `src/http-client.ts` handles authenticated API calls, retries, timeout behavior, rate limiting, and upstream error handling.
- `src/auth.ts` implements HMAC-SHA-384 signing.
- `src/api/` contains API resource wrappers.
- `src/tools/` contains most MCP tools and workflow logic.
- `src/prompts.ts` contains workflow prompt text.
- `src/resources/` contains MCP resources.
- `src/mcp-json.ts` and `src/tool-response.ts` shape MCP-safe output.
- Tests are colocated as `*.test.ts`; integration tests live under `src/__integration__/`.

## Accounting And API Safety Rules

- Mutating workflows should default to preview or dry-run and require explicit approval before creating, confirming, invalidating, deleting, or uploading.
- Keep `workflow_action_v1`, approval previews, `recommended_next_action`, and review-item flows consistent across tools.
- When a workflow leaves `PROJECT` records or review items and the tool has enough IDs and amounts, prefer inline MCP actions such as `confirm_transaction`, `reconcile_inter_account_transfers`, `update_transaction`, or `delete_transaction`. Manual e-arveldaja UI fallback is last resort only after the MCP path has been tried or is clearly unavailable.
- For inter-account transfers, use `reconcile_inter_account_transfers`; do not hand-roll direct confirmations that can duplicate journals.
- All bank transactions use `type: "C"`; accounting direction comes from confirmation distributions.
- Transaction confirmation bodies are top-level arrays of distribution objects, not `{ items: [...] }`.
- For account-dimension distributions, `related_id` is the account ID and `related_sub_id` is the account dimension ID.
- Purchase invoice creation must keep invoice-level `gross_price` and `vat_price`; PATCH requests must include `items`.
- If an expense account has dimensions, pass both `purchase_accounts_id` and `purchase_accounts_dimensions_id` on purchase invoice items.

## Security And Untrusted Text

- Preserve file path validation: resolve symlinks with `realpath`, enforce allowed roots, and re-check file extensions.
- Preserve input size limits for JSON-like user input.
- External text from OCR, PDFs, CAMT XML, CSV imports, and upstream API bodies is untrusted. When adding tools that emit such text, wrap it at MCP output using the existing untrusted OCR sandbox helpers in `src/mcp-json.ts`.
- CRUD list/get tools intentionally return trusted persisted API state raw; do not broaden sandboxing there without understanding the existing policy.
- Keep upstream API body details out of generic `Error.message`; expose detailed bodies through the existing structured error path.

## MCP And SDK Changes

When changing MCP SDK usage, tool registration semantics, resource/prompt contracts, or package publishing metadata, consult official documentation or existing repo examples first. Keep compatibility with MCP clients that consume JSON text responses.

## Release Notes

For releases, align:

- `package.json` version
- `CHANGELOG.md`
- `server.json`
- built output behavior
- npm package contents

Then run the full release validation path before tagging or publishing.
