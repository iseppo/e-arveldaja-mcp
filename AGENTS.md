# AGENTS.md - Codex Instructions for e-arveldaja-mcp

## Project

This repository is `e-arveldaja-mcp`, a TypeScript MCP server for the Estonian e-arveldaja / RIK e-Financials REST API.

The actual git repo root is:

`/home/seppo/Dokumendid/e_arveldaja/e-arveldaja-mcp`

Do not treat `/home/seppo/Dokumendid/e_arveldaja` as the repo root for git, tests, builds, or diffs.

> **Domain reference lives in [`CLAUDE.md`](./CLAUDE.md).** This file carries only
> the Codex-specific working conventions. For API endpoint semantics, accounting
> concepts, the D/C balance model, Estonian tax rules, tool-exposure flags, and
> the full OCR/untrusted-text sandbox policy, read `CLAUDE.md` — it is the single
> source of truth. Do not duplicate those facts here; update `CLAUDE.md` instead.

## How To Work Here

- Read the existing code before changing behavior. Prefer local patterns over new abstractions.
- Keep changes scoped to the user request. Do not rewrite unrelated accounting workflows or generated metadata.
- This project touches live accounting data. Preserve dry-run defaults, approval gates, audit logging, path validation, and untrusted-text sandboxing unless the user explicitly asks for a reviewed change. (Full rationale and the specific invariants are in `CLAUDE.md`.)
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

## Editing Workflow Prompt Text

Workflow prompt text is **not** hand-written in `src/prompts.ts`. It flows through one pipeline: the canonical registry `src/prompt-registry.ts` (names, string-only argument schemas, sales-aware variants) → the Markdown bodies under `workflows/*.md` loaded by `src/workflow-prompt-source.ts` → the shared renderer `src/prompt-surface.ts` (safety wrapper, external-text sandbox, 64k budget) → MCP prompts registered in `src/prompts.ts` and the `.claude/commands/*.md` slash-command mirrors.

- Edit `workflows/*.md` (never a `.claude/commands` mirror), then run `npm run sync:workflow-prompts`.
- `npm run validate:release` pins registry / workflow / command / README set-equality.
- See `ARCHITECTURE.md` → Workflow prompt pipeline, and `CLAUDE.md` for the surrounding architecture.

## Where To Find The Rest

These topics used to be summarized here; they now live in `CLAUDE.md` to avoid drift. Read the matching `CLAUDE.md` section before touching the area:

- **Architecture map** (module responsibilities, `api/`, `tools/`, `resources/`, MCP-safe output helpers).
- **Accounting & API safety rules** (dry-run/approval discipline, `type: "C"` invariant, distribution-array bodies, account-dimension `related_id`/`related_sub_id`, purchase-invoice `gross_price`/`vat_price`/`items` requirements, inter-account transfer reconciliation).
- **Security & untrusted text** (path/symlink validation, input size limits, the `src/mcp-json.ts` OCR sandbox policy and what is deliberately left unwrapped, structured upstream-error handling).
- **MCP / SDK changes** — consult official docs or existing repo examples before changing SDK usage, tool registration, or resource/prompt contracts; keep JSON-text response compatibility.
- **Release** — align `package.json` version, `CHANGELOG.md`, `server.json`, built output, and npm package contents, then run the full release validation path before tagging or publishing.
