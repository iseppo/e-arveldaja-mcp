# RIK API opening balances implementation plan

**Goal:** Use RIK's documented `INITIAL` journals throughout reporting and remove the obsolete local opening-register import, parser and store.

**Architecture:** The existing shared journal loader reads only the API. It returns the original journals unchanged and identifies the INITIAL journal for status reporting. No synthetic journal, local fallback, account matching or new compatibility path is needed. Existing user `opening-balances.json` files remain untouched and are never read.

**Scope:** TypeScript, existing API clients and Vitest. Public live/demo OpenAPI descriptions inspected on 2026-10-19 document INITIAL and normalized D/C postings. Transaction direction, bank metadata, pagination, missing-file and payment-status workarounds stay because the changelog does not establish their removal. No live accounting calls, credentials, commits, release or publication.

## Implementation and acceptance checks

- [x] Keep the original API INITIAL IDs, dates, clients, dimensions, registration/deletion states and postings. Never prepend or count an opening journal twice.
- [x] Refuse multiple non-deleted INITIAL journals and malformed D/C/nonnegative amounts clearly. Deleted history may coexist with one active opening. Draft/deleted/empty openings are disclosed without applying amounts.
- [x] Treat absence of INITIAL after a successful complete API read as a normal absence: no opening journal and no incomplete-API/import warning. Annual and client outputs use `not_present`; API failures still propagate.
- [x] Remove local parser/store/import source, tool registration/catalog references and storage-path coupling. Keep the independent statement-balance store. Never delete actual user accounting data.
- [x] Migrate all calculations to the same API journal set: account and dimension balances, statements, annual report and dividend equity. Keep all date, client, registration/deletion and posting filters.
- [x] Exclude INITIAL from all annual cash-flow classification and closing-entry detection. Include an in-year opening as the first-year starting cash/equity position.
- [x] Preserve API header-client attribution. Subtract client-less opening entries only from the counterpart-context count; do not subtract a selected client's opening twice.
- [x] Detect active nonzero null-dimension opening postings from API data. Keep them in account totals and the unassigned row, disclose partial dimension attribution and skip a misleading statement tolerance check.
- [x] Forward the existing `operation_type` list filter server-side while retaining defensive combined filters, pagination and separate unfiltered reporting caches. Keep mutation schemas unchanged.
- [x] Keep purchase fringe default 1 and explicit/readback classifiers. Refuse a totals PATCH if changed/missing readback rows cannot preserve nondefault caller intent, using the existing created-ID/cleanup error path.
- [x] Update current README, CLAUDE, architecture and unreleased changelog to the API-only design. Historical changelog entries remain unchanged.
- [x] Convert obsolete local-store tests to API fixtures and retain numeric accounting regressions. Verify an existing local opening file neither changes results nor gets deleted.
- [x] Regenerate canonical tool-surface fixtures with the repository script. Standard/full become 126/146; guided profiles remain 19/20.
- [x] Run focused tests, full `npm test`, `npm run build`, `npm run test:integration`, diff checks and independent final review. Report skipped integration cases and distinguish fixture/protocol verification from live accounting behavior.

## Review and verification evidence

The preceding implementation passed full checks before the user requested removing local support: 7,849 unit tests passed with 1 skipped; integration had 20 passed and 3 skipped. Independent code/spec reviews identified and fixed total-inclusive dimension disclosure and ambiguous purchase readback fringe preservation. Review-fix regressions were observed failing before correction.

Those results establish the preceding baseline only. Current API-only verification:

- Focused numerical, loader, status, CRUD, surface, financial-statement and purchase regressions: **752 passed across 10 files**. Includes stale and corrupt temporary `opening-balances.json` files ignored even when no INITIAL is returned, plus explicit retired-tool absence in every profile.
- `npm test`: **219/219 files passed; 7,805 passed, 1 skipped**, exit 0, 35.23 s. Log: `/tmp/rik-api-only-full-tests.log`.
- `npm run build`: **passed**, exit 0. Log: `/tmp/rik-api-only-build.log`. Clean build output contains only opening journal/status helpers, no retired parser/store/import modules.
- `npm run test:integration`: **20 passed, 3 skipped**, exit 0, 3.87 s. Log: `/tmp/rik-api-only-integration.log`. The skipped cases require opt-in live API testing; no live accounting calls were made.
- Canonical surface generation passed: setup 129, full 146, standard 126, custom 85, guided 19 and guided-sales 20. Log: `/tmp/rik-api-only-surfaces.log`.
- TypeScript and `git diff --check` passed. Existing user accounting files and the pre-existing untracked `.claude/worktrees/` remain untouched. Changes are local and unpublished.
- Independent high-effort final API-only review: **APPROVE**, no blockers. Removed the review's nonblocking “compatibility-preserving” wording from current README/CLAUDE because the obsolete tool is intentionally removed.
