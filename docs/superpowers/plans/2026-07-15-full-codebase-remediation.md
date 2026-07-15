# Full Codebase Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all 50 confirmed code-review findings while preserving live-accounting safety, proving every correction with a red-green regression, independent approval, and one atomic commit per finding.

**Architecture:** Apply seven strictly sequential remediation waves. Early tasks establish compatibility, lossless serialization, mutation outcome, locking, integrity, and validation primitives; later tasks consume those exact interfaces without merging finding gates. Each wave ends with the full release/unit/integration gate, and the final task adds a packed Node 18 smoke gate and whole-branch review.

**Tech Stack:** TypeScript 7, Node.js >=18.0.0 ESM, Vitest 4, MCP SDK, Zod 4, npm packaging, standard-library filesystem/crypto/child-process APIs.

## Global Constraints

In scope:

- `H01` through `H19`, `M01` through `M29`, and `D01` through `D02` in the inventory below.
- Production code, focused tests, affected workflow mirrors, release checks, and narrowly necessary documentation.
- Intentional contract tightening where unsafe behavior currently permits silent corruption, ambiguous mutation recovery, confirmed-ledger edits, or document substitution.
- Test fixtures that are necessary to reproduce the reviewed defect.

Out of scope:

- Unrelated cleanup, style changes, file reorganizations, dependency upgrades, or feature work.
- Replacing existing APIs or accounting workflows where a local correction is sufficient.
- New runtime dependencies unless the standard library and established repository helpers cannot implement the approved safety property.
- Live mutations during automated verification. All tests use mocks, fixtures, temporary directories, or existing integration-test safety controls.

Every fix must preserve these invariants:

- Preserve safe existing behavior unless the review proved it unsafe.
- A dry run never mutates local or remote accounting state and describes the same mutation mode that execution will use.
- A live create, update, confirm, invalidate, delete, or reconcile operation still requires the existing approval and connection-safety gates.
- Every attempted live mutation remains auditable, including explicit indeterminate and recovery outcomes.
- A network-ambiguous mutation is never treated as a confirmed failure and never receives a speculative compensating mutation.
- Confirmed journals and invoices cannot be ledger-edited through generic update tools.
- External text is untrusted at the MCP boundary, but sandbox markers are never sent back to the accounting API, used as matching keys, or persisted as business data.
- Monetary decisions use explicit source currency, base amount, allocation share, account, and dimension provenance. A nominal amount or default account cannot silently substitute for missing provenance.
- No finding is marked complete from code inspection alone; the regression test, focused suite, build, diff check, independent review, and commit must all succeed.
- A shared helper may be introduced by the current finding only when that finding needs it. Later findings must still receive their own regression test, acceptance check, review, and commit even if the helper already provides most of the implementation.

- Node.js `>=18.0.0` remains the supported engine range. `H01` is fixed with Node 18-compatible module-path derivation rather than raising the engine floor.
- MCP response shape remains JSON-compatible. TOON remains an optimization only when decode-round-trip equivalence proves it lossless; otherwise the response uses JSON.
- Safe draft updates, read tools, existing approval prompts, and existing audit formats remain compatible.
- Confirmed-ledger generic updates are intentionally rejected and replaced by invalidate-edit-reconfirm.
- Receipt and PDF create/upload calls that depend on prior extraction intentionally require the approved SHA-256 digest.
- Strict input parsing may reject malformed values that were previously truncated, defaulted, or silently skipped.
- Newly sandboxed outputs may add visible trust-boundary delimiters to untrusted text; server-side identities and persisted values remain delimiter-free.
- Any workflow prompt or mirrored command changed by a fix must be regenerated with `npm run sync:workflow-prompts` and committed together with its source workflow.

Before Task 1, run `git status --short --branch`, `git rev-parse --show-toplevel`, `node --version`, `npm --version`, `npm test`, and `npm run test:integration`. Confirm branch `fix/code-review-remediation`, root `/home/seppo/Dokumendid/e_arveldaja/e-arveldaja-mcp/.worktrees/code-review-remediation`, a clean worktree except this plan, and the baseline result of 1,753 unit tests plus 20 integration passes and 3 documented skips. Create ignored directories `.omc/reviews/` and `.omc/`, then create `.omc/full-codebase-remediation-ledger.md` with columns `ID | red command/result | green commands/result | reviewer/spec verdict | reviewer/quality verdict | commit`. Before every task, re-read the named evidence function and its adjacent callers/tests at the current branch head. Do not begin the next task until the current task is committed, its ledger row is appended, and `git status --short` is empty (ignored `.omc` evidence does not appear).

Every independent review step below means all of the following, in this order:

1. Run `git diff --check` and the finding's green commands.
2. Write the actual review artifact, not a terminal-only preview: `mkdir -p .omc/reviews && git diff --output=.omc/reviews/<ID>.diff -- <listed files>`. Confirm `test -s .omc/reviews/<ID>.diff` and record `git diff --stat -- <listed files>` beside the red/green evidence.
3. Dispatch a fresh reviewer task that did not author the change. Give it the approved design, finding ID and acceptance contract, `.omc/reviews/<ID>.diff`, red output, and green output. Require two explicit verdict lines: `SPEC COMPLIANCE: APPROVED` and `CODE QUALITY: APPROVED`, with no unresolved actionable finding. A generic approval is insufficient.
4. If either verdict is rejected, fix the implementation, rerun the focused tests/build/diff check, overwrite the diff package, and resubmit to a new fresh reviewer before committing.
5. Commit only after both verdicts approve. Append the ledger row only after the commit succeeds, then require `git status --short` to be empty. At a wave ending, run the wave gate only after this review -> commit -> ledger -> clean-status sequence.

---

### Task 1: H01 — Node 18-compatible project-root resolution

**Files:**
- Modify: `src/paths.ts:1-17`
- Create: `src/paths.test.ts`
- Test: `src/release-metadata.test.ts`
- Create: `scripts/smoke-node18-paths.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Node ESM `fileURLToPath(url: string | URL): string`.
- Produces: `getProjectRoot(startUrl?: string | URL): string`; callers that pass no argument retain the current API.
- Produces: dependency-free CLI `node scripts/smoke-node18-paths.mjs <installed-package-root>` and CI job `package-path-smoke-node18`.

- [ ] **Step 1: Write the failing regression**

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getProjectRoot } from "./paths.js";

describe("getProjectRoot", () => {
  it("does not depend on the Node 20 import.meta.dirname extension", () => {
    const source = readFileSync(new URL("./paths.ts", import.meta.url), "utf8");
    expect(source).not.toContain("import.meta.dirname");
  });

  it("derives the root through Node 18 ESM APIs", () => {
    const sourceUrl = pathToFileURL(resolve(process.cwd(), "src/paths.ts"));
    expect(getProjectRoot(sourceUrl)).toBe(process.cwd());
  });
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/paths.test.ts`

Expected: FAIL because `src/paths.ts` still contains the Node-20-only `import.meta.dirname` expression. The behavioral assertion may already pass on Node 22; the source assertion is the required local RED, while the packed Node 18 smoke below is the runtime proof.

- [ ] **Step 3: Implement the Node 18 path derivation**

```ts
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function getProjectRoot(startUrl: string | URL = import.meta.url): string {
  let dir = dirname(fileURLToPath(startUrl));
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  process.stderr.write("WARNING: Could not find package.json; falling back to process.cwd()\n");
  return process.cwd();
}
```

- [ ] **Step 4: Add the finding-local packed Node 18 proof**

Create `scripts/smoke-node18-paths.mjs`:

```js
#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: smoke-node18-paths.mjs <installed-package-root>");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const pathsModule = await import(pathToFileURL(resolve(packageRoot, "dist/paths.js")).href);
const actualRoot = pathsModule.getProjectRoot(pathToFileURL(resolve(packageRoot, "dist/paths.js")));
if (actualRoot !== packageRoot) throw new Error(`getProjectRoot returned ${actualRoot}; expected ${packageRoot}`);
await access(resolve(packageRoot, packageJson.main));
await access(resolve(packageRoot, "workflows"));
await access(resolve(packageRoot, ".claude", "commands"));
process.stdout.write(`Node ${process.version}: packed path/resource smoke passed\n`);
```

Add `workflow_dispatch:` under `on:` and this separate job to `.github/workflows/ci.yml`:

```yaml
  package-path-smoke-node18:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 18
          cache: npm
      - run: npm ci
      - run: npm run build
      - id: pack
        env:
          PACK_JSON: ${{ runner.temp }}/pack.json
        run: |
          npm pack --ignore-scripts --json --pack-destination "$RUNNER_TEMP" > "$PACK_JSON"
          PACK_NAME="$(node --input-type=module --eval 'import { readFileSync } from "node:fs"; process.stdout.write(JSON.parse(readFileSync(process.env.PACK_JSON, "utf8"))[0].filename)')"
          echo "tarball=$RUNNER_TEMP/$PACK_NAME" >> "$GITHUB_OUTPUT"
      - run: mkdir -p "$RUNNER_TEMP/smoke" && npm install --prefix "$RUNNER_TEMP/smoke" --ignore-scripts --no-audit --no-fund "${{ steps.pack.outputs.tarball }}"
      - run: node scripts/smoke-node18-paths.mjs "$RUNNER_TEMP/smoke/node_modules/e-arveldaja-mcp"
```

- [ ] **Step 5: Prove green and independently review**

Run: `npx vitest run src/paths.test.ts src/release-metadata.test.ts && npm run build && PACK_DIR="$(mktemp -d)" && npm pack --ignore-scripts --pack-destination "$PACK_DIR" && INSTALL_DIR="$(mktemp -d)" && npm install --prefix "$INSTALL_DIR" --ignore-scripts --no-audit --no-fund "$PACK_DIR"/*.tgz && node scripts/smoke-node18-paths.mjs "$INSTALL_DIR/node_modules/e-arveldaja-mcp" && npx --yes node@18 scripts/smoke-node18-paths.mjs "$INSTALL_DIR/node_modules/e-arveldaja-mcp" && git diff --check`

Expected: both suites PASS, build/pack/install/path-resource smoke PASS on the current Node and the downloaded Node 18 binary, no whitespace errors, and `rg -n "import.meta.dirname" src dist` returns no match after build. Network approval may be required for the one-time `node@18` package download. Write `.omc/reviews/H01.diff` and obtain both required fresh-reviewer verdicts.

- [ ] **Step 6: Commit H01**

```bash
git add src/paths.ts src/paths.test.ts src/release-metadata.test.ts scripts/smoke-node18-paths.mjs .github/workflows/ci.yml
git commit -m "fix(H01): support Node 18 project paths"
```

- [ ] **Step 7: Record Node 18 proof, then ledger and clean**

Append the H01 ledger row only after the local `npx --yes node@18` smoke reports `Node v18` plus `packed path/resource smoke passed`; then require `git status --short` to be empty. The committed CI lane preserves the same proof for future pushes, but this task does not authorize or require a push. D02 later replaces this narrow smoke with the full packed-runtime validator; it does not defer H01's Node 18 proof.

### Task 2: H02 — Lossless TOON emission

**Files:**
- Modify: `src/mcp-json.ts:75-100`
- Modify: `src/mcp-json.test.ts:118-170`

**Interfaces:**
- Consumes: `decode(text: string): unknown` from `@toon-format/toon`.
- Produces: `jsonDeepEqual(left: unknown, right: unknown): boolean`; `toMcpJson(obj: unknown): string` emits TOON only when decoded output is deeply equivalent.

- [ ] **Step 1: Write the failing regression**

```ts
import { decode } from "@toon-format/toon";
import { describe, expect, it, vi } from "vitest";

vi.mock("@toon-format/toon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@toon-format/toon")>();
  return { ...actual, decode: vi.fn(actual.decode) };
});

const mockedDecode = vi.mocked(decode);

it("falls back to JSON when TOON decodes to a different value without throwing", () => {
  const source = { count: 3, status: "ok" };
  mockedDecode.mockReturnValueOnce({ count: "3", status: "ok" });

  const encoded = toMcpJson(source);
  expect(encoded).toBe(JSON.stringify(source));
});

it("keeps TOON when TOON decoding is lossless", () => {
  const source = { count: 3, status: "ok" };
  const encoded = toMcpJson(source);

  expect(encoded.trimStart().startsWith("{")).toBe(false);
  expect(decode(encoded)).toEqual(source);
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/mcp-json.test.ts -t "decodes to a different value"`

Expected: FAIL because the mocked `decode(encoded)` succeeds with a scalar-type mismatch, but the current implementation ignores the decoded value and returns non-JSON TOON. The partial mock delegates to the real codec for all calls except this one deliberate mismatch. The installed `@toon-format/toon@2.3.0` currently round-trips the original sample losslessly, so that sample must not be forced to JSON.

- [ ] **Step 3: Implement exact decoded-value comparison**

```ts
export function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => jsonDeepEqual(value, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      jsonDeepEqual(leftRecord[key], rightRecord[key]));
}

const encoded = encode(stripped);
try {
  const decoded = decode(encoded);
  return jsonDeepEqual(decoded, stripped) ? encoded : json;
} catch {
  return json;
}
```

- [ ] **Step 4: Prove green and independently review**

Run: `npx vitest run src/mcp-json.test.ts && npm run build && git diff --check`

Expected: suite PASS, build PASS, no whitespace errors. Write `.omc/reviews/H02.diff` and obtain both required fresh-reviewer verdicts.

- [ ] **Step 5: Commit H02**

```bash
git add src/mcp-json.ts src/mcp-json.test.ts
git commit -m "fix(H02): require lossless TOON round trips"
```

- [ ] **Step 6: Append ledger row and prove clean status**

Record the H02 commit and both verdicts in the ledger, then run `git status --short` and require empty output.

- [ ] **Step 7: Pass Wave 1 gate**

Run: `npm run validate:release && git diff --check && npm run build && npm test && npm run test:integration`

Expected: release validation, 1,754-or-more unit tests, build, and integration suite all PASS with only the baseline documented skips; `git status --short` remains empty.

### Task 3: H03 — Preserve transaction client on indeterminate confirmation

**Goal:** Permit cleanup only after a proven confirmation rejection. Ambiguous register, reread, or cleanup outcomes preserve clients_id and the transaction ID, invalidate every affected cache, and expose neutral recovery data without another speculative mutation.

**Files:**
- Create: src/mutation-outcome.ts
- Create: src/mutation-outcome.test.ts
- Modify: src/tool-error.test.ts
- Modify: src/api/transactions.api.ts
- Modify: src/tools/crud/transactions.ts
- Modify: src/api/transactions.api.test.ts
- Modify: src/tools/crud-tools.test.ts

This seven-file source/test list is exact. Do not change src/tool-error.ts, src/api/base-resource.ts, or any other source/test file for H03. Ignored .omc review and ledger evidence is not part of the commit.

**Acceptance contract:**
- Preserve API-auto-set and explicit tool-set clients_id on indeterminate confirmation.
- A definite HTTP rejection or fresh PROJECT reread may use the existing safe cleanup path.
- Register network error plus failed reread, or a reread status other than CONFIRMED/PROJECT, returns MutationIndeterminateError for operation confirm and performs no clear.
- A network-ambiguous cleanup returns MutationIndeterminateError for operation rollback and retains entityId/businessKey.
- Every register catch invalidates /transactions before recovery. If a fresh reread returns neither CONFIRMED nor PROJECT, re-invalidate /transactions after that reread and before invalidating /journals and throwing, because get(id) repopulates the transaction cache. Every ambiguous confirmation invalidates /journals. Public TransactionsApi.invalidateTransactionsAfterAmbiguousCleanup() invalidates /transactions for both API-auto and explicit tool cleanup ambiguity.
- CONFIRMED reread still returns recovered success. Existing compound warning/error behavior for non-network rollback failure remains unchanged.
- toolError serializes every neutral field, including the serializable cause.

- [ ] **Step 1: Baseline**

Run:

~~~bash
git status --short
npx vitest run src/tool-error.test.ts src/api/transactions.api.test.ts src/tools/crud-tools.test.ts
~~~

Expected: clean status and all existing suites PASS. Record the output. Do not use the old -t "indeterminate" command: it selects only the existing textual test and produces a false green.

- [ ] **Step 2: RED-A — add only the missing neutral-module tests**

Create src/mutation-outcome.test.ts before any other suite imports the new module:

~~~ts
import { describe, expect, it } from "vitest";
import { HttpError } from "./http-client.js";
import {
  MutationIndeterminateError,
  describeMutationCause,
  isMutationIndeterminate,
  type MutationOperation,
} from "./mutation-outcome.js";

describe("H03 mutation outcome", () => {
  it("H03 mutation outcome exposes serializable recovery and HttpError cause fields", () => {
    const operation: MutationOperation = "confirm";
    const error = new MutationIndeterminateError({
      operation,
      entity: "transaction",
      entityId: 7,
      businessKey: "transaction:7",
      affectedCaches: ["/transactions", "/journals"],
      cause: new HttpError("lost", "network", "PATCH", "/transactions/7/register"),
      nextAction: "Freshly read transaction 7 before any retry.",
    });
    expect(error).toMatchObject({
      name: "MutationIndeterminateError",
      category: "mutation_indeterminate",
      mutationMayHaveOccurred: true,
      operation: "confirm",
      entity: "transaction",
      entityId: 7,
      businessKey: "transaction:7",
      affectedCaches: ["/transactions", "/journals"],
      cause: {
        name: "HttpError",
        message: "lost",
        status: "network",
        method: "PATCH",
        path: "/transactions/7/register",
      },
      nextAction: "Freshly read transaction 7 before any retry.",
    });
    expect(JSON.parse(JSON.stringify(error.cause))).toEqual({
      name: "HttpError",
      message: "lost",
      status: "network",
      method: "PATCH",
      path: "/transactions/7/register",
    });
  });

  it("H03 mutation outcome normalizes ordinary and non-Error causes", () => {
    expect(describeMutationCause(new TypeError("bad shape"))).toEqual({
      name: "TypeError",
      message: "bad shape",
    });
    expect(describeMutationCause({ code: "ODD" })).toEqual({
      name: "UnknownThrownValue",
      message: "[object Object]",
    });
  });

  it("H03 mutation outcome recognizes instances and serialized errors safely", () => {
    const instance = new MutationIndeterminateError({
      operation: "rollback",
      entity: "transaction",
      entityId: 7,
      businessKey: "transaction:7",
      affectedCaches: ["/transactions"],
      cause: new Error("cleanup lost"),
      nextAction: "Freshly read transaction 7.",
    });
    expect(isMutationIndeterminate(instance)).toBe(true);
    expect(isMutationIndeterminate({
      category: "mutation_indeterminate",
      mutationMayHaveOccurred: true,
    })).toBe(true);
    expect(isMutationIndeterminate({
      category: "mutation_indeterminate",
      mutationMayHaveOccurred: false,
    })).toBe(false);
    expect(isMutationIndeterminate({ category: "mutation_indeterminate" })).toBe(false);
    expect(isMutationIndeterminate(null)).toBe(false);
  });
});
~~~

Run:

~~~bash
npx vitest run src/mutation-outcome.test.ts -t "H03 mutation outcome"
~~~

Expected RED-A: module resolution fails because mutation-outcome.ts does not exist. This is the deliberate compile RED. Do not add dependent imports before recording it.

- [ ] **Step 3: GREEN-A — implement the neutral outcome**

Create src/mutation-outcome.ts:

~~~ts
import { HttpError } from "./http-client.js";

export type MutationOperation =
  | "create" | "update" | "delete" | "upload"
  | "confirm" | "invalidate" | "rollback";

export interface MutationCause {
  name: string;
  message: string;
  status?: number | "network";
  method?: string;
  path?: string;
}

export interface MutationIndeterminateContext {
  operation: MutationOperation;
  entity: string;
  entityId?: number;
  businessKey: string;
  affectedCaches: string[];
  cause: unknown;
  nextAction: string;
}

export function describeMutationCause(cause: unknown): MutationCause {
  if (cause instanceof HttpError) {
    return {
      name: cause.name,
      message: cause.message,
      status: cause.status,
      method: cause.method,
      path: cause.path,
    };
  }
  if (cause instanceof Error) return { name: cause.name, message: cause.message };
  return { name: "UnknownThrownValue", message: String(cause) };
}

export class MutationIndeterminateError extends Error {
  readonly category = "mutation_indeterminate" as const;
  readonly mutationMayHaveOccurred = true;
  readonly operation: MutationOperation;
  readonly entity: string;
  readonly entityId?: number;
  readonly businessKey: string;
  readonly affectedCaches: string[];
  readonly cause: MutationCause;
  readonly nextAction: string;

  constructor(context: MutationIndeterminateContext) {
    const serializableCause = describeMutationCause(context.cause);
    super(
      context.operation + " " + context.businessKey + " is indeterminate. " +
        context.nextAction,
      { cause: serializableCause },
    );
    this.name = "MutationIndeterminateError";
    this.operation = context.operation;
    this.entity = context.entity;
    this.entityId = context.entityId;
    this.businessKey = context.businessKey;
    this.affectedCaches = [...context.affectedCaches];
    this.cause = serializableCause;
    this.nextAction = context.nextAction;
  }
}

export function isMutationIndeterminate(
  error: unknown,
): error is MutationIndeterminateError {
  return error instanceof MutationIndeterminateError || (
    typeof error === "object" &&
    error !== null &&
    (error as { category?: unknown }).category === "mutation_indeterminate" &&
    (error as { mutationMayHaveOccurred?: unknown }).mutationMayHaveOccurred === true
  );
}
~~~

Run:

~~~bash
npx vitest run src/mutation-outcome.test.ts -t "H03 mutation outcome"
~~~

Expected GREEN-A: all three selected tests PASS.

- [ ] **Step 4: Characterize toolError**

Add the MutationIndeterminateError import and one test named H03 toolError serializes every neutral mutation field to src/tool-error.test.ts. Construct the same network PATCH error used above and assert exact equality for error, name, category, mutationMayHaveOccurred, operation, entity, entityId, businessKey, affectedCaches, cause.name/message/status/method/path, and nextAction.

Run:

~~~bash
npx vitest run src/tool-error.test.ts -t "H03 toolError"
~~~

Expected: PASS without changing src/tool-error.ts. This is a compatibility characterization, not another RED.

- [ ] **Step 5: RED-B — add the API cases**

In src/api/transactions.api.test.ts, replace the existing text-only indeterminate test with a structured H03 API test and add three adjacent tests. Every name must contain H03 API so the command below selects exactly these four cases:

1. API-auto-set purchase-invoice client; register PATCH and reread GET both return network HttpError. Assert confirm outcome fields, GET cause, no clients_id:null patch, and seeded /transactions plus /journals cache entries are absent.
2. Already-set client, representing explicit tool state on entry to TransactionsApi.confirm; the same ambiguity returns structured confirm outcome and the only PATCH is register.
3. Network register plus a fresh VOID status; assert structured confirm outcome, no cleanup, both caches invalidated.
4. Definite register 409 followed by network-ambiguous API-auto cleanup; seed a transaction cache entry immediately before throwing cleanup HttpError, assert structured rollback outcome with transaction ID/key/cause, and assert the cache is absent after invalidateTransactionsAfterAmbiguousCleanup() runs.

Keep the existing CONFIRMED recovery, PROJECT cleanup, definite HTTP rejection, successful cache invalidation, and compound non-network rollback-failure tests unchanged.

Run:

~~~bash
npx vitest run src/api/transactions.api.test.ts -t "H03 API"
~~~

Expected RED-B: exactly four tests run and fail for the intended neutral-field, unsafe-cleanup, or cache assertions.

- [ ] **Step 6: GREEN-B — implement one API state machine**

Import MutationIndeterminateError in src/api/transactions.api.ts. Add this public method to TransactionsApi so both the API and tool cleanup paths use the same cache-invalidating seam:

~~~ts
public invalidateTransactionsAfterAmbiguousCleanup(): void {
  this.invalidateCache();
}
~~~

Then replace the entire confirm catch, with these exact branches:

1. Call this.invalidateCache() immediately on every register error.
2. For register HttpError status network, perform one fresh get(id).
3. Reread failure: invalidate /journals and throw confirm MutationIndeterminateError whose cause is the read error.
4. Fresh CONFIRMED: invalidate /journals and return the existing recovered-success response.
5. Fresh PROJECT: registration is proven rejected; continue to safe cleanup.
6. Any other/absent status: call this.invalidateCache() again after the reread and immediately before invalidating /journals and throwing confirm MutationIndeterminateError. The fresh get(id) repopulates /transactions, so the second transaction invalidation is required. Do not clean clients_id.
7. If API auto-set clientsIdWasSet, attempt the existing clear only after definite HTTP rejection or fresh PROJECT.
8. Cleanup network HttpError: call this.invalidateTransactionsAfterAmbiguousCleanup() immediately before throwing rollback MutationIndeterminateError. BaseResource.update invalidates only on success, so this explicit call is required.
9. Cleanup non-network failure: preserve the existing stderr warning and compound Error containing both register and rollback messages.
10. Otherwise rethrow the original definite rejection.

Use affectedCaches ["/transactions", "/journals"] for confirm ambiguity and ["/transactions"] for rollback ambiguity. Include entity transaction, entityId id, businessKey transaction:id, the serializable cause, and a nextAction requiring a fresh read before retry.

Run:

~~~bash
npx vitest run src/mutation-outcome.test.ts -t "H03 mutation outcome"
npx vitest run src/api/transactions.api.test.ts
~~~

Expected GREEN-B: neutral and complete API suites PASS, including all pre-existing compatibility cases.

- [ ] **Step 7: RED-C — add explicit tool-set cases**

Add HttpError and MutationIndeterminateError imports to src/tools/crud-tools.test.ts. Inside describe("confirm_transaction"), add:

- One it.each test named H03 CRUD cleans a tool-set client only after proven rejection:
  - HttpError 409 expects the initial clients_id set plus one cleanup.
  - MutationIndeterminateError confirm expects only the initial set and explicitly forbids clients_id:null.
- One test named H03 CRUD exposes ambiguous explicit-client cleanup as rollback:
  - confirm rejects with HttpError 409.
  - initial update resolves and cleanup update rejects with network HttpError.
  - override invalidateTransactionsAfterAmbiguousCleanup with vi.fn().
  - assert rollback neutral fields, entityId/key, affected transaction cache list, and cause path.
  - assert api.transactions.invalidateTransactionsAfterAmbiguousCleanup was called exactly once before the rollback error is observed.

Every new case uses account distribution 4000 and must override readonly.getAccounts with one active non-dimensioned account 4000 and readonly.getAccountDimensions with an empty array. Otherwise the test fails in validation before reaching H03 behavior.

Run:

~~~bash
npx vitest run src/tools/crud-tools.test.ts -t "H03 CRUD"
~~~

Expected RED-C: exactly three cases run. The structured confirmation case performs an unwanted clear and cleanup ambiguity is swallowed; failures are not dimension-validation errors.

- [ ] **Step 8: GREEN-C — guard tool cleanup**

In src/tools/crud/transactions.ts import MutationIndeterminateError and isMutationIndeterminate. Replace only the confirm_transaction catch:

~~~ts
} catch (error) {
  if (clientsIdWasSet && !isMutationIndeterminate(error)) {
    try {
      await api.transactions.update(
        id,
        { clients_id: null } as Partial<Transaction>,
      );
    } catch (cleanupError) {
      if (
        cleanupError instanceof HttpError &&
        cleanupError.status === "network"
      ) {
        api.transactions.invalidateTransactionsAfterAmbiguousCleanup();
        throw new MutationIndeterminateError({
          operation: "rollback",
          entity: "transaction",
          entityId: id,
          businessKey: "transaction:" + id,
          affectedCaches: ["/transactions"],
          cause: cleanupError,
          nextAction: "Freshly read transaction " + id +
            "; clients_id cleanup may or may not have committed.",
        });
      }
      throw cleanupError;
    }
  }
  throw error;
}
~~~

The explicit public method call is required here even though confirm invalidates earlier: cache state can be repopulated between the register rejection and cleanup failure. Both API-auto and tool-set cleanup ambiguity must invoke the same method immediately before throwing the rollback outcome.

Run:

~~~bash
npx vitest run src/tools/crud-tools.test.ts -t "H03 CRUD"
npx vitest run src/tools/crud-tools.test.ts
~~~

Expected GREEN-C: selected and complete CRUD suites PASS.

- [ ] **Step 9: Focused and full verification**

Run:

~~~bash
npx vitest run src/mutation-outcome.test.ts src/tool-error.test.ts src/api/transactions.api.test.ts src/tools/crud-tools.test.ts
npm run build
npm test
npm run test:integration
git diff --check
H03_INDEX="$(mktemp)"
cp "$(git rev-parse --git-path index)" "$H03_INDEX"
GIT_INDEX_FILE="$H03_INDEX" git add -- \
  src/api/transactions.api.test.ts src/api/transactions.api.ts \
  src/mutation-outcome.test.ts src/mutation-outcome.ts \
  src/tool-error.test.ts src/tools/crud-tools.test.ts \
  src/tools/crud/transactions.ts
GIT_INDEX_FILE="$H03_INDEX" git diff --cached --check
GIT_INDEX_FILE="$H03_INDEX" git diff --cached --name-only
rm -f "$H03_INDEX"
git diff --cached --quiet
~~~

Expected: all focused/full checks PASS with only baseline skips. The temporary-index git diff --cached --name-only includes tracked and untracked work and prints exactly:

~~~text
src/api/transactions.api.test.ts
src/api/transactions.api.ts
src/mutation-outcome.test.ts
src/mutation-outcome.ts
src/tool-error.test.ts
src/tools/crud-tools.test.ts
src/tools/crud/transactions.ts
~~~

The temporary index is deleted afterward, and git diff --cached --quiet proves the real index remains empty. Do not use git add -N or any other real-index staging before Step 11.

- [ ] **Step 10: Independent review**

Run:

~~~bash
mkdir -p .omc/reviews
H03_INDEX="$(mktemp)"
cp "$(git rev-parse --git-path index)" "$H03_INDEX"
GIT_INDEX_FILE="$H03_INDEX" git add -- \
  src/api/transactions.api.test.ts src/api/transactions.api.ts \
  src/mutation-outcome.test.ts src/mutation-outcome.ts \
  src/tool-error.test.ts src/tools/crud-tools.test.ts \
  src/tools/crud/transactions.ts
GIT_INDEX_FILE="$H03_INDEX" git diff --cached \
  --output=.omc/reviews/H03.diff -- \
  src/api/transactions.api.test.ts src/api/transactions.api.ts \
  src/mutation-outcome.test.ts src/mutation-outcome.ts \
  src/tool-error.test.ts src/tools/crud-tools.test.ts \
  src/tools/crud/transactions.ts
test -s .omc/reviews/H03.diff
GIT_INDEX_FILE="$H03_INDEX" git diff --cached --stat -- \
  src/api/transactions.api.test.ts src/api/transactions.api.ts \
  src/mutation-outcome.test.ts src/mutation-outcome.ts \
  src/tool-error.test.ts src/tools/crud-tools.test.ts \
  src/tools/crud/transactions.ts
rm -f "$H03_INDEX"
git diff --cached --quiet
~~~

The copied temporary index makes both new untracked mutation-outcome files visible in the review artifact and stat. Removing it and passing git diff --cached --quiet prove that review packaging did not alter the real index; Step 11 remains the first real staging operation.

Give a fresh non-author reviewer the approved H03 design row, H03.diff, RED-A/B/C evidence, and all green output. Require exact verdicts:

~~~text
SPEC COMPLIANCE: APPROVED
CODE QUALITY: APPROVED
~~~

The review must explicitly cover both client sources, definite rejection versus ambiguous register/reread/cleanup, cache invalidation matching affectedCaches, toolError serialization, compound non-network rollback compatibility, and exact seven-file scope. Rejection requires an in-scope fix, full reverification, overwritten artifact, and a new reviewer.

- [ ] **Step 11: Commit H03**

Run:

~~~bash
git status --short
git add \
  src/api/transactions.api.test.ts src/api/transactions.api.ts \
  src/mutation-outcome.test.ts src/mutation-outcome.ts \
  src/tool-error.test.ts src/tools/crud-tools.test.ts \
  src/tools/crud/transactions.ts
git diff --cached --name-only
git commit -m "fix(H03): preserve clients on ambiguous confirmation"
~~~

Expected: staged names are exactly the seven approved paths. Do not stage ignored review or ledger artifacts.

- [ ] **Step 12: Ledger and clean status**

Append one H03 ledger row containing RED-A/B/C commands/results, focused/build/full/integration/diff results, both verdicts, and commit hash. Then run:

~~~bash
git status --short
~~~

Expected: empty output. Do not begin H04 until the H03 row is complete, both verdicts are recorded, and the worktree is clean.

### Task 4: H04 — Confirmed accounting records are immutable through generic updates

**Files:**
- Modify: `src/tools/crud/shared.ts`
- Modify: `src/tools/crud/journals.ts`
- Modify: `src/tools/crud/purchase-invoices.ts`
- Modify: `src/tools/crud/sale-invoices.ts`
- Modify: `src/tools/crud-tools.test.ts`

**Contract:** Confirmed journals and invoices accept only explicitly approved descriptive metadata. Ledger-bearing and lifecycle fields fail atomically with `category: "confirmed_record_immutable"` and invalidate-fetch-edit-reconfirm guidance. Draft/project ledger edits remain compatible, while draft blocked or empty patches retain `error: "Invalid update fields"`.

- [ ] **Step 1: Verify the clean five-file scope**

Run:

~~~bash
git status --short
git diff --name-only
git ls-files --others --exclude-standard
~~~

Expected: all outputs are empty. H04 may modify exactly the five paths above; `.omc` review and ledger files remain ignored and uncommitted.

- [ ] **Step 2: Add the 41-case H04 RED suite**

In `src/tools/crud-tools.test.ts`, import `validateUpdateFields` from the existing `./crud-tools.js` import; `crud-tools.ts` already re-exports `./crud/shared.js`. Add one table-driven suite with **exactly 41 expanded tests**. Every generated and non-table test title must contain `H04`, so the required selector cannot match legacy tests.

1. **23 confirmed validator rejections:**
   - journal (7): `postings`, `effective_date`, `document_number`, `clients_id`, `is_deleted`, `registered`, `status`;
   - purchase invoice (8): `items`, `gross_price`, `clients_id`, `liability_accounts_id`, `is_deleted`, `status`, `registered`, `payment_status`;
   - sale invoice (8): `items`, `gross_price`, `clients_id`, `receivable_accounts_id`, `is_deleted`, `status`, `registered`, `payment_status`.
2. A 6-row validator allow table for the complete approved metadata matrix: journal `title`; purchase invoice `notes`; sale invoice `notes`, `invoice_info`, `payment_description`, and `additional_info_content`.
3. **3 confirmed handler rejections**, one per entity, using a non-allowlisted ledger field. Assert no `update`, the exact entity-specific error, category `confirmed_record_immutable`, details naming `invalidate_<entity>`, and `next_action` describing invalidate, fetch draft, edit, and explicitly re-confirm.
4. **3 confirmed handler compatibility cases:** journal `title`; purchase `notes`; and one sale patch containing all four allowed fields. For purchase notes, assert the transport receives current items but a new array whose every object is a distinct shallow clone with equal values.
5. **3 draft/project blocked cases:** journal `registered`, purchase `payment_status`, and sale `status`. Assert no mutation, `error: "Invalid update fields"`, and no `confirmed_record_immutable` category.
6. **3 draft/project ledger compatibility cases:** journal `effective_date` plus `postings`, purchase `journal_date` plus caller-supplied `items`, and sale `journal_date` plus `items`; assert exact forwarding.

Use correctly shaped values: arrays for `items`/`postings`, booleans for `is_deleted`/`registered`, strings for statuses/dates/text, and numbers for IDs/totals. In the confirmed purchase caller-items rejection, prove validation happens before transport completion: the caller array is rejected unchanged and the API `update` is never called.

- [ ] **Step 3: Run the deterministic RED**

Run:

~~~bash
npx vitest run src/tools/crud-tools.test.ts -t "H04"
~~~

Expected before production changes: **exactly 41 tests selected; 19 fail and 22 pass**. The failures are 15 newly unprotected confirmed validator fields, 3 handler-category cases, and the purchase deep-clone assertion. Zero selected tests or a validation/setup failure is not acceptable RED evidence.

- [ ] **Step 4: Add the type-checked confirmed metadata allowlist**

In `src/tools/crud/shared.ts`, add `Journal`, `PurchaseInvoice`, and `SaleInvoice` to the existing type-only import from `../../types/api.js`. Define:

```ts
type ConfirmableEntity = "journal" | "purchase_invoice" | "sale_invoice";
type ConfirmedMetadataMatrix = {
  journal: readonly (keyof Journal)[];
  purchase_invoice: readonly (keyof PurchaseInvoice)[];
  sale_invoice: readonly (keyof SaleInvoice)[];
};

export const CONFIRMED_UPDATE_METADATA = {
  journal: ["title"],
  purchase_invoice: ["notes"],
  sale_invoice: ["notes", "invoice_info", "payment_description", "additional_info_content"],
} as const satisfies ConfirmedMetadataMatrix;

function isConfirmableEntity(entity: keyof typeof UPDATE_BLOCKED_FIELDS): entity is ConfirmableEntity {
  return entity === "journal" || entity === "purchase_invoice" || entity === "sale_invoice";
}
```

Keep the empty-object check first. For a non-empty confirmed confirmable entity, reject every caller key outside its allowlist, naming the field and exact `invalidate_<entity>` → fetch draft → edit → re-confirm recovery. Only draft/project and non-confirmable entities reach the existing generic denylist. Remove `post_confirm_fields` and the obsolete date-only confirmed branch.

- [ ] **Step 5: Classify handler failures and clone purchase transport items**

In each of `journals.ts`, `purchase-invoices.ts`, and `sale-invoices.ts`, compute `isConfirmed` once, pass it to `validateUpdateFields`, and branch immediately after validation:

```ts
if (updateErrors.length > 0) {
  if (isConfirmed && Object.keys(parsed).length > 0) {
    return toolError({
      category: "confirmed_record_immutable",
      error: `Confirmed ${entity} update contains ledger-bearing fields`,
      details: updateErrors,
      next_action: `invalidate_${entity}, fetch the draft, update it, then explicitly re-confirm`,
    });
  }
  return toolError({ error: "Invalid update fields", details: updateErrors });
}
```

Use the literal entity in each file. Confirmed non-allowlisted or mixed patches return `confirmed_record_immutable`; empty and draft/project denylisted patches retain `Invalid update fields`; confirmed allowlisted metadata continues to the API.

In `purchase-invoices.ts`, do API-required item completion **only after validation**, cloning both levels:

```ts
if (parsed.items === undefined && current.items !== undefined) {
  parsed.items = current.items.map(item => ({ ...item }));
}
```

This ensures caller-supplied confirmed items are validated before any completion, while confirmed notes re-send independent item data without aliasing fetched state.

- [ ] **Step 6: Prove focused GREEN, build, and full compatibility**

Run:

~~~bash
npx vitest run src/tools/crud-tools.test.ts -t "H04"
npx vitest run src/tools/crud-tools.test.ts src/api/purchase-invoices.api.test.ts src/api/sale-invoices.api.test.ts
npm run build
npm run validate:release
npm test
npm run test:integration
git diff --check
git diff --name-only
git ls-files --others --exclude-standard
~~~

Expected: **41/41 H04 tests pass**; all focused, build, release, full unit, and integration checks pass with only documented skips; `git diff --check` and untracked output are empty. `git diff --name-only` lists exactly the five H04 files in lexical order.

- [ ] **Step 7: Build the complete H04 review artifact**

Create `.omc/reviews/H04.diff` from the complete unstaged `git diff --` for exactly these five files:

~~~text
src/tools/crud/shared.ts
src/tools/crud/journals.ts
src/tools/crud/purchase-invoices.ts
src/tools/crud/sale-invoices.ts
src/tools/crud-tools.test.ts
~~~

The artifact must also contain: the H04 spec row; the exact RED command and `19 failed | 22 passed`; `41/41` GREEN; focused/build/release/full/integration/diff-check outputs; `git diff --stat` for the same five paths; exact changed-name output; and evidence that untracked output and the real index were empty. Run `test -s .omc/reviews/H04.diff`. If any sixth implementation file or staged file exists, correct scope before review.

- [ ] **Step 8: Obtain fresh sequential SPEC and QUALITY approval**

Give a fresh non-author spec reviewer the H04 row, complete artifact, and verification evidence. Require exactly:

~~~text
SPEC COMPLIANCE: APPROVED
~~~

Only after SPEC approval, give a different fresh non-author quality reviewer the same evidence plus the SPEC verdict. Require exactly:

~~~text
CODE QUALITY: APPROVED
~~~

SPEC checks the full confirmed rejection matrix, six metadata allowances, invalidate-edit-reconfirm contract, draft behavior, and exact scope. QUALITY checks type safety, classification, atomicity, clone ownership, test determinism, and maintainability. Any rejection requires an in-scope fix, all Step 6 checks again, artifact replacement, and both fresh sequential reviews again.

- [ ] **Step 9: Commit exactly the five H04 files**

Run:

~~~bash
git add \
  src/tools/crud/shared.ts \
  src/tools/crud/journals.ts \
  src/tools/crud/purchase-invoices.ts \
  src/tools/crud/sale-invoices.ts \
  src/tools/crud-tools.test.ts
git diff --cached --name-only
git diff --cached --check
git commit -m "fix(H04): lock confirmed ledger content"
~~~

Expected: staged names are exactly those five paths, cached diff-check passes, and the commit succeeds. Never stage `.omc` artifacts.

- [ ] **Step 10: Record the ledger row and prove clean handoff**

Append one H04 ledger row with the RED and GREEN counts, focused/build/release/full/integration evidence, both exact verdicts, five-file scope proof, and commit hash. Then run:

~~~bash
git status --short
git ls-files --others --exclude-standard
~~~

Expected: both outputs are empty before Task 5 begins.

### Task 5: H06 — Cross-process create-once guard

**Files:**
- Create: `src/connection-fingerprint.ts`
- Create: `src/connection-fingerprint.test.ts`
- Create: `src/file-lock.ts`
- Create: `src/file-lock.test.ts`
- Create: `src/__fixtures__/booking-guard-child.ts`
- Modify: `src/http-client.ts:65-80`
- Modify: `src/index.ts:210-225,385-415`
- Modify: `src/api/base-resource.ts:25-42`
- Modify: `src/api/base-resource.test.ts`
- Modify: `src/booking-guard.ts:1-330`
- Modify: `src/booking-guard.test.ts`
- Modify: `src/tools/estonian-tax.ts:450-525`
- Modify: `src/tools/estonian-tax.test.ts`
- Modify: `src/tools/currency-rounding.test.ts`
- Modify: `src/tools/lightyear-investments.test.ts`

**Contract and scope:**
- This task consumes H03 `MutationIndeterminateError`, `isMutationIndeterminate`, and `describeMutationCause`; raw network ambiguity remains `HttpError.status === "network"`.
- The cross-process key is `SHA-256(connectionFingerprint + NUL + "journal" + NUL + canonicalDocumentNumber)`. `cacheNamespace`, connection-array order, and `apiPassword` are deliberately excluded. The same fingerprint helper must initialize `HttpClient.connectionFingerprint` in its constructor and populate the audit-label fingerprint map in `index.ts`.
- `JournalsApi.invalidateListCache()` is already the required public cache boundary. H06 does not widen `BaseResource.invalidateCache`; it exposes only a read-only `BaseResource.connectionFingerprint` getter and uses the existing public journals invalidator before every verification read.
- Lock acquisition uses a fully-written owner candidate plus atomic hard-link publication. Empty/malformed owners and well-formed owners whose PID is live or cannot be proved dead remain busy until the deadline. Only a well-formed `ESRCH` main owner may be reclaimed after this process publishes a previously absent, independently owned reclaim guard; an already-existing reclaim guard is never auto-reclaimed. Timeout is the stable `lock_busy` category from the approved spec, not `lock_timeout`.
- `createJournalOnce` performs a cache invalidation and fresh upstream lookup *after* entering the keyed lock. Raw or structured ambiguous creates, absent `created_object_id`, and failed verification reads never trigger a second create. Confirmation ambiguity is verified by the known journal ID; an inconclusive or failed verification throws `MutationIndeterminateError` with that ID.
- Dividend identity remains backward compatible: its canonical stored number and lock business key are exactly `DIV-<effective_date>-<validated shareholder_client_id>`. Do not introduce a colon-form `DIV:` number, use `shareholder.id`, or add the amount to the key. Existing created-path response fields and `CREATED` audit summary/details remain stable; the duplicate path is explicitly reported without claiming a second create.
- H06 may modify exactly the fifteen paths listed above. The five new files are untracked until commit, so all verification/review packaging must use a copied temporary index.

- [ ] **Step 1: Verify the clean fifteen-file scope**

Run:

```bash
git status --short
git diff --name-only
git ls-files --others --exclude-standard
```

Expected: all outputs are empty. Do not begin H06 if H04 is not committed, its ledger row is incomplete, or the worktree is dirty.

- [ ] **Step 2: RED-A — specify one stable connection fingerprint**

Create `src/connection-fingerprint.test.ts` with test titles containing `H06-A`. Cover all of these assertions:

```ts
const config = {
  baseUrl: "https://rmp-api.rik.ee/v1/",
  apiKeyId: "key-id",
  apiPublicValue: "public-value",
  apiPassword: "password-one",
};

it("H06-A normalizes the URL and excludes process-local and secret values", () => {
  const expected = createHash("sha256")
    .update("https://rmp-api.rik.ee/v1\nkey-id\npublic-value")
    .digest("hex");
  const rotatedConfig = {
    ...config,
    baseUrl: " https://rmp-api.rik.ee/v1 ",
    apiPassword: "password-two",
  };
  expect(buildConnectionFingerprint(config)).toBe(expected);
  expect(buildConnectionFingerprint(rotatedConfig)).toBe(expected);
});

it("H06-A initializes equal clients independently of cache namespace and password", () => {
  const a = new HttpClient(config, "connection:0");
  const b = new HttpClient({ ...config, apiPassword: "rotated" }, "connection:9");
  expect(a.connectionFingerprint).toBe(buildConnectionFingerprint(config));
  expect(b.connectionFingerprint).toBe(a.connectionFingerprint);
});

it("H06-A makes BaseResource expose the client fingerprint read-only", () => {
  const resource = new BaseResource<{ id: number }>(new HttpClient(config), "/items");
  expect(resource.connectionFingerprint).toBe(buildConnectionFingerprint(config));
});

it("H06-A makes index audit initialization reuse the shared helper", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  expect(source).toContain("buildConnectionFingerprint(config.config)");
  expect(source).not.toMatch(/function buildConnectionFingerprint\s*\(/);
});
```

The last assertion is intentionally source-level: `index.ts` does not export startup internals, and the requirement is specifically that audit initialization cannot drift to a second implementation. In `src/api/base-resource.test.ts`, update `makeClient` to include a deterministic `connectionFingerprint` and add an `H06-A` getter assertion so structural fakes remain type-honest.

- [ ] **Step 3: Prove RED-A**

Run:

```bash
npx vitest run src/connection-fingerprint.test.ts src/api/base-resource.test.ts -t "H06-A"
```

Expected: FAIL because the module and both public properties do not exist and `index.ts` still owns a private duplicate helper. A missing-module/compiler failure is acceptable for this first create-file RED; zero selected tests is not.

- [ ] **Step 4: GREEN-A — implement and reuse the fingerprint**

Create `src/connection-fingerprint.ts`:

```ts
import { createHash } from "node:crypto";
import type { Config } from "./config.js";

export function buildConnectionFingerprint(
  config: Pick<Config, "baseUrl" | "apiKeyId" | "apiPublicValue">,
): string {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  return createHash("sha256")
    .update(`${baseUrl}\n${config.apiKeyId}\n${config.apiPublicValue}`)
    .digest("hex");
}
```

In `src/http-client.ts`, import the helper, declare `public readonly connectionFingerprint: string`, and assign it exactly once in the constructor body:

```ts
constructor(
  private config: Config,
  public readonly cacheNamespace = "connection:0",
  private readonly requestGuard?: () => void,
) {
  this.connectionFingerprint = buildConnectionFingerprint(config);
}
```

In `src/api/base-resource.ts`, add only:

```ts
get connectionFingerprint(): string {
  return this.client.connectionFingerprint;
}
```

In `src/index.ts`, import the shared helper, delete the local helper, and build the audit map with:

```ts
const connectionFingerprints = Object.fromEntries(
  allConfigs.map((config) => [config.name, buildConnectionFingerprint(config.config)]),
);
```

Keep the existing `createHash` import because credential-verification identity still uses it elsewhere in `index.ts`.

Run:

```bash
npx vitest run src/connection-fingerprint.test.ts src/api/base-resource.test.ts -t "H06-A"
npx tsc --ignoreConfig --noEmit --target ES2022 --module Node16 --moduleResolution Node16 --strict --esModuleInterop --skipLibCheck --forceConsistentCasingInFileNames --resolveJsonModule src/connection-fingerprint.test.ts src/api/base-resource.test.ts
```

Expected: all `H06-A` tests PASS and the explicit TypeScript 7 test-file typecheck PASS. Normal Vitest runs transpile tests without typechecking them, so this separate command is required and must not be omitted.

- [ ] **Step 5: RED-B — specify atomic ownership, reclaim, release, and FIFO**

Create `src/file-lock.test.ts`. Use one temporary directory per test (`mkdtemp`), remove it in `afterEach`, and give every test an `H06-B` title. Cover:

1. publication exposes a complete parseable token and mode no broader than `0600`;
2. a valid owner using PID `2147483646` is reclaimed and replaced;
3. `""`, `"not-json"`, a partial JSON token, PID 0, an empty nonce, and an invalid date each time out with `{ category: "lock_busy", mutationMayHaveOccurred: false, lockPath }` and remain byte-for-byte unchanged;
4. `process.pid` and a mocked `process.kill` `EPERM` owner remain unchanged and busy;
5. two simultaneous reclaimers of one dead owner cannot both enter (use two `acquireOwnedFileLock` calls, hold the winner, prove the other waits, release the winner, and then prove the waiter acquires);
6. any existing `${lockPath}.reclaim` guard — malformed, live, or dead — keeps even a valid-dead main owner busy and byte-for-byte unchanged until the deadline; after the test explicitly removes the reclaim guard, acquisition may publish its own guard and reclaim the main owner;
7. `release()` is idempotent and deletes its own token;
8. replacing the lock contents with a foreign valid token before `release()` leaves the foreign token untouched;
9. `withOwnedFileLock` runs three queued callbacks in call order, even when the first is held by a deferred promise;
10. a rejecting callback releases the file and advances the next FIFO waiter;
11. one caller holds the in-process predecessor beyond a queued caller's total timeout: the queued caller rejects with `LockBusyError` within that entry-to-deadline budget, its callback never runs, and a later queued caller proceeds after the holder releases.

The owner-policy assertions must call the exported policy helpers directly as well as through acquisition:

```ts
expect(parseOwner("not-json")).toEqual({ kind: "invalid" });
expect(ownerDefinitelyDead(parseOwner(JSON.stringify(deadOwner)))).toBe(true);
expect(ownerDefinitelyDead(parseOwner(JSON.stringify(liveOwner)))).toBe(false);
```

Run:

```bash
npx vitest run src/file-lock.test.ts -t "H06-B"
```

Expected: FAIL because `src/file-lock.ts` does not exist. Zero selected tests is not acceptable.

- [ ] **Step 6: GREEN-B — implement the hard-link lock and per-path FIFO**

Create `src/file-lock.ts` with these public types and stable busy error:

```ts
export interface OwnerToken { pid: number; nonce: string; createdAt: string }
export type ObservedOwner =
  | { kind: "valid"; token: OwnerToken }
  | { kind: "invalid" };
export interface LockOptions { timeoutMs?: number; pollMs?: number }
export interface OwnedFileLock { token: OwnerToken; release(): Promise<void> }

export class LockBusyError extends Error {
  readonly category = "lock_busy" as const;
  readonly mutationMayHaveOccurred = false;
  readonly nextAction: string;
  constructor(readonly lockPath: string, readonly timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for lock ${lockPath}.`);
    this.name = "LockBusyError";
    this.nextAction = `If no e-arveldaja process owns ${lockPath}, inspect its owner token before manual removal.`;
  }
}
```

Export `parseOwner(text)` and `ownerDefinitelyDead(owner)`. Parsing is strict about positive integer PID, non-empty nonce, and parseable timestamp. `ownerDefinitelyDead` returns true only when `process.kill(pid, 0)` throws `ESRCH`; invalid, live, `EPERM`, and every other result are false.

Use these private operations:

```ts
async function publishOwnedPath(path: string, text: string): Promise<boolean> {
  const candidate = `${path}.${process.pid}.${randomUUID()}.candidate`;
  await writeFile(candidate, text, { flag: "wx", mode: 0o600 });
  try {
    await link(candidate, path); // atomic winner; candidate is already complete
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(candidate, { force: true });
  }
}

async function releaseIfOwned(path: string, ownerText: string): Promise<void> {
  if (await readText(path) === ownerText) await rm(path, { force: true });
}
```

Reclamation must itself acquire an *absent* `${lockPath}.reclaim` through `publishOwnedPath`. Never auto-reclaim, replace, or remove an existing reclaim guard, regardless of whether its contents are malformed or its recorded PID appears live or dead; any existing reclaim guard remains busy until the acquisition deadline and requires manual inspection/removal. Only after this process atomically publishes the previously absent reclaim guard may it re-read `lockPath`, remove the main lock only if the bytes still equal the originally observed valid-dead token and a second liveness probe is still `ESRCH`, and then release its own reclaim guard with `releaseIfOwned`. Release normal paths with `releaseIfOwned` as well, so a foreign replacement is never removed.

`acquireOwnedFileLock` validates non-negative finite `timeoutMs` and positive finite `pollMs`, creates the parent directory with `0700`, publishes one JSON token, derives an absolute deadline from the budget it receives, and throws `LockBusyError` without deleting an unproved owner. `withOwnedFileLock` starts one absolute deadline when the function is entered and maintains `Map<string, Promise<void>>` tails. Waiting for the predecessor is deadline-aware; after that wait, file acquisition receives only the remaining budget, never a fresh timeout. On queued timeout or any other failure, resolve this caller's own queue turn in `finally` so successors are not poisoned, and delete the map entry only if it still points at this tail. After acquisition, call `fn`, release in `finally`, and advance the queue even when `fn` rejects.

Run:

```bash
npx vitest run src/file-lock.test.ts -t "H06-B"
```

Expected: all `H06-B` tests PASS, with no lock, reclaim, or candidate file left in any cleaned temporary directory.

- [ ] **Step 7: RED-C — migrate the create-once contract and add the two-process proof**

In `src/booking-guard.test.ts`, import H03 mutation outcomes and `withOwnedFileLock` from the now-green file-lock module. Do not import the not-yet-created `withBookingKeyLock` during RED. For the inside-lock regression, derive the required path in the test from `SHA-256(fingerprint + NUL + "journal" + NUL + formatDocNumber(key))`, hold it with `withOwnedFileLock`, and prove current `createJournalOnce` ignores that held path. Update `setup` before adding tests:

- expose `connectionFingerprint: "test-connection-fingerprint"`, `invalidateListCache`, `listAll`, `listAllWithPostings`, `get`, `create`, and `confirm` on the journals fake;
- make list state explicit so a successful create can be observed by the next fresh list; do not rely on the old process-local `guard.record()` shortcut;
- reset list/invalidator spies after `BookingGuard.load` in assertions that reason about the critical section;
- keep `listAllWithPostings` behavior unchanged for Lane B tests.

Replace the incompatible legacy expectations rather than keeping contradictory tests:

- replace `"leaves the journal in PROJECT when confirm throws"` with `"H06-C propagates a definite confirm rejection with createdJournalId"`, using an HTTP 400 and asserting the created ID is attached;
- replace `"retries exactly once when the ambiguous write did not commit"` with `"H06-C absent verification stays indeterminate and never retries"`, asserting one create;
- replace `"propagates a second network failure without a further retry"` with the verification-read-failure case, again asserting one create;
- update existing success/recovered tests for the additional fresh pre-check and exact-ID confirmation verification; direct-create results use `toMatchObject` and separately assert the retained `upstream_response`. No legacy test may continue to require a second POST or swallowed confirm error.

Add `H06-C` tests for this complete matrix:

1. the fresh pre-check occurs inside the lock. Derive and acquire the required external lock first, reset the critical-section spies, and make the fake `create` resolve a `createStarted` deferred/signal when entered. Start `createJournalOnce`, then use a short bounded `Promise.race` between `createStarted` and a real timer so the observation cannot be an immediate, vacuous `not.toHaveBeenCalled()` check. While the external holder is still active, assert the desired invariant from RED onward: `invalidateListCache`, `listAll`, and `create` are all untouched. The current implementation must fail this invariant specifically because the bounded observation sees `create` run. Put cleanup in `finally`: add a matching live journal to the shared list, release the external holder, await the holder promise, and `await Promise.allSettled([pendingCreateOnce])` so intentional RED cannot leave either operation or its lock alive. After GREEN the bounded observation times out without any critical operation, cleanup releases the holder, and the settled result is asserted `duplicate`; also assert `invalidateListCache` precedes `listAll` and `create` never runs;
2. raw network and structural H03 create ambiguity, each with fresh verification found, absent, and throwing; all six cases call create once, found returns `{ recovered: true }`, and the other four throw `mutation_indeterminate`;
3. a definite HTTP 400 create rejection performs no ambiguity verification and calls create once;
4. missing `created_object_id` with verification found recovers the ID; missing ID with absent or failed verification is indeterminate and never records sentinel `-1`;
5. raw network and structural H03 confirm ambiguity, each with exact `journals.get(createdId)` showing registered true, false, and throwing; true recovers, while false/throwing reject with `{ category: "mutation_indeterminate", operation: "confirm", entityId: createdId, businessKey, affectedCaches: ["/journals"] }`;
6. a definite confirm rejection and an unexpected non-HTTP error are not swallowed; both carry `createdJournalId`;
7. all verification branches call the public `invalidateListCache()` immediately before `listAll()` or exact-ID `get()`.

Create `src/__fixtures__/booking-guard-child.ts`. Arguments are `<statePath> <fingerprint>`. The fixture:

- reads a JSON journal array from `statePath` for `listAll`;
- exposes the supplied fingerprint and a no-op public invalidator;
- on create, waits 75 ms, writes the next full state to a unique sibling temporary file, renames it atomically over `statePath`, and returns the created ID;
- calls `BookingGuard.load(api).createJournalOnce({ ns: "FX", id: "child-proof" }, payload, { confirm: false })`;
- prints exactly one JSON line containing the result and sets a non-zero exit code on error.

The atomic rename is required because each child performs the initial `BookingGuard.load` before it acquires the booking lock; a late child must see either the old or new complete state, never half-written JSON.

In the parent `H06-C cross-process` test, initialize `statePath` to `[]`, set a unique `EARVELDAJA_LOCK_DIR`, and spawn two processes with:

```ts
spawn(process.execPath, ["--import", "tsx", fixturePath, statePath, fingerprint], {
  env: { ...process.env, EARVELDAJA_LOCK_DIR: lockDir },
  stdio: ["ignore", "pipe", "pipe"],
});
```

The child helper must capture stdout/stderr, use an explicit test timeout of at least 15 seconds, clear each child's five-second timer on both `error` and `close`, send `SIGKILL` on timeout, and include stderr in failures. Save the prior `EARVELDAJA_LOCK_DIR` value before the test; in `finally`, restore it when it existed or delete it when it did not. Track both child handles and their close promises. In test `finally`, kill every child whose `exitCode` and `signalCode` are both `null`, await all close promises, restore/delete the environment variable, and only then remove the state and lock directories. Require exit code 0, statuses exactly `created` and `duplicate` in either order, and one journal in final state. This is the required process proof; `Promise.all` in one process is insufficient.

Run:

```bash
npx vitest run src/booking-guard.test.ts -t "H06-C"
```

Expected: FAIL because there is no keyed booking lock: the held-lock invariant deterministically observes `create` start while the external holder is active and the `create`-untouched assertion fails. The remaining RED cases also expose the process-local pre-check, raw ambiguity retry, unrecognized structural ambiguity, sentinel `-1`, and swallowed confirmation failures. Fixture import/setup failures are not acceptable RED evidence.

- [ ] **Step 8: GREEN-C — lock the fresh check and make ambiguity fail closed**

In `src/booking-guard.ts`:

1. Add `"DIV"` to `DocNamespace`, but preserve its legacy spelling:

```ts
export function formatDocNumber(key: DocKey): string {
  return key.ns === "DIV" ? `DIV-${key.id}` : `${key.ns}:${key.id}`;
}

export function parseDocNumber(raw: string | null | undefined): DocKey | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw.startsWith("DIV-") && raw.length > 4) return { ns: "DIV", id: raw.slice(4) };
  // retain the existing first-colon FX/LY parser unchanged
}
```

Do not accept or emit `DIV:`. Add parser round-trip coverage for `DIV-2026-06-01-42`.

2. Export the keyed wrapper. Including the literal artifact type prevents a future non-journal key from colliding:

```ts
export async function withBookingKeyLock<T>(
  connectionFingerprint: string,
  key: DocKey,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = process.env.EARVELDAJA_LOCK_DIR ?? resolve(tmpdir(), "e-arveldaja-mcp-locks");
  const digest = createHash("sha256")
    .update(`${connectionFingerprint}\0journal\0${formatDocNumber(key)}`)
    .digest("hex");
  return withOwnedFileLock(resolve(lockDir, `${digest}.lock`), fn, {
    timeoutMs: 30_000,
    pollMs: 25,
  });
}
```

3. Define ambiguity structurally and use it for create and confirm:

```ts
function isAmbiguousMutation(error: unknown): boolean {
  return isMutationIndeterminate(error) ||
    (error instanceof HttpError && error.status === "network");
}
```

4. Replace `createJournalOnce` with one `withBookingKeyLock(this.api.journals.connectionFingerprint, key, async () => ...)` critical section. Its exact order is:

```text
invalidateListCache -> listAll -> liveness-aware exact key check -> create once
```

After any ambiguous create or missing ID, repeat `invalidateListCache -> listAll` once. If the key is found, recover its ID; if absent or the read throws, throw a new create `MutationIndeterminateError`. Never call create again in a catch branch. Do not use `UNKNOWN_JOURNAL_ID` for create responses.

Make the fresh scanner accept `liveness` and construct the artifact before applying `passesLiveness`; do not keep its current hard-coded `is_deleted` skip, which would make `liveness: "any"` ineffective. Extend only the created branch of `CreateOnceResult` with `upstream_response?: ApiResponse`. A direct successful create returns the exact upstream response in that field; recovered creates omit it. Existing Lightyear/currency consumers continue to use `status`/`journal_id` unchanged.

For confirmation, retain the known `journalId`. After raw/structured ambiguity, run `invalidateListCache -> get(journalId)` and accept success only when that exact object says `registered === true`. False, missing, or read failure becomes a confirm `MutationIndeterminateError` with `entityId: journalId`. A definite/upstream or unexpected confirm error is rethrown after attaching `createdJournalId` without overwriting existing error fields. Record into the in-run index only after a proven create/recovery outcome; an indeterminate branch records nothing.

Update only the shared journal fakes in `src/tools/currency-rounding.test.ts` and `src/tools/lightyear-investments.test.ts` for the newly required guarded API surface: add a deterministic `connectionFingerprint` and a no-op/spy `invalidateListCache`. Preserve their existing `listAll`, `listAllWithPostings`, `create`, `confirm`, fixture state, and all behavioral assertions unchanged; these two files are compatibility adaptations, not new currency or investment behavior.

Run:

```bash
npx vitest run src/booking-guard.test.ts -t "H06-C"
npx vitest run src/booking-guard.test.ts
```

Expected: selected and complete booking-guard suites PASS. The cross-process test terminates both children and leaves no fixture lock/candidate/reclaim files.

- [ ] **Step 9: RED-D — specify backward-compatible dividend deduplication**

In `src/tools/estonian-tax.test.ts`, make the shared `makeApi` journals fake compatible with the guarded path:

- retain the supplied accounting journals for `listAllWithPostings` so existing legality calculations do not change;
- maintain a separate stateful Lane-A journal list for `listAll`/`create`;
- expose `connectionFingerprint`, `invalidateListCache`, and `get`;
- have create append a correctly shaped draft journal carrying the submitted `document_number`.

Do not change the 43 existing dividend expectations except where direct access to the create payload now comes through the stateful fake. Add these `H06-D` regressions:

```ts
it("H06-D preserves the legacy dividend number and uses the validated client id", async () => {
  // clients.get(42) deliberately returns { id: 999, name: "Test Shareholder" }
  // The preview and executed payload must both remain DIV-2026-06-01-42,
  // clients_id and both preview/executed shareholder.id fields must remain 42.
});

it("H06-D deduplicates the same company/date/shareholder across calls", async () => {
  // Invoke the registered callback twice with identical approved input.
  // Assert journals.create once, both results name journal 42, and the second
  // result reports booking_status: "duplicate".
});

it("H06-D keeps created-path response and audit behavior compatible", async () => {
  // Assert journal_entry.api_response still has code/messages/created_object_id,
  // created_object_id is the guarded journal ID, and the first audit entry keeps
  // action CREATED, the existing summary wording, and all existing detail fields.
});
```

Mock `logAudit` with a hoisted Vitest mock for the final audit assertion. Add a separate assertion that a duplicate audit entry cannot use `CREATED`; it must identify the existing journal and carry `booking_key: "DIV-2026-06-01-42"` plus `booking_status: "duplicate"`.

Run:

```bash
npx vitest run src/tools/estonian-tax.test.ts -t "H06-D"
```

Expected: FAIL because dividends call `api.journals.create` directly and have no guarded duplicate outcome. The pre-existing legacy document-number test may already pass and is compatibility evidence, not sufficient RED by itself.

- [ ] **Step 10: GREEN-D — route dividends through the same guard without changing identity**

In `src/tools/estonian-tax.ts`, import `BookingGuard`, `formatDocNumber`, and `DocKey`. After fetching the validated shareholder, define:

```ts
const dividendKey: DocKey = {
  ns: "DIV",
  id: `${effective_date}-${shareholder_client_id}`,
};
const documentNumber = formatDocNumber(dividendKey);
```

Build the executable payload without `document_number`; build `proposed_journal` for dry run as `{ ...journalPayload, document_number: documentNumber }`. This keeps preview/execution spelling identical while letting the guard be the sole stamper.

Render `shareholder: { id: shareholder_client_id, name: shareholder.name }` on both dry-run and executed responses. The fetched object supplies descriptive data only; its optional `id` cannot replace the already validated input identity.

On execution:

```ts
const guard = await BookingGuard.load(api);
const booking = await guard.createJournalOnce(dividendKey, journalPayload, { confirm: false });
const createdId = booking.journal_id;
```

Preserve `journal_entry.api_response` as an object with `code`, `messages`, and `created_object_id`; set `created_object_id` to `createdId`, and add sibling `booking_status`/`recovered` fields rather than replacing the established response object with `CreateOnceResult`. For a direct create, read `code/messages` from `booking.upstream_response`; for recovered/duplicate outcomes use `code: 200` and an explicit informational message. Do not synthesize `CREATED` audit evidence for a duplicate.

For `booking.status === "created"`, keep the existing `CREATED` action, summary text, and detail fields exactly, adding only `booking_key` and `booking_status`. For a duplicate, write a distinct non-`CREATED` audit entry (use `UPDATED`), identify `createdId`, state that the existing dividend journal was reused, and include the same calculation details plus the canonical booking key/status. Return the same calculation, legality, shareholder, posting, warning, and compliance fields on both paths.

Run:

```bash
npx vitest run src/tools/estonian-tax.test.ts -t "H06-D"
npx vitest run src/tools/estonian-tax.test.ts
```

Expected: selected and complete Estonian-tax suites PASS; the legacy document number remains exactly `DIV-2026-06-01-42`, the validated input ID wins over an inconsistent fetched object ID, and two identical executions create once.

- [ ] **Step 11: Focused and full verification**

Before running any Step 11 verification, compare the exact fifteen-path manifest against the complete tracked-plus-untracked H06 change set. `diff -u` must fail on either a missing required path or any extra path:

```bash
H06_EXPECTED="$(mktemp)"
H06_ACTUAL="$(mktemp)"
printf '%s\n' \
  src/__fixtures__/booking-guard-child.ts \
  src/api/base-resource.test.ts \
  src/api/base-resource.ts \
  src/booking-guard.test.ts \
  src/booking-guard.ts \
  src/connection-fingerprint.test.ts \
  src/connection-fingerprint.ts \
  src/file-lock.test.ts \
  src/file-lock.ts \
  src/http-client.ts \
  src/index.ts \
  src/tools/currency-rounding.test.ts \
  src/tools/estonian-tax.test.ts \
  src/tools/estonian-tax.ts \
  src/tools/lightyear-investments.test.ts | sort -u > "$H06_EXPECTED"
{
  git diff --name-only HEAD
  git ls-files --others --exclude-standard
} | sort -u > "$H06_ACTUAL"
diff -u "$H06_EXPECTED" "$H06_ACTUAL"
rm -f "$H06_EXPECTED" "$H06_ACTUAL"
```

Expected: `diff -u` exits 0 with no output. Stop immediately on a non-zero result; do not silently filter or amend the manifest.

Then run:

```bash
npx vitest run src/connection-fingerprint.test.ts src/file-lock.test.ts src/api/base-resource.test.ts src/booking-guard.test.ts src/tools/currency-rounding.test.ts src/tools/estonian-tax.test.ts src/tools/lightyear-investments.test.ts
npx tsc --ignoreConfig --noEmit --target ES2022 --module Node16 --moduleResolution Node16 --strict --esModuleInterop --skipLibCheck --forceConsistentCasingInFileNames --resolveJsonModule src/connection-fingerprint.test.ts src/api/base-resource.test.ts
npm run build
npm test
npm run test:integration
npm run validate:release
git diff --check
H06_INDEX="$(mktemp)"
cp "$(git rev-parse --git-path index)" "$H06_INDEX"
GIT_INDEX_FILE="$H06_INDEX" git add -- \
  src/connection-fingerprint.ts src/connection-fingerprint.test.ts \
  src/file-lock.ts src/file-lock.test.ts \
  src/__fixtures__/booking-guard-child.ts \
  src/http-client.ts src/index.ts \
  src/api/base-resource.ts src/api/base-resource.test.ts \
  src/booking-guard.ts src/booking-guard.test.ts \
  src/tools/currency-rounding.test.ts \
  src/tools/estonian-tax.ts src/tools/estonian-tax.test.ts \
  src/tools/lightyear-investments.test.ts
GIT_INDEX_FILE="$H06_INDEX" git diff --cached --check
GIT_INDEX_FILE="$H06_INDEX" git diff --cached --name-only
rm -f "$H06_INDEX"
git diff --cached --quiet
```

Expected: the exact-scope comparison, explicit TypeScript 7 test-file typecheck, and all focused/full checks PASS with only documented integration skips. The temporary-index name list contains exactly these fifteen H06 paths, including all five untracked files, and the real index remains empty:

```text
src/__fixtures__/booking-guard-child.ts
src/api/base-resource.test.ts
src/api/base-resource.ts
src/booking-guard.test.ts
src/booking-guard.ts
src/connection-fingerprint.test.ts
src/connection-fingerprint.ts
src/file-lock.test.ts
src/file-lock.ts
src/http-client.ts
src/index.ts
src/tools/currency-rounding.test.ts
src/tools/estonian-tax.test.ts
src/tools/estonian-tax.ts
src/tools/lightyear-investments.test.ts
```

- [ ] **Step 12: Build the complete review artifact**

Run:

```bash
mkdir -p .omc/reviews
H06_INDEX="$(mktemp)"
cp "$(git rev-parse --git-path index)" "$H06_INDEX"
GIT_INDEX_FILE="$H06_INDEX" git add -- \
  src/connection-fingerprint.ts src/connection-fingerprint.test.ts \
  src/file-lock.ts src/file-lock.test.ts \
  src/__fixtures__/booking-guard-child.ts \
  src/http-client.ts src/index.ts \
  src/api/base-resource.ts src/api/base-resource.test.ts \
  src/booking-guard.ts src/booking-guard.test.ts \
  src/tools/currency-rounding.test.ts \
  src/tools/estonian-tax.ts src/tools/estonian-tax.test.ts \
  src/tools/lightyear-investments.test.ts
GIT_INDEX_FILE="$H06_INDEX" git diff --cached \
  --output=.omc/reviews/H06.diff -- \
  src/connection-fingerprint.ts src/connection-fingerprint.test.ts \
  src/file-lock.ts src/file-lock.test.ts \
  src/__fixtures__/booking-guard-child.ts \
  src/http-client.ts src/index.ts \
  src/api/base-resource.ts src/api/base-resource.test.ts \
  src/booking-guard.ts src/booking-guard.test.ts \
  src/tools/currency-rounding.test.ts \
  src/tools/estonian-tax.ts src/tools/estonian-tax.test.ts \
  src/tools/lightyear-investments.test.ts
test -s .omc/reviews/H06.diff
GIT_INDEX_FILE="$H06_INDEX" git diff --cached --stat
rm -f "$H06_INDEX"
git diff --cached --quiet
```

Expected: the artifact includes all fifteen reviewed paths across tracked and untracked changes, including both dependent-tool fake adaptations, and packaging leaves the real index untouched.

- [ ] **Step 13: Independent SPEC review**

Give a fresh non-author reviewer the H06 design row, this Task 5, `.omc/reviews/H06.diff`, RED-A/B/C/D evidence, and all green output. Require exactly:

```text
SPEC COMPLIANCE: APPROVED
```

The spec pass must audit stable connection/audit identity, lock publication and reclaim races, invalid/live/dead policy, release ownership, FIFO, process cleanup, fresh lookup inside lock, every ambiguity/missing-ID branch, public cache use, legacy dividend identity, validated client ID, audit compatibility, both dependent-tool fake adaptations, and exact fifteen-file scope.

- [ ] **Step 14: Independent QUALITY review**

Only after SPEC approval, give a second fresh non-author reviewer the same evidence and require exactly:

```text
CODE QUALITY: APPROVED
```

The quality pass must inspect candidate/reclaim cleanup, deadline behavior, promise-tail cleanup, child timer/process cleanup, test determinism, error field preservation, mutation-count assertions, public response compatibility, behavior-preserving fake adaptations, and the exact fifteen-file scope. Any rejection requires an in-scope fix, rerunning Step 11, overwriting `H06.diff`, then restarting both reviews in order.

- [ ] **Step 15: Commit H06**

Immediately before real staging, repeat the failing exact fifteen-path comparison against the union of tracked and untracked changes:

```bash
H06_EXPECTED="$(mktemp)"
H06_ACTUAL="$(mktemp)"
printf '%s\n' \
  src/__fixtures__/booking-guard-child.ts \
  src/api/base-resource.test.ts \
  src/api/base-resource.ts \
  src/booking-guard.test.ts \
  src/booking-guard.ts \
  src/connection-fingerprint.test.ts \
  src/connection-fingerprint.ts \
  src/file-lock.test.ts \
  src/file-lock.ts \
  src/http-client.ts \
  src/index.ts \
  src/tools/currency-rounding.test.ts \
  src/tools/estonian-tax.test.ts \
  src/tools/estonian-tax.ts \
  src/tools/lightyear-investments.test.ts | sort -u > "$H06_EXPECTED"
{
  git diff --name-only HEAD
  git ls-files --others --exclude-standard
} | sort -u > "$H06_ACTUAL"
diff -u "$H06_EXPECTED" "$H06_ACTUAL"
rm -f "$H06_EXPECTED" "$H06_ACTUAL"
```

Expected: `diff -u` exits 0 with no output. Only then run:

```bash
git status --short
git add \
  src/connection-fingerprint.ts src/connection-fingerprint.test.ts \
  src/file-lock.ts src/file-lock.test.ts \
  src/__fixtures__/booking-guard-child.ts \
  src/http-client.ts src/index.ts \
  src/api/base-resource.ts src/api/base-resource.test.ts \
  src/booking-guard.ts src/booking-guard.test.ts \
  src/tools/currency-rounding.test.ts \
  src/tools/estonian-tax.ts src/tools/estonian-tax.test.ts \
  src/tools/lightyear-investments.test.ts
git diff --cached --name-only
git commit -m "fix(H06): serialize create-once bookings"
```

Expected: staged names are exactly the fifteen reviewed paths. Do not stage ignored review/ledger artifacts.

- [ ] **Step 16: Ledger and clean status**

Append one H06 ledger row containing RED-A/B/C/D commands/results, focused/build/full/integration/release/diff results, both ordered review verdicts, and the commit hash. Then run:

```bash
git status --short
```

Expected: empty output. Do not begin H14 until the H06 row is complete and the worktree is clean.

### Task 6: H14 — Preserve post-create receipt recovery state

**Files:**
- Modify: `src/tools/receipt-inbox.ts:1940-2040`
- Modify: `src/tools/receipt-inbox-tools.test.ts`

**Interfaces:**
- Consumes: created purchase-invoice `id`, attempted transaction ID, and `MutationIndeterminateError` metadata from H03.
- Produces: `PartialClassificationMutation` with `category`, `mutation_may_have_occurred`, `failed_stage`, `created_invoice_id`, `created_invoice_status`, `attempted_transaction_id`, `transaction_status`, and `next_action`; the existing granular and merged wrapper envelopes carry it unchanged.

- [ ] **Step 1: Write the failing regression**

```ts
it("keeps createAndSetTotals recovery state through the merged wrapper", async () => {
  const tx = { id: 99, status: "PROJECT", is_deleted: false, type: "C", amount: 25,
    date: "2026-03-22", accounts_dimensions_id: 100, bank_account_name: "OpenAI",
    description: "Subscription", cl_currencies_id: "EUR", clients_id: 7 };
  const getImpl = vi.fn()
    .mockResolvedValueOnce(tx)
    .mockRejectedValueOnce(new HttpError("post-create read lost", "network", "GET", "/transactions/99"));
  const { handler, api } = setupReceiptTool("classify_bank_transactions", {
    getImpl,
    clients: [{ id: 7, name: "OpenAI Ireland Limited", is_supplier: true, is_client: false,
      cl_code_country: "IE", is_member: false, send_invoice_to_email: false,
      send_invoice_to_accounting_email: false, is_deleted: false }],
    purchaseInvoices: [{ id: 88, status: "CONFIRMED", payment_status: "PAID", clients_id: 7,
      client_name: "OpenAI Ireland Limited", create_date: "2026-02-22" }],
    purchaseInvoiceDetails: { 88: { id: 88, number: "OLD-88", liability_accounts_id: 2310,
      items: [{ custom_title: "Subscription", cl_purchase_articles_id: 501,
        purchase_accounts_id: 5230, vat_rate_dropdown: "24", vat_accounts_id: 1510 }] } },
    purchaseArticles: [{ id: 501, name_est: "Software", name_eng: "Software",
      accounts_id: 5230, vat_accounts_id: 1510, is_disabled: false, priority: 1 }],
    accounts: [{ id: 5230, name_est: "Software", name_eng: "Software",
      account_type_est: "Kulud", account_type_eng: "Expenses" }],
  });
  api.purchaseInvoices.createAndSetTotals.mockResolvedValueOnce({
    id: 701, status: "PROJECT", number: "AUTO-TX-99", clients_id: 7,
    client_name: "OpenAI Ireland Limited", create_date: "2026-03-22",
    journal_date: "2026-03-22", term_days: 0, cl_currencies_id: "EUR", items: [],
  });
  const classifications = [{ category: "saas_subscriptions", apply_mode: "purchase_invoice",
    normalized_counterparty: "openai", display_counterparty: "OpenAI", recurring: true,
    similar_amounts: true, total_amount: 25,
    suggested_booking: { purchase_article_id: 501, purchase_article_name: "Software",
      purchase_account_id: 5230, purchase_account_name: "Software", liability_account_id: 2310,
      reason: "Recurring SaaS" }, reasons: ["keyword"], transactions: [tx] }];

  const response = await handler({ mode: "execute_apply", classifications_json: classifications });
  const payload = parseMcpResponse(response.content[0]!.text) as any;
  expect(payload).toMatchObject({
    recommended_entry_point: "classify_bank_transactions", mode: "execute_apply",
    delegated_tool: "apply_transaction_classifications",
    result: { results: [{ status: "failed", created_invoice_ids: [701], partial_mutations: [{
      category: "mutation_indeterminate", mutation_may_have_occurred: true,
      failed_stage: "transaction_reread", created_invoice_id: 701, created_invoice_status: "PROJECT",
      attempted_transaction_id: 99, transaction_status: "UNKNOWN",
    }] }] },
  });
  expect(api.purchaseInvoices.createAndSetTotals).toHaveBeenCalledTimes(1);
  expect(api.purchaseInvoices.invalidate).not.toHaveBeenCalled();
  expect(api.transactions.confirm).not.toHaveBeenCalled();
});

it.each([
  ["invoice_confirmation", "UNKNOWN", "PROJECT"],
  ["transaction_confirmation", "CONFIRMED", "UNKNOWN"],
] as const)("returns partial completion when %s fails ambiguously", async (failedStage, invoiceStatus, transactionStatus) => {
  const tx = { id: 99, status: "PROJECT", is_deleted: false, type: "C", amount: 25,
    date: "2026-03-22", accounts_dimensions_id: 100, bank_account_name: "OpenAI",
    description: "Subscription", cl_currencies_id: "EUR", clients_id: 7 };
  const { handler, api } = setupReceiptTool("apply_transaction_classifications", {
    getImpl: vi.fn().mockResolvedValue(tx),
    clients: [{ id: 7, name: "OpenAI Ireland Limited", is_supplier: true, is_client: false,
      cl_code_country: "IE", is_member: false, send_invoice_to_email: false,
      send_invoice_to_accounting_email: false, is_deleted: false }],
    purchaseInvoices: [{ id: 88, status: "CONFIRMED", payment_status: "PAID", clients_id: 7,
      client_name: "OpenAI Ireland Limited", create_date: "2026-02-22" }],
    purchaseInvoiceDetails: { 88: { id: 88, number: "OLD-88", liability_accounts_id: 2310,
      items: [{ custom_title: "Subscription", cl_purchase_articles_id: 501,
        purchase_accounts_id: 5230, vat_rate_dropdown: "24", vat_accounts_id: 1510 }] } },
    purchaseArticles: [{ id: 501, name_est: "Software", name_eng: "Software",
      accounts_id: 5230, vat_accounts_id: 1510, is_disabled: false, priority: 1 }],
    accounts: [{ id: 5230, name_est: "Software", name_eng: "Software",
      account_type_est: "Kulud", account_type_eng: "Expenses" }],
  });
  api.purchaseInvoices.createAndSetTotals.mockResolvedValueOnce({
    id: 701, status: "PROJECT", number: "AUTO-TX-99", clients_id: 7,
    client_name: "OpenAI Ireland Limited", create_date: "2026-03-22",
    journal_date: "2026-03-22", term_days: 0, cl_currencies_id: "EUR", items: [],
  });
  const ambiguous = new MutationIndeterminateError({
    operation: "confirm", entity: failedStage === "invoice_confirmation" ? "purchase_invoice" : "transaction",
    entityId: failedStage === "invoice_confirmation" ? 701 : 99,
    businessKey: failedStage === "invoice_confirmation" ? "purchase_invoice:701" : "transaction:99",
    affectedCaches: failedStage === "invoice_confirmation" ? ["/purchase_invoices"] : ["/transactions", "/journals"],
    cause: new HttpError("response lost", "network", "PATCH", "/register"),
    nextAction: "Fresh read required.",
  });
  if (failedStage === "invoice_confirmation") api.purchaseInvoices.confirmWithTotals.mockRejectedValueOnce(ambiguous);
  else api.transactions.confirm.mockRejectedValueOnce(ambiguous);
  const classifications = [{ category: "saas_subscriptions", apply_mode: "purchase_invoice",
    normalized_counterparty: "openai", display_counterparty: "OpenAI", recurring: true,
    similar_amounts: true, total_amount: 25,
    suggested_booking: { purchase_article_id: 501, purchase_article_name: "Software",
      purchase_account_id: 5230, purchase_account_name: "Software", liability_account_id: 2310,
      reason: "Recurring SaaS" }, reasons: ["keyword"], transactions: [tx] }];

  const response = await handler({ classifications_json: classifications, execute: true });
  const payload = parseMcpResponse(response.content[0]!.text) as any;
  expect(payload.results[0].partial_mutations[0]).toMatchObject({
    category: "mutation_indeterminate", failed_stage: failedStage,
    created_invoice_id: 701, created_invoice_status: invoiceStatus,
    attempted_transaction_id: 99, transaction_status: transactionStatus,
    next_action: expect.stringContaining("do not create another invoice"),
  });
  expect(api.purchaseInvoices.invalidate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/receipt-inbox-tools.test.ts -t "createAndSetTotals recovery state|partial completion"`

Expected: FAIL because the exception escapes without invoice ID or continuation data.

- [ ] **Step 3: Return explicit partial completion**

```ts
interface PartialClassificationMutation {
  category: "mutation_indeterminate" | "mutation_failed";
  mutation_may_have_occurred: true;
  failed_stage: "transaction_reread" | "invoice_confirmation" | "transaction_confirmation";
  created_invoice_id: number;
  created_invoice_status: "PROJECT" | "CONFIRMED" | "UNKNOWN";
  attempted_transaction_id: number;
  transaction_status: "PROJECT" | "CONFIRMED" | "UNKNOWN";
  next_action: string;
}

const partialMutations: PartialClassificationMutation[] = [];
if (invoice.id !== undefined) createdInvoiceIds.push(invoice.id);

function recordPostCreateFailure(
  error: unknown,
  failedStage: PartialClassificationMutation["failed_stage"],
  invoiceId: number,
  transactionId: number,
  invoiceWasConfirmed: boolean,
): void {
  const ambiguous = isMutationIndeterminate(error) || error instanceof HttpError && error.status === "network";
  const createdInvoiceStatus = failedStage === "invoice_confirmation" && ambiguous
    ? "UNKNOWN"
    : invoiceWasConfirmed ? "CONFIRMED" : "PROJECT";
  const transactionStatus = failedStage === "transaction_reread" || failedStage === "transaction_confirmation" && ambiguous
    ? "UNKNOWN"
    : "PROJECT";
  const nextAction = failedStage === "transaction_reread"
    ? `Resume from purchase invoice ${invoiceId}; do not create another invoice. Freshly read transaction ${transactionId}, then approve a new continuation.`
    : failedStage === "invoice_confirmation"
      ? `Resume from purchase invoice ${invoiceId}; do not create another invoice or invalidate it. Freshly read invoice ${invoiceId} and transaction ${transactionId}, then approve a new continuation.`
      : `Resume from confirmed purchase invoice ${invoiceId}; do not create another invoice or invalidate it. Freshly read transaction ${transactionId} before deciding whether confirmation needs a newly approved retry.`;
  partialMutations.push({
    category: ambiguous ? "mutation_indeterminate" : "mutation_failed",
    mutation_may_have_occurred: true,
    failed_stage: failedStage,
    created_invoice_id: invoiceId,
    created_invoice_status: createdInvoiceStatus,
    attempted_transaction_id: transactionId,
    transaction_status: transactionStatus,
    next_action: nextAction,
  });
  notes.push(nextAction);
}

let freshTransaction: Transaction;
try { freshTransaction = await api.transactions.get(transaction.id!); }
catch (error) {
  recordPostCreateFailure(error, "transaction_reread", invoice.id!, transaction.id!, false);
  continue;
}
if (!isProjectTransaction(freshTransaction)) {
  await invalidateAutoCreatedInvoice(`transaction ${transaction.id} is no longer bookable (status ${freshTransaction.status ?? "UNKNOWN"})`);
  continue;
}
try {
  await api.purchaseInvoices.confirmWithTotals(invoice.id!, isVatRegistered, { preserveExistingTotals: true });
} catch (error) {
  recordPostCreateFailure(error, "invoice_confirmation", invoice.id!, transaction.id!, false);
  continue;
}
try {
  await api.transactions.confirm(transaction.id!, [{
    related_table: "purchase_invoices", related_id: invoice.id!, amount: transaction.amount,
  }]);
} catch (error) {
  recordPostCreateFailure(error, "transaction_confirmation", invoice.id!, transaction.id!, true);
  continue;
}
linkedTransactionIds.push(transaction.id!);
```

Remove the later duplicate `createdInvoiceIds.push(invoice.id)` and the combined confirmation catch. Keep the stale-PROJECT reread branch's proven-safe invalidation, but do not invalidate after any thrown post-create read or confirmation failure. Add `partial_mutations?: PartialClassificationMutation[]` to the local result type and include `partial_mutations: partialMutations.length ? partialMutations : undefined` in the existing result. Compute `status` as `"failed"` whenever `partialMutations.length > 0`; otherwise use the current status expression. `classify_bank_transactions` carries the granular object as `payload.result`; do not flatten it.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/receipt-inbox-tools.test.ts && npm run build && git diff --check`

Expected: granular and merged envelopes retain invoice/transaction IDs and exact stage/status/recovery data for second-read, invoice-confirm, and transaction-confirm failures; ambiguous confirmation performs no invalidation or speculative retry; existing successful and proven-stale paths stay green. Write `.omc/reviews/H14.diff` and obtain both verdicts.

- [ ] **Step 5: Commit H14**

```bash
git add src/tools/receipt-inbox.ts src/tools/receipt-inbox-tools.test.ts
git commit -m "fix(H14): retain receipt partial-completion state"
```

### Task 7: M01 — Cache invalidation and audit metadata for indeterminate mutations

**Files:**
- Modify: `src/api/base-resource.ts:120-180`
- Modify: `src/api/base-resource.test.ts`
- Create: `src/mutation-audit.ts`
- Create: `src/mutation-audit.test.ts`
- Modify: `src/audit-log.ts:30-65`
- Modify: `src/index.ts:890-940`

**Interfaces:**
- Consumes: `HttpError`, neutral `MutationIndeterminateError` from H03, and the invocation's captured connection snapshot.
- Produces: `BaseResource.mutate<R>(operation, entityId, businessKey, affectedPatterns, request): Promise<R>`; create/update/delete/upload invalidate on success or ambiguity but not proven rejection.
- Produces: audit action `MUTATION_INDETERMINATE`; the top-level tool wrapper writes it to the invocation's original connection before serializing the MCP error.

- [ ] **Step 1: Write the failing regression**

```ts
it("invalidates object and collection caches on an indeterminate update", async () => {
  const client = makeClient();
  const resource = new BaseResource<Item>(client, "/clients");
  vi.mocked(client.get).mockResolvedValueOnce({ id: 5, name: "old" }).mockResolvedValueOnce({ id: 5, name: "fresh" });
  await resource.get(5);
  vi.mocked(client.patch).mockRejectedValueOnce(new HttpError("lost", "network", "PATCH", "/clients/5"));
  await expect(resource.update(5, { name: "new" })).rejects.toMatchObject({ category: "mutation_indeterminate" });
  expect(await resource.get(5)).toEqual({ id: 5, name: "fresh" });
});

it("keeps a proven rejection out of the indeterminate path", async () => {
  const client = makeClient();
  const resource = new BaseResource<Item>(client, "/clients");
  const generation = cache.generation;
  vi.mocked(client.patch).mockRejectedValueOnce(new HttpError("conflict", 409, "PATCH", "/clients/5"));
  await expect(resource.update(5, { name: "new" })).rejects.toMatchObject({ status: 409 });
  expect(cache.generation).toBe(generation);
});

it.each([
  [ClientsApi, "/clients", "client"],
  [ProductsApi, "/products", "product"],
  [JournalsApi, "/journals", "journal"],
  [TransactionsApi, "/transactions", "transaction"],
  [SaleInvoicesApi, "/sale_invoices", "sale_invoice"],
  [PurchaseInvoicesApi, "/purchase_invoices", "purchase_invoice"],
] as const)("maps %s mutation ambiguity to the singular audit entity", async (Resource, path, entity) => {
  const client = makeClient();
  const resource = new Resource(client);
  vi.mocked(client.patch).mockRejectedValueOnce(new HttpError("lost", "network", "PATCH", `${path}/5`));
  await expect(resource.update(5, {})).rejects.toMatchObject({ entity, entityId: 5 });
});
```

Import the six concrete API classes used by the table. This table is the contract that API resource paths are normalized to the existing singular `AUDIT_ENTITY_TYPES`, rather than leaking plural URL segments into audit records.

```ts
it("audits the original connection with the complete neutral outcome", () => {
  const error = new MutationIndeterminateError({
    operation: "update", entity: "purchase_invoice", entityId: 5, businessKey: "/purchase_invoices:5",
    affectedCaches: ["/purchase_invoices"], cause: new HttpError("lost", "network", "PATCH", "/purchase_invoices/5"),
    nextAction: "Freshly read purchase invoice 5.",
  });
  auditMutationIndeterminate("update_purchase_invoice", error, "original-company");
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
    tool: "update_purchase_invoice", action: "MUTATION_INDETERMINATE", entity_type: "purchase_invoice", entity_id: 5,
    details: expect.objectContaining({ operation: "update", business_key: "/purchase_invoices:5", affected_caches: ["/purchase_invoices"] }),
  }), { connectionName: "original-company" });
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/api/base-resource.test.ts src/mutation-audit.test.ts -t "indeterminate update|proven rejection|singular audit entity|original connection"`

Expected: FAIL because the failed request leaves the old cached object and exposes no recovery metadata.

- [ ] **Step 3: Centralize mutation outcome handling**

```ts
private async mutate<R>(
  operation: MutationOperation,
  entityId: number | undefined,
  businessKey: string,
  affectedPatterns: string[],
  request: () => Promise<R>,
): Promise<R> {
  try {
    const result = await request();
    for (const pattern of affectedPatterns) this.invalidateCache(pattern);
    return result;
  } catch (error) {
    if (error instanceof HttpError && error.status === "network") {
      for (const pattern of affectedPatterns) this.invalidateCache(pattern);
      throw new MutationIndeterminateError({
        operation, entity: auditEntityForResourcePath(this.basePath), entityId, businessKey,
        affectedCaches: [...affectedPatterns], cause: error,
        nextAction: `Perform a fresh read for ${businessKey} before another mutation.`,
      });
    }
    throw error;
  }
}

async update(id: number, data: Partial<T>): Promise<ApiResponse> {
  return this.mutate("update", id, `${this.basePath}:${id}`, [this.basePath],
    () => this.client.patch(`${this.basePath}/${id}`, data));
}

async create(data: Partial<T>): Promise<ApiResponse> {
  return this.mutate("create", undefined, `${this.basePath}:create`, [this.basePath],
    () => this.client.post(this.basePath, data));
}

async delete(id: number): Promise<ApiResponse> {
  return this.mutate("delete", id, `${this.basePath}:${id}`, [this.basePath],
    () => this.client.delete(`${this.basePath}/${id}`));
}

async uploadDocument(id: number, name: string, contents: string): Promise<ApiResponse> {
  return this.mutate("upload", id, `${this.basePath}:${id}:document_user`, [this.basePath],
    () => this.client.request(`${this.basePath}/${id}/document_user`, { method: "PUT", body: { name, contents } }));
}

async deleteDocument(id: number): Promise<ApiResponse> {
  return this.mutate("delete", id, `${this.basePath}:${id}:document_user`, [this.basePath],
    () => this.client.delete(`${this.basePath}/${id}/document_user`));
}
```

Define the mapping next to `BaseResource` and type-check every output against the audit vocabulary from `audit-log.ts`:

```ts
import type { AuditEntityType } from "../audit-log.js";

const RESOURCE_AUDIT_ENTITY_BY_PATH = {
  "/clients": "client",
  "/products": "product",
  "/journals": "journal",
  "/transactions": "transaction",
  "/sale_invoices": "sale_invoice",
  "/purchase_invoices": "purchase_invoice",
} as const satisfies Record<string, AuditEntityType>;

function auditEntityForResourcePath(path: string): AuditEntityType {
  const entity = (RESOURCE_AUDIT_ENTITY_BY_PATH as Readonly<Record<string, AuditEntityType | undefined>>)[path];
  if (!entity) throw new Error(`No audit entity mapping for resource path ${path}`);
  return entity;
}
```

In `audit-log.ts`, export the inferred type alongside the Zod schema without changing the runtime export:

```ts
export type AuditEntityType = z.infer<typeof AuditEntityType>;
```

Add `"MUTATION_INDETERMINATE"` to `AUDIT_ACTIONS`. Create `src/mutation-audit.ts`:

```ts
import { logAudit } from "./audit-log.js";
import type { MutationIndeterminateError } from "./mutation-outcome.js";

export function auditMutationIndeterminate(tool: string, error: MutationIndeterminateError, connectionName?: string): void {
  logAudit({
    tool, action: "MUTATION_INDETERMINATE", entity_type: error.entity, entity_id: error.entityId,
    summary: `${error.operation} ${error.businessKey} has an indeterminate outcome; inspect before retrying.`,
    details: {
      operation: error.operation, business_key: error.businessKey,
      affected_caches: [...error.affectedCaches], cause: error.cause, next_action: error.nextAction,
      mutation_may_have_occurred: true,
    },
  }, connectionName ? { connectionName } : undefined);
}
```

In `index.ts`'s `wrapToolHandler` catch, before `ConnectionSwitchInterruptedError` handling and before `toolError(error)`, add:

```ts
if (isMutationIndeterminate(error) && trackMutation) {
  const originalConnectionName = allConfigs[snapshot.index]?.name;
  auditMutationIndeterminate(toolName, error,
    originalConnectionName ?? undefined);
}
```

The lookup must use `snapshot.index`, never `connectionState.activeIndex`. Keep H06's `ambiguousMutation` predicate structural so this BaseResource outcome is recovered exactly like a raw network create.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/api/base-resource.test.ts src/api/transactions.api.test.ts src/mutation-audit.test.ts src/audit-log.test.ts && npm run build && git diff --check`

Expected: ambiguity invalidates and carries every neutral field; 4xx rejection remains unwrapped; H06 recognizes the structured create; original-connection audit contains the operation, IDs, key, caches, cause, and next action. Write `.omc/reviews/M01.diff` and obtain both verdicts.

- [ ] **Step 5: Commit M01**

```bash
git add src/api/base-resource.ts src/api/base-resource.test.ts src/mutation-audit.ts src/mutation-audit.test.ts src/audit-log.ts src/index.ts
git commit -m "fix(M01): invalidate caches on ambiguous mutations"
```

### Task 8: M02 — Fail closed on malformed pagination

**Files:**
- Modify: `src/api/base-resource.ts:45-120`
- Modify: `src/api/base-resource.test.ts`

**Interfaces:**
- Consumes: `PaginatedResponse<T>`.
- Produces: `validatePage<T>(response, requestedPage): void`; invalid metadata never enters per-page or aggregate cache.

- [ ] **Step 1: Write failing regressions**

```ts
it.each([
  [{ current_page: 1, total_pages: 3, items: [] }, 2, "current_page"],
  [{ current_page: 1, total_pages: Number.NaN, items: [] }, 1, "total_pages"],
  [{ current_page: 2, total_pages: 1, items: [] }, 2, "total_pages"],
])("rejects malformed page metadata", async (response, page, message) => {
  const client = makeClient();
  vi.mocked(client.get).mockResolvedValue(response as never);
  const resource = new BaseResource<Item>(client, "/items");
  await expect(resource.listAll(undefined, 10)).rejects.toThrow(message);
  expect(cache.get(`${client.cacheNamespace}:/items:listAll`)).toBeUndefined();
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/api/base-resource.test.ts -t "malformed page metadata"`

Expected: FAIL because malformed continuation returns and may cache a partial list.

- [ ] **Step 3: Validate before caching or appending**

```ts
function validatePage<T>(response: PaginatedResponse<T>, requestedPage: number): void {
  if (!response || !Array.isArray(response.items)) throw new Error(`Pagination page ${requestedPage}: items must be an array`);
  if (!Number.isInteger(response.current_page) || response.current_page !== requestedPage) {
    throw new Error(`Pagination page ${requestedPage}: current_page was ${String(response.current_page)}`);
  }
  if (!Number.isInteger(response.total_pages) || response.total_pages < requestedPage || response.total_pages < 1) {
    throw new Error(`Pagination page ${requestedPage}: invalid total_pages ${String(response.total_pages)}`);
  }
}

const result = await this.client.get<PaginatedResponse<T>>(this.basePath, params as Record<string, string | number>);
validatePage(result, params?.page ?? 1);
cache.setIfSameGeneration(cacheKey, result, gen, 120);
```

- [ ] **Step 4: Prove green and independently review**

Run: `npx vitest run src/api/base-resource.test.ts && npm run build && git diff --check`

Expected: malformed/cyclic pages reject and no partial aggregate is cached. Write `.omc/reviews/M02.diff` and obtain both verdicts.

- [ ] **Step 5: Commit M02**

```bash
git add src/api/base-resource.ts src/api/base-resource.test.ts
git commit -m "fix(M02): reject malformed pagination"
```

- [ ] **Step 6: Append ledger, prove clean, then pass Wave 2**

Append M02, require empty `git status --short`, then run `npm run validate:release && git diff --check && npm run build && npm test && npm run test:integration`; require PASS with baseline skips only.

### Task 9: H05 — Preserve approved purchase-invoice totals by default

**Files:**
- Modify: `src/api/purchase-invoices.api.ts:180-235`
- Modify: `src/api/purchase-invoices.api.test.ts`
- Modify: `src/tools/pdf-workflow.ts:750-790`
- Modify: `src/tools/pdf-workflow.test.ts`

**Interfaces:**
- Consumes: `ConfirmPurchaseInvoiceOptions`.
- Produces: `ConfirmPurchaseInvoiceOptions.recalculateTotals?: boolean`; default `false`, replacing opt-in preservation with opt-in correction.

- [ ] **Step 1: Write failing regressions**

```ts
it("preserves an approved one-cent supplier rounding difference by default", async () => {
  get.mockResolvedValue({ id: 7, gross_price: 100.01, vat_price: 18.04, items: [{ total_net_price: 81.97, vat_amount: 18.03 }] });
  await api.confirmWithTotals(7, true);
  expect(patch).not.toHaveBeenCalledWith("/purchase_invoices/7", expect.objectContaining({ gross_price: 100 }));
  expect(patch).toHaveBeenCalledWith("/purchase_invoices/7/register", {});
});
```

```ts
it("PDF confirmation does not request recalculation", async () => {
  await callTool("create_purchase_invoice_from_pdf", approvedArgs);
  expect(api.purchaseInvoices.confirmWithTotals).toHaveBeenCalledWith(expect.any(Number), true, { recalculateTotals: false });
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/api/purchase-invoices.api.test.ts src/tools/pdf-workflow.test.ts -t "rounding difference|does not request recalculation"`

Expected: FAIL because default confirmation recalculates and the PDF call does not express the approved mode.

- [ ] **Step 3: Make correction explicit and previewed**

```ts
export interface ConfirmPurchaseInvoiceOptions { recalculateTotals?: boolean }

if (options.recalculateTotals !== true && hasInvoiceGross && (hasInvoiceVat || !isVatRegistered)) {
  return this.confirm(id);
}
```

At the PDF call site:

```ts
const confirmationMode = { recalculateTotals: false } as const;
// include confirmationMode in preview.raw and audit details
await api.purchaseInvoices.confirmWithTotals(result.id, isVatRegistered, confirmationMode);
```

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/api/purchase-invoices.api.test.ts src/tools/pdf-workflow.test.ts && npm run build && git diff --check`

Expected: source totals survive default/document confirmation; explicit `recalculateTotals: true` repairs missing/corrupt totals. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit H05**

```bash
git add src/api/purchase-invoices.api.ts src/api/purchase-invoices.api.test.ts src/tools/pdf-workflow.ts src/tools/pdf-workflow.test.ts
git commit -m "fix(H05): preserve approved invoice totals"
```

### Task 10: H07 — Use invoice liability and allocated payment amount

**Files:**
- Modify: `src/tools/currency-rounding.ts:35-145,250-360`
- Modify: `src/tools/currency-rounding.test.ts`

**Interfaces:**
- Consumes: transaction `distributions`, purchase invoice `items`, posting/account dimensions.
- Produces: `resolveInvoiceSettlementProvenance(invoice, transactions): { liabilityAccountId: number; liabilityDimensionId?: number; paidEur: number } | { reviewReason: string }`.

- [ ] **Step 1: Write the failing regression**

```ts
it("uses the invoice liability dimension and only its transaction allocation", async () => {
  const { handler, api } = setupTool({
    invoices: [{ id: 7, status: "CONFIRMED", payment_status: "PARTIALLY_PAID", cl_currencies_id: "USD", base_gross_price: 90, transactions: [11], liability_accounts_id: 2120, liability_accounts_dimensions_id: 44 }],
    transactionsById: { 11: { id: 11, amount: 100, base_amount: 90, items: [{ relation_table: "purchase_invoices", relation_id: 7, amount: 50, base_amount: 45 }] } },
  });
  await handler({ execute: true });
  expect(api.journals.create).toHaveBeenCalledWith(expect.objectContaining({ postings: expect.arrayContaining([
    expect.objectContaining({ accounts_id: 2120, accounts_dimensions_id: 44, amount: 45 }),
  ]) }));
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/currency-rounding.test.ts -t "only its transaction allocation"`

Expected: FAIL because the default liability account and full `base_amount` are used.

- [ ] **Step 3: Resolve explicit provenance or require review**

```ts
export function allocationEurForInvoice(tx: Transaction, invoiceId: number): number | undefined {
  const distribution = tx.items?.find(d => d.relation_table === "purchase_invoices" && d.relation_id === invoiceId);
  if (!distribution) return undefined;
  if (distribution.base_amount !== undefined && Number.isFinite(distribution.base_amount)) return roundMoney(distribution.base_amount);
  if ((distribution.cl_currencies_id ?? tx.cl_currencies_id ?? "EUR") === "EUR" && distribution.amount !== undefined) return roundMoney(distribution.amount);
  if (distribution.amount !== undefined && tx.base_amount !== undefined && tx.amount !== 0) return roundMoney(distribution.amount * tx.base_amount / tx.amount);
  return undefined;
}

const liability = full.liability_accounts_id === undefined ? undefined : {
  accounts_id: full.liability_accounts_id,
  accounts_dimensions_id: full.liability_accounts_dimensions_id ?? undefined,
};
const allocated = txIds.map(id => allocationEurForInvoice(await api.transactions.get(id), full.id!));
if (!liability || allocated.some(value => value === undefined)) {
  category = "review";
  provenance_error = "Invoice liability account/dimension or allocated base amount is missing or conflicting.";
} else {
  paidEur = roundMoney(allocated.reduce((sum, value) => sum + value!, 0));
  liabilityAccount = liability.accounts_id;
  liabilityDimension = liability.accounts_dimensions_id;
}
```

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/currency-rounding.test.ts && npm run build && git diff --check`

Expected: account/dimension/allocation assertions PASS; missing provenance becomes review and creates nothing. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit H07**

```bash
git add src/tools/currency-rounding.ts src/tools/currency-rounding.test.ts
git commit -m "fix(H07): reconcile allocated invoice settlement"
```

### Task 11: H16 — Carry explicit Lightyear FX orientation

**Files:**
- Modify: `src/tools/lightyear-investments.ts:30-230,336-445`
- Modify: `src/tools/lightyear-investments.test.ts`

**Interfaces:**
- Consumes: paired EUR/foreign conversion rows.
- Produces: `FxRateOrientation`, `resolveFxPair(eurNet, foreignNet, rates)`, `InvestmentTrade.fx_orientation`, and orientation-aware `tradeFeeInEur`.

- [ ] **Step 1: Write the failing regression**

```ts
it.each([
  [{ fee_eur: 10, fx_rate: 0.9, fx_orientation: "eur_per_foreign" as const }, 9],
  [{ fee_eur: 10, fx_rate: 1.111111, fx_orientation: "foreign_per_eur" as const }, 9],
])("converts fee using explicit orientation", (trade, expected) => {
  expect(tradeFeeInEur(trade)).toBeCloseTo(expected, 2);
});
```

```ts
it("derives orientation from paired net amounts and rejects contradictory rates", () => {
  expect(resolveFxPair(1126.28, 1303.22, [1.15709, 0.86423])).toEqual({
    rate: 0.86423, orientation: "eur_per_foreign",
  });
  expect(resolveFxPair(1126.28, 1303.22, [7, 8])).toBeUndefined();
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/lightyear-investments.test.ts -t "explicit orientation"`

Expected: FAIL because `tradeFeeInEur` always divides and accepts no orientation.

- [ ] **Step 3: Preserve and apply the orientation**

```ts
type FxRateOrientation = "eur_per_foreign" | "foreign_per_eur";

export function resolveFxPair(eurNet: number, foreignNet: number, rates: number[]):
  { rate: number; orientation: FxRateOrientation } | undefined {
  if (!(eurNet > 0) || !(foreignNet > 0)) return undefined;
  for (const rate of rates.filter(value => Number.isFinite(value) && value >= MIN_FX_RATE)) {
    if (Math.abs(roundMoney(foreignNet * rate) - roundMoney(eurNet)) <= 0.01) return { rate, orientation: "eur_per_foreign" };
    if (Math.abs(roundMoney(foreignNet / rate) - roundMoney(eurNet)) <= 0.01) return { rate, orientation: "foreign_per_eur" };
  }
  return undefined;
}

export function tradeFeeInEur(trade: { fee_eur: number; fx_rate: number | null; fx_orientation: FxRateOrientation | null }): number {
  if (!(trade.fee_eur > 0)) return 0;
  if (trade.fx_rate === null || trade.fx_orientation === null || !Number.isFinite(trade.fx_rate) || trade.fx_rate < MIN_FX_RATE) return trade.fee_eur;
  return roundMoney(trade.fx_orientation === "eur_per_foreign" ? trade.fee_eur * trade.fx_rate : trade.fee_eur / trade.fx_rate);
}
```

Replace the successful candidate branch with:

```ts
const fx = resolveFxPair(Math.abs(best.eurConv.net_amount), Math.abs(best.fgnConv.net_amount), [best.eurConv.fx_rate, best.fgnConv.fx_rate]);
if (!fx) {
  fxWarnings.push(`${wrapUntrustedOcr(row.reference) ?? ""}: conversion ${wrapUntrustedOcr(best.ref) ?? ""} has contradictory net amounts/rates; trade left unbookable.`);
} else {
  trade.eur_amount = Math.abs(best.eurConv.net_amount);
  trade.fx_rate = fx.rate;
  trade.fx_orientation = fx.orientation;
  trade.fx_fee_eur = fxFeeToEur(best.eurConv, best.fgnConv);
  trade.conversion_ref = best.ref;
  trade.conversion_row_indexes = [best.eurConv.row_index, best.fgnConv.row_index];
  consumedConversions.add(best.ref);
  fxMatched = true;
}
```

Add `fx_orientation: FxRateOrientation | null` to `InvestmentTrade`, initialize it to `null`, and pass it at every `tradeFeeInEur` call. Existing EUR trades retain `null`.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/lightyear-investments.test.ts && npm run build && git diff --check`

Expected: multiply/divide, paired-net derivation, contradictory-pair skip, and existing Lightyear booking tests PASS. Write `.omc/reviews/H16.diff` and obtain both verdicts.

- [ ] **Step 5: Commit H16**

```bash
git add src/tools/lightyear-investments.ts src/tools/lightyear-investments.test.ts
git commit -m "fix(H16): preserve Lightyear FX orientation"
```

### Task 12: H17 — Preserve distribution currency and EUR values

**Files:**
- Modify: `src/tools/lightyear-investments.ts:449-475,1350-1450`
- Modify: `src/tools/lightyear-investments.test.ts`

**Interfaces:**
- Consumes: H16 `FxRateOrientation` and conversion pairing.
- Produces: `LightyearDistribution` with `currency`, `gross_eur`, `fee_eur`, `net_eur`, `tax_eur`, and `fx_provenance`.

- [ ] **Step 1: Write the failing regression**

```ts
it("books a USD distribution with authoritative EUR amounts", async () => {
  const result = await runDistributionFixture({ currency: "USD", gross: 100, net: 85, tax: 15, eurPerForeign: 0.9 });
  expect(result.postings).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "D", amount: 76.5 }),
    expect.objectContaining({ type: "D", amount: 13.5 }),
    expect.objectContaining({ type: "C", amount: 90 }),
  ]));
  expect(result.journal.cl_currencies_id).toBe("EUR");
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/lightyear-investments.test.ts -t "USD distribution"`

Expected: FAIL because nominal 100/85/15 are treated as EUR and currency is discarded.

- [ ] **Step 3: Convert at extraction and require provenance**

```ts
interface LightyearDistribution {
  row_index: number; date: string; reference: string; type: AccountStatementRow["type"];
  ticker: string; isin: string; currency: string;
  gross_amount: number; fee: number; net_amount: number; tax_amount: number;
  gross_eur?: number; fee_eur?: number; net_eur?: number; tax_eur?: number;
  fx_provenance?: { rate: number; orientation: FxRateOrientation; conversion_reference: string };
}

if (dist.currency !== "EUR" && !dist.fx_provenance) {
  results.push({ ...dist, status: "manual_review", reason: "Missing authoritative EUR conversion" });
  continue;
}
const grossEur = dist.currency === "EUR" ? dist.gross_amount : dist.gross_eur!;
const netEur = dist.currency === "EUR" ? dist.net_amount : dist.net_eur!;
const taxEur = dist.currency === "EUR" ? dist.tax_amount : dist.tax_eur!;
```

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/lightyear-investments.test.ts && npm run build && git diff --check`

Expected: EUR posting values reconcile and missing conversion creates no journal. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit H17**

```bash
git add src/tools/lightyear-investments.ts src/tools/lightyear-investments.test.ts
git commit -m "fix(H17): retain distribution currency provenance"
```

### Task 13: H18 — Tolerant but bounded gains matching

**Files:**
- Modify: `src/tools/lightyear-investments.ts:542-600`
- Modify: `src/tools/lightyear-investments.test.ts`

**Interfaces:**
- Consumes: sell/gains EUR proceeds.
- Produces: `withinProceedsTolerance(actual, expected, absolute=0.02, relative=0.001): boolean`.

- [ ] **Step 1: Write the failing regression**

```ts
it("rejects the only date/ticker/quantity candidate when proceeds are materially different", () => {
  const warnings: string[] = [];
  const matches = matchSellsToCapitalGains([sell({ eur_amount: 100 })], [gain({ proceeds_eur: 160 })], warnings);
  expect(matches.size).toBe(0);
  expect(warnings.join(" ")).toContain("outside proceeds tolerance");
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/lightyear-investments.test.ts -t "materially different"`

Expected: FAIL because a unique inexact candidate is accepted without a bound.

- [ ] **Step 3: Apply absolute/relative tolerance**

```ts
export function withinProceedsTolerance(actual: number, expected: number, absolute = 0.02, relative = 0.001): boolean {
  const difference = Math.abs(actual - expected);
  return difference <= Math.max(absolute, Math.abs(expected) * relative);
}
```

Classify date+ticker+quantity candidates into exact/tolerant/outside. Only one exact or tolerant candidate may be consumed; every outside candidate adds a manual-review warning and never enters the result map.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/lightyear-investments.test.ts && npm run build && git diff --check`

Expected: cent rounding passes, large discrepancy remains unmatched. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit H18**

```bash
git add src/tools/lightyear-investments.ts src/tools/lightyear-investments.test.ts
git commit -m "fix(H18): bound Lightyear proceeds matching"
```

### Task 14: M19 — Surface opening-balance incompleteness

**Files:**
- Modify: `src/tools/account-balance.ts:155-220`
- Modify: `src/tools/account-balance.test.ts`
- Modify: `src/tools/annual-report.ts:689-730,1060-1145`
- Modify: `src/tools/annual-report.test.ts`

**Interfaces:**
- Consumes: `withOpeningBalanceApiLimitation()` from `src/opening-balance-limitations.ts`.
- Produces: `opening_balance_status: "complete" | "api_incomplete"`; visible warnings on client debt and annual report.

- [ ] **Step 1: Write failing regressions**

```ts
it.each(["compute_client_debt", "buildAnnualReportData"])("warns that %s may omit opening balances", async (surface) => {
  const payload = await invokeReportingSurface(surface);
  expect(payload.opening_balance_status).toBe("api_incomplete");
  expect(payload.warnings.join(" ")).toMatch(/opening balance|algbilans/i);
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/account-balance.test.ts src/tools/annual-report.test.ts -t "omit opening balances"`

Expected: FAIL because these outputs omit the known limitation.

- [ ] **Step 3: Add explicit status and warnings**

```ts
const openingBalanceWarnings = withOpeningBalanceApiLimitation();
const openingBalanceMetadata = {
  opening_balance_status: openingBalanceWarnings.length > 0 ? "api_incomplete" : "complete",
  warnings: openingBalanceWarnings,
  balance_scope: openingBalanceWarnings.length > 0 ? "period_movement_plus_API_visible_opening_entries" : "complete_balance",
};
```

Spread the same metadata into client-debt root output and annual-report root output; append to existing annual-report warnings instead of replacing them.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/account-balance.test.ts src/tools/annual-report.test.ts && npm run build && git diff --check`

Expected: both surfaces visibly distinguish period movement from complete balance. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M19**

```bash
git add src/tools/account-balance.ts src/tools/account-balance.test.ts src/tools/annual-report.ts src/tools/annual-report.test.ts
git commit -m "fix(M19): warn on incomplete opening balances"
```

### Task 15: M20 — Canonical year-end-close detector

**Files:**
- Modify: `src/tools/annual-report.ts:350-390,700-715`
- Modify: `src/tools/annual-report.test.ts`

**Interfaces:**
- Consumes: journal document number, effective date, title.
- Produces: `isYearEndClosingJournal(journal, year?): boolean` shared by close discovery and P&L filtering.

- [ ] **Step 1: Write the failing regression**

```ts
it("excludes a title-only legacy year-end close from P&L", async () => {
  const report = await buildAnnualReportData(apiWithJournal({
    effective_date: "2025-12-31", title: "Aasta lõppkanne 2025", document_number: undefined,
    postings: expenseClosePostings(100),
  }), 2025);
  expect(readProfit(report)).toBe(0);
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/annual-report.test.ts -t "title-only legacy"`

Expected: FAIL because P&L filtering only checks `YECL-` document numbers.

- [ ] **Step 3: Reuse one detector**

```ts
export function isYearEndClosingJournal(journal: Pick<Journal, "document_number" | "effective_date" | "title">, year?: number): boolean {
  if (journal.document_number?.startsWith("YECL-")) return true;
  const effectiveYear = year ?? Number(journal.effective_date?.slice(0, 4));
  if (journal.effective_date !== `${effectiveYear}-12-31`) return false;
  const title = journal.title?.toLocaleLowerCase("et") ?? "";
  return title.includes(`aasta lõppkanne ${effectiveYear}`) || title.includes(`year-end close ${effectiveYear}`);
}
```

Use this function in `findExistingYearEndCloseJournals` and the `journalFilter` passed to period P&L.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/annual-report.test.ts && npm run build && git diff --check`

Expected: legacy close excluded once; ordinary 31 December journals remain. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M20**

```bash
git add src/tools/annual-report.ts src/tools/annual-report.test.ts
git commit -m "fix(M20): unify year-end close detection"
```

### Task 16: M21 — Prevent deductible VAT defaults for non-VAT companies

**Files:**
- Modify: `src/tools/purchase-vat-defaults.ts:75-150`
- Modify: `src/tools/purchase-vat-defaults.test.ts`
- Modify: `src/tools/crud-tools.test.ts`

**Interfaces:**
- Consumes: live `isVatRegistered` and purchase article defaults.
- Produces: `validateNonVatItem(item): string[]`; non-VAT defaults never contain `vat_accounts_id` or deductible VAT article/rate.

- [ ] **Step 1: Write failing regressions**

```ts
it("strips deductible VAT defaults for a non-VAT company", () => {
  const result = applyPurchaseVatDefaults([{ id: 1, vat_accounts_id: 1510, cl_vat_articles_id: 1 } as any],
    { cl_purchase_articles_id: 1, vat_rate_dropdown: "22" } as any, false);
  expect(result.vat_accounts_id).toBeUndefined();
  expect(result.cl_vat_articles_id).toBe(11);
  expect(result.vat_rate_dropdown).toBe("-");
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/purchase-vat-defaults.test.ts src/tools/crud-tools.test.ts -t "non-VAT company"`

Expected: FAIL because selected/rate article defaults can carry deductible VAT fields.

- [ ] **Step 3: Fail conflicting explicit input and sanitize defaults**

```ts
export function validateNonVatItem(item: PurchaseInvoiceItem): string[] {
  const conflicts: string[] = [];
  if (item.vat_accounts_id !== undefined) conflicts.push("vat_accounts_id is not allowed for a non-VAT company");
  if (item.cl_vat_articles_id !== undefined && item.cl_vat_articles_id !== 11) conflicts.push("deductible cl_vat_articles_id is not allowed for a non-VAT company");
  if (normalizeVatRate(item.vat_rate_dropdown) !== undefined && normalizeVatRate(item.vat_rate_dropdown) !== "-") conflicts.push("vat_rate_dropdown must be '-' for a non-VAT company");
  return conflicts;
}

if (!isVatRegistered) {
  delete merged.vat_accounts_id;
  merged.cl_vat_articles_id = NON_VAT_REGISTERED_FALLBACK.cl_vat_articles_id;
  merged.vat_rate_dropdown = "-";
  return merged;
}
```

The CRUD handler calls `validateNonVatItem` on explicit input before defaults and returns `manual_review_required` if conflicts exist.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/purchase-vat-defaults.test.ts src/tools/crud-tools.test.ts && npm run build && git diff --check`

Expected: defaults sanitize; explicit contradiction stops before create. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M21**

```bash
git add src/tools/purchase-vat-defaults.ts src/tools/purchase-vat-defaults.test.ts src/tools/crud-tools.test.ts
git commit -m "fix(M21): block deductible VAT for non-VAT companies"
```

### Task 17: M22 — Detect accounting-rule migration collisions

**Files:**
- Modify: `src/accounting-rules.ts:1389-1445`
- Modify: `src/accounting-rules.test.ts`

**Interfaces:**
- Consumes: `normalizeAutoBookingRuleMatch(match)` and `autoBookingConceptSlug`.
- Produces: `findRuleMigrationConflicts(rules): Array<{ canonicalKey: string; sourceMatches: string[] }>`; migration aborts before staging writes.

- [ ] **Step 1: Write the failing regression**

```ts
it("refuses normalized duplicate rules without overwriting either source", () => {
  writeFileSync(legacy, rulesMarkdown([rule("ACME OÜ", 5000), rule("acme ou", 6000)]));
  expect(() => migrateLegacyRulesToBundle(legacy, bundle)).toThrow(/normalized rule collision.*ACME OÜ.*acme ou/i);
  expect(readFileSync(legacy, "utf8")).toContain("ACME OÜ");
  expect(existsSync(bundle)).toBe(false);
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/accounting-rules.test.ts -t "normalized duplicate"`

Expected: FAIL because the later normalized slug overwrites the earlier concept.

- [ ] **Step 3: Preflight all canonical keys**

```ts
export function findRuleMigrationConflicts(rules: AccountingAutoBookingRule[]) {
  const groups = new Map<string, string[]>();
  for (const rule of rules) {
    const key = `${normalizeAutoBookingRuleMatch(rule.match)}\0${(rule.category ?? "").trim().toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), rule.match]);
  }
  return [...groups].filter(([, matches]) => matches.length > 1)
    .map(([canonicalKey, sourceMatches]) => ({ canonicalKey, sourceMatches }));
}

const conflicts = findRuleMigrationConflicts(counterparties);
if (conflicts.length) throw new Error(`Normalized rule collision: ${conflicts.map(c => c.sourceMatches.join(" <> ")).join("; ")}`);
```

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/accounting-rules.test.ts && npm run build && git diff --check`

Expected: collision aborts before writes/archive; distinct rules migrate. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M22**

```bash
git add src/accounting-rules.ts src/accounting-rules.test.ts
git commit -m "fix(M22): detect rule migration collisions"
```

### Task 18: M23 — Ignore connection-scoped generated rules

**Files:**
- Modify: `src/accounting-rules.ts:130-170`
- Modify: `src/accounting-rules.test.ts`
- Modify: `.gitignore:1-20`

**Interfaces:**
- Consumes: global config directory and active connection namespace.
- Produces: `chooseDefaultBundleStorage(projectRoot, globalConfigDir, connectionName="default")` resolving to `<globalConfigDir>/accounting-rules/<safe-connection>` for new installs.

- [ ] **Step 1: Write the failing regression**

```ts
it("places new company rules in an ignored connection-scoped location", () => {
  expect(chooseDefaultBundleStorage("/repo", "/config", "Acme OÜ")).toMatchObject({
    dir: resolve("/config", "accounting-rules", "acme-ou"),
  });
  expect(readFileSync(".gitignore", "utf8")).toContain("accounting-rules/");
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/accounting-rules.test.ts -t "connection-scoped location"`

Expected: FAIL because the function has no connection argument and the repo path lacks an ignore policy.

- [ ] **Step 3: Scope and ignore generated bundles**

```ts
export function chooseDefaultBundleStorage(projectRoot: string, globalConfigDir: string, connectionName = "default") {
  const projectDir = resolve(projectRoot, BUNDLE_DIR_NAME);
  const projectLegacy = resolve(projectRoot, LEGACY_FILE_NAME);
  if (isInitializedBundle(projectDir) || existsSync(projectLegacy)) return { mode: "bundle" as const, dir: projectDir, legacyFile: projectLegacy };
  const scope = connectionName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";
  const dir = resolve(globalConfigDir, BUNDLE_DIR_NAME, scope);
  return { mode: "bundle" as const, dir, legacyFile: resolve(globalConfigDir, scope, LEGACY_FILE_NAME) };
}
```

Add exactly this ignore entry:

```gitignore
# Generated connection-specific accounting rules (templates remain tracked elsewhere)
accounting-rules/
```

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/accounting-rules.test.ts && git check-ignore accounting-rules/example/concept.md && npm run build && git diff --check`

Expected: tests/build PASS and `git check-ignore` prints the generated path. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M23**

```bash
git add src/accounting-rules.ts src/accounting-rules.test.ts .gitignore
git commit -m "fix(M23): isolate generated accounting rules"
```

### Task 19: M26 — Separate booked, skipped, and review-required portfolio rows

**Files:**
- Modify: `src/tools/lightyear-investments.ts:1471-1585`
- Modify: `src/tools/lightyear-investments.test.ts`

**Interfaces:**
- Consumes: H16/H17 FX warnings and the same `isBookableTrade` criteria used by `book_lightyear_trades`.
- Produces: portfolio output buckets `booked_basis`, `previewed`, `skipped`, `review_required`; totals use `booked_basis` only.

- [ ] **Step 1: Write the failing regression**

```ts
it("does not count an FX-unmatched skipped instrument in booked portfolio totals", async () => {
  const payload = await runPortfolioFixture([foreignTradeWithoutConversion("BAD", 100), eurTrade("OK", 50)]);
  expect(payload.totals.total_remaining_cost_eur).toBe(50);
  expect(payload.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ ticker: "BAD" })]));
  expect(payload.booked_basis).toEqual(expect.arrayContaining([expect.objectContaining({ ticker: "OK" })]));
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/lightyear-investments.test.ts -t "skipped instrument"`

Expected: FAIL because every parsed trade feeds holdings/totals.

- [ ] **Step 3: Partition with the booking predicate**

```ts
const partition = trades.reduce((result, trade) => {
  const reason = bookingReviewReason(trade);
  if (reason) result.review_required.push({ ...trade, reason });
  else if (trade.skip_reason) result.skipped.push({ ...trade, reason: trade.skip_reason });
  else result.booked_basis.push(trade);
  return result;
}, { booked_basis: [] as InvestmentTrade[], skipped: [] as Array<InvestmentTrade & { reason: string }>, review_required: [] as Array<InvestmentTrade & { reason: string }> });

const holdings = new Map<string, { ticker: string; isin: string; quantity: number; total_cost_eur: number; total_proceeds_eur: number; realized_gain_loss_eur: number; buy_count: number; sell_count: number }>();
for (const trade of partition.booked_basis) {
  const holding = holdings.get(trade.ticker) ?? { ticker: trade.ticker, isin: trade.isin, quantity: 0, total_cost_eur: 0, total_proceeds_eur: 0, realized_gain_loss_eur: 0, buy_count: 0, sell_count: 0 };
  if (trade.type === "Buy") {
    holding.total_cost_eur += trade.eur_amount + tradeFeeInEur(trade);
    holding.quantity += trade.quantity;
    holding.buy_count += 1;
  } else {
    const proceeds = trade.eur_amount - tradeFeeInEur(trade);
    const averageCost = holding.quantity > 0.000001 ? holding.total_cost_eur / holding.quantity : 0;
    const soldCost = averageCost * trade.quantity;
    holding.total_proceeds_eur += proceeds;
    holding.realized_gain_loss_eur += proceeds - soldCost;
    holding.total_cost_eur -= soldCost;
    holding.quantity -= trade.quantity;
    holding.sell_count += 1;
  }
  holdings.set(trade.ticker, holding);
}
```

Return all buckets and calculate every `booked_*` total only from `partition.booked_basis`.

- [ ] **Step 4: Prove green and independently review**

Run: `npx vitest run src/tools/lightyear-investments.test.ts && npm run build && git diff --check`

Expected: skipped/review rows are visible but excluded from booked totals. Write `.omc/reviews/M26.diff` and obtain both verdicts.

- [ ] **Step 5: Commit M26**

```bash
git add src/tools/lightyear-investments.ts src/tools/lightyear-investments.test.ts
git commit -m "fix(M26): separate Lightyear portfolio outcomes"
```

- [ ] **Step 6: Append ledger, prove clean, then pass Wave 3**

Append M26, require empty `git status --short`, then run `npm run validate:release && git diff --check && npm run build && npm test && npm run test:integration`; require PASS with baseline skips only.

### Task 20: H08 — Bind CAMT statement IBAN to the selected bank dimension

**Files:**
- Modify: `src/tools/camt-import.ts:994-1030,1160-1210`
- Modify: `src/tools/camt-import.test.ts`
- Modify: `src/tools/camt-import-tools.test.ts`

**Interfaces:**
- Consumes: `CamtStatementMetadata.iban`, `api.readonly.getBankAccounts()` records with `accounts_dimensions_id`, `iban_code`, and `account_no`.
- Produces: `assertStatementAccountMatchesDimension(api, statementIban, dimensionId): Promise<void>`.

- [ ] **Step 1: Write failing regressions**

```ts
it("blocks import when statement IBAN belongs to another bank dimension", async () => {
  readonly.getBankAccounts.mockResolvedValue([
    { accounts_dimensions_id: 10, iban_code: "EE111" },
    { accounts_dimensions_id: 20, iban_code: "EE222" },
  ]);
  await expect(importHandler({ file_path: camtWithIban("EE111"), accounts_dimensions_id: 20, execute: true }))
    .rejects.toThrow(/EE111.*dimension 20.*EE222/i);
  expect(api.transactions.create).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/camt-import.test.ts src/tools/camt-import-tools.test.ts -t "another bank dimension"`

Expected: FAIL because only dimension existence is validated.

- [ ] **Step 3: Match normalized own-account identity before mutation**

```ts
const normalizeIban = (value?: string | null) => (value ?? "").replace(/\s+/g, "").toUpperCase();

export async function assertStatementAccountMatchesDimension(api: ApiContext, statementIban: string, dimensionId: number): Promise<void> {
  const accounts = await api.readonly.getBankAccounts();
  const selected = accounts.find(account => account.accounts_dimensions_id === dimensionId);
  if (!selected) throw Object.assign(new Error(`No bank account is bound to dimension ${dimensionId}`), { category: "validation_failed" });
  const selectedIbans = [selected.iban_code, selected.account_no].map(normalizeIban).filter(Boolean);
  if (!selectedIbans.includes(normalizeIban(statementIban))) {
    throw Object.assign(new Error(`Statement IBAN ${statementIban} does not match dimension ${dimensionId} (${selectedIbans.join(", ")})`), { category: "validation_failed" });
  }
}
```

Call this after parsing and before duplicate lookup, client resolution, preview execution data, or any create.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/camt-import.test.ts src/tools/camt-import-tools.test.ts && npm run build && git diff --check`

Expected: matching IBAN continues; mismatch creates nothing and names both identities. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit H08**

```bash
git add src/tools/camt-import.ts src/tools/camt-import.test.ts src/tools/camt-import-tools.test.ts
git commit -m "fix(H08): bind CAMT IBAN to bank dimension"
```

### Task 21: H09 — Scope CAMT reference duplicates by bank dimension

**Files:**
- Modify: `src/tools/camt-import.ts:205-220,548-670,974-990`
- Modify: `src/tools/camt-import.test.ts`

**Interfaces:**
- Consumes: H08 selected `accounts_dimensions_id`.
- Produces: `bankReferenceLookupKey(reference, dimensionId): string`; duplicate lookup requires dimension.

- [ ] **Step 1: Write the failing regression**

```ts
it("does not suppress an equal reference on another own bank dimension", () => {
  const lookup = buildDuplicateLookup([{ id: 1, bank_ref_number: "ABC", accounts_dimensions_id: 10 } as Transaction], 20);
  expect(findDuplicateTransactionIds(lookup, entry({ bank_reference: "ABC" }), 20)).toEqual([]);
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/camt-import.test.ts -t "another own bank dimension"`

Expected: FAIL because reference `ABC` matches globally.

- [ ] **Step 3: Include dimension in every exact-reference key**

```ts
export function bankReferenceLookupKey(value: string | undefined, dimensionId: number): string | undefined {
  const normalized = normalizeOptionalReference(value)?.toUpperCase();
  return normalized ? `${dimensionId}\0${normalized}` : undefined;
}

const key = bankReferenceLookupKey(transaction.bank_ref_number ?? undefined, transaction.accounts_dimensions_id!);
const entryKey = bankReferenceLookupKey(entry.bank_reference, selectedDimensionId);
```

Thread `selectedDimensionId` through `buildDuplicateLookup`, stored-reference fallback, and `findDuplicateTransactionIds`; entries lacking a bank dimension are not exact reference matches.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/camt-import.test.ts && npm run build && git diff --check`

Expected: same dimension deduplicates; another dimension remains eligible. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit H09**

```bash
git add src/tools/camt-import.ts src/tools/camt-import.test.ts
git commit -m "fix(H09): scope CAMT references by bank account"
```

### Task 22: H10 — Use authoritative EUR amount for one-sided FX transfers

**Files:**
- Modify: `src/tools/bank-reconciliation.ts:1400-1510`
- Modify: `src/tools/bank-reconciliation.test.ts`

**Interfaces:**
- Consumes: transaction `amount`, `base_amount`, `cl_currencies_id`, `currency_rate`.
- Produces: `authoritativeTransferEurAmount(tx): number | undefined` used by matching, preview, distribution, journal index, audit, and result.

- [ ] **Step 1: Write the failing regression**

```ts
it("posts the base EUR amount for a one-sided USD transfer", async () => {
  const { handler, api } = setupInterAccount([{ id: 201, status: "PROJECT", type: "C", amount: 100, base_amount: 90, cl_currencies_id: "USD", date: "2026-03-20", accounts_dimensions_id: 100, bank_account_no: "EE222" }]);
  await handler({ execute: true });
  expect(api.transactions.confirm).toHaveBeenCalledWith(201, [expect.objectContaining({ amount: 90 })]);
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/bank-reconciliation.test.ts -t "one-sided USD transfer"`

Expected: FAIL because confirmation posts nominal 100 as EUR.

- [ ] **Step 3: Centralize authoritative base amount**

```ts
export function authoritativeTransferEurAmount(tx: Transaction): number | undefined {
  if ((tx.cl_currencies_id ?? "EUR").toUpperCase() === "EUR") return roundMoney(tx.base_amount ?? tx.amount);
  if (tx.base_amount !== undefined && Number.isFinite(tx.base_amount)) return roundMoney(tx.base_amount);
  if (tx.currency_rate !== undefined && Number.isFinite(tx.currency_rate) && tx.currency_rate > 0) return roundMoney(tx.amount * tx.currency_rate);
  return undefined;
}

const eurAmount = authoritativeTransferEurAmount(tx);
if (eurAmount === undefined) {
  errors.push({ transaction_ids: [tx.id], reason: "manual_review_required: missing FX base amount" });
  continue;
}
await api.transactions.confirm(tx.id, [buildAccountDistribution(targetDimension, eurAmount)]);
```

Use `eurAmount` for duplicate resolution, journal recording, preview `base_amount_eur`, audit, and result.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/bank-reconciliation.test.ts && npm run build && git diff --check`

Expected: USD 100/base 90 posts 90; missing base/rate stops. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit H10**

```bash
git add src/tools/bank-reconciliation.ts src/tools/bank-reconciliation.test.ts
git commit -m "fix(H10): post one-sided transfers in base EUR"
```

### Task 23: M03 — Verify Wise transfer endpoint ownership

**Files:**
- Modify: `src/tools/wise-import.ts:200-300,680-730`
- Modify: `src/tools/wise-import.test.ts`

**Interfaces:**
- Consumes: bank-account identities from `api.readonly.getBankAccounts()` and normalized own-company name.
- Produces: `classifyWiseOwnTransfer(row, ownAccounts, ownCompany): { verified: boolean; reason: string }`; `TRANSFER-*` is only a hint.

- [ ] **Step 1: Write the failing regression**

```ts
it("does not auto-reconcile TRANSFER-* without two verified own endpoints", async () => {
  const { handler, api } = setupWise({ id: "TRANSFER-7", sourceName: "Acme OÜ", targetName: "Unknown Ltd" });
  const payload = parseResult(await handler({ file_path, accounts_dimensions_id: 10, execute: false }));
  expect(payload.execution.needs_review).toEqual(expect.arrayContaining([expect.objectContaining({ wise_id: "TRANSFER-7", reason: expect.stringContaining("ownership") })]));
  expect(api.transactions.confirm).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/wise-import.test.ts -t "verified own endpoints"`

Expected: FAIL because identifier prefix alone enters inter-account logic.

- [ ] **Step 3: Gate transfer actions on ownership evidence**

```ts
export function classifyWiseOwnTransfer(row: WiseRow, ownNames: Set<string>): { verified: boolean; reason: string } {
  const sourceOwned = ownNames.has(normalizeWiseCompanyName(row.sourceName));
  const targetOwned = ownNames.has(normalizeWiseCompanyName(row.targetName));
  return sourceOwned && targetOwned
    ? { verified: true, reason: "both Wise endpoints match verified own-account identities" }
    : { verified: false, reason: `ownership unverified: source=${sourceOwned}, target=${targetOwned}` };
}
```

Only verified entries enter `transferEntries`; unverified entries remain created/previewed as ordinary bank rows and receive `needs_review`, unless an explicit approved `confirm_own_transfer_ids` contains that Wise ID.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/wise-import.test.ts && npm run build && git diff --check`

Expected: prefix-only transfer does not auto-confirm; two owned endpoints do. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M03**

```bash
git add src/tools/wise-import.ts src/tools/wise-import.test.ts
git commit -m "fix(M03): verify Wise transfer ownership"
```

### Task 24: M04 — Wise dry-run/execution parity

**Files:**
- Modify: `src/tools/wise-import.ts:430-760`
- Modify: `src/tools/wise-import.test.ts`

**Interfaces:**
- Consumes: M03 verified transfer decision and H10-style explicit monetary provenance.
- Produces: `WiseImportCommand[]`, `digestWiseCommands(commands): string`, required execute-time `approved_command_digest`, and one executor consumed by preview and execution.

- [ ] **Step 1: Write the failing regression**

```ts
it("dry run previews the exact later inter-account confirmation", async () => {
  const dry = parseResult(await handler({ file_path, accounts_dimensions_id: 10, inter_account_dimension_id: 20, execute: false }));
  expect(dry.execution.commands).toContainEqual(expect.objectContaining({
    mode: "create_then_confirm", source_dimension_id: 10, target_dimension_id: 20,
    amount: 90, currency: "EUR", transaction_type: "C",
  }));
  expect(api.transactions.create).not.toHaveBeenCalled();
});

it("rejects a missing or changed approved command digest before mutation", async () => {
  const { handler, api } = setupWiseTool();
  const dry = parseMcpResponse((await handler({ file_path, accounts_dimensions_id: 10, execute: false })).content[0]!.text) as any;
  await handler({ file_path, accounts_dimensions_id: 10, execute: true });
  await handler({ file_path, accounts_dimensions_id: 11, execute: true, approved_command_digest: dry.approved_command_digest });
  expect(api.transactions.create).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/wise-import.test.ts -t "exact later inter-account confirmation"`

Expected: FAIL because dry-run rows have no API IDs and the post-import confirmation plan is absent.

- [ ] **Step 3: Build commands before branching on execute**

```ts
interface WiseImportCommand {
  wise_id: string; mode: "create" | "create_then_confirm";
  source_dimension_id: number; target_dimension_id?: number;
  transaction_type: "C" | "D"; amount: number; currency: string;
  source_amount: number; source_currency: string; requires_fresh_lookup: boolean;
}

export function digestWiseCommands(commands: readonly WiseImportCommand[]): string {
  return createHash("sha256").update(JSON.stringify(commands)).digest("hex");
}

const commands = eligible.map(row => buildWiseImportCommand(row, {
  sourceDimensionId: accounts_dimensions_id,
  targetDimensionId: isVerifiedTransfer(row) ? resolvedInterAccountDimension : undefined,
}));
const commandDigest = digestWiseCommands(commands);
if (dryRun) return wiseImportResponse({ mode: "DRY_RUN", commands, approved_command_digest: commandDigest });
if (approved_command_digest === undefined || approved_command_digest !== commandDigest) {
  return toolError({
    category: "approval_digest_mismatch",
    error: approved_command_digest === undefined ? "approved_command_digest is required for execution" : "Approved Wise command digest no longer matches",
    expected_digest: commandDigest,
    supplied_digest: approved_command_digest,
    next_action: "Run a new dry run, review its commands, and approve that exact digest.",
  });
}
for (const command of commands) await executeWiseImportCommand(command, api);
```

Add `approved_command_digest: z.string().regex(/^[0-9a-f]{64}$/).optional()` to `import_wise_transactions`; include it in the handler destructuring. `wiseImportResponse` is the existing final response construction extracted into a local function with the current summary/skipped/error fields unchanged. Audit each exact command before its executor call.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/wise-import.test.ts && npm run build && git diff --check`

Expected: preview and execution payloads match apart from created IDs; missing/stale digest returns `approval_digest_mismatch` before any create/confirm. Write `.omc/reviews/M04.diff` and obtain both verdicts.

- [ ] **Step 5: Commit M04**

```bash
git add src/tools/wise-import.ts src/tools/wise-import.test.ts
git commit -m "fix(M04): align Wise preview and execution"
```

### Task 25: M05 — Strict CAMT and Wise row validation

**Files:**
- Modify: `src/tools/camt-import.ts:180-200,454-470,849-960`
- Modify: `src/tools/camt-import.test.ts`
- Modify: `src/tools/camt-import-tools.test.ts`
- Modify: `src/tools/wise-import.ts:35-120`
- Modify: `src/tools/wise-import.test.ts`

**Interfaces:**
- Produces: `ImportRejectedField { source_row_id, field, value, reason }`; disjoint `CamtPreflightResult` and `WisePreflightResult`; source-specific amount/date/currency/identifier parsers. A failed preflight returns before any API mutation.

- [ ] **Step 1: Write source-specific failing regressions**

In `src/tools/camt-import.test.ts`, extend the current import and use its file-local `sampleXml`:

```ts
import { parseCamt053Xml, parseCamtDate, preflightCamt053Xml } from "./camt-import.js";

it.each(["10oops", "Infinity", "1,2,3"])("CAMT preflight rejects malformed amount %s with a source row ID", (value) => {
  const result = preflightCamt053Xml(sampleXml.replace(">150.00</Amt>", `>${value}</Amt>`));
  expect(result).toMatchObject({ ok: false, rejected_fields: [expect.objectContaining({
    source_row_id: "camt:sample-statement:ntry:1", field: "amount", value,
  })] });
});

it.each([
  "2026-02-01junk",
  "2026-02-01T24:00:00+02:00",
  "2026-02-01T12:60:00+02:00",
  "2026-02-01T12:00:60+02:00",
  "2026-02-01T12:00:00+15:00",
  "2026-02-01T12:00:00+14:01",
])("rejects the complete malformed CAMT date/date-time %s", (value) => {
  expect(() => parseCamtDate(value, "camt:s:ntry:1", "booking_date")).toThrow();
});

it.each([
  ["2026-02-01", "2026-02-01"],
  ["2026-02-01T23:59:59Z", "2026-02-01"],
  ["2026-02-01T23:59:59.123456789+14:00", "2026-02-01"],
  ["2026-02-01T00:00:00-03:30", "2026-02-01"],
] as const)("accepts complete CAMT date/date-time %s", (value, date) => {
  expect(parseCamtDate(value, "camt:s:ntry:1", "booking_date")).toBe(date);
});
```

In `src/tools/camt-import-tools.test.ts`, use the current `singleEntryXml`, captured-handler harness, and mocks:

```ts
it.each(["parse_camt053", "import_camt053"] as const)(
  "%s rejects the whole CAMT file before any accounting API read",
  async (toolName) => {
    mockedResolveFileInput.mockResolvedValue({ path: "/tmp/camt.xml" });
    mockedReadFile.mockResolvedValue(singleEntryXml.replaceAll(">10.00<", ">10oops<"));
    const { api, handler } = setupCamtTool({ toolName });
    const result = await handler(toolName === "parse_camt053"
      ? { file_path: "/tmp/camt.xml" }
      : { file_path: "/tmp/camt.xml", accounts_dimensions_id: 7, execute: true });
    const payload = parseMcpResponse(result.content[0]!.text) as any;

    expect(payload).toMatchObject({
      category: "import_preflight_failed",
      source: "camt",
      rejected_fields: [expect.objectContaining({ field: "amount", value: "10oops" })],
    });
    expect(api.readonly.getAccountDimensions).not.toHaveBeenCalled();
    expect(api.transactions.listAll).not.toHaveBeenCalled();
    expect(api.transactions.create).not.toHaveBeenCalled();
  },
);
```

In `src/tools/wise-import.test.ts`, use the current `buildCsvRow`, `mockedReadFile`, `setupWiseTool`, and `parseMcpResponse` helpers:

```ts

it("Wise preflights every row and mutates nothing when ID, amount, timestamp, or currency is invalid", async () => {
  mockedReadFile.mockResolvedValue(buildCsvRow([
    "", "COMPLETED", "OUT", "2026-02-30 10:00:00", "2026-02-30 10:00:00",
    "0", "EURO", "0", "EUR", "Me", "10oops", "EURO", "Vendor", "10", "EUR", "1", "REF", "", "", "General", "",
  ]));
  const { handler, api } = setupWiseTool([]);
  const payload = parseMcpResponse((await handler({ file_path: "/tmp/wise.csv", accounts_dimensions_id: 10, execute: true })).content[0]!.text) as any;
  expect(payload).toMatchObject({ category: "import_preflight_failed", source: "wise" });
  expect(payload.rejected_fields.map((item: any) => item.field)).toEqual(expect.arrayContaining(["ID", "Created on", "Finished on", "Source amount (after fees)", "Source currency"]));
  expect(api.clients.listAll).not.toHaveBeenCalled();
  expect(api.readonly.getAccountDimensions).not.toHaveBeenCalled();
  expect(api.transactions.listAll).not.toHaveBeenCalled();
  expect(api.transactions.create).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/camt-import.test.ts src/tools/camt-import-tools.test.ts src/tools/wise-import.test.ts -t "malformed amount|complete malformed CAMT|accepts complete CAMT|whole CAMT file|preflights every row"`

Expected: FAIL because `parseFloat("10oops")` returns 10, CAMT dates are truncated to ten characters without validating the complete date-time grammar, and invalid/short Wise rows are silently skipped.

- [ ] **Step 3: Fully consume and surface invalid values**

```ts
export interface ImportRejectedField { source_row_id: string; field: string; value: string; reason: string }
export type CamtPreflightResult = { ok: true; source: "camt"; value: CamtParseResult } |
  { ok: false; source: "camt"; rejected_fields: ImportRejectedField[] };
export type WisePreflightResult = { ok: true; source: "wise"; rows: WiseRow[] } |
  { ok: false; source: "wise"; rejected_fields: ImportRejectedField[] };

class ImportFieldError extends Error {
  constructor(readonly issue: ImportRejectedField) { super(issue.reason); }
}
function reject(source_row_id: string, field: string, value: unknown, reason: string): never {
  throw new ImportFieldError({ source_row_id, field, value: String(value ?? ""), reason });
}
export function parseCamtMoney(value: unknown, row: string, field: string): number {
  const text = String(value ?? "").trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return reject(row, field, value, "CAMT amount must be a complete finite decimal");
  const result = Number(text);
  return Number.isFinite(result) ? result : reject(row, field, value, "CAMT amount must be finite");
}
function realDate(date: string, row: string, field: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return reject(row, field, date, "Expected YYYY-MM-DD");
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return parsed.toISOString().slice(0, 10) === date ? date : reject(row, field, date, "Impossible calendar date");
}
export function parseCamtDate(value: unknown, row: string, field: string): string {
  const text = String(value ?? "").trim();
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/.exec(text);
  if (!match) return reject(row, field, value, "Expected a complete CAMT YYYY-MM-DD or ISO date-time");
  const date = realDate(match[1]!, row, field);
  if (match[2] !== undefined && (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59)) {
    return reject(row, field, value, "Impossible CAMT clock time");
  }
  if (match[6] !== undefined) {
    const offsetHours = Number(match[6]);
    const offsetMinutes = Number(match[7]);
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) {
      return reject(row, field, value, "Invalid CAMT timezone offset");
    }
  }
  return date;
}
export function parseWiseTimestamp(value: unknown, row: string, field: string): string {
  const text = String(value ?? "").trim();
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (!match) return reject(row, field, value, "Invalid Wise timestamp");
  realDate(match[1]!, row, field);
  if (match[2] !== undefined && (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59)) {
    return reject(row, field, value, "Impossible Wise clock time");
  }
  return text;
}
export function parseCurrency(value: unknown, row: string, field: string): string {
  const text = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(text) ? text : reject(row, field, value, "Expected a three-letter ISO currency code");
}
export function parseWiseId(value: unknown, row: string): string {
  const text = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(text) ? text : reject(row, "ID", value, "Invalid or missing Wise ID");
}
```

In CAMT parsing, derive `entrySourceRowId = camt:${statementId ?? "unknown"}:ntry:${entryIndex + 1}`, add `source_row_id` to `ParsedCamtEntry`, and pass that identity into strict amount/date/currency parsing before constructing each row. `preflightCamt053Xml` catches only `ImportFieldError` and returns `{ ok: false, source: "camt", rejected_fields: [error.issue] }`; structural XML errors still throw. Extend `parseAmountNode` with `sourceRowId?: string, field = "amount"`; when supplied, it calls `parseCamtMoney(amountText, sourceRowId, field)` and `parseCurrency(currencyText, sourceRowId, `${field}_currency`)`. Extend `parseOriginalAmountNode` with the detail row ID and fields `original_amount`/`original_amount_currency`.

Define the Wise layout and builder completely in `src/tools/wise-import.ts`. These are every current CSV column consumed by `WiseRow`; `Batch` and `Created by` remain accepted export columns but are intentionally unused:

```ts
const WISE_ROW_HEADERS = [
  "ID", "Status", "Direction", "Created on", "Finished on",
  "Source fee amount", "Source fee currency", "Target fee amount", "Target fee currency",
  "Source name", "Source amount (after fees)", "Source currency",
  "Target name", "Target amount (after fees)", "Target currency",
  "Exchange rate", "Reference", "Category", "Note",
] as const;
type WiseRowHeader = typeof WISE_ROW_HEADERS[number];
type WiseHeaderIndex = (name: WiseRowHeader) => number;

function validateWiseHeaders(records: string[][]): { headers: string[]; idx: WiseHeaderIndex } {
  if (records.length < 2) return reject("wise:file", "row", records.length, "CSV has no data rows");
  const headers = records[0]!.map(header => header.replace(/^\uFEFF/, "").trim());
  for (const expected of WISE_ROW_HEADERS) {
    const count = headers.filter(header => header === expected).length;
    if (count !== 1) return reject(
      "wise:header", expected, count,
      count === 0 ? `Missing expected header "${expected}"` : `Header "${expected}" occurs ${count} times`,
    );
  }
  return { headers, idx: name => headers.indexOf(name) };
}

function parseWiseMoney(value: unknown, row: string, field: string, defaultValue?: number): number {
  const text = String(value ?? "").trim();
  if (text === "" && defaultValue !== undefined) return defaultValue;
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) {
    return reject(row, field, value, "Wise number must be a complete finite decimal");
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : reject(row, field, value, "Wise number must be finite");
}

function parseWiseOptionalCurrency(value: unknown, fallback: string, row: string, field: string): string {
  const text = String(value ?? "").trim();
  return text === "" ? fallback : parseCurrency(text, row, field);
}

interface ValidatedWiseRequiredValues {
  id: string; createdOn: string; finishedOn: string;
  sourceAmount: number; targetAmount: number;
  sourceCurrency: string; targetCurrency: string;
}

function buildWiseRow(
  fields: string[], idx: WiseHeaderIndex, row: string, required: ValidatedWiseRequiredValues,
): WiseRow {
  const sourceFeeAmount = parseWiseMoney(fields[idx("Source fee amount")], row, "Source fee amount", 0);
  const targetFeeAmount = parseWiseMoney(fields[idx("Target fee amount")], row, "Target fee amount", 0);
  const exchangeRate = parseWiseMoney(fields[idx("Exchange rate")], row, "Exchange rate", 1);
  if (exchangeRate <= 0) return reject(row, "Exchange rate", exchangeRate, "Wise exchange rate must be positive");
  return {
    id: required.id,
    status: fields[idx("Status")]!.trim(),
    direction: fields[idx("Direction")]!.trim(),
    createdOn: required.createdOn,
    finishedOn: required.finishedOn,
    sourceFeeAmount,
    sourceFeeCurrency: parseWiseOptionalCurrency(fields[idx("Source fee currency")], required.sourceCurrency, row, "Source fee currency"),
    targetFeeAmount,
    targetFeeCurrency: parseWiseOptionalCurrency(fields[idx("Target fee currency")], required.targetCurrency, row, "Target fee currency"),
    sourceName: fields[idx("Source name")] ?? "",
    sourceAmount: required.sourceAmount,
    sourceCurrency: required.sourceCurrency,
    targetName: fields[idx("Target name")] ?? "",
    targetAmount: required.targetAmount,
    targetCurrency: required.targetCurrency,
    exchangeRate,
    reference: fields[idx("Reference")] ?? "",
    category: fields[idx("Category")] ?? "",
    note: fields[idx("Note")] ?? "",
  };
}
```

Replace `parseWiseCSV`'s short-row `continue` and `parseFloat` path with an issue-accumulating loop:

```ts
export function preflightWiseCsv(csv: string): WisePreflightResult {
  const records = parseCSV(csv, ",", 10 * 1024 * 1024).filter(record => record.some(field => field.trim() !== ""));
  let layout: ReturnType<typeof validateWiseHeaders>;
  try { layout = validateWiseHeaders(records); }
  catch (error) {
    if (error instanceof ImportFieldError) return { ok: false, source: "wise", rejected_fields: [error.issue] };
    throw error;
  }
  const { headers, idx } = layout;
  const rows: WiseRow[] = [];
  const rejected_fields: ImportRejectedField[] = [];
  for (let i = 1; i < records.length; i++) {
    const fields = records[i]!;
    const provisional = `wise:row:${i + 1}:${fields[idx("ID")]?.trim() || "missing-id"}`;
    if (fields.length !== headers.length) {
      rejected_fields.push({ source_row_id: provisional, field: "row", value: String(fields.length), reason: `Expected ${headers.length} columns` });
      continue;
    }
    const issuesBefore = rejected_fields.length;
    const capture = <T>(field: string, parse: () => T): T | undefined => {
      try { return parse(); }
      catch (error) { if (error instanceof ImportFieldError) rejected_fields.push(error.issue); else throw error; return undefined; }
    };
    const id = capture("ID", () => parseWiseId(fields[idx("ID")], provisional));
    const createdOn = capture("Created on", () => parseWiseTimestamp(fields[idx("Created on")], provisional, "Created on"));
    const finishedOn = capture("Finished on", () => parseWiseTimestamp(fields[idx("Finished on")], provisional, "Finished on"));
    const sourceAmount = capture("Source amount (after fees)", () => parseWiseMoney(fields[idx("Source amount (after fees)")], provisional, "Source amount (after fees)"));
    const targetAmount = capture("Target amount (after fees)", () => parseWiseMoney(fields[idx("Target amount (after fees)")], provisional, "Target amount (after fees)"));
    const sourceCurrency = capture("Source currency", () => parseCurrency(fields[idx("Source currency")], provisional, "Source currency"));
    const targetCurrency = capture("Target currency", () => parseCurrency(fields[idx("Target currency")], provisional, "Target currency"));
    if (rejected_fields.length !== issuesBefore || !id || !createdOn || !finishedOn || sourceAmount === undefined || targetAmount === undefined || !sourceCurrency || !targetCurrency) continue;
    try {
      rows.push(buildWiseRow(fields, idx, provisional, {
        id, createdOn, finishedOn, sourceAmount, targetAmount, sourceCurrency, targetCurrency,
      }));
    } catch (error) {
      if (error instanceof ImportFieldError) rejected_fields.push(error.issue);
      else throw error;
    }
  }
  return rejected_fields.length ? { ok: false, source: "wise", rejected_fields } : { ok: true, source: "wise", rows };
}
```

Replace `loadParsedCamt053` with the following loader and import `toolError` in both importer modules if M04 has not already added it:

```ts
async function loadCamt053Preflight(filePath: string): Promise<CamtPreflightResult> {
  const { path, cleanup } = await resolveFileInput(filePath, [".xml"], CAMT_MAX_FILE_SIZE);
  try { return preflightCamt053Xml(await readFile(path, "utf-8")); }
  finally { if (cleanup) await cleanup(); }
}
```

The complete preflight start of the `parse_camt053` callback, before duplicate reads, is:

```ts
const preflight = await loadCamt053Preflight(file_path);
if (!preflight.ok) return toolError({ category: "import_preflight_failed", source: preflight.source, rejected_fields: preflight.rejected_fields });
const parsed = await enrichWithDuplicates(preflight.value, api);
```

The complete preflight start of the `import_camt053` callback, before dimension or duplicate reads, is:

```ts
const preflight = await loadCamt053Preflight(file_path);
if (!preflight.ok) return toolError({ category: "import_preflight_failed", source: preflight.source, rejected_fields: preflight.rejected_fields });
await ensureAccountDimensionExists(api, accounts_dimensions_id);
const parsed = await enrichWithDuplicates(preflight.value, api);
```

Immediately after reading Wise CSV and before `api.clients`, `api.readonly`, `api.transactions`, or journal calls, replace `const rows = parseWiseCSV(csv)` with:

```ts
const preflight = preflightWiseCsv(csv);
if (!preflight.ok) return toolError({ category: "import_preflight_failed", source: preflight.source, rejected_fields: preflight.rejected_fields });
const rows = preflight.rows;
```

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/camt-import.test.ts src/tools/camt-import-tools.test.ts src/tools/wise-import.test.ts && npm run build && git diff --check`

Expected: every invalid required field is identified by source row and field, valid files remain compatible, and invalid files make zero API mutations. Write `.omc/reviews/M05.diff` and obtain both verdicts.

- [ ] **Step 5: Commit M05**

```bash
git add src/tools/camt-import.ts src/tools/camt-import.test.ts src/tools/wise-import.ts src/tools/wise-import.test.ts
git commit -m "fix(M05): validate bank import rows strictly"
```

- [ ] **Step 6: Append ledger row and prove clean status**

Append M05 after commit and require `git status --short` to be empty.

- [ ] **Step 7: Pass Wave 4 gate**

Run: `npm run validate:release && git diff --check && npm run build && npm test && npm run test:integration`

Expected: all commands PASS with only baseline integration skips and clean status remains empty.

### Task 26: H11 — Preserve explicit zero VAT

**Files:**
- Modify: `src/tools/receipt-extraction.ts:515-585,650-790`
- Modify: `src/tools/receipt-extraction.test.ts`

**Interfaces:**
- Consumes: amount tokens and VAT/net/gross line labels.
- Produces: `extractAmountsFromLine(line, documentContext?, { includeZero?: boolean }): number[]`; VAT-label extraction passes `includeZero: true`.

- [ ] **Step 1: Write the failing regression**

```ts
it("keeps explicit VAT 0.00 authoritative", () => {
  const result = extractReceiptFieldsFromText("Subtotal 100.00 EUR\nVAT 0.00 EUR\nTotal 100.00 EUR", "zero-vat.pdf");
  expect(result).toMatchObject({ total_net: 100, total_vat: 0, total_gross: 100, vat_explicit: true });
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/receipt-extraction.test.ts -t "VAT 0.00 authoritative"`

Expected: FAIL with net 0/VAT 100 because zero is removed before labeled classification.

- [ ] **Step 3: Retain zero only where labels make it meaningful**

```ts
export function extractAmountsFromLine(line: string, documentContext?: string, options: { includeZero?: boolean } = {}): number[] {
  const matches = [...line.matchAll(/(?<!\d)-?\d[\d\s.,]*\d|(?<!\d)-?\d/g)];
  const amounts = matches
    .filter(match => {
      const raw = match[0] ?? "";
      const next = line.slice((match.index ?? 0) + raw.length).trimStart();
      return !next.startsWith("%");
    })
    .map(match => {
      const raw = match[0] ?? "";
      const parsed = parseAmount(raw, line, documentContext);
      if (parsed === undefined) return undefined;
      const start = match.index ?? 0;
      const parenthesized = line[start - 1] === "(" && line[start + raw.length] === ")";
      return parenthesized && parsed > 0 ? -parsed : parsed;
    })
    .filter((value): value is number => value !== undefined && (options.includeZero === true || value !== 0));
  return [...new Set(amounts)];
}

const vatAmounts = extractAmountsFromLine(vatLine, text, { includeZero: true });
if (vatAmounts.length > 0) {
  totalVat = vatAmounts[vatAmounts.length - 1]!;
  vatExplicit = true;
}
```

Keep zero filtering for unlabeled structural candidates so page numbers and empty amounts do not become totals.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/receipt-extraction.test.ts && npm run build && git diff --check`

Expected: explicit zero VAT returns net=gross and VAT zero; unlabeled zero behavior remains. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit H11**

```bash
git add src/tools/receipt-extraction.ts src/tools/receipt-extraction.test.ts
git commit -m "fix(H11): preserve explicit zero VAT"
```

### Task 27: H12 — Bind receipt currency to authoritative total

**Files:**
- Modify: `src/tools/receipt-extraction.ts:820-865`
- Modify: `src/tools/receipt-extraction.test.ts`

**Interfaces:**
- Consumes: total label, gross amount, per-line currencies.
- Produces: `detectReceiptCurrency(text, authoritativeGross?): string | undefined`; conflicting authoritative lines return `undefined` and an extraction note.

- [ ] **Step 1: Write the failing regression**

```ts
it("uses total-line EUR instead of an earlier USD equivalent", () => {
  const text = "Card conversion: USD 110.00\nService fee USD 2.00\nTOTAL 100.00 EUR";
  expect(detectReceiptCurrency(text, 100)).toBe("EUR");
});

it("returns undefined for conflicting total currencies", () => {
  expect(detectReceiptCurrency("TOTAL 100 USD\nAMOUNT DUE 90 EUR")).toBeUndefined();
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/receipt-extraction.test.ts -t "total-line EUR|conflicting total"`

Expected: FAIL because the first amount-bearing currency wins.

- [ ] **Step 3: Rank only authoritative total lines first**

```ts
export function detectReceiptCurrency(text: string, authoritativeGross?: number): string | undefined {
  const lines = text.split(/\r?\n/).map(clampTextLine).filter(Boolean);
  const totals = lines.filter(line => RECEIPT_TOTAL_LABEL_RE.test(line) &&
    (authoritativeGross === undefined || extractAmountsFromLine(line, text).some(value => Math.abs(value - authoritativeGross) < 0.01)));
  const totalCurrencies = new Set(totals.flatMap(detectCurrenciesOnLine));
  if (totalCurrencies.size === 1) return [...totalCurrencies][0];
  if (totalCurrencies.size > 1) return undefined;
  const unambiguous = new Set(lines.flatMap(detectCurrenciesOnLine));
  return unambiguous.size === 1 ? [...unambiguous][0] : undefined;
}
```

Pass extracted gross into this function; when undefined due to ambiguity, append `Currency is ambiguous across authoritative total lines` to `extraction_notes`.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/receipt-extraction.test.ts && npm run build && git diff --check`

Expected: total currency wins; conflicting totals require review. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit H12**

```bash
git add src/tools/receipt-extraction.ts src/tools/receipt-extraction.test.ts
git commit -m "fix(H12): bind currency to receipt total"
```

### Task 28: H13 — Strong supplier identifiers veto name matching

**Files:**
- Modify: `src/tools/supplier-resolution.ts:113-210`
- Modify: `src/tools/supplier-resolution.test.ts`

**Interfaces:**
- Consumes: extracted registry/VAT identifiers and client identities.
- Produces: `strongIdentifierConflict` result with `found: false`, `match_type: "strong_identifier_conflict"`, and `requires_manual_review: true`.

- [ ] **Step 1: Write the failing regression**

```ts
it("does not name-match a client whose registry code conflicts", async () => {
  const result = await resolveSupplierInternal(api, [{ id: 1, name: "Acme OÜ", code: "12345678" } as Client], {
    supplier_name: "Acme OÜ", supplier_reg_code: "87654321",
  }, false);
  expect(result).toMatchObject({ found: false, match_type: "strong_identifier_conflict", requires_manual_review: true });
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/supplier-resolution.test.ts -t "registry code conflicts"`

Expected: FAIL because normalized-name matching returns client 1.

- [ ] **Step 3: Stop after an unmatched strong identifier**

```ts
const suppliedStrong = Boolean(fields.supplier_reg_code || fields.supplier_vat_no);
const activeStrongMatches = clients.filter(client => !client.is_deleted && (
  fields.supplier_reg_code && client.code?.trim() === fields.supplier_reg_code.trim() ||
  fields.supplier_vat_no && normalizeVatForCompare(client.invoice_vat_no) === normalizeVatForCompare(fields.supplier_vat_no)
));
if (suppliedStrong && activeStrongMatches.length === 0) {
  return {
    found: false, created: false, match_type: "strong_identifier_conflict",
    requires_manual_review: true,
    reason: "No active client matches the supplier registry/VAT identifier; name fallback is unsafe.",
  };
}
```

Place this before exact/fuzzy name matching but after self-identity protection and successful strong matches.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/supplier-resolution.test.ts && npm run build && git diff --check`

Expected: conflict stays unresolved; matching strong ID still resolves. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit H13**

```bash
git add src/tools/supplier-resolution.ts src/tools/supplier-resolution.test.ts
git commit -m "fix(H13): veto supplier name on ID conflict"
```

### Task 29: H15 — Bind document approval to SHA-256 bytes

**Files:**
- Modify: `src/tools/receipt-inbox-types.ts:20-80`
- Modify: `src/tools/receipt-inbox-files.ts:1-120`
- Modify: `src/tools/receipt-inbox-booking.ts:74-325`
- Modify: `src/tools/receipt-inbox.ts:1490-1585`
- Modify: `src/tools/receipt-inbox.test.ts`
- Modify: `src/tools/receipt-inbox-tools.test.ts`
- Modify: `src/tools/pdf-workflow.ts:30-55,640-810`
- Modify: `src/tools/pdf-workflow.test.ts`
- Modify: `workflows/book-invoice.md`
- Modify: `.claude/commands/book-invoice.md`

**Interfaces:**
- Produces: `ReceiptApprovedManifestEntry { relative_path, sha256 }`; `ReceiptFileSnapshot`; `prepareReceiptBatchSnapshot`; both receipt mutation schemas require the dry-run manifest. PDF extraction returns `source_sha256`; PDF create requires it. All parsers/uploads consume the same immutable byte snapshot.

- [ ] **Step 1: Write byte-substitution regressions**

```ts
it.each([
  ["replacement", { "a.pdf": "%PDF-B" }],
  ["addition", { "a.pdf": "%PDF-A", "b.pdf": "%PDF-B" }],
  ["deletion", {}],
])("rejects receipt manifest %s before mutation", async (_case, replacement) => {
  const folder = createReceiptFolder({ "a.pdf": "%PDF-A" });
  try {
    const dry = await prepareReceiptBatchSnapshot(folder);
    const approved = dry.manifest;
    await dry.cleanup();
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    for (const [name, bytes] of Object.entries(replacement)) writeFileSync(join(folder, name), bytes);
    await expect(prepareReceiptBatchSnapshot(folder, undefined, undefined, undefined, approved))
      .rejects.toMatchObject({ category: "manifest_mismatch" });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

it("uploads the exact immutable receipt snapshot bytes", async () => {
  const bytes = Buffer.from("%PDF-approved");
  const snapshot: ReceiptFileSnapshot = {
    file: {
      name: "receipt.pdf", path: "/tmp/snapshot/receipt.pdf", extension: ".pdf", file_type: "pdf",
      size_bytes: bytes.length, modified_at: "2026-07-15T00:00:00.000Z",
    },
    relative_path: "receipt.pdf",
    sha256: sha256Hex(bytes),
    bytes,
    snapshot_path: "/tmp/snapshot/receipt.pdf",
  };
  const createdInvoice = { id: 900, number: "INV-1", status: "PROJECT" };
  const api = {
    purchaseInvoices: {
      createAndSetTotals: vi.fn().mockResolvedValue(createdInvoice),
      uploadDocument: vi.fn().mockResolvedValue({ ok: true }),
      invalidate: vi.fn(),
    },
  } as any;
  const result = await createAndMaybeMatchPurchaseInvoice(
    api,
    { clients: [], purchaseInvoices: [], purchaseArticlesWithVat: [], accounts: [], isVatRegistered: true },
    snapshot,
    {
      supplier_name: "Supplier OÜ", invoice_number: "INV-1", invoice_date: "2026-07-15",
      total_net: 100, total_vat: 24, total_gross: 124, currency: "EUR", description: "Service",
    },
    {
      found: true, created: false, match_type: "exact_name",
      client: {
        id: 7, name: "Supplier OÜ", is_supplier: true, is_client: false, cl_code_country: "EE",
        is_member: false, send_invoice_to_email: false, send_invoice_to_accounting_email: false,
      },
    },
    {
      source: "supplier_history",
      item: { custom_title: "Service", amount: 1, total_net_price: 100, cl_purchase_articles_id: 45, purchase_accounts_id: 5230, vat_rate_dropdown: "24" },
    },
    [],
    "create",
    false,
    new Set<number>(),
  );

  expect(result.status).toBe("created");
  expect(api.purchaseInvoices.uploadDocument).toHaveBeenCalledWith(
    900,
    "receipt.pdf",
    bytes.toString("base64"),
  );
});
```

In `src/tools/receipt-inbox-tools.test.ts`, use the current `createReceiptFolder`, `setupReceiptTool`, and captured handlers to prove both public schemas and merged-tool threading:

```ts
it("requires and threads the approved manifest through both receipt tools", async () => {
  const folder = createReceiptFolder({});
  try {
    const granular = setupReceiptTool("process_receipt_batch");
    const missing = await granular.handler({
      folder_path: folder, accounts_dimensions_id: 100, execution_mode: "create",
    });
    expect(parseMcpResponse(missing.content[0]!.text)).toMatchObject({ category: "approved_manifest_required" });
    expect(granular.api.purchaseInvoices.createAndSetTotals).not.toHaveBeenCalled();

    const merged = setupReceiptTool("receipt_batch");
    const dry = await merged.handler({ mode: "dry_run", folder_path: folder, accounts_dimensions_id: 100 });
    const dryPayload = parseMcpResponse(dry.content[0]!.text) as any;
    expect(dryPayload.result.approved_manifest).toEqual([]);
    expect(dryPayload.result.workflow.dry_run_steps[0].suggested_args.approved_manifest).toEqual([]);

    const execute = await merged.handler({
      mode: "create", folder_path: folder, accounts_dimensions_id: 100,
      approved_manifest: dryPayload.result.approved_manifest,
    });
    expect((parseMcpResponse(execute.content[0]!.text) as any).delegated_args).toMatchObject({
      execution_mode: "create", approved_manifest: [],
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
```

In `src/tools/pdf-workflow.test.ts`, add `access` to its `fs/promises` import, then use `createTempInvoiceFile` and `setupPdfWorkflowTool`; define every create argument locally and assert the existing three-argument upload call:

```ts

it("requires PDF source_sha256 and uploads byte-identical extraction input", async () => {
  const filePath = createTempInvoiceFile("approved.pdf", "%PDF-approved");
  mockedResolveFileInput.mockResolvedValue({ path: filePath });
  const parsedSnapshotPaths: string[] = [];
  mockedParseDocument.mockImplementation(async (snapshotPath) => {
    parsedSnapshotPaths.push(snapshotPath);
    return { text: "Supplier OÜ\nInvoice INV-1\nTotal 124 EUR", pageCount: 1, result: { text: "", pages: [] } as any };
  });
  const extraction = setupPdfWorkflowTool("extract_pdf_invoice");
  const extracted = parseMcpResponse((await extraction.handler({ file_path: filePath })).content[0]!.text) as any;
  await expect(access(parsedSnapshotPaths[0]!)).rejects.toThrow();
  const creation = setupPdfWorkflowTool("create_purchase_invoice_from_pdf");
  const args = {
    supplier_client_id: 7, invoice_number: "INV-1", invoice_date: "2026-07-15",
    journal_date: "2026-07-15", term_days: 14,
    items: JSON.stringify([{
      cl_purchase_articles_id: 45, custom_title: "Service", purchase_accounts_id: 5230,
      total_net_price: 100, vat_rate_dropdown: "24", vat_accounts_id: 1510, cl_vat_articles_id: 1,
    }]),
    vat_price: 24, gross_price: 124, file_path: filePath,
  };

  const missing = await creation.handler({ ...args });
  expect(missing.isError).toBe(true);
  expect(creation.api.purchaseInvoices.createAndSetTotals).not.toHaveBeenCalled();

  writeFileSync(filePath, "%PDF-changed");
  await expect(creation.handler({ ...args, source_sha256: extracted.source_sha256 }))
    .rejects.toMatchObject({ category: "digest_mismatch" });
  expect(creation.api.purchaseInvoices.createAndSetTotals).not.toHaveBeenCalled();

  writeFileSync(filePath, "%PDF-approved");
  const created = await creation.handler({ ...args, source_sha256: extracted.source_sha256 });
  expect(created.isError).not.toBe(true);
  expect(creation.api.purchaseInvoices.uploadDocument).toHaveBeenCalledWith(
    9001,
    "approved.pdf",
    Buffer.from("%PDF-approved").toString("base64"),
  );
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/receipt-inbox.test.ts src/tools/receipt-inbox-tools.test.ts src/tools/pdf-workflow.test.ts -t "manifest|immutable receipt snapshot|source_sha256"`

Expected: FAIL because mutation reopens the path without content identity.

- [ ] **Step 3: Compute, carry, and verify exact bytes**

```ts
export interface ReceiptApprovedManifestEntry { relative_path: string; sha256: string }
export interface ReceiptFileSnapshot { file: ReceiptFileInfo; relative_path: string; sha256: string; bytes: Buffer; snapshot_path: string }
export interface ReceiptBatchSnapshot {
  scan: ReceiptScanResult; files: ReceiptFileSnapshot[]; manifest: ReceiptApprovedManifestEntry[]; cleanup(): Promise<void>;
}
export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export async function prepareReceiptBatchSnapshot(
  folderPath: string, fileTypes?: FileType[], dateFrom?: string, dateTo?: string,
  approvedManifest?: readonly ReceiptApprovedManifestEntry[],
): Promise<ReceiptBatchSnapshot> {
  const scan = await scanReceiptFolderInternal(folderPath, fileTypes, dateFrom, dateTo);
  const snapshotDir = await mkdtemp(join(tmpdir(), "e-arveldaja-receipts-"));
  try {
    const files: ReceiptFileSnapshot[] = [];
    for (const file of scan.files) {
      const bytes = await readFile(await revalidateReceiptFilePath(file));
      const relative_path = file.name;
      const sha256 = sha256Hex(bytes);
      const snapshot_path = join(snapshotDir, `${files.length}${file.extension}`);
      await writeFile(snapshot_path, bytes, { mode: 0o600 });
      files.push({ file: { ...file, path: snapshot_path }, relative_path, sha256, bytes, snapshot_path });
    }
    const manifest = files.map(({ relative_path, sha256 }) => ({ relative_path, sha256 }))
      .sort((a, b) => a.relative_path.localeCompare(b.relative_path));
    if (approvedManifest) {
      const approved = [...approvedManifest].sort((a, b) => a.relative_path.localeCompare(b.relative_path));
      if (JSON.stringify(manifest) !== JSON.stringify(approved)) throw Object.assign(
        new Error("Receipt folder differs from the approved manifest"),
        { category: "manifest_mismatch", approved_manifest: approved, current_manifest: manifest },
      );
    }
    return { scan, files, manifest, cleanup: () => rm(snapshotDir, { recursive: true, force: true }) };
  } catch (error) {
    await rm(snapshotDir, { recursive: true, force: true });
    throw error;
  }
}
```

Change exact signatures and call sites:

```ts
async function extractReceiptFields(snapshot: ReceiptFileSnapshot, ownVat?: string, ownRegistry?: string): Promise<ExtractedReceiptFields> {
  const parsedDocument = await parseDocument(snapshot.snapshot_path);
  const allTextItems = parsedDocument.result?.pages?.flatMap(page =>
    (page.textItems ?? []).map(item => ({ ...item, pageNum: page.pageNum }))
  );
  return extractReceiptFieldsFromText(parsedDocument.text, snapshot.file.name, {
    ownCompanyVat: ownVat,
    ownCompanyRegistryCode: ownRegistry,
    textItems: allTextItems,
    minOcrConfidence: computeMinOcrConfidence(allTextItems),
    partialOcrFailure: parsedDocument.ocrPartialFailure,
  });
}
async function processSingleReceipt(api: ApiContext, context: ReceiptProcessingContext, snapshot: ReceiptFileSnapshot, options: ProcessSingleReceiptOptions) {
  const file = snapshot.file;
  const extracted = await extractReceiptFields(snapshot, options.ownCompanyVat, options.ownCompanyRegistryCode);
  const created = await createAndMaybeMatchPurchaseInvoice(
    api,
    context,
    snapshot,
    extracted,
    materializedSupplierResolution,
    bookingSuggestion,
    options.bankTransactions,
    options.executionMode,
    options.legacyExecuteCreate,
    options.consumedTransactionIds,
  );
}
export async function createAndMaybeMatchPurchaseInvoice(
  api: ApiContext, context: ReceiptProcessingContext, snapshot: ReceiptFileSnapshot, extracted: ExtractedReceiptFields,
  supplierResolution: SupplierResolution, bookingSuggestion: BookingSuggestion, bankTransactions: Transaction[],
  executionMode: ReceiptBatchExecutionMode, legacyExecuteCreate: boolean, consumedTransactionIds: Set<number>,
) {
  const file = snapshot.file;
  await api.purchaseInvoices.uploadDocument(createdInvoice.id!, file.name, snapshot.bytes.toString("base64"));
}
```

This is a mechanical signature patch: change `processSingleReceipt`'s third parameter from `ReceiptFileInfo` to `ReceiptFileSnapshot`, add `const file = snapshot.file` as its first statement, replace its extraction call with the one shown above, and replace only the third argument of its existing `createAndMaybeMatchPurchaseInvoice` call (`file` to `snapshot`). Change `createAndMaybeMatchPurchaseInvoice`'s third parameter to `ReceiptFileSnapshot`, add `const file = snapshot.file`, and replace its `readValidatedReceiptFile(file)` upload source with `snapshot.bytes.toString("base64")`. Do not alter its `createAndSetTotals` arguments, confirmation flow, rollback flow, or transaction matching.

Add this schema field to both `process_receipt_batch` and `receipt_batch`; add `approved_manifest` to both callback destructuring signatures:

```ts
const manifestSchema = z.array(z.object({
  relative_path: z.string().min(1).refine(value => !value.includes("/") && !value.includes("\\")),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}));
approved_manifest: manifestSchema.optional().describe("Exact manifest returned by dry_run; required for create/create_and_confirm."),
```

At the start of `process_receipt_batch`, after resolving `executionMode`, use:

```ts
if (!dryRun && approved_manifest === undefined) {
  return toolError({ category: "approved_manifest_required", error: "approved_manifest is required for receipt mutation" });
}
const snapshot = await prepareReceiptBatchSnapshot(
  folder_path,
  undefined,
  date_from,
  date_to,
  dryRun ? undefined : approved_manifest,
);
try {
  const scan = snapshot.scan;
  const files = snapshot.files;
  const results: ReceiptBatchFileResult[] = [];
  for (let index = 0; index < files.length; index++) {
    const fileSnapshot = files[index]!;
    await reportProgress(index, files.length);
    results.push(await processSingleReceipt(api, context, fileSnapshot, {
      ownCompanyVat,
      ownCompanyRegistryCode,
      bankTransactions,
      executionMode,
      legacyExecuteCreate,
      dryRun,
      consumedTransactionIds,
      previousResults: results,
    }));
  }
} finally {
  await snapshot.cleanup();
}
```

Keep the current API/context setup between `const scan = snapshot.scan` and the results loop. Put the handler's existing response construction inside the same `try`; add `approved_manifest: snapshot.manifest` to the top-level response and to `workflowArgs`. In `receipt_batch`, when `selectedMode !== "scan"`, reject missing `approved_manifest` for `create`/`create_and_confirm`, and construct `delegatedArgs` with `approved_manifest` when supplied. This makes the dry-run manifest appear in `result.approved_manifest`, the approval action, and the later captured `process_receipt_batch` call. The `finally` shown above executes for normal responses, validation returns, and thrown parser/API errors.

For PDF preparation, snapshot once and compose both cleanup functions:

```ts
export async function prepareInvoiceDocumentUpload(filePath: string, expectedSha256?: string) {
  const resolved = await resolveInvoiceDocumentInput(filePath);
  const bytes = await readFile(resolved.path);
  const source_sha256 = sha256Hex(bytes);
  const dir = await mkdtemp(join(tmpdir(), "e-arveldaja-invoice-"));
  const snapshotPath = join(dir, sanitizeInvoiceDocumentFileName(resolved.path));
  try { await writeFile(snapshotPath, bytes, { mode: 0o600 }); }
  catch (error) { await rm(dir, { recursive: true, force: true }); if (resolved.cleanup) await resolved.cleanup(); throw error; }
  const cleanup = async () => { await rm(dir, { recursive: true, force: true }); if (resolved.cleanup) await resolved.cleanup(); };
  if (expectedSha256 !== undefined && source_sha256 !== expectedSha256) {
    await cleanup();
    throw Object.assign(new Error("Document digest mismatch"), { category: "digest_mismatch", expected_sha256: expectedSha256, actual_sha256: source_sha256 });
  }
  return { snapshotPath, fileName: sanitizeInvoiceDocumentFileName(resolved.path), bytes, contentsBase64: bytes.toString("base64"), source_sha256, cleanup };
}
```

`extract_pdf_invoice` calls `prepareInvoiceDocumentUpload(file_path)`, parses `snapshot.snapshotPath`, returns `source_sha256: snapshot.source_sha256`, and calls `snapshot.cleanup()` in `finally`. `create_purchase_invoice_from_pdf` adds required `source_sha256: z.string().regex(/^[0-9a-f]{64}$/)` and begins its callback with an explicit direct-handler guard:

```ts
if (!/^[0-9a-f]{64}$/.test(params.source_sha256 ?? "")) {
  return toolError({ category: "source_sha256_required", error: "source_sha256 from extract_pdf_invoice is required" });
}
const documentUpload = await prepareInvoiceDocumentUpload(params.file_path, params.source_sha256);
```

Move `const supplier = await api.clients.get(params.supplier_client_id)` to the first line of the callback's existing `try`, use `documentUpload.contentsBase64` in the existing three-argument upload call, and replace the final conditional cleanup with `await documentUpload.cleanup()`. A digest mismatch is thrown before `api.clients.get` and before invoice creation. Update `workflows/book-invoice.md`, regenerate `.claude/commands/book-invoice.md`, and pass the extraction's `source_sha256` exactly.

- [ ] **Step 4: Prove green, sync workflow, and review**

Run: `npm run sync:workflow-prompts && npx vitest run src/tools/receipt-inbox.test.ts src/tools/receipt-inbox-tools.test.ts src/tools/pdf-workflow.test.ts src/prompts.test.ts && npm run build && git diff --check`

Expected: replacement/addition/deletion/missing manifest and missing/changed PDF digest create nothing; parser and uploader observe byte-identical snapshots; temp snapshots clean up on success, validation return, and thrown error. Write `.omc/reviews/H15.diff` and obtain both verdicts.

- [ ] **Step 5: Commit H15**

```bash
git add src/tools/receipt-inbox-types.ts src/tools/receipt-inbox-files.ts src/tools/receipt-inbox-booking.ts src/tools/receipt-inbox.ts src/tools/receipt-inbox.test.ts src/tools/receipt-inbox-tools.test.ts src/tools/pdf-workflow.ts src/tools/pdf-workflow.test.ts workflows/book-invoice.md .claude/commands/book-invoice.md
git commit -m "fix(H15): bind document approval to SHA-256"
```

### Task 30: M06 — Continue past invalid IBANs and reject impossible dates

**Files:**
- Modify: `src/document-identifiers.ts:53-75,228-235`
- Modify: `src/document-identifiers.test.ts`
- Modify: `src/tools/receipt-extraction.ts:839-885,1980-2030`
- Modify: `src/tools/receipt-extraction.test.ts`

**Interfaces:**
- Consumes: all IBAN-shaped candidates; date components.
- Produces: exported `isRealIsoDate(value): boolean`; `extractIban` returns first valid candidate, not first candidate.

- [ ] **Step 1: Write paired failing regressions**

```ts
it("continues from invalid first IBAN to a later valid IBAN", () => {
  expect(extractIban("IBAN EE001234567890123456 then EE471000001020145685")).toBe("EE471000001020145685");
});

it("rejects impossible ISO dates", () => {
  expect(normalizeDate("2026-02-30")).toBeUndefined();
  expect(extractDates("Invoice date: 2026-02-30")).toEqual({});
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/document-identifiers.test.ts src/tools/receipt-extraction.test.ts -t "later valid IBAN|impossible ISO"`

Expected: FAIL because first invalid IBAN returns undefined and ISO regex accepts 30 February.

- [ ] **Step 3: Iterate and validate the calendar**

```ts
export function extractIban(text: string): string | undefined {
  for (const match of text.matchAll(/\b([A-Z]{2}\d{2}(?:[ \t]*[A-Z0-9]){11,30})\b/gi)) {
    const candidate = match[1]!.replace(/\s+/g, "").toUpperCase();
    if (isValidIban(candidate)) return candidate;
  }
  return undefined;
}

export function isRealIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!));
  return date.toISOString().slice(0, 10) === value;
}
```

In `normalizeDate`, return `isRealIsoDate(trimmed) ? trimmed : undefined`; ensure `toIsoDate` performs the same round-trip validation.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/document-identifiers.test.ts src/tools/receipt-extraction.test.ts && npm run build && git diff --check`

Expected: valid later IBAN selected; impossible dates never reach extracted booking fields. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M06**

```bash
git add src/document-identifiers.ts src/document-identifiers.test.ts src/tools/receipt-extraction.ts src/tools/receipt-extraction.test.ts
git commit -m "fix(M06): validate receipt identifiers and dates"
```

### Task 31: M07 — Require supplier identity for payment-receipt invoice matching

**Files:**
- Modify: `src/tools/receipt-inbox.ts:970-1030`
- Modify: `src/tools/receipt-inbox.test.ts`

**Interfaces:**
- Consumes: extracted supplier registry/VAT/name and purchase invoice supplier fields.
- Produces: `buildReferencedInvoiceForPaymentReceipt(invoiceNumber, invoices, supplier): ReferencedInvoice`; ambiguous number matches never auto-link.

- [ ] **Step 1: Write the failing regression**

```ts
it("does not auto-match the same invoice number across suppliers", () => {
  const result = buildReferencedInvoiceForPaymentReceipt("INV-7", [
    { id: 1, number: "INV-7", clients_id: 10, client_name: "Alpha" },
    { id: 2, number: "INV-7", clients_id: 20, client_name: "Beta" },
  ] as PurchaseInvoice[], { client_id: 20, name: "Beta" });
  expect(result).toMatchObject({ matched: true, matched_invoice_id: 2 });
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/receipt-inbox.test.ts -t "same invoice number across suppliers"`

Expected: FAIL because the first number match wins.

- [ ] **Step 3: Filter number matches by compatible supplier identity**

```ts
const numberMatches = purchaseInvoices.filter(invoice => active(invoice) && normalize(invoice.number) === normalize(trimmed));
const supplierMatches = numberMatches.filter(invoice =>
  supplier.client_id !== undefined ? invoice.clients_id === supplier.client_id :
  normalizeCompanyName(invoice.client_name) === normalizeCompanyName(supplier.name));
if (supplierMatches.length === 1) return { invoice_number: trimmed, matched: true, matched_invoice_id: supplierMatches[0]!.id };
return { invoice_number: trimmed, matched: false, ambiguity_reason: numberMatches.length > 1 ? "supplier_identity_required" : undefined };
```

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/receipt-inbox.test.ts && npm run build && git diff --check`

Expected: unique compatible supplier links; same number without identity requires review. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M07**

```bash
git add src/tools/receipt-inbox.ts src/tools/receipt-inbox.test.ts
git commit -m "fix(M07): bind receipt invoice match to supplier"
```

### Task 32: M08 — Separate file-date and accounting-date filters

**Files:**
- Modify: `src/tools/receipt-inbox.ts:1490-1540`
- Modify: `src/tools/receipt-inbox.test.ts`

**Interfaces:**
- Consumes: receipt `date_from/date_to` as filesystem modified-date bounds only.
- Produces: optional `transaction_date_from/transaction_date_to` schema fields for accounting dates.

- [ ] **Step 1: Write the failing regression**

```ts
it("does not apply receipt modified-date bounds to bank transactions", async () => {
  await handler({ folder_path, accounts_dimensions_id: 10, date_from: "2026-07-01", date_to: "2026-07-02" });
  expect(processReceiptSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(),
    expect.objectContaining({ bankTransactions: expect.arrayContaining([expect.objectContaining({ id: 1, date: "2026-06-30" })]) }));
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/receipt-inbox.test.ts -t "modified-date bounds"`

Expected: FAIL because the June bank row is filtered by receipt file dates.

- [ ] **Step 3: Use independent accounting bounds**

```ts
transaction_date_from: z.string().optional().describe("Optional bank accounting-date lower bound (YYYY-MM-DD)"),
transaction_date_to: z.string().optional().describe("Optional bank accounting-date upper bound (YYYY-MM-DD)"),
```

```ts
const bankTransactions = allTransactions.filter(transaction =>
  transaction.accounts_dimensions_id === accounts_dimensions_id && isProjectTransaction(transaction) && transaction.type === "C" &&
  (!transaction_date_from || transaction.date >= transaction_date_from) &&
  (!transaction_date_to || transaction.date <= transaction_date_to));
```

Keep `date_from/date_to` only in `scanReceiptFolderInternal` and label them `receipt_modified_date_*` in output.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/receipt-inbox.test.ts && npm run build && git diff --check`

Expected: file bounds do not narrow bank rows; explicit transaction bounds do. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M08**

```bash
git add src/tools/receipt-inbox.ts src/tools/receipt-inbox.test.ts
git commit -m "fix(M08): separate receipt and bank date filters"
```

### Task 33: M09 — Fail closed when own-company identity cannot load

**Files:**
- Modify: `src/tools/receipt-inbox.ts:875-920,1500-1530`
- Modify: `src/tools/receipt-inbox.test.ts`

**Interfaces:**
- Consumes: `api.readonly.getInvoiceInfo()`.
- Produces: `loadOwnCompanyIdentity(api): Promise<{ status: "available"; invoiceCompanyName?: string } | { status: "retryable_error"; reason: string }>`.

- [ ] **Step 1: Write the failing regression**

```ts
it("blocks automatic receipt booking when invoice_info transiently fails", async () => {
  api.readonly.getInvoiceInfo.mockRejectedValueOnce(new HttpError("temporary", 503, "GET", "/invoice_info"));
  const result = parseResult(await handler({ folder_path, accounts_dimensions_id: 10, execution_mode: "create" }));
  expect(result).toMatchObject({ category: "manual_review_required", protection_state: "retryable_error" });
  expect(api.purchaseInvoices.create).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/receipt-inbox.test.ts -t "invoice_info transiently fails"`

Expected: FAIL because the helper returns `{}` and booking continues without protection.

- [ ] **Step 3: Distinguish unavailable API from transient failure**

```ts
async function loadOwnCompanyIdentity(api: ApiContext) {
  if (typeof api.readonly.getInvoiceInfo !== "function") return { status: "retryable_error" as const, reason: "invoice_info endpoint unavailable" };
  try {
    const info = await api.readonly.getInvoiceInfo();
    return { status: "available" as const, invoiceCompanyName: info.invoice_company_name?.trim() || undefined };
  } catch (error) {
    return { status: "retryable_error" as const, reason: error instanceof Error ? error.message : String(error) };
  }
}
```

For `dry_run`, return the protection error in review output; for create/create-and-confirm, return before supplier resolution or mutation.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/receipt-inbox.test.ts && npm run build && git diff --check`

Expected: transient/unavailable identity blocks automation; successful identity retains behavior. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M09**

```bash
git add src/tools/receipt-inbox.ts src/tools/receipt-inbox.test.ts
git commit -m "fix(M09): fail closed on company identity errors"
```

### Task 34: M10 — Remove sandbox markers from persisted rule/audit values

**Files:**
- Modify: `src/tools/receipt-inbox.ts:830-875,1700-1765`
- Modify: `src/tools/receipt-inbox.test.ts`

**Interfaces:**
- Consumes: `unwrapUntrustedOcr(text)` from `src/mcp-json.ts`.
- Produces: `canonicalBusinessText(value): string`; all matching/rule/API/audit persistence uses canonical text, wrapping occurs only on response rendering.

- [ ] **Step 1: Write the failing regression**

```ts
it("persists canonical rule keys and audit text after review round-trip", async () => {
  const wrapped = wrapUntrustedOcr("Acme OÜ")!;
  await applyHandler({ classifications_json: [{ normalized_counterparty: wrapped, save_as_rule: true }] });
  expect(saveAutoBookingRule).toHaveBeenCalledWith(expect.objectContaining({ match: "Acme OÜ" }));
  expect(logAudit).toHaveBeenCalledWith(expect.not.objectContaining({ summary: expect.stringContaining("UNTRUSTED_OCR") }));
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/receipt-inbox.test.ts -t "canonical rule keys"`

Expected: FAIL because nonce delimiters enter the rule key and audit text.

- [ ] **Step 3: Canonicalize every server-side value once**

```ts
export function canonicalBusinessText(value: unknown): string {
  return typeof value === "string" ? unwrapUntrustedOcr(value).trim().replace(/\s+/g, " ") : "";
}

const counterparty = canonicalBusinessText(input.normalized_counterparty);
const description = canonicalBusinessText(input.description);
saveAutoBookingRule({ ...rule, match: counterparty });
logAudit({ ...entry, summary: `Saved classification for ${counterparty}`, details: { ...details, description } });
```

Apply before normalization, matching, payload construction, rule save, and audit; response builders wrap canonical values after all business logic.

- [ ] **Step 4: Prove green and independently review**

Run: `npx vitest run src/tools/receipt-inbox.test.ts src/mcp-json.test.ts && npm run build && git diff --check`

Expected: no persisted/audited marker; MCP response remains wrapped. Write `.omc/reviews/M10.diff` and obtain both verdicts.

- [ ] **Step 5: Commit M10**

```bash
git add src/tools/receipt-inbox.ts src/tools/receipt-inbox.test.ts
git commit -m "fix(M10): canonicalize persisted receipt text"
```

- [ ] **Step 6: Append ledger, prove clean, then pass Wave 5**

Append M10, require empty `git status --short`, then run `npm run validate:release && git diff --check && npm run build && npm test && npm run test:integration`; require PASS with baseline skips only.

### Task 35: H19 — Prove CAMT duplicate identity before deletion

**Files:**
- Modify: `src/tools/accounting-inbox.ts:1390-1495`
- Modify: `src/tools/accounting-inbox.test.ts`

**Interfaces:**
- Consumes: kept/deleted transaction bank dimension, date, signed amount, currency, bank/reference identity.
- Produces: `compareCamtDuplicateIdentity(kept, candidate): { matches: true; canonicalReference: string } | { matches: false; reasons: string[] }`.

- [ ] **Step 1: Write the failing regression**

```ts
it.each([
  ["bank dimension", { accounts_dimensions_id: 20 }],
  ["date", { date: "2026-07-02" }],
  ["amount", { amount: 99 }],
  ["currency", { cl_currencies_id: "USD" }],
  ["reference", { bank_ref_number: "OTHER" }],
])("refuses cleanup when %s differs", async (_label, patch) => {
  api.transactions.get.mockResolvedValueOnce(confirmedTx()).mockResolvedValueOnce({ ...projectTx(), ...patch });
  await expect(cleanupHandler(args)).rejects.toThrow(/identity mismatch/i);
  expect(api.transactions.delete).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/accounting-inbox.test.ts -t "refuses cleanup when"`

Expected: FAIL because status alone permits deletion.

- [ ] **Step 3: Compare the complete destructive identity**

```ts
export function compareCamtDuplicateIdentity(kept: Transaction, candidate: Transaction) {
  const reasons: string[] = [];
  if (kept.accounts_dimensions_id !== candidate.accounts_dimensions_id) reasons.push("bank dimension differs");
  if (kept.date !== candidate.date) reasons.push("date differs");
  if ((kept.cl_currencies_id ?? "EUR") !== (candidate.cl_currencies_id ?? "EUR")) reasons.push("currency differs");
  if (roundMoney(signedAmount(kept)) !== roundMoney(signedAmount(candidate))) reasons.push("signed amount differs");
  const keptRef = canonicalTransactionReference(kept);
  const candidateRef = canonicalTransactionReference(candidate);
  if (!keptRef || !candidateRef || keptRef !== candidateRef) reasons.push("canonical reference missing or differs");
  return reasons.length ? { matches: false as const, reasons } : { matches: true as const, canonicalReference: keptRef! };
}
```

Call after both status checks and before patch/delete; mismatch returns `manual_review_required` and no update/delete.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/accounting-inbox.test.ts && npm run build && git diff --check`

Expected: all mismatches block; exact identity permits existing cleanup. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit H19**

```bash
git add src/tools/accounting-inbox.ts src/tools/accounting-inbox.test.ts
git commit -m "fix(H19): prove CAMT duplicate identity"
```

### Task 36: M11 — Complete, resumable accounting review pages

**Files:**
- Modify: `src/tools/accounting-inbox-autopilot-service.ts:180-340`
- Modify: `src/tools/accounting-inbox-autopilot-service.test.ts`

**Interfaces:**
- Consumes: CAMT/receipt/classification review arrays.
- Produces: `stableReviewId(sourceTool, item): string`; review page `{ items, next_cursor?, total, complete }`; IDs are accepted by continuation payloads.

- [ ] **Step 1: Write the failing regression**

```ts
it("returns every review item with stable resumable IDs", async () => {
  const output = await summarizePipelineWithClassificationGroups(7);
  expect(output.needs_accountant_review).toHaveLength(7);
  expect(new Set(output.needs_accountant_review.map(item => item.id)).size).toBe(7);
  expect(output.review_page).toMatchObject({ total: 7, complete: true });
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/accounting-inbox-autopilot-service.test.ts -t "stable resumable IDs"`

Expected: FAIL because classification reviews are sliced to five and lack IDs.

- [ ] **Step 3: Assign deterministic IDs and expose complete pagination state**

```ts
export function stableReviewId(sourceTool: string, item: Record<string, unknown>): string {
  const identity = JSON.stringify([sourceTool, item.transaction_id, item.new_transaction_api_id, item.file_path, item.category, item.normalized_counterparty]);
  return `${sourceTool}:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

const reviewItems = reviewGroups.map(group => ({ id: stableReviewId(tool, group), ...toFollowUp(group) }));
return { ...summary, followUps: reviewItems, review_page: { total: reviewItems.length, complete: true } };
```

Do not slice. Thread `id` into `resolver_input` and accept it unchanged in `continue_accounting_workflow` review items.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/accounting-inbox-autopilot-service.test.ts src/tools/accounting-inbox.test.ts && npm run build && git diff --check`

Expected: seven input reviews yield seven stable IDs and resume works by ID. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M11**

```bash
git add src/tools/accounting-inbox-autopilot-service.ts src/tools/accounting-inbox-autopilot-service.test.ts
git commit -m "fix(M11): make inbox reviews resumable"
```

### Task 37: M12 — Defer reconciliation until imports materialize

**Files:**
- Modify: `src/tools/accounting-inbox-autopilot-service.ts:380-485`
- Modify: `src/tools/accounting-inbox-autopilot-service.test.ts`

**Interfaces:**
- Consumes: `leavesPendingMaterializationAfterDryRun` and step prerequisites.
- Produces: `materialization_state: "current" | "pending_imports" | "failed"`; reconciliation steps only run when `current`.

- [ ] **Step 1: Write the failing regression**

```ts
it("marks reconciliation deferred when an import dry run has pending rows", async () => {
  const result = await runAccountingInboxDryRunPipeline(pipelineWithPendingCamtAndReconciliation());
  expect(result.skipped_steps).toEqual(expect.arrayContaining([expect.objectContaining({
    tool: "reconcile_inter_account_transfers", status: "deferred", materialization_state: "pending_imports",
  })]));
  expect(handlers.get("reconcile_inter_account_transfers")).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/accounting-inbox-autopilot-service.test.ts -t "reconciliation deferred"`

Expected: FAIL because only classification is blocked and reconciliation reads the old ledger.

- [ ] **Step 3: Gate every ledger-dependent step**

```ts
const LEDGER_DEPENDENT_TOOLS = new Set(["classify_unmatched_transactions", "reconcile_inter_account_transfers"]);
let materializationState: "current" | "pending_imports" | "failed" = "current";
const blockedByMaterialization = LEDGER_DEPENDENT_TOOLS.has(step.tool) && materializationState !== "current";
if (blockedByMaterialization) {
  skippedSteps.push({ ...baseStep, status: "deferred", materialization_state: materializationState,
    summary: "Deferred until approved imports are materialized and a fresh ledger is loaded." });
  continue;
}
if (leavesPendingMaterializationAfterDryRun(step.tool, summarized.preview)) materializationState = "pending_imports";
```

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/accounting-inbox-autopilot-service.test.ts && npm run build && git diff --check`

Expected: old-ledger reconciliation never runs; dry run explains exact execution order. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M12**

```bash
git add src/tools/accounting-inbox-autopilot-service.ts src/tools/accounting-inbox-autopilot-service.test.ts
git commit -m "fix(M12): defer stale-ledger reconciliation"
```

### Task 38: M13 — Process all discovered receipt folders

**Files:**
- Modify: `src/tools/accounting-inbox.ts:470-590`
- Modify: `src/tools/accounting-inbox.test.ts`

**Interfaces:**
- Consumes: deterministically sorted `receiptFolders`.
- Produces: one `process_receipt_batch` step per eligible folder, with `folder_index`, file count, and error scope.

- [ ] **Step 1: Write the failing regression**

```ts
it("creates deterministic processing steps for every receipt folder", () => {
  const prepared = buildSuggestedSteps({ receiptFolders: [folder("b", 2), folder("a", 1)] } as any);
  expect(prepared.steps.filter(step => step.tool === "process_receipt_batch").map(step => step.suggested_args.folder_path))
    .toEqual(["a", "b"]);
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/accounting-inbox.test.ts -t "every receipt folder"`

Expected: FAIL because only `receiptFolders[0]` becomes a step.

- [ ] **Step 3: Emit a step for each sorted folder**

```ts
for (const [folderIndex, folder] of [...receiptFolders].sort((a, b) => a.path.localeCompare(b.path)).entries()) {
  steps.push({
    step: stepNumber++, tool: "process_receipt_batch",
    purpose: `Dry-run receipt processing for folder ${folder.path}.`, recommended: dimensionId !== undefined,
    suggested_args: { folder_path: folder.path, ...(dimensionId !== undefined && { accounts_dimensions_id: dimensionId }), execution_mode: "dry_run" },
    missing_inputs: dimensionId === undefined ? ["accounts_dimensions_id"] : [],
    reason: `Folder ${folderIndex + 1}/${receiptFolders.length}; ${folder.receipt_file_count} eligible receipt file(s).`,
  });
}
```

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/accounting-inbox.test.ts src/tools/accounting-inbox-autopilot-service.test.ts && npm run build && git diff --check`

Expected: all folders appear in path order with independent outcomes. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M13**

```bash
git add src/tools/accounting-inbox.ts src/tools/accounting-inbox.test.ts
git commit -m "fix(M13): process every receipt folder"
```

### Task 39: M14 — Actionable unknown-review errors

**Files:**
- Modify: `src/tools/accounting-inbox.ts:990-1020`
- Modify: `src/tools/accounting-inbox.test.ts`

**Interfaces:**
- Consumes: M11 review item ID.
- Produces: unknown review result `status: "unsupported_review_type"`, `error`, `supported_review_types`, and non-empty `unresolved_questions`.

- [ ] **Step 1: Write the failing regression**

```ts
it("returns an actionable question for an unknown review type", () => {
  const result = resolveReviewItemPlan({ id: "review:7", review_type: "mystery" } as any);
  expect(result).toMatchObject({ status: "unsupported_review_type", supported_review_types: ["receipt_review", "classification_group", "camt_possible_duplicate"] });
  expect(result.unresolved_questions[0]).toMatch(/review:7.*supported type/i);
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/accounting-inbox.test.ts -t "unknown review type"`

Expected: FAIL because status is `needs_answers` with an empty question list.

- [ ] **Step 3: Return an explicit unsupported contract**

```ts
return {
  review_type: "unknown", status: "unsupported_review_type",
  error: `Review item ${stringAt(reviewItem, "id") ?? "without-id"} has unsupported review_type ${reviewType ?? "missing"}.`,
  supported_review_types: ["receipt_review", "classification_group", "camt_possible_duplicate"],
  recommendation: "Re-emit the item from its source tool with a supported review_type.",
  compliance_basis: [],
  unresolved_questions: [`Which supported review type applies to item ${stringAt(reviewItem, "id") ?? "without-id"}?`],
  suggested_tools: [], next_step_summary: "Correct the review type before preparing any action.",
};
```

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/accounting-inbox.test.ts && npm run build && git diff --check`

Expected: no `needs_answers` response has zero questions. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M14**

```bash
git add src/tools/accounting-inbox.ts src/tools/accounting-inbox.test.ts
git commit -m "fix(M14): make unknown reviews actionable"
```

### Task 40: M15 — Count every traversed workspace entry

**Files:**
- Modify: `src/tools/accounting-inbox.ts:190-250,720-760`
- Modify: `src/tools/accounting-inbox.test.ts`

**Interfaces:**
- Consumes: directory entries from `readdir`.
- Produces: scan metadata `inspected_entries`, `entry_limit`, `truncated`, `continuation_guidance`.

- [ ] **Step 1: Write the failing regression**

```ts
it("stops after the entry budget even when entries do not match", async () => {
  await createWorkspaceWithNonMatchingFiles(root, MAX_SCANNED_FILES + 5);
  const result = await scanAccountingWorkspace(root, 2);
  expect(result.inspected_entries).toBe(MAX_SCANNED_FILES);
  expect(result.truncated).toBe(true);
  expect(result.continuation_guidance).toMatch(/narrower workspace/i);
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/tools/accounting-inbox.test.ts -t "entry budget"`

Expected: FAIL because only matching `files.length` consumes the cap.

- [ ] **Step 3: Increment before classifying every entry**

```ts
let inspectedEntries = 0;
for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
  if (inspectedEntries >= MAX_SCANNED_FILES) { truncated = true; return; }
  inspectedEntries += 1;
  // existing directory/file classification follows
}
return { files, scanned_directories: scannedDirectories, inspected_entries: inspectedEntries,
  entry_limit: MAX_SCANNED_FILES, truncated,
  ...(truncated && { continuation_guidance: "Re-run accounting_inbox with a narrower workspace_path." }) };
```

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/tools/accounting-inbox.test.ts && npm run build && git diff --check`

Expected: traversal halts deterministically independent of matching files. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M15**

```bash
git add src/tools/accounting-inbox.ts src/tools/accounting-inbox.test.ts
git commit -m "fix(M15): enforce workspace traversal budget"
```

### Task 41: M16 — Render audit summaries exactly once

**Files:**
- Modify: `src/audit-log.ts:470-530`
- Modify: `src/audit-log.test.ts`

**Interfaces:**
- Consumes: `AuditEntry.summary`.
- Produces: one localized `Summary/Kokkuvõte` row in human-readable entry rendering; machine details unchanged.

- [ ] **Step 1: Write the failing regression**

```ts
it("renders a non-empty summary once", () => {
  logAudit({ tool: "x", action: "UPDATED", entity_type: "journal", entity_id: 1, summary: "Adjusted Acme", details: {} });
  const text = getAuditLog();
  expect(text.match(/Adjusted Acme/g)).toHaveLength(1);
  expect(text).toMatch(/Summary|Kokkuvõte/);
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/audit-log.test.ts -t "summary once"`

Expected: FAIL because summary is not rendered.

- [ ] **Step 3: Insert the localized escaped row**

```ts
addRow("summary", entry.summary);
```

Place this immediately after `addRow("tool", entry.tool, { code: true })` inside `renderDetails`; `formatDetailValue` supplies newline normalization and markdown escaping. Do not duplicate summary elsewhere.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/audit-log.test.ts && npm run build && git diff --check`

Expected: summary appears once and markdown/control text is escaped. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M16**

```bash
git add src/audit-log.ts src/audit-log.test.ts
git commit -m "fix(M16): render audit summaries"
```

### Task 42: M17 — Lock audit relabel/merge against concurrent append

**Files:**
- Modify: `src/file-lock.ts`
- Modify: `src/file-lock.test.ts`
- Modify: `src/audit-log.ts:200-300`
- Modify: `src/audit-log.test.ts`

**Interfaces:**
- Consumes: H06 `withOwnedFileLockSync(lockPath, fn, options)` and existing atomic/private audit-file writer. The audit API stays synchronous; it never consumes a `Promise` as a lock.
- Produces: `withAuditLogLock<T>(fn: () => T): T`; `setAuditMergeTestHookForTesting(hook)`; relabel rereads both files inside lock and atomically renames merged content.

- [ ] **Step 1: Write deterministic concurrent-append regression**

```ts
it("preserves an append that occurs while labels are merged", () => {
  setAuditMergeTestHookForTesting(() => appendFileSync(sourcePath, entryText("concurrent")));
  setAuditLogLabel("connection:1", "Acme");
  const merged = readFileSync(targetPath, "utf8");
  expect(merged.match(/concurrent/g)).toHaveLength(1);
  expect(merged.match(/before/g)).toHaveLength(1);
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/audit-log.test.ts -t "append that occurs"`

Expected: FAIL because merge writes an earlier snapshot over the concurrent append.

- [ ] **Step 3: Reread and replace inside a cross-process lock**

Add this synchronous companion to `src/file-lock.ts`. It reuses H06's `OwnerToken`, `parseOwner`, and `ownerDefinitelyDead` policy, including treating empty/malformed tokens as busy:

```ts
const syncWaitCell = new Int32Array(new SharedArrayBuffer(4));

function readTextSync(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function linkOwnedPathSync(path: string, text: string): boolean {
  const candidate = `${path}.${process.pid}.${randomUUID()}.candidate`;
  writeFileSync(candidate, text, { flag: "wx", mode: 0o600 });
  try { linkSync(candidate, path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally { rmSync(candidate, { force: true }); }
}

function releaseIfOwnedSync(path: string, text: string): void {
  if (readTextSync(path) === text) rmSync(path, { force: true });
}

function reclaimIfStaleSync(lockPath: string, observed: string): void {
  const reclaimPath = `${lockPath}.reclaim`;
  const guardText = JSON.stringify({ pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() } satisfies OwnerToken);
  if (!linkOwnedPathSync(reclaimPath, guardText)) {
    const currentGuard = readTextSync(reclaimPath);
    if (currentGuard !== undefined && ownerDefinitelyDead(parseOwner(currentGuard))) rmSync(reclaimPath, { force: true });
    return;
  }
  try {
    const current = readTextSync(lockPath);
    if (current === observed && ownerDefinitelyDead(parseOwner(current))) rmSync(lockPath, { force: true });
  } finally { releaseIfOwnedSync(reclaimPath, guardText); }
}

export function withOwnedFileLockSync<T>(lockPath: string, fn: () => T, options: LockOptions = {}): T {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = { pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() } satisfies OwnerToken;
  const text = JSON.stringify(token);
  while (!linkOwnedPathSync(lockPath, text)) {
    const observed = readTextSync(lockPath);
    if (observed === undefined) continue;
    if (ownerDefinitelyDead(parseOwner(observed))) reclaimIfStaleSync(lockPath, observed);
    if (Date.now() >= deadline) throw Object.assign(
      new Error(`Timed out waiting for lock ${lockPath}`),
      { category: "lock_timeout", lockPath, timeoutMs },
    );
    Atomics.wait(syncWaitCell, 0, 0, Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  try { return fn(); }
  finally { releaseIfOwnedSync(lockPath, text); }
}
```

Add synchronous lock tests that preset a malformed token and expect `lock_timeout` without file replacement, preset a well-formed dead PID and expect acquisition, and assert `withOwnedFileLockSync` releases its own token after `fn` throws.

```ts
export function withAuditLogLock<T>(fn: () => T): T {
  return withOwnedFileLockSync(join(LOGS_DIR, ".audit-log.lock"), fn);
}

let auditMergeTestHook: (() => void) | undefined;
export function setAuditMergeTestHookForTesting(hook?: () => void): void { auditMergeTestHook = hook; }

withAuditLogLock(() => {
  auditMergeTestHook?.();
  const source = existsSync(sourcePath) ? readFileSync(sourcePath, "utf8") : "";
  const target = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
  const sections = [...target.split(ENTRY_SEPARATOR), ...source.split(ENTRY_SEPARATOR)].filter(Boolean);
  const merged = `${[...new Set(sections)].join(ENTRY_SEPARATOR)}${ENTRY_SEPARATOR}`;
  const temporary = `${targetPath}.tmp-${process.pid}`;
  writeFileSync(temporary, merged, { mode: 0o600 });
  renameSync(temporary, targetPath);
  if (sourcePath !== targetPath) unlinkSync(sourcePath);
});
```

Make `logAudit` use the same lock around append, so the test hook blocks rather than racing outside the protocol.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/file-lock.test.ts src/audit-log.test.ts && npm run build && git diff --check`

Expected: both entries survive once; live/malformed owner fails busy rather than evicting. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M17**

```bash
git add src/file-lock.ts src/file-lock.test.ts src/audit-log.ts src/audit-log.test.ts
git commit -m "fix(M17): serialize audit relabel and append"
```

### Task 43: M18 — Enforce default audit limit for every read

**Files:**
- Modify: `src/audit-log.ts:750-825`
- Modify: `src/audit-log.test.ts`

**Interfaces:**
- Consumes: `parseLimitFilter(undefined) === 100`.
- Produces: newest-first/chronological output contract capped to `limit` for filtered and unfiltered reads.

- [ ] **Step 1: Write the failing regression**

```ts
it("returns only the newest 100 entries when no filter is provided", () => {
  seedAuditEntries(105);
  const entries = splitAuditEntries(getAuditLog());
  expect(entries).toHaveLength(100);
  expect(entries.join(" ")).not.toContain("entry-0");
  expect(entries.join(" ")).toContain("entry-104");
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/audit-log.test.ts -t "newest 100"`

Expected: FAIL because an unfiltered call returns raw full content.

- [ ] **Step 3: Always split/filter/limit**

```ts
const sections = content.split(ENTRY_SEPARATOR).filter(Boolean);
let filtered = sections.filter(section => matchesAuditFilter(section, filter));
filtered = filtered.slice(-limit);
return filtered.length ? `${filtered.join(ENTRY_SEPARATOR)}${ENTRY_SEPARATOR}` : "";
```

Remove the raw-content fast path. Preserve explicit positive limit validation and chronological ordering of the selected newest entries.

- [ ] **Step 4: Prove green and independently review**

Run: `npx vitest run src/audit-log.test.ts && npm run build && git diff --check`

Expected: omitted limit yields newest 100 for all read paths; explicit limits work. Write `.omc/reviews/M18.diff` and obtain both verdicts.

- [ ] **Step 5: Commit M18**

```bash
git add src/audit-log.ts src/audit-log.test.ts
git commit -m "fix(M18): enforce default audit read limit"
```

- [ ] **Step 6: Append ledger, prove clean, then pass Wave 6**

Append M18, require empty `git status --short`, then run `npm run validate:release && git diff --check && npm run build && npm test && npm run test:integration`; require PASS with baseline skips only.

### Task 44: M24 — Expose documented dimension prompt arguments

**Files:**
- Modify: `src/prompts.ts:145-330`
- Modify: `src/prompts.test.ts`

**Interfaces:**
- Consumes: workflow-documented dimension names.
- Produces: prompt schema arguments with exactly matching names/types/optionality: `purchase_accounts_dimensions_id`, `vat_accounts_dimensions_id`, `bank_account_dimension_id`, `receipt_matching_dimension_id`, `wise_account_dimension_id`, `inter_account_dimension_id`, and `target_accounts_dimensions_id`.

- [ ] **Step 1: Write the failing schema regression**

```ts
it.each([
  ["book-invoice", ["purchase_accounts_dimensions_id", "vat_accounts_dimensions_id"]],
  ["accounting-inbox", ["bank_account_dimension_id", "receipt_matching_dimension_id", "wise_account_dimension_id"]],
  ["import-wise", ["inter_account_dimension_id"]],
  ["reconcile-bank", ["target_accounts_dimensions_id"]],
])("prompt %s exposes documented dimensions", async (promptName, names) => {
  const schema = registeredPromptSchema(promptName);
  for (const name of names) expect(schema).toHaveProperty(name);
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/prompts.test.ts -t "exposes documented dimensions"`

Expected: FAIL because the named optional arguments are absent.

- [ ] **Step 3: Add exact optional positive-integer schemas**

```ts
const optionalDimension = (description: string) => z.number().int().positive().optional().describe(description);
```

Add to the matching prompt objects:

```ts
purchase_accounts_dimensions_id: optionalDimension("Optional purchase expense account dimension ID carried into the approved invoice item"),
vat_accounts_dimensions_id: optionalDimension("Optional VAT account dimension ID carried into the approved invoice item"),
bank_account_dimension_id: optionalDimension("Default CAMT bank account dimension ID"),
receipt_matching_dimension_id: optionalDimension("Receipt bank-matching dimension ID"),
wise_account_dimension_id: optionalDimension("Wise bank account dimension ID"),
inter_account_dimension_id: optionalDimension("Other own bank dimension for Wise transfers"),
target_accounts_dimensions_id: optionalDimension("Target own-bank dimension for one-sided reconciliation"),
```

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/prompts.test.ts && npm run build && git diff --check`

Expected: schema names/types/optionality match workflows and existing prompt arguments remain. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M24**

```bash
git add src/prompts.ts src/prompts.test.ts
git commit -m "fix(M24): expose workflow dimension prompts"
```

### Task 45: M25 — Standardize Lightyear `file_path`

**Files:**
- Modify: `src/prompts.ts:310-330`
- Modify: `src/prompts.test.ts`
- Modify: `src/tools/workflow-recommendations.ts:338-355`
- Modify: `src/tools/workflow-recommendations.test.ts`
- Modify: `workflows/lightyear-booking.md`
- Modify: `.claude/commands/lightyear-booking.md`

**Interfaces:**
- Consumes: `parse_lightyear_statement` schema `file_path`.
- Produces: every Lightyear prompt/recommendation/workflow command uses `file_path`; capital gains retains its own tool’s actual parameter name.

- [ ] **Step 1: Write failing drift regressions**

```ts
it("uses file_path for the Lightyear statement on every surface", () => {
  expect(registeredPromptSchema("lightyear-booking")).toHaveProperty("file_path");
  expect(registeredPromptSchema("lightyear-booking")).not.toHaveProperty("statement_path");
  expect(lightyearRecommendation().next_actions[0]).toMatchObject({ tool: "parse_lightyear_statement", args: { file_path: expect.any(String) } });
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/prompts.test.ts src/tools/workflow-recommendations.test.ts -t "Lightyear statement on every surface"`

Expected: FAIL because prompt/recommendation use `statement_path`.

- [ ] **Step 3: Rename only the statement argument and update workflow prose**

```ts
file_path: z.string().describe("Absolute path to Lightyear AccountStatement CSV file"),
```

```ts
next_actions: [{
  tool: "parse_lightyear_statement",
  args: { file_path: "<absolute Lightyear AccountStatement CSV path>" },
  why: "Parse the statement first so trades, distributions, FX warnings, and skipped entries are visible before booking.",
}],
```

In `workflows/lightyear-booking.md`, show `parse_lightyear_statement { "file_path": "/absolute/Lightyear AccountStatement.csv" }` and use `file_path` in every statement call.

- [ ] **Step 4: Sync, prove green, and review**

Run: `npm run sync:workflow-prompts && npx vitest run src/prompts.test.ts src/tools/workflow-recommendations.test.ts src/release-metadata.test.ts && npm run build && git diff --check`

Expected: prompt/recommendation/workflow/mirror/tool schema agree and drift validation passes. Package all listed/generated files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M25**

```bash
git add src/prompts.ts src/prompts.test.ts src/tools/workflow-recommendations.ts src/tools/workflow-recommendations.test.ts workflows/lightyear-booking.md .claude/commands/lightyear-booking.md
git commit -m "fix(M25): standardize Lightyear file_path"
```

### Task 46: M27 — Prevent `.env` metadata line injection

**Files:**
- Modify: `src/config.ts:725-810`
- Modify: `src/config.test.ts`

**Interfaces:**
- Consumes: `CredentialBlockMetadata` values.
- Produces: `serializeEnvComment(label, value): string`; rejects CR/LF/NUL/C0 controls and guarantees one comment line.

- [ ] **Step 1: Write the failing regression**

```ts
it.each(["Acme\nEARVELDAJA_SERVER=evil", "source\r\nKEY=x", "bad\u0000name"])("rejects control characters in credential metadata", (value) => {
  expect(() => serializeEnvFile(env, { primary: { companyName: value, verifiedAt: value, sourceFile: value } }))
    .toThrow(/credential metadata.*control character/i);
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/config.test.ts -t "control characters in credential metadata"`

Expected: FAIL because metadata produces additional `.env` lines.

- [ ] **Step 3: Validate every metadata comment**

```ts
function serializeEnvComment(label: string, value: string): string {
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(value)) {
    throw new Error(`Credential metadata ${label} contains a control character`);
  }
  return `# ${label}: ${value.trim()}`;
}

if (metadata?.companyName) lines.push(serializeEnvComment("Company", metadata.companyName));
if (metadata?.verifiedAt) lines.push(serializeEnvComment("Verified at", metadata.verifiedAt));
if (metadata?.sourceFile) lines.push(serializeEnvComment("Imported from", metadata.sourceFile));
```

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/config.test.ts src/startup-credential-import.test.ts && npm run build && git diff --check`

Expected: injected metadata rejects before write; legitimate Unicode/path metadata remains one line. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M27**

```bash
git add src/config.ts src/config.test.ts
git commit -m "fix(M27): validate credential metadata lines"
```

### Task 47: M28 — Preserve insecure `.env` bytes while hardening permissions

**Files:**
- Modify: `src/config.ts:403-440,680-725,935-1025`
- Modify: `src/config.test.ts`

**Interfaces:**
- Consumes: regular `.env` path and POSIX mode.
- Produces: `ensurePrivateEnvFile(path): void`; it chmods an existing regular file to `0600` before parse, never truncates, and aborts on failure.

- [ ] **Step 1: Write preservation regressions**

```ts
it("hardens an insecure regular env without discarding existing bytes", async () => {
  writeFileSync(envPath, "KEEP=value\n", { mode: 0o644 });
  await importApiKeyCredentials(importOptions(envPath));
  expect(readFileSync(envPath, "utf8")).toContain("KEEP=value");
  expect(statSync(envPath).mode & 0o777).toBe(0o600);
});

it("preserves bytes when permission hardening fails", async () => {
  writeFileSync(envPath, "KEEP=value\n", { mode: 0o644 });
  fsOps.chmodSync.mockImplementationOnce(() => { throw new Error("denied"); });
  await expect(importApiKeyCredentials(importOptions(envPath, fsOps))).rejects.toThrow(/permissions.*KEEP/i);
  expect(readFileSync(envPath, "utf8")).toBe("KEEP=value\n");
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/config.test.ts -t "insecure regular env|permission hardening fails"`

Expected: FAIL because `parseEnvFile` treats insecure content as empty and later atomic write replaces it.

- [ ] **Step 3: Harden before reading and fail without writing**

```ts
function ensurePrivateEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;
  const info = lstatSync(envPath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing unsafe .env target: ${envPath}`);
  if ((info.mode & 0o077) !== 0) {
    try { chmodSync(envPath, 0o600); }
    catch (error) { throw new Error(`Could not establish private .env permissions; existing bytes were preserved: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if ((lstatSync(envPath).mode & 0o077) !== 0) throw new Error("Could not verify private .env permissions; existing bytes were preserved");
}
```

Call `ensurePrivateEnvFile(targetEnvFile)` before `parseEnvFile`/`parseEnvMetadata`. Keep `writePrivateEnvFile` atomic temp+rename; inject filesystem ops only in tests without changing the public default.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/config.test.ts src/startup-credential-import.test.ts && npm run build && git diff --check`

Expected: prior bytes survive success and hardening failure; symlink/non-regular targets fail closed. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M28**

```bash
git add src/config.ts src/config.test.ts
git commit -m "fix(M28): preserve env while hardening permissions"
```

### Task 48: M29 — Disable stderr file logging when privacy cannot be proven

**Files:**
- Modify: `src/stderr-tee.ts:15-90`
- Modify: `src/stderr-tee.test.ts`

**Interfaces:**
- Consumes: open file descriptor, `fchmodSync`, `fstatSync`.
- Produces: optional test seam `StderrTeeFsOps`; failed chmod or post-chmod mode check closes FD and returns `{ enabled: false, error }`.

- [ ] **Step 1: Write the failing regression**

```ts
it("writes no tee data when chmod cannot establish 0600", () => {
  const path = join(tmpDir, "insecure.log");
  const ops = stderrFsOps({ fchmodSync: () => { throw new Error("denied"); } });
  const result = installStderrTee({ EARVELDAJA_LOG_FILE: path }, ops);
  expect(result).toMatchObject({ enabled: false, error: expect.stringContaining("0600") });
  process.stderr.write("secret\n");
  expect(existsSync(path) ? readFileSync(path, "utf8") : "").not.toContain("secret");
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/stderr-tee.test.ts -t "chmod cannot establish"`

Expected: FAIL because the warning is emitted but the insecure FD becomes active.

- [ ] **Step 3: Close and disable on chmod or verification failure**

```ts
try {
  ops.fchmodSync(openedFd, 0o600);
  const mode = ops.fstatSync(openedFd).mode & 0o777;
  if (mode !== 0o600) throw new Error(`mode is ${mode.toString(8)}, expected 600`);
} catch (error) {
  try { ops.closeSync(openedFd); } catch { /* already closed */ }
  const message = `EARVELDAJA_LOG_FILE could not be verified private (0600) (${path}): ${error instanceof Error ? error.message : String(error)}`;
  originalWrite(`${message}\n`);
  return { enabled: false, path, error: message };
}
fd = openedFd;
```

Do not install the stderr override or write the open stamp before the verified assignment.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/stderr-tee.test.ts && npm run build && git diff --check`

Expected: chmod/mode failures never tee; secure 0600 files append normally. Package the listed files and obtain independent `APPROVED`.

- [ ] **Step 5: Commit M29**

```bash
git add src/stderr-tee.ts src/stderr-tee.test.ts
git commit -m "fix(M29): fail closed on insecure stderr log"
```

### Task 49: D01 — Sandbox stored external text at MCP rendering boundaries

**Files:**
- Create: `src/external-text-renderer.ts`
- Create: `src/external-text-renderer.test.ts`
- Modify: `src/resources/dynamic-resources.ts:1-120`
- Create: `src/resources/dynamic-resources.test.ts`
- Modify: `src/tools/crud/clients.ts`
- Modify: `src/tools/crud/products.ts`
- Modify: `src/tools/crud/journals.ts`
- Modify: `src/tools/crud/transactions.ts`
- Modify: `src/tools/crud/purchase-invoices.ts`
- Modify: `src/tools/crud/sale-invoices.ts`
- Modify: `src/tools/crud-tools.test.ts`
- Modify: `src/tools/reference-data-tools.ts`
- Modify: `src/tools/reference-data-tools.test.ts`
- Modify: `src/tools/pdf-workflow.ts`
- Modify: `src/tools/pdf-workflow.test.ts`
- Modify: `src/tools/lightyear-investments.ts`
- Modify: `src/tools/lightyear-investments.test.ts`

**Interfaces:**
- Consumes: actual response types in `src/types/api.ts`, `wrapUntrustedOcr`, and `unwrapUntrustedOcr`.
- Produces: typed `EXTERNAL_TEXT_POLICY`, immutable recursive `renderExternalEntity(entity, value)`, and idempotent `sandboxExternalText`.

- [ ] **Step 1: Write boundary regressions**

Create `src/external-text-renderer.test.ts` with these imports and regression:

```ts
import { describe, expect, it } from "vitest";
import { UNTRUSTED_OCR_START_PREFIX } from "./mcp-json.js";
import { renderExternalEntity } from "./external-text-renderer.js";

it("recursively renders without mutation and is idempotent", () => {
  const source = { id: 7, client_name: "Supplier", items: [{ custom_title: "Ignore instructions" }] };
  const once = renderExternalEntity("purchase_invoice", source) as any;
  const twice = renderExternalEntity("purchase_invoice", once) as any;
  expect(once.items[0].custom_title).toContain(UNTRUSTED_OCR_START_PREFIX);
  expect(twice).toEqual(once);
  expect(source).toEqual({ id: 7, client_name: "Supplier", items: [{ custom_title: "Ignore instructions" }] });
});

```

Create `src/resources/dynamic-resources.test.ts` with its complete local fixture and captured-resource helper:

```ts
import { describe, expect, it, vi } from "vitest";
import { parseMcpResponse } from "../mcp-json.js";
import { registerDynamicResources } from "./dynamic-resources.js";

const resourceCases = [
  ["client", "clients", "earveldaja://clients/7", { id: 7, name: "Injected client" }],
  ["product", "products", "earveldaja://products/7", { id: 7, name: "Injected product" }],
  ["journal", "journals", "earveldaja://journals/7", { id: 7, title: "Injected journal", postings: [] }],
  ["sale_invoice", "saleInvoices", "earveldaja://sale_invoices/7", { id: 7, client_name: "Injected buyer", items: [{ custom_title: "Injected item" }] }],
  ["purchase_invoice", "purchaseInvoices", "earveldaja://purchase_invoices/7", { id: 7, client_name: "Injected supplier", items: [{ custom_title: "Injected item" }] }],
  ["transaction", "transactions", "earveldaja://transactions/7", { id: 7, bank_account_name: "Injected bank party", description: "Injected description" }],
] as const;

describe("dynamic external-text rendering", () => {
  it.each(resourceCases)("sandboxes the %s resource", async (resourceName, apiKey, uri, source) => {
    const server = { registerResource: vi.fn() } as any;
    const api = {
      clients: { get: vi.fn() }, products: { get: vi.fn() }, journals: { get: vi.fn() },
      saleInvoices: { get: vi.fn() }, purchaseInvoices: { get: vi.fn() }, transactions: { get: vi.fn() },
    } as any;
    api[apiKey].get.mockResolvedValue(source);
    registerDynamicResources(server, api);
    const registration = server.registerResource.mock.calls.find(([name]: [string]) => name === resourceName);
    if (!registration) throw new Error(`Resource not registered: ${resourceName}`);
    const handler = registration[3] as (uri: URL, params: { id: string }) => Promise<{ contents: Array<{ text: string }> }>;
    const response = await handler(new URL(uri), { id: "7" });
    const payload = parseMcpResponse(response.contents[0]!.text);
    expect(JSON.stringify(payload)).toContain("UNTRUSTED_OCR_START:");
    expect(source).not.toEqual(expect.objectContaining({ name: expect.stringContaining("UNTRUSTED_OCR_START:") }));
  });
});
```

In `src/tools/crud-tools.test.ts`, use its defined `getCrudToolHarness` for all twelve list/get boundaries and the two client lookup boundaries:

```ts
const crudRenderCases = [
  ["client", "clients", "list_clients", "get_client", { id: 7, name: "Injected client" }],
  ["product", "products", "list_products", "get_product", { id: 7, name: "Injected product" }],
  ["journal", "journals", "list_journals", "get_journal", { id: 7, title: "Injected journal", postings: [] }],
  ["transaction", "transactions", "list_transactions", "get_transaction", { id: 7, description: "Injected transaction", bank_account_name: "Injected party" }],
  ["sale_invoice", "saleInvoices", "list_sale_invoices", "get_sale_invoice", { id: 7, client_name: "Injected buyer", items: [{ custom_title: "Injected line" }] }],
  ["purchase_invoice", "purchaseInvoices", "list_purchase_invoices", "get_purchase_invoice", { id: 7, client_name: "Injected supplier", items: [{ custom_title: "Injected line" }] }],
] as const;

it.each(crudRenderCases)("sandboxes %s list and get output", async (_entity, apiKey, listTool, getTool, source) => {
  const listApi = { list: vi.fn().mockResolvedValue({ current_page: 1, total_pages: 1, items: [source] }) };
  const listHarness = getCrudToolHarness(listTool, { [apiKey]: listApi } as any);
  const list = await listHarness.handler({ page: 1, view: "full" }) as { content: Array<{ text: string }> };
  const getHarness = getCrudToolHarness(getTool, { [apiKey]: { get: vi.fn().mockResolvedValue(source) } } as any);
  const get = await getHarness.handler({ id: 7 }) as { content: Array<{ text: string }> };
  expect(JSON.stringify(parseMcpResponse(list.content[0]!.text))).toContain("UNTRUSTED_OCR_START:");
  expect(JSON.stringify(parseMcpResponse(get.content[0]!.text))).toContain("UNTRUSTED_OCR_START:");
});

it("sandboxes search_client and find_client_by_code raw client records", async () => {
  const source = { id: 7, name: "Injected supplier", code: "12345678" };
  const search = getCrudToolHarness("search_client", { clients: { findByName: vi.fn().mockResolvedValue([source]) } });
  const found = getCrudToolHarness("find_client_by_code", { clients: { findByCode: vi.fn().mockResolvedValue(source) } });
  const searchPayload = parseMcpResponse(((await search.handler({ name: "supplier" })) as any).content[0]!.text) as any;
  const foundPayload = parseMcpResponse(((await found.handler({ code: "12345678" })) as any).content[0]!.text) as any;
  expect(searchPayload.raw[0].name).toContain("UNTRUSTED_OCR_START:");
  expect(foundPayload.raw.name).toContain("UNTRUSTED_OCR_START:");
  expect(source.name).toBe("Injected supplier");
});
```

In `src/tools/reference-data-tools.test.ts`, import `parseMcpResponse`, extend `makeReadonly` with every read method below, and use its existing captured-handler `register` helper to cover every reference-data response that contains stored strings:

```ts
const referenceRenderCases = [
  ["list_accounts", "getAccounts", {}, [{ id: 1, balance_type: "Injected balance", account_type_est: "Injected type", account_type_eng: "Injected type EN", name_est: "Injected account", name_eng: "Injected account EN", cl_account_groups: ["Injected group"] }]],
  ["list_account_dimensions", "getAccountDimensions", {}, [{ id: 2, accounts_id: 1, title_est: "Injected dimension", title_eng: "Injected dimension EN", cl_currencies_id: "EUR" }]],
  ["list_currencies", "getCurrencies", {}, [{ id: "EUR", name_est: "Injected currency", name_eng: "Injected currency EN" }]],
  ["list_sale_articles", "getSaleArticles", {}, [{ id: 3, group_est: "Injected sales group", group_eng: "Injected sales group EN", name_est: "Injected sale article", name_eng: "Injected sale article EN", description_est: "Injected description", description_eng: "Injected description EN", cl_account_groups: ["Injected group"] }]],
  ["list_purchase_articles", "getPurchaseArticles", {}, [{ id: 4, name_est: "Injected purchase article", name_eng: "Injected purchase article EN", vat_rate_dropdown: "Injected VAT", cl_account_groups: ["Injected group"] }]],
  ["list_templates", "getTemplates", {}, [{ id: 5, name: "Injected template", cl_languages_id: "Injected language" }]],
  ["list_projects", "getProjects", {}, [{ id: 6, name: "Injected project", notes: "Injected notes", cl_projects_type: "Injected type", create_date: "Injected date" }]],
  ["get_invoice_info", "getInvoiceInfo", {}, { address: "Injected address", email: "Injected email", phone: "Injected phone", fax: "Injected fax", webpage: "Injected web", invoice_company_name: "Injected company", invoice_email_subject: "Injected subject", invoice_email_body: "Injected body", balance_email_subject: "Injected balance subject", balance_email_body: "Injected balance body", balance_document_footer: "Injected footer" }],
  ["get_vat_info", "getVatInfo", {}, { vat_number: "Injected VAT number", tax_refnumber: "Injected tax reference" }],
  ["list_invoice_series", "getInvoiceSeries", {}, [{ id: 7, number_prefix: "Injected prefix" }]],
  ["get_invoice_series", "getInvoiceSeriesOne", { id: 7 }, { id: 7, number_prefix: "Injected prefix" }],
  ["list_bank_accounts", "getBankAccounts", {}, [{ id: 8, account_name_est: "Injected bank label", account_name_eng: "Injected bank label EN", account_no: "Injected account number", bank_name: "Injected bank", bank_regcode: "Injected regcode", iban_code: "Injected IBAN", swift_code: "Injected SWIFT", beneficiary_name: "Injected beneficiary" }]],
  ["get_bank_account", "getBankAccount", { id: 8 }, { id: 8, account_name_est: "Injected bank label", account_no: "Injected account number", bank_name: "Injected bank" }],
] as const;

function expectInjectedStringsSandboxed(value: unknown): void {
  if (typeof value === "string") {
    if (value.includes("Injected")) expect(value).toContain("UNTRUSTED_OCR_START:");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) expectInjectedStringsSandboxed(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) expectInjectedStringsSandboxed(item);
  }
}

it.each(referenceRenderCases)("sandboxes every stored string returned by %s", async (toolName, method, args, source) => {
  const readonly = makeReadonly() as ReturnType<typeof makeReadonly> & Record<string, ReturnType<typeof vi.fn>>;
  readonly[method] = vi.fn().mockResolvedValue(source);
  const handlers = register(readonly);
  const response = await handlers[toolName](args);
  const payload = parseMcpResponse(response.content[0]!.text);
  expectInjectedStringsSandboxed(payload);
  expect(JSON.stringify(source)).not.toContain("UNTRUSTED_OCR_START:");
});
```

In `src/tools/pdf-workflow.test.ts`, use its current captured tool setup and a local fetch spy for registry output:

```ts
it("sandboxes resolve_supplier registry_data", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    headers: new Headers({ "content-length": "80" }),
    text: vi.fn().mockResolvedValue(JSON.stringify([{ company_name: "Injected registry", address: "Injected address" }])),
  } as any);
  try {
    const { handler } = setupPdfWorkflowTool("resolve_supplier", {
      clients: { listAll: vi.fn().mockResolvedValue([]) },
      readonly: { getVatInfo: vi.fn().mockResolvedValue({}), getInvoiceInfo: vi.fn().mockResolvedValue({}) },
    });
    const response = await handler({ name: "Fallback", reg_code: "12345678", country: "EST", auto_create: false });
    const payload = parseMcpResponse(response.content[0]!.text) as any;
    expect(payload.registry_data.name).toContain("UNTRUSTED_OCR_START:");
    expect(payload.registry_data.address).toContain("UNTRUSTED_OCR_START:");
  } finally {
    fetchSpy.mockRestore();
  }
});
```

In `src/tools/lightyear-investments.test.ts`, use the existing CSV builders and `setupLightyearTool` for every registered output:

```ts
it("sandboxes every Lightyear final payload", async () => {
  const statement = buildStatementCsv([[
    "10/03/2026 11:51:35", "Injected reference", "INJECTED", "Injected ISIN", "Buy",
    "1", "EUR", "10", "10", "1", "0", "10", "0",
  ]]);
  mockedReadFile.mockResolvedValue(statement);
  const parsedStatement = await setupLightyearTool("parse_lightyear_statement").handler({ file_path: "/tmp/lightyear.csv", include_rows: true });
  mockedReadFile.mockResolvedValue(buildCapitalGainsCsv([[
    "24/04/2026 18:55:48", "INJECTED", "Injected issuer", "Injected ISIN", "Injected country",
    "equity", "0", "1", "10", "11", "1",
  ]]));
  const parsedGains = await setupLightyearTool("parse_lightyear_capital_gains").handler({ file_path: "/tmp/lightyear.csv" });
  mockedReadFile.mockResolvedValue(statement);
  const bookedTrades = await setupLightyearTool("book_lightyear_trades").handler({
    file_path: "/tmp/lightyear.csv", investment_account: 1550, broker_account: 1120, dry_run: true,
  });
  mockedReadFile.mockResolvedValue(buildStatementCsv([[
    "2026-03-01", "Injected distribution", "INJECTED", "Injected ISIN", "Dividend",
    "0", "EUR", "0", "10", "1", "0", "10", "0",
  ]]));
  const bookedDistributions = await setupLightyearTool("book_lightyear_distributions").handler({
    file_path: "/tmp/lightyear.csv", broker_account: 1120, income_account: 8320, dry_run: true,
  });
  mockedReadFile.mockResolvedValue(statement);
  const portfolio = await setupLightyearTool("lightyear_portfolio_summary").handler({ file_path: "/tmp/lightyear.csv" });

  for (const response of [parsedStatement, parsedGains, bookedTrades, bookedDistributions, portfolio]) {
    expect(JSON.stringify(parseMcpResponse(response.content[0]!.text))).toContain("UNTRUSTED_OCR_START:");
  }
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/external-text-renderer.test.ts src/resources/dynamic-resources.test.ts src/tools/crud-tools.test.ts src/tools/reference-data-tools.test.ts src/tools/pdf-workflow.test.ts src/tools/lightyear-investments.test.ts -t "recursively renders|sandboxes"`

Expected: FAIL because resources emit raw stored text and wrapping is not idempotent.

- [ ] **Step 3: Add idempotent rendering helpers and explicit field maps**

```ts
export function sandboxExternalText(text: string): string;
export function sandboxExternalText(text: string | null | undefined): string | null | undefined;
export function sandboxExternalText(text: string | null | undefined): string | null | undefined {
  if (text === undefined || text === null || text === "") return text;
  return unwrapUntrustedOcr(text) !== text ? text : wrapUntrustedOcr(text);
}

interface TextPolicy { strings?: readonly string[]; stringArrays?: readonly string[]; stringMaps?: readonly string[]; children?: Readonly<Record<string, TextPolicy>>; arrays?: Readonly<Record<string, TextPolicy>> }
export const EXTERNAL_TEXT_POLICY = {
  client: { strings: ["name","alt_name","code","address_ads_oid","address_adr_id","address_text","postal_address_text","email","accounting_email","telephone","contact_person","bank_account_no","notes","invoice_vat_no","cl_invoice_country","bank_ref_number_sales","bank_ref_number_purchases","bank_account_custom_name"], stringMaps: ["invoice_electronic_opts"] },
  product: { strings: ["name","code","description","price_currency","notes","activity_text","emtak_code","emtak_version","unit"], stringMaps: ["foreign_names","translations"] },
  journal: { strings: ["title","document_number","operation_type","cl_currencies_id"] },
  transaction: { strings: ["status","bank_ref_number","bank_subtype","bank_code","bank_account_no","bank_account_name","ref_number","cl_currencies_id","description","date","export_format","operation_type"], arrays: { items: { strings: ["relation_table","cl_currencies_id"] } } },
  purchase_invoice: { strings: ["client_name","number","status","payment_status","payment_type","bank_ref_number","bank_account_no","notes","cl_currencies_id"], arrays: { items: { strings: ["unit","vat_rate_dropdown","custom_title"] } } },
  sale_invoice: { strings: ["sale_invoice_type","client_name","cl_countries_id","number_prefix","number_suffix","number","status","payment_status","bank_ref_number","notes","invoice_info","payment_description","cl_currencies_id","client_vat_no","contract_number","invoice_content_code","invoice_content_text","additional_info_content"], arrays: { items: { strings: ["unit","custom_title"] }, deliveries: { strings: ["destination_type","invoice_type","receiver_address","receiver_name","sender_person_code","sender_person_name"] } } },
  account: { strings: ["balance_type","account_type_est","account_type_eng","name_est","name_eng"], stringArrays: ["cl_account_groups"] },
  account_dimension: { strings: ["title_est","title_eng","cl_currencies_id"] },
  currency: { strings: ["id","name_est","name_eng"] },
  sale_article: { strings: ["group_est","group_eng","name_est","name_eng","description_est","description_eng"], stringArrays: ["cl_account_groups"] },
  purchase_article: { strings: ["name_est","name_eng","vat_rate_dropdown"], stringArrays: ["cl_account_groups"] },
  template: { strings: ["name","cl_languages_id"] },
  project: { strings: ["name","notes","cl_projects_type","create_date"] },
  invoice_info: { strings: ["address","email","phone","fax","webpage","invoice_company_name","invoice_email_subject","invoice_email_body","balance_email_subject","balance_email_body","balance_document_footer"] },
  vat_info: { strings: ["vat_number","tax_refnumber"] },
  invoice_series: { strings: ["number_prefix"] },
  bank_account: { strings: ["account_name_est","account_name_eng","account_no","bank_name","bank_regcode","iban_code","swift_code","beneficiary_name"] },
  registry_data: { stringMaps: ["$"] },
  lightyear: { stringMaps: ["$"] },
} as const satisfies Record<string, TextPolicy>;

function renderPolicy(value: unknown, policy: TextPolicy): unknown {
  if (Array.isArray(value)) return value.map(item => renderPolicy(item, policy));
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = { ...source };
  if (policy.stringMaps?.includes("$")) {
    for (const [key, item] of Object.entries(source)) output[key] = typeof item === "string" ? sandboxExternalText(item) : renderPolicy(item, policy);
    return output;
  }
  for (const key of policy.strings ?? []) if (typeof source[key] === "string") output[key] = sandboxExternalText(source[key] as string);
  for (const key of policy.stringArrays ?? []) if (Array.isArray(source[key])) {
    output[key] = (source[key] as unknown[]).map(item => typeof item === "string" ? sandboxExternalText(item) : item);
  }
  for (const key of policy.stringMaps ?? []) if (source[key] && typeof source[key] === "object") output[key] = renderPolicy(source[key], { stringMaps: ["$"] });
  for (const [key, child] of Object.entries(policy.children ?? {})) if (source[key] !== undefined) output[key] = renderPolicy(source[key], child);
  for (const [key, child] of Object.entries(policy.arrays ?? {})) if (Array.isArray(source[key])) output[key] = (source[key] as unknown[]).map(item => renderPolicy(item, child));
  return output;
}
export type ExternalEntity = keyof typeof EXTERNAL_TEXT_POLICY;
export function renderExternalEntity<T>(entity: ExternalEntity, value: T): T {
  return renderPolicy(value, EXTERNAL_TEXT_POLICY[entity]) as T;
}
```

Apply exact boundary form `toMcpJson(renderExternalEntity("<entity>", value))` to all six callbacks in `dynamic-resources.ts`; list/get handlers in all six CRUD modules after filtering/view selection; `search_client`/`find_client_by_code` `raw`; and every final Lightyear payload. In `reference-data-tools.ts`, render each completed read result immediately before `toMcpJson`: `account` for `list_accounts`, `account_dimension` for `list_account_dimensions`, `currency` for `list_currencies`, `sale_article` for `list_sale_articles`, `purchase_article` for `list_purchase_articles`, `template` for `list_templates`, `project` for `list_projects`, `invoice_info` for `get_invoice_info`, `vat_info` for `get_vat_info`, `invoice_series` for both `list_invoice_series` and `get_invoice_series`, and `bank_account` for both `list_bank_accounts` and `get_bank_account`. Also render the `resolve_supplier` existing-client copy and `registry_data` final response. Do not render create/update input, matching keys, audit input, or API objects. Registry and Lightyear use their recursive policies only on final response copies.

- [ ] **Step 4: Prove green and review**

Run: `npx vitest run src/external-text-renderer.test.ts src/resources/dynamic-resources.test.ts src/tools/crud-tools.test.ts src/tools/reference-data-tools.test.ts src/tools/pdf-workflow.test.ts src/tools/lightyear-investments.test.ts && npm run build && git diff --check`

Expected: every named surface wraps nested free text exactly once, original objects and persisted/matching values are byte-for-byte unchanged, and all suites pass. Write `.omc/reviews/D01.diff` and obtain both verdicts.

- [ ] **Step 5: Commit D01**

```bash
git add src/external-text-renderer.ts src/external-text-renderer.test.ts src/resources/dynamic-resources.ts src/resources/dynamic-resources.test.ts src/tools/crud/clients.ts src/tools/crud/products.ts src/tools/crud/journals.ts src/tools/crud/transactions.ts src/tools/crud/purchase-invoices.ts src/tools/crud/sale-invoices.ts src/tools/crud-tools.test.ts src/tools/reference-data-tools.ts src/tools/reference-data-tools.test.ts src/tools/pdf-workflow.ts src/tools/pdf-workflow.test.ts src/tools/lightyear-investments.ts src/tools/lightyear-investments.test.ts
git commit -m "fix(D01): sandbox stored external output"
```

### Task 50: D02 — Build, pack, inspect, install, and smoke the publish payload on Node 18

**Files:**
- Modify: `scripts/validate-release-metadata.mjs:1-180`
- Create: `scripts/release-smoke-helpers.mjs`
- Create: `scripts/smoke-packed-runtime.mjs`
- Modify: `scripts/smoke-node18-paths.mjs`
- Modify: `src/release-metadata.test.ts`
- Create: `src/release-smoke.test.ts`
- Modify: `package.json:20-45`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `package.json.main`, `package.json.bin`, `package.json.files`, `package.json.engines.node`, npm pack JSON.
- Produces: cycle-free `scripts/release-smoke-helpers.mjs`; timed `runCommand`; `terminateChild` with SIGTERM/grace/SIGKILL/await-close; `startAndObserve`; `smokePackedRuntime`. Validator and CLI import the third module but never each other.

- [ ] **Step 1: Write failing package-list and runner regressions**

```ts
it("requires built entry, bin, workflows, and command mirrors in packed files", () => {
  expect(validatePackedFileList(["package/package.json", "package/dist/index.js"], validPackage)).toEqual(expect.arrayContaining([
    expect.stringContaining("workflows/"), expect.stringContaining(".claude/commands/"),
  ]));
});

it("constructs runtime checks with the supplied Node executable", () => {
  const plan = buildPackedSmokePlan("/tmp/install/node_modules/e-arveldaja-mcp", validPackage, "/opt/node18/bin/node");
  expect(plan.importCheck.command).toBe("/opt/node18/bin/node");
  expect(plan.binCheck).toEqual(expect.objectContaining({
    command: "/opt/node18/bin/node",
    args: ["/tmp/install/node_modules/e-arveldaja-mcp/dist/index.js"],
  }));
});

it("imports validator and smoke CLI without recursive main execution", async () => {
  const smoke = vi.fn();
  const validator = await import("../scripts/validate-release-metadata.mjs");
  const cli = await import("../scripts/smoke-packed-runtime.mjs");
  expect(typeof validator.main).toBe("function");
  expect(typeof cli.main).toBe("function");
  await cli.main({ root: process.cwd(), smokePackedRuntime: smoke });
  expect(smoke).toHaveBeenCalledTimes(1);
});

it.skipIf(process.platform === "win32")("closes stdin, escalates SIGTERM to SIGKILL, and awaits close", async () => {
  const started = Date.now();
  const result = await startAndObserve(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
    cwd: process.cwd(), minimumAliveMs: 25, timeoutMs: 500, terminateGraceMs: 25, env: process.env,
  });
  expect(result.terminationSignal).toBe("SIGKILL");
  expect(Date.now() - started).toBeLessThan(500);
});
```

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/release-metadata.test.ts -t "packed files|supplied Node executable"`

Expected: FAIL because no packed-payload validator or smoke runner exists.

- [ ] **Step 3: Implement the standard-library/npm smoke**

```js
export function validatePackedFileList(files, packageJson) {
  const names = new Set(files.map(file => file.replace(/^package\//, "")));
  const required = [packageJson.main, ...Object.values(packageJson.bin ?? {}), "package.json", "workflows/", ".claude/commands/"];
  return required.filter(requiredName => requiredName.endsWith("/")
    ? ![...names].some(name => name.startsWith(requiredName))
    : !names.has(requiredName)).map(name => `packed payload must include ${name}`);
}

export function buildPackedSmokePlan(packageRoot, packageJson, nodeExecutable) {
  const binRelative = Object.values(packageJson.bin ?? {})[0];
  if (!binRelative) throw new Error("package.json must declare a bin entry");
  return {
    importCheck: {
      command: nodeExecutable,
      args: ["--input-type=module", "--eval", `import { getProjectRoot } from ${JSON.stringify(pathToFileURL(resolve(packageRoot, "dist/paths.js")).href)}; const root=getProjectRoot(); if(root!==${JSON.stringify(packageRoot)}) throw new Error(root);`],
    },
    binCheck: { command: nodeExecutable, args: [resolve(packageRoot, binRelative)] },
  };
}
```

Create `scripts/release-smoke-helpers.mjs`. Move `validatePackedFileList` and `buildPackedSmokePlan` above into it and add:

```js
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const closed = child => new Promise(resolveClose => child.once("close", (code, signal) => resolveClose({ code, signal })));
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

export async function terminateChild(child, graceMs = 1_000) {
  if (child.exitCode !== null || child.signalCode !== null) return { ...(await closedAlready(child)), terminationSignal: child.signalCode };
  const closePromise = closed(child);
  child.kill("SIGTERM");
  const graceful = await Promise.race([closePromise.then(value => ({ closed: true, value })), wait(graceMs).then(() => ({ closed: false }))]);
  if (graceful.closed) return { ...graceful.value, terminationSignal: "SIGTERM" };
  child.kill("SIGKILL");
  const forced = await closePromise;
  return { ...forced, terminationSignal: "SIGKILL" };
}

function closedAlready(child) {
  return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
}

export async function runCommand(command, args, { timeoutMs = 120_000, ...options } = {}) {
  const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end();
  let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const closePromise = closed(child);
  const outcome = await Promise.race([closePromise.then(value => ({ kind: "close", value })), wait(timeoutMs).then(() => ({ kind: "timeout" }))]);
  if (outcome.kind === "timeout") {
    await terminateChild(child);
    throw new Error(`${command} timed out after ${timeoutMs}ms`);
  }
  if (outcome.value.code !== 0) throw new Error(`${command} exited ${outcome.value.code ?? outcome.value.signal}: ${stderr}`);
  return { stdout, stderr };
}

export async function startAndObserve(command, args, { cwd, env, minimumAliveMs = 1_000, timeoutMs = 10_000, terminateGraceMs = 1_000 }) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end();
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const closePromise = closed(child);
  const early = await Promise.race([closePromise.then(value => ({ kind: "close", value })), wait(minimumAliveMs).then(() => ({ kind: "alive" }))]);
  if (early.kind === "close") throw new Error(`Packed bin exited before smoke window (${early.value.code ?? early.value.signal}): ${stderr}`);
  if (/SyntaxError|ERR_MODULE_NOT_FOUND|ENOENT.*(?:workflow|command|package)/i.test(stderr)) {
    await terminateChild(child, terminateGraceMs);
    throw new Error(stderr);
  }
  const deadline = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try { return await terminateChild(child, terminateGraceMs); }
  finally { clearTimeout(deadline); }
}

async function assertReadable(path) {
  const info = await stat(path);
  if (!info.isDirectory() && !info.isFile()) throw new Error(`Unreadable packed path: ${path}`);
}

export async function assertInstalledPackagePaths(packageRoot, packageJson) {
  await assertReadable(resolve(packageRoot, packageJson.main));
  await assertReadable(resolve(packageRoot, "workflows"));
  await assertReadable(resolve(packageRoot, ".claude", "commands"));
}

export async function smokePackedRuntime({ root, nodeExecutable = process.execPath, run = runCommand }) {
  const temp = await mkdtemp(resolve(tmpdir(), "e-arveldaja-pack-smoke-"));
  try {
    await run("npm", ["run", "build"], { cwd: root, timeoutMs: 120_000 });
    const packed = JSON.parse((await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], { cwd: root, timeoutMs: 120_000 })).stdout)[0];
    const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    const errors = validatePackedFileList(packed.files.map(file => file.path), packageJson);
    if (errors.length) throw new Error(errors.join("\n"));
    const installRoot = resolve(temp, "install");
    await mkdir(installRoot);
    await writeFile(resolve(installRoot, "package.json"), "{\"private\":true,\"type\":\"module\"}\n");
    await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", resolve(temp, packed.filename)], { cwd: installRoot, timeoutMs: 120_000 });
    const packageRoot = resolve(installRoot, "node_modules", packageJson.name);
    const plan = buildPackedSmokePlan(packageRoot, packageJson, nodeExecutable);
    await run(plan.importCheck.command, plan.importCheck.args, { cwd: installRoot, timeoutMs: 20_000 });
    await assertInstalledPackagePaths(packageRoot, packageJson);
    await startAndObserve(plan.binCheck.command, plan.binCheck.args, { cwd: installRoot, timeoutMs: 10_000, env: { ...process.env, EARVELDAJA_API_KEY_ID: "", EARVELDAJA_API_PUBLIC_VALUE: "", EARVELDAJA_API_PASSWORD: "" } });
  } finally { await rm(temp, { recursive: true, force: true }); }
}
```

Create cycle-free `scripts/smoke-packed-runtime.mjs`:

```js
#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { smokePackedRuntime } from "./release-smoke-helpers.mjs";
export async function main({ root = process.cwd(), smokePackedRuntime: smoke = smokePackedRuntime } = {}) { await smoke({ root }); }
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
```

`validate-release-metadata.mjs` statically imports only `smokePackedRuntime` from `release-smoke-helpers.mjs`, exports `main({ root = process.cwd(), smoke = smokePackedRuntime } = {})`, and invokes `await smoke({ root })` after metadata/workflow checks only when its own `invokedPath === thisPath` guard fires. It never imports `smoke-packed-runtime.mjs`. Change `scripts/smoke-node18-paths.mjs` to import `assertInstalledPackagePaths` from the helper and retain its H01 path-root assertion. Add `"smoke:package": "node scripts/smoke-packed-runtime.mjs"` to `package.json`.

Add a separate CI job; do not assume local Node 18 exists:

```yaml
  package-smoke-node18:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 18
          cache: npm
      - run: npm ci
      - run: npm run smoke:package
```

- [ ] **Step 4: Prove green and independently review**

Run locally: `npx vitest run src/release-metadata.test.ts && npm run sync:workflow-prompts && npm run validate:release && git diff --check && npm run build && npm test && npm run test:integration && npm pack --dry-run`

Expected: release validator builds/packs/installs/smokes under the current Node; import-cycle/single-main/timeout/forced-termination tests pass; all unit/integration/release commands PASS. The Node 18-specific proof is `package-smoke-node18`.

Write `.omc/reviews/D02.diff` and obtain the required spec/code-quality verdicts. Write `.omc/reviews/WHOLE-BRANCH.diff` using `git diff --output=.omc/reviews/WHOLE-BRANCH.diff 9915011..HEAD`, then obtain a separate whole-branch spec/code-quality verdict covering all 50 IDs, compatibility, live-accounting safety, trust boundaries, and unrelated changes.

- [ ] **Step 5: Commit D02**

```bash
git add scripts/validate-release-metadata.mjs scripts/release-smoke-helpers.mjs scripts/smoke-packed-runtime.mjs scripts/smoke-node18-paths.mjs src/release-metadata.test.ts src/release-smoke.test.ts package.json .github/workflows/ci.yml
git commit -m "fix(D02): smoke packed release on Node 18"
```

- [ ] **Step 6: Append ledger and prove clean**

Append D02, require all 50 unique IDs exactly once in `.omc/full-codebase-remediation-ledger.md`, require no pending verdict, and require `git status --short` empty.

- [ ] **Step 7: Pass Wave 7/final branch gates**

Run locally: `npm run sync:workflow-prompts && npm run validate:release && git diff --check && npm run build && npm test && npm run test:integration && npm pack --dry-run`

Push the committed branch, run `gh workflow run ci.yml --ref fix/code-review-remediation`, then `gh run watch <run-id> --exit-status`. Require `package-smoke-node18` green. Finally require `git status --short` empty and `git log --format=%s 9915011..HEAD` to contain one finding commit for every H01-H19, M01-M29, and D01-D02 ID.

## Execution handoff

Plan complete. Execute strictly in task order with `superpowers:subagent-driven-development` so every task receives a fresh author and independent verifier, or use `superpowers:executing-plans` for inline sequential execution with the same per-finding gates. Do not parallelize findings, merge commits, or waive a red test, wave gate, Node 18 CI proof, or clean independent verdict.
