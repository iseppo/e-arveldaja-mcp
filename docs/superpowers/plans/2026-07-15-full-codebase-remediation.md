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
- Modify: `src/tools/receipt-inbox.ts:1-15,1777-2205`
- Test: `src/tools/receipt-inbox-tools.test.ts`

**Exact scope:** this finding changes exactly the two paths above. Do not change `src/api/purchase-invoices.ts`, `src/mutation-outcome.ts`, `src/workflow-response.ts`, audit infrastructure, fixtures, or any other source/test file.

**Interfaces:**
- Test code imports `MutationIndeterminateError`; production code imports `isMutationIndeterminate` from `../mutation-outcome.js`. Raw `HttpError.status === "network"` is the other ambiguous shape.
- Production defines a local `PartialClassificationMutation`; no shared public type is added for this finding.
- A proven-created invoice whose transaction reread, required invoice invalidation, invoice confirmation, or transaction confirmation does not complete is emitted in `partial_mutations`. The granular result, its `execution.errors` entry, and `classify_bank_transactions.result` carry the same object equality-equivalent through the existing `remapHiddenGranularWorkflowResult` spread.
- `mutation_may_have_occurred` is always `true` in this envelope because purchase-invoice creation is already proven, even when the later failure itself is a definite rejection.
- Category is `mutation_indeterminate` only when `isMutationIndeterminate(error)` is true or the thrown value is a raw network `HttpError`; all other thrown values, including HTTP 422/503 responses, are `mutation_failed`.
- Statuses are evidence-based. The create response contributes `PROJECT` or `CONFIRMED` only when it says exactly that, otherwise `UNKNOWN`. A failed transaction reread makes transaction status `UNKNOWN`. A successful reread can prove transaction `PROJECT`, `CONFIRMED`, or `VOID` only when `is_deleted !== true`; any deleted transaction maps to `UNKNOWN` regardless of its raw status field, and every other status also maps to `UNKNOWN`. Failed ambiguous invoice invalidation makes invoice status `UNKNOWN`, while definite invalidation rejection preserves the observed create-response status. An ambiguous invoice confirmation makes invoice status `UNKNOWN`; a definite rejection preserves the pre-confirm create-response status. A proven successful invoice confirmation changes invoice status to `CONFIRMED`. An ambiguous transaction confirmation makes transaction status `UNKNOWN`; a definite rejection retains the last proven transaction status `PROJECT`.
- The created ID is appended immediately and once after `invoice.id` is proven. A later thrown named stage never erases it, invalidates it, retries creation, rereads speculatively, or repeats a confirmation.
- The only automatic invalidation retained is the existing safe branch where a successful post-create reread proves the transaction is no longer `PROJECT`. A successful invalidation removes that current invoice ID from the live-ID result and emits no partial. A failed invalidation keeps the ID, preserves the existing rollback-failure note, and emits an `invoice_invalidation` partial with the original thrown value classified normally.
- Any group containing `partial_mutations` is `failed`, even if a later transaction succeeds. Successfully linked transaction IDs and created invoice IDs remain reported.

**Deliberate exclusions:** a create response without `invoice.id` is outside H14 because no created identity has been proven at this handler boundary; API-level create ambiguity/idempotency requires a separate design. Audit logging is also outside H14 because `logAudit` catches its own persistence errors and is not one of the three named mutation stages. Tests must always prove a concrete created ID and must not add missing-ID or audit-failure behavior.

- [ ] **Step 1: Record the clean gate and the proven-stale baseline**

Run:

```bash
git status --short
npx vitest run src/tools/receipt-inbox-tools.test.ts -t "reports failed when a draft invoice is invalidated after stale transaction detection|reports a group as failed when only part of it executes"
```

Expected: clean worktree; both existing tests pass. Preserve their safe behavior: a successful reread of `VOID` causes exactly one invalidation, no confirmation, a failed group, and no live created invoice ID after successful invalidation.

- [ ] **Step 2: Add exact H14 test imports and a compact scenario fixture**

In `src/tools/receipt-inbox-tools.test.ts`, add the exact import:

```ts
import { MutationIndeterminateError } from "../mutation-outcome.js";
```

Near `setupReceiptTool`, add one fixture builder using the existing `getImpl`, `clients`, `purchaseInvoices`, `purchaseInvoiceDetails`, `purchaseArticles`, and `accounts` option shapes. Keep the actual registered handler/API return shape `{ handler, api }`:

```ts
const H14_TX = {
  id: 99, status: "PROJECT", is_deleted: false, type: "C", amount: 25,
  date: "2026-03-22", accounts_dimensions_id: 100, bank_account_name: "OpenAI",
  description: "Subscription", cl_currencies_id: "EUR", clients_id: 7,
};

const H14_CLASSIFICATION = {
  category: "saas_subscriptions", apply_mode: "purchase_invoice",
  normalized_counterparty: "openai", display_counterparty: "OpenAI",
  recurring: true, similar_amounts: true, total_amount: 25,
  suggested_booking: {
    purchase_article_id: 501, purchase_article_name: "Software",
    purchase_account_id: 5230, purchase_account_name: "Software",
    liability_account_id: 2310, reason: "Recurring SaaS",
  },
  reasons: ["keyword"], transactions: [H14_TX],
};

const H14_INVOICE = {
  id: 701, status: "PROJECT", number: "AUTO-TX-99", clients_id: 7,
  client_name: "OpenAI Ireland Limited", create_date: "2026-03-22",
  journal_date: "2026-03-22", term_days: 0, cl_currencies_id: "EUR", items: [],
};

function setupH14Tool(toolName: "apply_transaction_classifications" | "classify_bank_transactions") {
  const setup = setupReceiptTool(toolName, {
    getImpl: vi.fn().mockImplementation(async (id: number) =>
      id === 100 ? { ...H14_TX, id: 100, date: "2026-03-23" } : H14_TX),
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
  setup.api.purchaseInvoices.createAndSetTotals.mockResolvedValue(H14_INVOICE);
  return setup;
}

function h14StructuredAmbiguity(
  stage: "transaction_reread" | "invoice_invalidation" | "invoice_confirmation" | "transaction_confirmation",
) {
  const entity = stage === "invoice_invalidation" || stage === "invoice_confirmation"
    ? "purchase_invoice"
    : "transaction";
  const id = entity === "purchase_invoice" ? 701 : 99;
  return new MutationIndeterminateError({
    operation: stage === "transaction_reread"
      ? "update"
      : stage === "invoice_invalidation"
        ? "invalidate"
        : "confirm",
    entity, entityId: id, businessKey: `${entity}:${id}`,
    affectedCaches: entity === "purchase_invoice"
      ? ["/purchase_invoices"] : ["/transactions", "/journals"],
    cause: new HttpError(
      "response lost",
      "network",
      "PATCH",
      `/${entity}/${id}/${stage === "invoice_invalidation" ? "invalidate" : "register"}`,
    ),
    nextAction: "Fresh read required.",
  });
}
```

- [ ] **Step 3: RED-A — cover raw, structural, and definite failure at every post-create stage**

Add a table-driven suite named exactly `H14 post-create recovery state`. Each row configures only the named mock, calls the granular handler with `{ classifications_json: [H14_CLASSIFICATION], execute: true }`, and asserts one exact partial plus exact mutation counts:

| exact tagged case | create status | thrown value | stage | category | invoice status | transaction status | get/create/invoice-confirm/transaction-confirm |
|---|---|---|---|---|---|---|---|
| `H14 reread raw network` | `PROJECT` | network `HttpError` on second `get` | `transaction_reread` | `mutation_indeterminate` | `PROJECT` | `UNKNOWN` | `2/1/0/0` |
| `H14 reread H03 structural` | `CONFIRMED` | `h14StructuredAmbiguity("transaction_reread")` | `transaction_reread` | `mutation_indeterminate` | `CONFIRMED` | `UNKNOWN` | `2/1/0/0` |
| `H14 reread definite response` | `DRAFT` | HTTP 503 `HttpError` | `transaction_reread` | `mutation_failed` | `UNKNOWN` | `UNKNOWN` | `2/1/0/0` |
| `H14 invoice confirm raw network` | `PROJECT` | network `HttpError` | `invoice_confirmation` | `mutation_indeterminate` | `UNKNOWN` | `PROJECT` | `2/1/1/0` |
| `H14 invoice confirm H03 structural` | `PROJECT` | `h14StructuredAmbiguity("invoice_confirmation")` | `invoice_confirmation` | `mutation_indeterminate` | `UNKNOWN` | `PROJECT` | `2/1/1/0` |
| `H14 invoice confirm definite PROJECT` | `PROJECT` | HTTP 422 `HttpError` | `invoice_confirmation` | `mutation_failed` | `PROJECT` | `PROJECT` | `2/1/1/0` |
| `H14 invoice confirm definite CONFIRMED` | `CONFIRMED` | ordinary `Error` | `invoice_confirmation` | `mutation_failed` | `CONFIRMED` | `PROJECT` | `2/1/1/0` |
| `H14 transaction confirm raw network` | `PROJECT` | network `HttpError` | `transaction_confirmation` | `mutation_indeterminate` | `CONFIRMED` | `UNKNOWN` | `2/1/1/1` |
| `H14 transaction confirm H03 structural` | `PROJECT` | `h14StructuredAmbiguity("transaction_confirmation")` | `transaction_confirmation` | `mutation_indeterminate` | `CONFIRMED` | `UNKNOWN` | `2/1/1/1` |
| `H14 transaction confirm definite` | `PROJECT` | HTTP 422 `HttpError` | `transaction_confirmation` | `mutation_failed` | `CONFIRMED` | `PROJECT` | `2/1/1/1` |

For the three reread rows, set `api.transactions.get` to resolve the initial `H14_TX` and then reject. For confirmation rows, keep both `get` calls successful and reject exactly the relevant confirmation mock once. Override the create mock per row with `{ ...H14_INVOICE, status: createStatus }`. Use a network error shaped as `new HttpError("response lost", "network", method, path)` and definite HTTP errors with numeric status.

Use these exact common assertions for every row:

```ts
expect(payload.summary).toMatchObject({ applied: 0, failed: 1 });
expect(payload.results[0]).toMatchObject({
  status: "failed",
  created_invoice_ids: [701],
  linked_transaction_ids: [],
  partial_mutations: [{
    category: expectedCategory,
    mutation_may_have_occurred: true,
    failed_stage: expectedStage,
    created_invoice_id: 701,
    created_invoice_status: expectedInvoiceStatus,
    attempted_transaction_id: 99,
    transaction_status: expectedTransactionStatus,
    next_action: expect.stringContaining("purchase invoice 701"),
  }],
});
const nextAction = payload.results[0].partial_mutations[0].next_action;
expect(nextAction).toContain("explicit approval");
expect(nextAction).not.toMatch(/create another|invalidate|retry/i);
expect(api.purchaseInvoices.invalidate).not.toHaveBeenCalled();
expect(api.purchaseInvoices.createAndSetTotals).toHaveBeenCalledTimes(1);
expect(api.transactions.get).toHaveBeenCalledTimes(expectedGetCalls);
expect(api.purchaseInvoices.confirmWithTotals).toHaveBeenCalledTimes(expectedInvoiceConfirmCalls);
expect(api.transactions.confirm).toHaveBeenCalledTimes(expectedTransactionConfirmCalls);
expect(payload.execution.errors[0].partial_mutations).toEqual(
  payload.results[0].partial_mutations,
);
```

Run:

```bash
npx vitest run src/tools/receipt-inbox-tools.test.ts -t "H14 post-create recovery state"
```

Expected: FAIL with missing `partial_mutations`/created IDs. Current reread errors reach the outer group catch without recovery state, while confirmation errors invalidate the proven-created invoice. The exact counts make this an honest RED for one create, no retry, and no invalidation.

- [ ] **Step 4: RED-B — cover merged propagation, accumulator durability, partial success, and invalidation recovery**

Add these tests with the exact tagged names:

1. `H14 merged wrapper preserves granular partial mutations unchanged`: inject structural transaction-confirm ambiguity through `classify_bank_transactions` with `mode: "execute_apply"`; assert the exact expected partial in `payload.result.results[0].partial_mutations`, including category, boolean, IDs, statuses, stage, and safe `next_action`. Assert it also equals `payload.result.execution.errors[0].partial_mutations`. Do not modify the merged wrapper.
2. `H14 later group error does not erase an earlier partial mutation`: one group contains transactions 99 and 100. Invoice 701 gets ambiguous invoice confirmation, then the second `createAndSetTotals` throws `new Error("second create rejected")`. Assert the failed group retains `created_invoice_ids: [701]`, one 701 partial, no linked IDs, both the safe continuation and later create-rejection notes, two create calls, one invoice-confirm call, zero transaction-confirm calls, and zero invalidations.
3. `H14 multi-transaction partial plus success preserves both outcomes`: one group contains 99 and 100. Invoice 701 gets ambiguous invoice confirmation; invoice 702 then confirms and links transaction 100. Assert group/summary failed, `created_invoice_ids: [701, 702]`, `linked_transaction_ids: [100]`, exactly one partial for 701, and the existing note that transaction 100 was booked and left in place. Assert two creates, two invoice-confirm calls, one transaction-confirm call, four transaction reads, and zero invalidations.
4. `H14 partial state is isolated across multiple groups`: use two one-transaction groups. Group 99 gets ambiguous transaction confirmation for invoice 701; group 100 succeeds with 702. Assert summary `{ applied: 1, failed: 1 }`, no cross-group IDs/partials, exactly two creates, two invoice confirmations, two transaction confirmations, and zero invalidations.
5. Add a table suite named exactly `H14 failed stale invalidation retains partial recovery state`. Every row makes the initial transaction read return `H14_TX`, the one post-create reread return the listed non-bookable transaction, and `api.purchaseInvoices.invalidate(701)` reject once:

| exact tagged case | fresh transaction | create status | invalidation error | note fragment | category | invoice status | transaction status |
|---|---|---|---|---|---|---|---|
| `H14 invalidation definite HTTP rejection` | `{ ...H14_TX, status: "VOID" }` | `CONFIRMED` | `new HttpError("invalidation rejected", 422, "PATCH", "/purchase_invoices/701/invalidate")` | `invalidation rejected` | `mutation_failed` | `CONFIRMED` | `VOID` |
| `H14 invalidation raw network` | `{ ...H14_TX, status: "VOID" }` | `PROJECT` | `new HttpError("response lost", "network", "PATCH", "/purchase_invoices/701/invalidate")` | `response lost` | `mutation_indeterminate` | `UNKNOWN` | `VOID` |
| `H14 invalidation H03 structural` | `{ ...H14_TX, status: "VOID" }` | `PROJECT` | `h14StructuredAmbiguity("invoice_invalidation")` | `is indeterminate` | `mutation_indeterminate` | `UNKNOWN` | `VOID` |
| `H14 invalidation definite deleted transaction` | `{ ...H14_TX, status: "PROJECT", is_deleted: true }` | `PROJECT` | `new Error("invalidation rejected for deleted transaction")` | `invalidation rejected for deleted transaction` | `mutation_failed` | `PROJECT` | `UNKNOWN` |

For every row assert group/summary failed, `created_invoice_ids: [701]`, `linked_transaction_ids: []`, and exactly one partial:

```ts
expect(payload.results[0]).toMatchObject({
  status: "failed",
  created_invoice_ids: [701],
  linked_transaction_ids: [],
  partial_mutations: [{
    category: expectedCategory,
    mutation_may_have_occurred: true,
    failed_stage: "invoice_invalidation",
    created_invoice_id: 701,
    created_invoice_status: expectedInvoiceStatus,
    attempted_transaction_id: 99,
    transaction_status: expectedTransactionStatus,
    next_action: expect.stringContaining("Freshly read existing purchase invoice 701"),
  }],
});
const nextAction = payload.results[0].partial_mutations[0].next_action;
expect(nextAction).toContain("explicit approval");
expect(nextAction).not.toMatch(/create another|invalidate|retry/i);
expect(payload.results[0].notes).toEqual(expect.arrayContaining([
  expect.stringContaining(
    `Auto-created purchase invoice 701 could not be kept because transaction 99 is no longer bookable (status ${freshTransaction.status}), and invalidation also failed:`,
  ),
]));
expect(payload.results[0].notes.join("\n")).toContain(expectedErrorNote);
expect(api.transactions.get).toHaveBeenCalledTimes(2); // initial read + one post-create reread
expect(api.transactions.get).toHaveBeenNthCalledWith(1, 99);
expect(api.transactions.get).toHaveBeenNthCalledWith(2, 99);
expect(api.purchaseInvoices.createAndSetTotals).toHaveBeenCalledTimes(1);
expect(api.purchaseInvoices.invalidate).toHaveBeenCalledTimes(1);
expect(api.purchaseInvoices.invalidate).toHaveBeenCalledWith(701);
expect(api.purchaseInvoices.confirmWithTotals).not.toHaveBeenCalled();
expect(api.transactions.confirm).not.toHaveBeenCalled();
```

Use `const tx100 = { ...H14_TX, id: 100, date: "2026-03-23" }` and `const group100 = { ...H14_CLASSIFICATION, normalized_counterparty: "openai-two", transactions: [tx100] }`. Make `createAndSetTotals` return `{ ...H14_INVOICE, id: number.endsWith("100") ? 702 : 701, number }` based on the first argument's `number`; make confirmation behavior conditional on ID. Do not rely on global call order except where the outer-catch test deliberately makes the second create throw.

Run:

```bash
npx vitest run src/tools/receipt-inbox-tools.test.ts -t "H14 merged wrapper|H14 later group error|H14 multi-transaction partial plus success|H14 partial state is isolated|H14 failed stale invalidation retains partial recovery state"
```

Expected: FAIL because current code has no partial contract, its outer catch discards prior group-local state, and its confirmation catch invalidates instead of preserving the partial invoice and continuing safely. Every failed-invalidation row is independently honest RED: current code does not append the proven created ID until after confirmation, reports `created_invoice_ids: []`, and the shared helper swallows the thrown error so no categorized `invoice_invalidation` partial exists.

In the existing test named exactly `apply_transaction_classifications reports a group as failed when only part of it executes`, replace the shared fake ID with deterministic distinct IDs: return invoice 9001 for payload number `AUTO-TX-44` and invoice 9002 for `AUTO-TX-45`. Make these assertions mandatory:

```ts
expect(payload.results[0]!.created_invoice_ids).toEqual([9001]);
expect(payload.results[0]!.linked_transaction_ids).toEqual([44]);
expect(api.purchaseInvoices.createAndSetTotals).toHaveBeenCalledTimes(2);
expect(api.transactions.get).toHaveBeenCalledTimes(4);
expect(api.purchaseInvoices.confirmWithTotals).toHaveBeenCalledTimes(1);
expect(api.transactions.confirm).toHaveBeenCalledTimes(1);
expect(api.purchaseInvoices.invalidate).toHaveBeenCalledTimes(1);
expect(api.purchaseInvoices.invalidate).toHaveBeenCalledWith(9002);
```

This existing regression must prove that successful invalidation removes exactly the current stale invoice 9002 while preserving the earlier successfully linked live invoice 9001. Do not leave the fake IDs aliased and do not make this adaptation optional.

- [ ] **Step 5: Add the typed partial-mutation contract and durable group accumulators**

In `src/tools/receipt-inbox.ts`, add the exact import:

```ts
import { isMutationIndeterminate } from "../mutation-outcome.js";
```

Define near the classification result types:

```ts
type PartialClassificationStatus = "PROJECT" | "CONFIRMED" | "VOID" | "UNKNOWN";

interface PartialClassificationMutation {
  category: "mutation_indeterminate" | "mutation_failed";
  mutation_may_have_occurred: true;
  failed_stage:
    | "transaction_reread"
    | "invoice_invalidation"
    | "invoice_confirmation"
    | "transaction_confirmation";
  created_invoice_id: number;
  created_invoice_status: PartialClassificationStatus;
  attempted_transaction_id: number;
  transaction_status: PartialClassificationStatus;
  next_action: string;
}

function invoiceClassificationStatus(status: unknown): PartialClassificationStatus {
  return status === "PROJECT" || status === "CONFIRMED" ? status : "UNKNOWN";
}

function transactionClassificationStatus(
  transaction: Pick<Transaction, "status" | "is_deleted">,
): PartialClassificationStatus {
  if (transaction.is_deleted === true) return "UNKNOWN";
  return transaction.status === "PROJECT" ||
    transaction.status === "CONFIRMED" ||
    transaction.status === "VOID"
    ? transaction.status
    : "UNKNOWN";
}

function isAmbiguousPostCreateFailure(error: unknown): boolean {
  return isMutationIndeterminate(error) || (
    error instanceof HttpError && error.status === "network"
  );
}
```

Extend the local `results` element type with `partial_mutations?: PartialClassificationMutation[]`. Immediately after `notes`/`transactionIds`, but before the outer group `try`, declare:

```ts
const createdInvoiceIds: number[] = [];
const linkedTransactionIds: number[] = [];
const partialMutations: PartialClassificationMutation[] = [];
let wouldCreateCount = 0;
let attemptedCreateCount = 0;
```

Remove their current declarations from inside the `try`. In the outer group `catch`, preserve the accumulators instead of replacing them:

```ts
const message = error instanceof Error ? error.message : String(error);
notes.push(message);
results.push({
  category: group.category,
  counterparty: group.display_counterparty,
  status: "failed",
  notes,
  transactions: transactionIds,
  created_invoice_ids: dryRun ? undefined : createdInvoiceIds,
  linked_transaction_ids: dryRun ? undefined : linkedTransactionIds,
  partial_mutations: partialMutations.length > 0 ? partialMutations : undefined,
});
```

This is required even though each named post-create stage is caught locally: a later transaction in the same group can still throw before proving its own create and must not erase earlier created/partial state. Do not wrap the four recorded post-create stages in another broad catch.

- [ ] **Step 6: Record each proven create and preserve all four post-create failure outcomes**

Immediately after `createAndSetTotals` resolves, require its proven ID and record it once before audit/reread work:

```ts
const invoiceId = invoice.id;
if (!invoiceId) {
  throw new Error("createAndSetTotals resolved without a purchase invoice ID");
}
attemptedCreateCount += 1;
createdInvoiceIds.push(invoiceId);
let observedInvoiceStatus = invoiceClassificationStatus(invoice.status);
```

The guard documents the production invariant; it is not a missing-ID recovery policy. Remove the old later `attemptedCreateCount += 1` and `createdInvoiceIds.push(invoice.id)` so the ID can never be duplicated.

Remove `invalidateAndReport` from the `./receipt-inbox-booking.js` import because this H14-local path must retain the original thrown error for categorization. Define this discriminated local helper after `invoiceId` is proven. It reproduces the existing success/failure note text and continues wrapping untrusted upstream error text:

```ts
type InvoiceInvalidationOutcome =
  | { ok: true }
  | { ok: false; error: unknown };

const invalidateAutoCreatedInvoice = async (
  reason: string,
): Promise<InvoiceInvalidationOutcome> => {
  try {
    await api.purchaseInvoices.invalidate(invoiceId);
    notes.push(`Invalidated auto-created purchase invoice ${invoiceId} because ${reason}.`);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.push(
      `Auto-created purchase invoice ${invoiceId} could not be kept because ${reason}, and invalidation also failed: ${wrapUntrustedOcr(message) ?? message}.`,
    );
    return { ok: false, error };
  }
};
```

Do not modify the shared `invalidateAndReport`: its string-only return is appropriate for existing consumers but cannot preserve the thrown value H14 needs.

Inside the per-transaction scope, define:

```ts
const recordPostCreateFailure = (
  error: unknown,
  failedStage: PartialClassificationMutation["failed_stage"],
  createdInvoiceStatus: PartialClassificationStatus,
  transactionStatus: PartialClassificationStatus,
): void => {
  const ambiguous = isAmbiguousPostCreateFailure(error);
  const nextAction = failedStage === "transaction_reread"
    ? `Use existing purchase invoice ${invoiceId}. Freshly read transaction ${transaction.id}, then continue only after explicit approval.`
    : failedStage === "invoice_invalidation"
      ? `Freshly read existing purchase invoice ${invoiceId} before any further action, then continue only after explicit approval.`
    : failedStage === "invoice_confirmation"
      ? `Use existing purchase invoice ${invoiceId}. Freshly read that invoice and transaction ${transaction.id}, then continue only after explicit approval.`
      : `Use existing confirmed purchase invoice ${invoiceId}. Freshly read transaction ${transaction.id}, then continue only after explicit approval.`;
  partialMutations.push({
    category: ambiguous ? "mutation_indeterminate" : "mutation_failed",
    mutation_may_have_occurred: true,
    failed_stage: failedStage,
    created_invoice_id: invoiceId,
    created_invoice_status: createdInvoiceStatus,
    attempted_transaction_id: transaction.id!,
    transaction_status: transactionStatus,
    next_action: nextAction,
  });
  notes.push(nextAction);
};
```

Replace the current reread, invalidation branch, and combined confirmation catch with four separately recorded stages:

```ts
let freshTransaction: Transaction;
try {
  freshTransaction = await api.transactions.get(transaction.id!);
} catch (error) {
  recordPostCreateFailure(error, "transaction_reread", observedInvoiceStatus, "UNKNOWN");
  continue;
}

if (!isProjectTransaction(freshTransaction)) {
  const invalidation = await invalidateAutoCreatedInvoice(
    `transaction ${transaction.id} is no longer bookable (status ${freshTransaction.status ?? "UNKNOWN"})`,
  );
  if (invalidation.ok) {
    // Remove the ID appended for this create, even if a test double reuses IDs.
    const createdIndex = createdInvoiceIds.lastIndexOf(invoiceId);
    if (createdIndex >= 0) createdInvoiceIds.splice(createdIndex, 1);
  } else {
    recordPostCreateFailure(
      invalidation.error,
      "invoice_invalidation",
      isAmbiguousPostCreateFailure(invalidation.error) ? "UNKNOWN" : observedInvoiceStatus,
      transactionClassificationStatus(freshTransaction),
    );
  }
  continue;
}

try {
  await api.purchaseInvoices.confirmWithTotals(invoiceId, isVatRegistered, {
    preserveExistingTotals: true,
  });
  observedInvoiceStatus = "CONFIRMED";
  logAudit({
    tool: "apply_transaction_classifications", action: "CONFIRMED", entity_type: "purchase_invoice",
    entity_id: invoiceId,
    summary: `Auto-confirmed purchase invoice ${invoiceId} for transaction ${transaction.id}`,
    details: { invoice_id: invoiceId, transaction_id: transaction.id },
  });
} catch (error) {
  recordPostCreateFailure(
    error,
    "invoice_confirmation",
    isAmbiguousPostCreateFailure(error) ? "UNKNOWN" : observedInvoiceStatus,
    "PROJECT",
  );
  continue;
}

try {
  await api.transactions.confirm(transaction.id!, [{
    related_table: "purchase_invoices",
    related_id: invoiceId,
    amount: transaction.amount,
  }]);
  logAudit({
    tool: "apply_transaction_classifications", action: "CONFIRMED", entity_type: "transaction",
    entity_id: transaction.id!,
    summary: `Auto-confirmed transaction ${transaction.id} against invoice ${invoiceId}`,
    details: { amount: transaction.amount, invoice_id: invoiceId },
  });
} catch (error) {
  recordPostCreateFailure(
    error,
    "transaction_confirmation",
    "CONFIRMED",
    isAmbiguousPostCreateFailure(error) ? "UNKNOWN" : "PROJECT",
  );
  continue;
}

linkedTransactionIds.push(transaction.id!);
```

No failure branch in these four stages may reread, create, invalidate, or confirm again. `recordPostCreateFailure` records only the evidence already known; it does not inspect an error message to guess status. Successful invalidation alone removes the current ID and emits no partial; failed invalidation retains the ID and records exactly one partial in addition to its rollback-failure note.

- [ ] **Step 7: Emit partials and compute completion status from actual links**

Replace the execute-mode status calculation with:

```ts
const status = dryRun
  ? (wouldCreateCount > 0 ? "dry_run_preview" : "skipped")
  : partialMutations.length > 0
    ? "failed"
    : attemptedCreateCount > 0 && linkedTransactionIds.length === attemptedCreateCount
      ? "applied"
      : attemptedCreateCount > 0
        ? "failed"
        : "skipped";
```

This deliberately does not infer completion from `createdInvoiceIds.length`: partial failures retain a live created ID but are not applied. Include in the normal result:

```ts
partial_mutations: partialMutations.length > 0 ? partialMutations : undefined,
```

Leave `invokeCapturedTool` and `remapHiddenGranularWorkflowResult` unchanged; their object spreads already preserve unknown result fields. The merged test must prove this rather than adding wrapper-specific transformation code.

- [ ] **Step 8: GREEN — run H14 and adjacent behavior**

Run:

```bash
npx vitest run src/tools/receipt-inbox-tools.test.ts -t "H14|reports failed when a draft invoice is invalidated after stale transaction detection|reports a group as failed when only part of it executes|still marks group applied"
npx vitest run src/tools/receipt-inbox-tools.test.ts
npm run build
git diff --check
```

Expected: all pass. H14 rows retain exact IDs/statuses/stages/categories and safe continuation; call counts prove one create, one post-create operation per stage, and no speculative retry or compensating invalidation. The existing two-transaction stale-reread test uses mandatory distinct IDs, invalidates/removes only stale invoice 9002, and preserves live invoice 9001 plus linked transaction 44. Each failed-invalidation row keeps invoice 701 in `created_invoice_ids`, emits one categorized `invoice_invalidation` partial, preserves the wrapped rollback-failure note, calls invalidation exactly once, and performs no confirmation. Non-deleted `VOID` rereads report `VOID`; the deleted transaction whose raw status remains `PROJECT` reports `UNKNOWN`.

- [ ] **Step 9: Full repository verification**

Run each command freshly and retain output for the ledger/review handoff:

```bash
npm run validate:release
npm test
npm run test:integration
git diff --check
```

Expected: release metadata passes; full unit suite passes; integration suite passes with only documented baseline skips; diff check is empty. A failure must be diagnosed and fixed within the two-file scope or escalated before review.

- [ ] **Step 10: Build the complete two-file review artifact without touching the real index**

First prove exact scope:

```bash
H14_EXPECTED="$(mktemp)"
H14_ACTUAL="$(mktemp)"
printf '%s\n' \
  src/tools/receipt-inbox-tools.test.ts \
  src/tools/receipt-inbox.ts | sort -u > "$H14_EXPECTED"
{
  git diff --name-only HEAD
  git ls-files --others --exclude-standard
} | sort -u > "$H14_ACTUAL"
diff -u "$H14_EXPECTED" "$H14_ACTUAL"
rm -f "$H14_EXPECTED" "$H14_ACTUAL"
```

Expected: no output. Then package the actual complete diff through a temporary index:

```bash
mkdir -p .omc/reviews
H14_INDEX="$(mktemp)"
rm -f "$H14_INDEX"
GIT_INDEX_FILE="$H14_INDEX" git read-tree HEAD
GIT_INDEX_FILE="$H14_INDEX" git add -f -- \
  src/tools/receipt-inbox.ts \
  src/tools/receipt-inbox-tools.test.ts
GIT_INDEX_FILE="$H14_INDEX" git diff --cached --binary > .omc/reviews/H14.diff
test -s .omc/reviews/H14.diff
GIT_INDEX_FILE="$H14_INDEX" git diff --cached --name-only
rm -f "$H14_INDEX"
git diff --cached --quiet
```

Expected: artifact is non-empty, temporary staged names are exactly the two H14 paths, and the real index remains empty.

- [ ] **Step 11: Independent SPEC review**

Give a fresh non-author reviewer the H14 spec row, this Task 6, `.omc/reviews/H14.diff`, RED-A/RED-B output, baseline output, and all green verification. Require exactly:

```text
SPEC COMPLIANCE: APPROVED
```

The spec pass must audit transaction reread, invoice invalidation, invoice confirmation, and transaction confirmation; raw network and structural H03 ambiguity plus definite rejection evidence; `PROJECT`/`CONFIRMED`/`VOID`/`UNKNOWN` status mapping; mandatory `UNKNOWN` for every `is_deleted === true` transaction even when raw status is `PROJECT`; immediate/unique invoice ID recording; exact mutation counts; absence of speculative retry or compensating invalidation; safe continuation wording; successful stale invalidation removing exactly the current distinct ID while preserving an earlier live ID and emitting no partial; definite/raw-network/structural invalidation failures retaining the created ID, wrapped rollback note, and correctly categorized `invoice_invalidation` partial; outer-catch accumulator survival; multi-transaction partial-plus-success behavior; cross-group isolation; summary/result/execution consistency; unchanged merged-wrapper propagation; deliberate missing-ID/audit exclusions; and exact two-file scope.

- [ ] **Step 12: Independent QUALITY review**

Only after SPEC approval, give a second fresh non-author reviewer the same artifact and evidence. Require exactly:

```text
CODE QUALITY: APPROVED
```

The quality pass must inspect discriminated invalidation outcomes, preservation of the original thrown error, wrapped external error text, type narrowing, operator precedence in ambiguity detection, whole-transaction status mapping with deleted-first precedence, transitions including `VOID`, duplicate-ID prevention, per-group accumulator lifetime, `lastIndexOf` removal only after proven successful invalidation, retention/partial recording after failed invalidation, no broad catch that discards partials, deterministic distinct-ID mocks, one-create/no-retry counts, public response compatibility, and exact two-file scope. Any rejection requires an in-scope fix, rerunning Steps 8-10, overwriting `H14.diff`, then restarting both reviews in order.

- [ ] **Step 13: Stage and commit exactly H14**

Immediately before staging, repeat the Step 10 exact two-path comparison. Only then run:

```bash
git status --short
git add src/tools/receipt-inbox.ts src/tools/receipt-inbox-tools.test.ts
git diff --cached --name-only
git commit -m "fix(H14): retain receipt partial-completion state"
```

Expected: staged names are exactly the two reviewed paths. Do not stage ignored review or ledger artifacts.

- [ ] **Step 14: Ledger and clean gate**

Append one H14 row to `.omc/full-codebase-remediation-ledger.md` with baseline, RED-A, RED-B, focused/build/full/integration/release/diff results, the ordered SPEC and QUALITY verdicts, and the commit hash. Then run:

```bash
git status --short
```

Expected: empty output. Do not begin M01 until the H14 row is complete and the worktree is clean.

### Task 7: M01 — Cache invalidation and audit metadata for indeterminate mutations

**Exact tracked scope (freeze before review):**
- Modify: `src/api/base-resource.ts`
- Modify: `src/api/base-resource.test.ts`
- Create: `src/mutation-audit.ts`
- Create: `src/mutation-audit.test.ts`
- Modify: `src/audit-log.ts`
- Modify: `src/audit-log.test.ts`
- Modify: `src/index.ts`
- Modify: `src/api/transactions.api.ts`
- Modify: `src/api/transactions.api.test.ts`
- Modify: `src/tools/crud/transactions.ts`
- Modify: `src/tools/crud-tools.test.ts`

**Contracts and boundaries:**
- Add protected `BaseResource.mutate<R>(operation, entityId, businessKey, affectedPatterns, request)` and route inherited `create`, `update`, `delete`, `uploadDocument`, and `deleteDocument` through it.
- On success, invalidate the supplied connection-scoped prefixes. On raw `HttpError.status === "network"`, invalidate them and throw one neutral `MutationIndeterminateError`. If the request already throws a structured indeterminate outcome, invalidate the deduplicated union of local and declared `affectedCaches`, then rethrow the same object without losing IDs, key, cause, or next action.
- Numeric `HttpError` responses—including 400, 409, and 503—and unrelated errors are response-backed/definite for this helper: rethrow unchanged and do not evict caches.
- Prefix `connection:0:/clients` must remove that namespace's object, list, and `listAll` entries while preserving unrelated resource prefixes and every other connection namespace.
- Map all and only the six current `BaseResource` subclass paths to the existing singular audit vocabulary: `/clients -> client`, `/products -> product`, `/journals -> journal`, `/transactions -> transaction`, `/sale_invoices -> sale_invoice`, and `/purchase_invoices -> purchase_invoice`. Type-check values against exported `AuditEntityType`; an unknown path must not produce plural/untyped audit metadata.
- Add `MUTATION_INDETERMINATE` to `AUDIT_ACTIONS` and to both `ACTION_LABELS` maps (Estonian and English), plus `export type AuditEntityType = z.infer<typeof AuditEntityType>`.
- `auditMutationIndeterminate` first validates `error.entity` with `AuditEntityType.safeParse`. Unknown or plural structural entities are never persisted. For valid entities it records tool, action, singular entity/type and ID plus scalar Markdown-renderable details: `category`, `mutation_may_have_occurred`, `operation`, `business_key`, a deterministic comma-separated `affected_caches`, `cause_name`, `cause_message`, optional `cause_status`/`cause_method`/`cause_path`, and `next_action`. Do not pass the caches or cause as nested values because the current audit renderer skips complex objects.
- Change `logAudit` to return `true` only after the append succeeds and `false` from its existing best-effort catch; existing callers may ignore the backward-compatible return. `auditMutationIndeterminate` returns the same boolean. This is the strict production persistence signal used by tests—do not add a test-only writer or make audit failure throw through normal callers.
- Extract a small tested final-error seam `serializeToolMutationError`. It receives `toolName`, `error`, `trackMutation`, `snapshotIndex`, and connection names; only a tracked mutating indeterminate outcome with a valid entity and a resolvable non-empty original connection name is audited. Resolve the destination exclusively from `snapshotIndex`, never `connectionState.activeIndex`. An invalid/out-of-range snapshot skips persistence entirely. If the strict writer returns `false` or throws, emit one stable error log without raw cause data and still return `toolError(error)` for the original outcome.
- Preserve specialized confirm/invalidate/deactivate/reactivate/deliver implementations. In particular, do not disturb H03's transaction-confirm recovery/cleanup state machine or H06's `BookingGuard` verification and structural ambiguity predicate. H06 compatibility is proven against the new structured inherited `JournalsApi.create`.
- Preserve H03's public cleanup outcome when inherited `TransactionsApi.update` normalizes its raw network failure first. The H03-local cleanup catch must recognize `isMutationIndeterminate`, then runtime-narrow its serialized cause to `name === "HttpError"`, `status === "network"`, a non-empty `path`, and a method in the exported `HttpMethod` vocabulary before reconstructing `HttpError`. Only that complete network-cause shape is re-expressed as `operation: "rollback"` with H03's existing `transaction:${id}` business key, next action, affected cache, and complete original cause. Incomplete/foreign structural outcomes continue through the existing compound rollback-failure branch; do not use unsafe assertions/default metadata, special-case BaseResource business keys/payloads, or change `mutation-outcome.ts`.
- Apply the same compatibility rule to the explicit-client cleanup in the public `confirm_transaction` handler. Export the fully guarded `getNormalizedNetworkCause(error): HttpError | undefined` helper from `src/api/transactions.api.ts` and import it in `src/tools/crud/transactions.ts`; do not duplicate its property-walking logic. The helper must contain all structural/getter access in `try/catch`, require `category: "mutation_indeterminate"`, `mutationMayHaveOccurred: true`, and the complete serialized network-`HttpError` cause above, and return `undefined` for incomplete, foreign, or accessor-throwing shapes. Each H03 cleanup catch remains responsible for constructing its own rollback outcome, so the exact H03 `operation`, entity/id, business key, affected cache, original serialized cause, and next action remain contextual and unchanged. Raw network `HttpError` compatibility remains intact. A successful cleanup still rethrows the original confirmation error by identity; a non-normalizable cleanup failure retains its established fallthrough behavior and must not trigger ambiguous-cleanup invalidation.

- [ ] **Step 1: Establish the clean baseline**

Run before source edits:

```bash
git status --short
npx vitest run src/api/base-resource.test.ts src/api/transactions.api.test.ts src/booking-guard.test.ts src/audit-log.test.ts src/mutation-outcome.test.ts src/tool-error.test.ts src/tools/crud-tools.test.ts
```

Expected: empty status and all selected tests pass. Record exact counts. Stop if the baseline is not clean.

- [ ] **Step 2: Write RED-A cache/outcome tests**

In `src/api/base-resource.test.ts`, add named M01 tests for:

1. A raw network `update(5)` with `/clients:list:...`, `/clients:listAll`, and `/clients:5` primed; all three are evicted, while `/products` and `connection:1:/clients` remain.
2. A five-row inherited-method matrix covering create/update/delete/upload/delete-document. Assert exactly one request, correct operation, ID omission/presence, exact business key, `affectedCaches: [basePath]`, singular entity, complete serialized cause, and no unrelated eviction.
3. Numeric 400, 409, and 503 errors plus an ordinary `Error`; assert identity-preserving rejection, no wrapping, and no cache eviction.
4. An already-created `MutationIndeterminateError` with declared caches `[/clients, /products, /products]` while the local path is `/clients`; assert the deduplicated union invalidates exactly two prefixes (including the exact cache-generation delta), both prefixes are evicted, and the exact original object/fields survive.
5. A six-class table importing `ClientsApi`, `ProductsApi`, `JournalsApi`, `TransactionsApi`, `SaleInvoicesApi`, and `PurchaseInvoicesApi`; inherited `update(5)` ambiguity must yield the exact singular entity/path contract.
6. Existing success-path and namespace-isolation regressions remain green.

Use production paths for ambiguity cases; the generic `/items` fixture has no audit entity mapping.

- [ ] **Step 3: Write RED-B audit/wrapper tests**

Create `src/mutation-audit.test.ts` and add focused tests that:

1. Assert the direct audit entry contains every neutral field in the flattened scalar contract and is routed with `{ connectionName: "original-company" }`.
2. Call the actual serialization seam with `snapshotIndex: 0` and names `["original-company", "currently-active-company"]`; assert only the original company is audited and the returned MCP payload retains every neutral field.
3. Assert `trackMutation: false` emits no audit for both read-only and setup-mode call-site cases.
4. Assert a numeric `HttpError` emits no indeterminate audit.
5. Make the strict audit dependency return `false`, then throw in a separate row; each asserts one safe error log and the exact original MCP error payload still returns.
6. Assert an out-of-range snapshot index does not call the writer at all rather than falling back to the active connection.
7. Throw a structural indeterminate object whose `entity` is plural or unknown; assert `AuditEntityType.safeParse` blocks persistence while the exact original MCP payload is preserved.

In `src/audit-log.test.ts`, assert the new Zod action parses and render it once with `EARVELDAJA_AUDIT_LANG=et` and once with `en`; both must show the chosen localized label, not the raw token. Add a real temporary-log write/read assertion through production `logAudit`/`getAuditLogByConnection` proving every flattened M01 recovery field survives persisted Markdown. Also force the append path to fail and assert `logAudit` returns `false`; a successful write returns `true`. Restore environment and filesystem state.

In `src/api/transactions.api.test.ts`, extend the H03 test `H03 API exposes ambiguous API-auto cleanup as rollback and invalidates transactions` as RED-C. Its cleanup must travel through production inherited `update`, then still expose the exact H03 rollback contract and complete original cleanup cause, including `nextAction: "Freshly read transaction 12; clients_id cleanup may or may not have committed."`; call the cleanup update once and evict the seeded transaction cache. Do not relax its expected operation, key, cause, next action, or patch sequence to accept M01's intermediate `operation: "update"` outcome.

In `src/tools/crud-tools.test.ts`, extend the public `confirm_transaction` H03 coverage as RED-D:

1. Set the explicit client successfully, reject confirmation with the existing definite `HttpError`, then make the cleanup update reject with a complete structured M01 ambiguity carrying intermediate `operation: "update"` and `businessKey: "/transactions:1"`, whose serialized cause is `{ name: "HttpError", message: "cleanup lost", status: "network", method: "PATCH", path: "/transactions/1" }`. Assert the public handler rejects with the exact H03 rollback contract: `operation: "rollback"`, `entity: "transaction"`, `entityId: 1`, `businessKey: "transaction:1"`, `affectedCaches: ["/transactions"]`, the complete cause above, and `nextAction: "Freshly read transaction 1; clients_id cleanup may or may not have committed."`. Assert the set-client update, confirmation, and cleanup update each occur exactly once and `invalidateTransactionsAfterAmbiguousCleanup()` occurs exactly once.
2. Add table rows for an incomplete structural ambiguity (for example a missing path or invalid method) and an ambiguity whose category/cause accessor throws. Assert normalization is contained, invalidation is not called, and each cleanup error follows the handler's existing non-network fallthrough unchanged rather than being fabricated into an H03 rollback outcome.
3. Keep the successful-cleanup regression identity-strict: when cleanup succeeds, the handler rethrows the original confirmation error object. Keep the raw network cleanup row green. Do not weaken either existing H03 assertion.

- [ ] **Step 4: Prove honest RED**

Run:

```bash
npx vitest run src/api/base-resource.test.ts -t "M01"
npx vitest run src/mutation-audit.test.ts src/audit-log.test.ts -t "M01|MUTATION_INDETERMINATE"
npx vitest run src/api/transactions.api.test.ts -t "H03 API exposes ambiguous API-auto cleanup as rollback"
npx vitest run src/tools/crud-tools.test.ts -t "H03 CRUD"
```

Expected RED-A: assertion failures show stale caches/raw network errors and absent metadata. Expected RED-B: after minimal compile wiring, assertion failures show missing routing, failure containment, and labels. Expected RED-C after GREEN-A introduces inherited normalization: the H03 API test receives the existing compound ordinary `Error`, whose diagnostic includes the intermediate `operation: "update"` ambiguity, instead of the required structured rollback outcome; the cleanup request still occurs once and the seeded transaction cache is evicted. Expected RED-D: the public handler returns the intermediate structured `operation: "update"` outcome by identity and skips `invalidateTransactionsAfterAmbiguousCleanup()` instead of producing the H03 rollback outcome; the incomplete/getter rows prove the new normalizer must fail closed without leaking an accessor exception. An import/parse error alone is not sufficient RED evidence.

- [ ] **Step 5: Implement minimal GREEN**

In `src/api/base-resource.ts`:

- Define the six-entry typed path map.
- In `mutate`, success invalidates `affectedPatterns`; structured ambiguity invalidates the deduplicated local/declared union and rethrows by identity; raw network invalidates local patterns and constructs the neutral error; everything else rethrows unchanged.
- Use exact inherited-method metadata:

| Method | Operation | Entity ID | Business key |
|---|---|---:|---|
| `create` | `create` | omitted | `${basePath}:create` |
| `update(id)` | `update` | `id` | `${basePath}:${id}` |
| `delete(id)` | `delete` | `id` | `${basePath}:${id}` |
| `uploadDocument(id)` | `upload` | `id` | `${basePath}:${id}:document_user` |
| `deleteDocument(id)` | `delete` | `id` | `${basePath}:${id}:document_user` |

In `src/audit-log.ts`, add the typed action and both labels, make `logAudit` return the strict boolean persistence signal, and keep its best-effort non-throwing contract. In `src/mutation-audit.ts`, implement runtime entity validation, flattened recovery details, the direct boolean writer, and the serialization seam. In `src/index.ts`, keep connection-switch/debug/setup handling intact and replace only the final `toolError(error)` path with the seam, passing `snapshot.index` and the immutable config-name list.

In `src/api/transactions.api.ts`, add only the H03 compatibility adapter at the existing API-auto cleanup catch. Import `isMutationIndeterminate` and `HttpMethod`; use an explicit method guard for `GET|POST|PUT|PATCH|DELETE`. Export the small, safe `getNormalizedNetworkCause` helper described above so the tool layer can reuse the exact same fully guarded shape validation. When the rollback is structurally indeterminate and its serialized cause passes that complete network-`HttpError` narrowing, call `invalidateTransactionsAfterAmbiguousCleanup()`, rebuild the H03 rollback `MutationIndeterminateError` using `transaction:${id}`, `["/transactions"]`, the complete original cause, and the existing fresh-read next action. Otherwise fall through unchanged to the raw-network `HttpError` branch or existing compound rollback failure. The adapter is contextual to cleanup ambiguity and must not inspect or depend on M01's intermediate operation/business key.

In `src/tools/crud/transactions.ts`, import and call the exported `getNormalizedNetworkCause` only inside the explicit-client cleanup catch. A complete normalized cause takes the same path as the existing raw network cleanup failure: invalidate transaction caches once and throw the established H03 rollback `MutationIndeterminateError` with `transaction:${id}`, `["/transactions"]`, the reconstructed `HttpError`, and the exact current next action. Keep the raw `HttpError.status === "network"` branch and all non-normalizable fallthrough behavior. Do not move this policy into `mutation-outcome.ts`, weaken `isMutationIndeterminate`, or use assertions/default method/path values.

- [ ] **Step 6: Prove focused GREEN and H03/H06 compatibility**

Run in order:

```bash
npx vitest run src/api/base-resource.test.ts -t "M01"
npx vitest run src/mutation-audit.test.ts src/audit-log.test.ts -t "M01|MUTATION_INDETERMINATE"
npx vitest run src/api/transactions.api.test.ts -t "H03 API exposes ambiguous API-auto cleanup as rollback"
npx vitest run src/tools/crud-tools.test.ts -t "H03 CRUD"
npx vitest run src/api/base-resource.test.ts src/api/transactions.api.test.ts src/booking-guard.test.ts src/mutation-outcome.test.ts src/tool-error.test.ts src/mutation-audit.test.ts src/audit-log.test.ts src/tools/crud-tools.test.ts
npx vitest run src/booking-guard.test.ts -t "recovers a found structured ambiguous create|makes a structured ambiguous create"
npm run build
git diff --check
```

Expected: all four RED groups pass; both API-auto and public-handler H03 rollback contracts remain exact; complete structured cleanup causes invalidate once, incomplete/getter shapes fail closed without invalidation, successful cleanup still rethrows the original confirmation error, and raw network cleanup remains compatible. H03 neutral fields remain intact; H06 recognizes structured create ambiguity, verifies once, and never duplicates; build and diff check pass.

- [ ] **Step 7: Run full verification**

```bash
npm test
npm run test:integration
npm run validate:release
git diff --check
```

Expected: full unit, integration (only documented environment skips), release, and diff gates pass. Record exact counts and skip reasons.

- [ ] **Step 8: Freeze exact scope and run ordered reviews**

Require `git status --short` to contain exactly the eleven tracked paths above and `git diff --cached --name-only` to be empty. Copy the real index to a temporary index, add exactly the eleven paths there—including `src/tools/crud/transactions.ts` and `src/tools/crud-tools.test.ts`—and write non-empty `.omc/reviews/M01.diff`. Verify the temporary-index name list equals the exact eleven-path list under **Exact tracked scope**, the artifact byte-matches its diff, and the real index stays empty; a nine-file artifact is incomplete and must not be reviewed.

Dispatch a fresh SPEC reviewer with the M01 spec row, this task, RED/GREEN evidence, and frozen artifact. Require exactly `SPEC COMPLIANCE: APPROVED`. After that only, dispatch a different fresh QUALITY reviewer and require exactly `CODE QUALITY: APPROVED`. Any code change invalidates both verdicts: rerun all gates, rebuild the artifact, then restart SPEC followed by QUALITY.

- [ ] **Step 9: Commit and close the ledger gate**

```bash
git add src/api/base-resource.ts src/api/base-resource.test.ts src/mutation-audit.ts src/mutation-audit.test.ts src/audit-log.ts src/audit-log.test.ts src/index.ts src/api/transactions.api.ts src/api/transactions.api.test.ts src/tools/crud/transactions.ts src/tools/crud-tools.test.ts
git diff --cached --name-only
git commit -m "fix(M01): invalidate caches on ambiguous mutations"
```

Expected staged names: exactly the eleven-path allowlist. Append one M01 row to `.omc/full-codebase-remediation-ledger.md` with baseline, RED-A, RED-B, RED-C API-auto H03 compatibility, RED-D public-handler H03 compatibility/containment, focused/build/full/integration/release/diff results, ordered review verdicts, and commit hash. Require final `git status --short` empty. Do not begin M02 until the row is complete and the worktree is clean.

### Task 8: M02 — Fail closed on malformed pagination

**Exact tracked scope:**
- Modify: `src/cache.ts`
- Modify: `src/cache.test.ts`
- Modify: `src/api/base-resource.ts`
- Modify: `src/api/base-resource.test.ts`

**Contracts and boundaries:**
- Add a private `PaginationMetadataError` and `validatePage<T>(response, requestedPage): PaginatedResponse<T>`. It rejects a non-object/null/array response, non-array `items`, a requested page that is not a positive integer, `current_page` that is not exactly the requested positive integer, and `total_pages` that is not a positive integer or is less than the requested page. Pinned-total drift uses the same typed error. Every message begins `Pagination page <requestedPage>:` and names the invalid field/value; never classify errors by message text.
- Add `Cache.invalidateExact(key): void`: increment the generation once and delete only the exact key, whether or not it currently exists, so an in-flight stale writer from the prior generation cannot repopulate it. It must not use prefix matching.
- `list()` derives `requestedPage = params?.page ?? 1` and rejects an invalid requested page before cache or transport access. It validates cached hits before returning them and validates fresh responses before `setIfSameGeneration`. On cached or fresh page-validation failure, call `cache.invalidateExact(cacheKey)`, rethrow the same typed error object, and preserve valid sibling page/resource/namespace entries.
- `listAll()` pins page 1's `total_pages`. Every later page must report the same total; shrink or expansion is unstable continuation metadata and rejects before appending that page's items. On any validation/continuation failure, invalidate the current connection/resource prefix so valid page caches accumulated earlier in that failed traversal and any aggregate cache are removed. Preserve unrelated resources and connection namespaces.
- `listAllCached()` may cache only a fully successful aggregate; a failed traversal leaves no `${basePath}:listAll` or per-page entry for that resource. Preserve current max-page, max-item, timeout, progress, and `setIfSameGeneration` behavior.
- Deliberate exclusion: cross-page snapshot consistency during a concurrent valid mutation is not M02; this task validates response metadata and cache hygiene only.

- [ ] **Step 1: Establish baseline**

Run `git status --short` and `npx vitest run src/cache.test.ts src/api/base-resource.test.ts`; require a clean worktree and record the passing count.

- [ ] **Step 2: RED-A — page-shape and cache-entry matrix**

In `src/cache.test.ts`, RED-test `invalidateExact` with keys `...:list:`, `...:list:page=1`, `...:list:page=10`, and `...:listAll`: removing each chosen key affects no prefix-colliding sibling, increments generation exactly once even for an absent key, and blocks `setIfSameGeneration` using the prior generation.

In `src/api/base-resource.test.ts`, add table-driven `M02` tests for fresh and manually seeded cached responses covering: null/non-object/array response, missing/non-array `items`, `requestedPage` 0, negative, fractional, `NaN`, and `Infinity`, mismatched/repeated/noninteger `current_page`, and `total_pages` values 0, below requested, fractional, `NaN`, and `Infinity`. Invalid requested-page rows make zero transport calls. Other fresh rows make one; cached rows make zero. Assert the exact failing page/field/value, the malformed exact cache key is absent afterward, no malformed return/write occurs, and prefix-colliding default/page-1/page-10, aggregate, `/products`, and `connection:1` entries remain unless one is the exact malformed key.

- [ ] **Step 3: RED-B — traversal stability and cleanup**

Add fresh and fully cached `listAll` variants for page-1 total 3 followed by total 2, page-1 total 2 followed by total 3, and repeated page metadata (`current_page: 1` for requested page 2). Fresh variants make exactly two transport calls; fully cached variants pre-seed both exact page keys and make zero. For total drift, give page 2 an array whose `Symbol.iterator` is spied; assert it is never iterated, proving comparison happens before `allItems.push`. Before calling `listAll`, seed a `${basePath}:listAll` sentinel and assert typed failure removes that aggregate plus all `/items` page caches while preserving `/products` and `connection:1:/items`.

For `listAllCached`, start without an aggregate cache entry, trigger the same typed traversal failure, and assert it rejects and never writes `${basePath}:listAll`. Do not pre-seed that aggregate when calling `listAllCached`, because that would bypass traversal.

Add negative-control tests with resource cache sentinels for a raw upstream rejection, `reportProgress` rejection, deadline timeout, max-page breach, and max-item breach. Each must retain its original error identity/message and must not invoke resource-prefix cleanup; valid cache entries remain. Use fake time/bounded limits rather than real waiting.

- [ ] **Step 4: Prove honest RED**

Run:

```bash
npx vitest run src/cache.test.ts -t "M02 exact invalidation"
npx vitest run src/api/base-resource.test.ts -t "M02 page validation"
npx vitest run src/api/base-resource.test.ts -t "M02 traversal stability"
```

Expected: behavior assertions fail because malformed pages are returned/cached, unstable totals are accepted, or failed traversal page caches remain. Zero selected tests or compile-only failure is not sufficient.

- [ ] **Step 5: Implement minimal GREEN**

Implement and unit-test `Cache.invalidateExact` first. Then implement the typed validator near `BaseResource`. Validate requested page before any lookup/request, then cached and fresh results before return/write; catch only `PaginationMetadataError` to call `cache.invalidateExact(cacheKey)` and rethrow the same object. In `listAll`, pin the first total and compare every later response before touching its items; catch only `PaginationMetadataError`, call `this.invalidateCache()` once to remove all current-namespace resource pages/aggregate, and rethrow the same object. Do not catch or convert upstream, progress, timeout, max-page, or max-item failures. Preserve `setIfSameGeneration` and existing limit/progress ordering outside these typed boundaries.

- [ ] **Step 6: Focused and full verification**

Run in order:

```bash
npx vitest run src/api/base-resource.test.ts -t "M02"
npx vitest run src/cache.test.ts src/api/base-resource.test.ts
npm run build
npm test
npm run test:integration
npm run validate:release
git diff --check
```

Require all unit/build/release gates and only documented integration skips. Record exact counts.

- [ ] **Step 7: Freeze scope and ordered reviews**

Require exactly the four tracked paths above and an empty real index. Build `.omc/reviews/M02.diff` through a copied temporary index containing exactly those paths; require a non-empty byte-matching artifact. Obtain a fresh `SPEC COMPLIANCE: APPROVED`, then a different fresh `CODE QUALITY: APPROVED`. Any edit restarts verification, artifact creation, and both reviews in order.

- [ ] **Step 8: Commit, ledger, and Wave 2 gate**

```bash
git add src/cache.ts src/cache.test.ts src/api/base-resource.ts src/api/base-resource.test.ts
git diff --cached --name-only
git commit -m "fix(M02): reject malformed pagination"
```

Append the M02 ledger row and require a clean worktree. Then run `npm run validate:release && git diff --check && npm run build && npm test && npm run test:integration`; require PASS with documented skips only before starting H05.

### Task 9: H05 — Preserve approved purchase-invoice totals by default

**Files:**
- Modify: `src/api/purchase-invoices.api.ts`
- Modify: `src/api/purchase-invoices.api.test.ts`
- Modify: `src/tools/crud/purchase-invoices.ts`
- Modify: `src/tools/crud-tools.test.ts`
- Modify: `src/tools/receipt-inbox-booking.ts`
- Modify: `src/tools/receipt-inbox.ts`
- Modify: `src/tools/receipt-batch-failure.test.ts`
- Modify: `src/tools/receipt-inbox-tools.test.ts`
- Modify: `src/tools/pdf-workflow.test.ts`

**Exact scope:** H05 changes exactly the nine paths above. `create_purchase_invoice_from_pdf` only creates/uploads a `PROJECT` invoice and never calls `confirmWithTotals`, so `src/tools/pdf-workflow.ts` is explicitly out of scope. Its test-only regression proves the document workflow passes exact supplier totals into draft creation and hands the ID to the ordinary default-preserving confirmation path. `src/tools/receipt-inbox-tools.test.ts` is required even though its paired production file already appears in scope: it owns the exact-arguments regression for the classification-created invoice caller, while `src/tools/receipt-batch-failure.test.ts` owns the receipt-batch caller. Do not change workflow Markdown/mirrors, shared CRUD helpers, invoice types, cache infrastructure, or any H07 code.

**Decision and compatibility boundary:** Merely flipping the API default would preserve totals but would leave the old public confirm tool able to repair them without showing the change. Removing repair entirely would strand legitimate malformed drafts. Use two distinct public calls instead: the new read-only `preview_purchase_invoice_totals_correction { id }` returns a no-mutation approval snapshot, while destructive `confirm_purchase_invoice { id, recalculate_totals: true, approved_correction: <exact preview> }` may apply only that exact fresh-approved snapshot and then confirm. Ordinary `confirm_purchase_invoice { id }` never recalculates. The internal `preserveExistingTotals` option is private and has exactly two production callers, so migrate both to the safe default and remove the alias rather than retaining two opposite flags.

**Interfaces and exact contracts:**

```ts
export interface PurchaseInvoiceTotalsCorrectionPreview {
  invoice_id: number;
  is_vat_registered: boolean;
  current_vat_price: number | null;
  current_gross_price: number | null;
  proposed_vat_price: number;
  proposed_gross_price: number;
  correction_required: boolean;
  approval_digest: string; // lowercase SHA-256, 64 hex characters
}

interface ConfirmPurchaseInvoiceOptions {
  recalculateTotals?: boolean;
  approvedCorrection?: PurchaseInvoiceTotalsCorrectionPreview;
}
```

- Default/false `recalculateTotals` with no approval calls `/purchase_invoices/:id/register` without a prerequisite GET or totals PATCH for all currencies, including complete totals, one-cent rounding differences, missing totals, non-VAT invoices, reverse-charge invoices, and non-EUR invoices. This is the H05 preservation rule: if required totals are missing, the upstream register may reject, and the caller may repair them only through the documented preview-then-approved-correction path below; default confirmation must never manufacture unapproved values. At the API boundary, `approvedCorrection` without `recalculateTotals: true` and `recalculateTotals: true` without `approvedCorrection` both reject before GET/PATCH rather than silently selecting a branch.
- A correction preview invalidates the current connection's `/purchase_invoices` cache, performs a fresh GET, and rejects unless `status === "PROJECT"`. It also rejects missing/empty items, reverse-charge items, and any currency other than EUR. These failures occur before POST/PATCH/DELETE and before any audit write. An eligible preview calculates VAT/gross with the existing `roundMoney` rules and likewise performs no mutation or audit write.
- The preview has exactly eight fields: the seven business fields `invoice_id`, `is_vat_registered`, `current_vat_price`, `current_gross_price`, `proposed_vat_price`, `proposed_gross_price`, and `correction_required`, plus `approval_digest`. `approval_digest` is SHA-256 over one exact snapshot containing `invoice_id`, `is_vat_registered`, fresh `status`, `net_price`, `vat_price`, `gross_price`, `cl_currencies_id`, `currency_rate`, `base_net_price`, `base_vat_price`, `base_gross_price`, `proposed_vat_price`, `proposed_gross_price`, `correction_required`, and the complete ordered `items` array. Normalize `undefined` to `null` recursively, sort object keys recursively, and preserve array/item order before JSON serialization. This binds status, every nominal/base total and currency scalar, the VAT mode, proposed values, and every full item field/order rather than only the visible current VAT/gross fields.
- Explicit correction application again invalidates `/purchase_invoices`, performs a fresh GET, recomputes the complete preview, and requires every supplied preview field plus the digest to equal that fresh preview. Missing, malformed, foreign-invoice-ID, wrong-VAT-status, or stale approval throws/returns an actionable `correction_preview_mismatch` before totals PATCH or register. The same preview object cannot apply after total/item drift.
- Correction application repeats the same eligibility checks before approval comparison: fresh status must still be `PROJECT`, currency must still be EUR, items must remain non-empty, and no item may be reverse charge. A `PROJECT` -> `CONFIRMED` transition after preview is therefore stale approval and rejects before totals PATCH/register/audit even if every total and item is otherwise unchanged. A matching approval updates only `{ vat_price: proposed_vat_price, gross_price: proposed_gross_price, items: freshItems }` when `correction_required` is true, then confirms. A matching no-op preview skips the update and confirms. Existing mutation ambiguity/cache behavior remains inherited from `BaseResource`.
- Register `preview_purchase_invoice_totals_correction` separately with `{ ...readOnly, title: "Preview Purchase Invoice Totals Correction" }` and schema `{ id: coerceId }`. Its exact success envelope is `action: "previewed"`, `entity: "purchase_invoice"`, the invoice ID, the exact eight-field preview in `raw`, and `next_actions` containing one instruction to obtain approval and resubmit the preview unchanged to `confirm_purchase_invoice`.
- Keep `confirm_purchase_invoice` destructive. Its schema adds `recalculate_totals?: boolean` and exactly one representation of `approved_correction`: a strict `z.object({...}).strict()` with the eight fields above, nullable finite current totals, finite proposed totals, positive integer invoice ID, boolean fields, and `/^[0-9a-f]{64}$/` digest. Do not accept a JSON string or coerce approval fields. `approved_correction` without `recalculate_totals: true`, or `recalculate_totals: true` without `approved_correction`, is rejected before API calls. Extra, missing, wrong-type, non-finite, or malformed-digest fields fail schema validation before the handler.
- Use one exported API/tool-boundary `PurchaseInvoiceTotalsCorrectionError` carrying one of these exact codes: `correction_invoice_not_project`, `correction_currency_not_supported`, `correction_reverse_charge_not_supported`, `correction_items_missing`, `correction_preview_required`, or `correction_preview_mismatch`. Each instance also carries the exact `error` and `next_action` strings from this table:

  | `code` | `error` | `next_action` |
  | --- | --- | --- |
  | `correction_invoice_not_project` | `Purchase invoice totals correction requires a PROJECT draft.` | `Fetch the invoice; if it is confirmed, invalidate it explicitly, then request and approve a new correction preview.` |
  | `correction_currency_not_supported` | `Automatic purchase invoice totals correction supports EUR invoices only.` | `Review the currency and base totals manually; do not use automatic totals correction.` |
  | `correction_reverse_charge_not_supported` | `Automatic totals correction is disabled for reverse-charge purchase invoices.` | `Review and preserve the reverse-charge totals manually, then confirm without recalculation only after approval.` |
  | `correction_items_missing` | `Purchase invoice totals correction requires at least one item.` | `Add or repair the invoice items, then request and approve a new correction preview.` |
  | `correction_preview_required` | `An exact approved purchase invoice totals correction preview is required.` | `Call preview_purchase_invoice_totals_correction, obtain approval, and resubmit that preview unchanged.` |
  | `correction_preview_mismatch` | `The approved purchase invoice totals correction preview no longer matches fresh invoice state.` | `Call preview_purchase_invoice_totals_correction again and obtain approval for the new snapshot.` |

  Both public handlers catch **only** `PurchaseInvoiceTotalsCorrectionError` and return `toolError({ category: "purchase_invoice_totals_correction", code: error.code, error: error.message, next_action: error.nextAction })`. All other errors rethrow unchanged so transport/ambiguity handling is not converted into an apparently safe domain rejection. Apply-time status/currency/item drift uses the corresponding eligibility code; approval field/digest drift uses `correction_preview_mismatch`. Every domain error rejects before a totals PATCH/register and before a confirmation audit.
- Preview never writes an audit. Only successful confirmation writes `CONFIRMED`: the default path preserves the existing empty `details`, while approved correction writes `details: { recalculate_totals: true, approval_digest: approved_correction.approval_digest }`. Preview rejection, stale approval, validation failure, update failure, and register failure must not produce a successful confirmation audit.

- [ ] **Step 1: Baseline and current-consumer proof**

Run:

```bash
git status --short
rg -n "preserveExistingTotals|confirmWithTotals\\(" src/api src/tools
npx vitest run src/api/purchase-invoices.api.test.ts src/tools/crud-tools.test.ts src/tools/pdf-workflow.test.ts src/tools/receipt-batch-failure.test.ts src/tools/receipt-inbox-tools.test.ts src/tools/receipt-inbox.test.ts
```

Require a clean worktree. Record the passing baseline count and the two production preservation callers: `src/tools/receipt-inbox-booking.ts` and the classification flow in `src/tools/receipt-inbox.ts`. Record the existing `confirm_purchase_invoice` tool inventory entry, prove `preview_purchase_invoice_totals_correction` is not yet registered, and confirm again that PDF creation does not call confirmation.

- [ ] **Step 2: RED-A — API default and approval-binding matrix**

In `src/api/purchase-invoices.api.test.ts`, add table-driven `H05 default preservation` cases for: VAT-registered complete totals with a one-cent supplier rounding difference; missing VAT; missing gross; non-VAT with item VAT; reverse charge; and non-EUR. Each calls `confirmWithTotals(id, isVatRegistered)` and asserts exactly one register PATCH, no invoice totals PATCH, and no prerequisite GET. The missing-VAT and missing-gross rows explicitly prove the safe default delegates validation to register rather than silently repairing; their repair is covered only by the approved correction rows.

Add `H05 correction approval` tests that use sequential fresh GET responses and prove:

1. `previewTotalsCorrection` fresh-reads after invalidating stale cached invoice/list entries, requires fresh `status: "PROJECT"`, returns the exact seven business fields plus a 64-hex digest, and makes no PATCH.
2. Missing/empty items, non-`PROJECT` status, reverse-charge items, and non-EUR currency each reject without PATCH/register.
3. `confirmWithTotals(..., { recalculateTotals: true })` rejects without update/register because approval is absent.
4. A matching VAT-registered approval performs one totals PATCH with the fresh items and then register; a matching non-VAT approval proposes VAT 0 and payable gross using item VAT.
5. A matching preview with `correction_required: false` skips totals PATCH and registers.
6. A table-driven fresh-state drift matrix changes exactly one digest-bound scalar per row: `status`, `net_price`, `vat_price`, `gross_price`, `cl_currencies_id`, `currency_rate`, `base_net_price`, `base_vat_price`, or `base_gross_price`. Include `undefined` -> concrete and concrete -> `null` rows to prove the consistent null normalization. Every row rejects before update/register; status/currency eligibility failures use their exact code and all other scalar drift uses `correction_preview_mismatch`.
7. Additional rows change the VAT-registration mode, proposed totals through item amount/VAT changes, an item's title/account field while keeping proposed totals unchanged, and item order. Every row rejects before update/register, proving the digest binds ID/VAT mode, proposed fields, and the full ordered items rather than only monetary output.
8. The `status` matrix row specifically changes only `PROJECT` at preview to `CONFIRMED` at apply and proves status-bound approval rejects before update/register.
9. Tampered invoice ID, VAT-registration flag, proposed value, digest, missing field, extra field, and non-finite value are rejected before mutation.

Name both groups with the `H05` prefix so the focused RED selects them.

- [ ] **Step 3: RED-B — public preview/apply, PDF handoff, and caller migration**

In `src/tools/crud-tools.test.ts`, add `H05 correction tool inventory and workflow` tests:

- tool inventory contains exactly one `preview_purchase_invoice_totals_correction` registration annotated read-only and retains destructive `confirm_purchase_invoice`;
- preview `{ id }` calls only `previewTotalsCorrection`, returns `action: "previewed"` plus the exact eight-field preview and one approval next action, and writes no audit;
- preview rejects non-`PROJECT`, reverse-charge, and non-EUR invoices with zero mutation/audit calls;
- default confirm `{ id }` calls `confirmWithTotals(id, isVatRegistered)` with no third argument and writes one ordinary confirmation audit with existing empty details;
- confirm with `recalculate_totals: true` but no approval, or approval without the flag, returns an actionable tool error with zero preview/confirm/audit calls;
- an exact strict `approved_correction` object is forwarded as `{ recalculateTotals: true, approvedCorrection }`, confirms, and audits exactly `{ recalculate_totals: true, approval_digest }`;
- JSON-string, extra/missing/wrong-type/non-finite/malformed-digest approvals fail the strict object schema with zero preview/confirm/audit calls;
- a preview followed by fresh `PROJECT` -> `CONFIRMED` drift and a preview followed by EUR -> non-EUR drift both return an actionable error with zero update/register/audit calls.

Invoke both registered handlers directly with `PurchaseInvoiceTotalsCorrectionError` rejections from their API mocks. For every exact code, assert `isError: true` and the exact `{ category: "purchase_invoice_totals_correction", code, error, next_action }` payload, with zero update/register/audit calls. Add a non-domain `Error("transport failed")` row for each handler and assert it rejects rather than returning `toolError`; this proves the catch boundary is limited to the typed correction error.

In `src/tools/pdf-workflow.test.ts`, extend the creation fixture with a `confirmWithTotals` spy and add `H05 PDF handoff preserves approved supplier totals`: call `create_purchase_invoice_from_pdf` with a one-cent invoice rounding difference, assert the exact `vat_price`/`gross_price` reach `createAndSetTotals`, no confirmation method is called, and the returned draft note names plain `confirm_purchase_invoice` without requesting correction.

In `src/tools/receipt-batch-failure.test.ts`, change the create-and-confirm expectation to the two-argument default call. In `src/tools/receipt-inbox-tools.test.ts`, add the same exact-arguments assertion for classification-created invoices. Keeping these in their owning suites is why both test paths are in the nine-file scope. These must initially fail while the two production receipt callers still pass `{ preserveExistingTotals: true }`.

- [ ] **Step 4: Prove honest RED**

Run separately:

```bash
npx vitest run src/api/purchase-invoices.api.test.ts -t "H05 default preservation"
npx vitest run src/api/purchase-invoices.api.test.ts -t "H05 correction approval"
npx vitest run src/tools/crud-tools.test.ts src/tools/pdf-workflow.test.ts -t "H05"
npx vitest run src/tools/receipt-batch-failure.test.ts src/tools/receipt-inbox-tools.test.ts -t "H05"
```

Expected: behavior assertions fail because default API confirmation still recalculates, the separate preview tool/approval contract does not exist, and both receipt callers still pass the preservation alias. The PDF no-confirmation check may pass as a negative control; at least one runtime behavior assertion in every other focused group must fail for the intended reason. Zero selected tests, source-text-only assertions, or compile-only failures are not sufficient RED.

- [ ] **Step 5: Implement minimal GREEN**

In `src/api/purchase-invoices.api.ts`, import `createHash`, remove `preserveExistingTotals`, add the exact eight-field preview/options interfaces and exported typed correction error, deterministic recursive null-normalizing/key-sorting snapshot construction, the exact digest field list above, a cache-invalidating fresh-read helper, one calculation helper, `previewTotalsCorrection`, and approval equality checking. Put the default branch first so it calls `confirm(id)` without GET for every currency and regardless of total completeness. Preview and explicit apply must independently fresh-read, require `PROJECT`, reject reverse charge/non-EUR/missing items, and use the same snapshot builder. The explicit branch verifies the complete freshly recomputed preview before `update`, uses only fresh items, and then calls `confirm`.

In `src/tools/crud/purchase-invoices.ts`, define one reusable strict Zod object schema for the exact eight-field approval and register `preview_purchase_invoice_totals_correction` with the read-only annotation before the destructive confirm tool. Add `recalculate_totals` and that object-only `approved_correction` to confirm. Wrap only each handler's correction API call in a typed-error catch that emits the exact structured `toolError` above; rethrow every other error. Preserve the existing default response/audit contract; only approved correction adds the exact digest audit details. Do not accept strings, do not let preview output claim confirmation, and do not audit preview or failed/stale correction.

Remove the third argument from `confirmWithTotals` in `src/tools/receipt-inbox-booking.ts` and `src/tools/receipt-inbox.ts`; update the two exact caller tests. Do not alter their rollback, partial-mutation, transaction-confirmation, or audit sequencing. Do not edit `src/tools/pdf-workflow.ts`.

- [ ] **Step 6: Focused and compatibility verification**

Run in order:

```bash
npx vitest run src/api/purchase-invoices.api.test.ts -t "H05"
npx vitest run src/tools/crud-tools.test.ts src/tools/pdf-workflow.test.ts -t "H05"
npx vitest run src/tools/receipt-batch-failure.test.ts src/tools/receipt-inbox-tools.test.ts -t "H05"
npx vitest run src/api/purchase-invoices.api.test.ts src/tools/crud-tools.test.ts src/tools/pdf-workflow.test.ts src/tools/receipt-batch-failure.test.ts src/tools/receipt-inbox-tools.test.ts src/tools/receipt-inbox.test.ts
if rg -n "preserveExistingTotals" src; then exit 1; fi
npm run build
npm test
npm run test:integration
npm run validate:release
git diff --check
```

Require all focused/affected/full unit, build, release, and integration gates; only documented integration skips are allowed. Record exact counts. Confirm default confirmation has no GET/totals update for complete, missing-total, reverse-charge, or non-EUR rows; the separately registered read-only preview has no mutation/audit; non-`PROJECT`, non-EUR, reverse-charge, and stale approval have no mutation/audit; explicit approved EUR `PROJECT` correction updates then registers; both old preservation callers use the new default; and `preserveExistingTotals` has no remaining source match.

- [ ] **Step 7: Freeze exact scope and obtain ordered independent reviews**

Require exactly the nine tracked paths listed above and an empty real index. Copy the real index to `/tmp/h05-review-index`; with `GIT_INDEX_FILE=/tmp/h05-review-index`, add exactly those nine paths and write the staged binary diff to `.omc/reviews/H05.diff`. Require the artifact to be non-empty and byte-identical to `env GIT_INDEX_FILE=/tmp/h05-review-index git diff --cached --binary`, while `git diff --cached --name-only` on the real index remains empty.

Give the frozen artifact, H05 spec row, RED outputs, GREEN/full outputs, scope list, and this contract to a fresh spec reviewer; require exact `SPEC COMPLIANCE: APPROVED`. Only after that approval, give the same frozen artifact/evidence to a different fresh quality reviewer; require exact `CODE QUALITY: APPROVED`. Any code/test edit invalidates the artifact and both verdicts and restarts Step 6 plus both reviews in order.

- [ ] **Step 8: Final primary verification, commit, ledger, and clean handoff**

After both approvals, rerun the Step 6 commands from the primary agent, `git diff --check`, the exact-scope check, and artifact byte comparison. Then:

```bash
git add src/api/purchase-invoices.api.ts src/api/purchase-invoices.api.test.ts src/tools/crud/purchase-invoices.ts src/tools/crud-tools.test.ts src/tools/receipt-inbox-booking.ts src/tools/receipt-inbox.ts src/tools/receipt-batch-failure.test.ts src/tools/receipt-inbox-tools.test.ts src/tools/pdf-workflow.test.ts
git diff --cached --name-only
git commit -m "fix(H05): preserve approved invoice totals"
```

Require the staged list to equal the nine approved paths exactly. Append the H05 ledger row only after the commit succeeds, then require `git status --short` to be empty before beginning H07. Do not push.

### Task 10: H07 — Use invoice liability and allocated payment amount

**Exact tracked scope (freeze before review):**
- Modify: `src/tools/currency-rounding.ts`
- Modify: `src/tools/currency-rounding.test.ts`

Do not change `src/types/api.ts`, accounting defaults, `BookingGuard`, purchase-invoice APIs, transaction APIs, audit infrastructure, workflow Markdown/mirrors, or any H16 code. `TransactionItem.relation_table` and `relation_id` are the canonical response-side relation fields; the public confirmation request's `related_table` spelling is not used here.

**Authoritative contracts:**
- The invoice header is the liability source of truth. `liability_accounts_id` must be a positive integer. `liability_accounts_dimensions_id === null || liability_accounts_dimensions_id === undefined` means a valid account-level posting; a positive integer dimension is included on the liability posting; zero, negative, fractional, non-finite, or otherwise malformed account/dimension values force review.
- Keep the existing public `liability_accounts_id` argument for compatibility, but relabel it as a deprecated assertion. It never supplies a missing invoice account and never overrides the invoice. Omitted or exactly matching values proceed; a mismatch forces review. Remove `DEFAULT_LIABILITY_ACCOUNT` from this tool's production decision path.
- Preserve the invoice's raw `transactions` array in `linked_transaction_ids` for output compatibility. Resolve/fetch each distinct positive integer ID only once. A malformed linked ID forces review. A fetched transaction whose `id` is present but differs from the requested ID forces review.
- Ignore a linked transaction only when `is_deleted === true` or `status === "VOID"`. Every other linked transaction must load, have `status === "CONFIRMED"`, have `type === "C"`, and contain at least one item with `relation_table === "purchase_invoices" && relation_id === invoice.id`. `PROJECT`, absent/unknown statuses, non-`C` directions, load errors, and missing canonical invoice relations force review for the entire invoice; never fall back to the whole transaction.
- Sum **all** canonical matching items across all distinct active linked transactions. Multiple allocations for the same invoice in one transaction are legitimate rows and are all counted. Repeated transaction IDs are counted once. At least one active contributing allocation is required; an empty link array or links containing only deleted/VOID transactions force review.
- For each active transaction, require finite positive `tx.amount`; when `tx.base_amount` or `tx.currency_rate` is present, it must also be finite and positive. For each matching item, require a finite positive `amount`; when `item.base_amount` or `item.currency_rate` is present, it must likewise be finite and positive even if another higher-precedence value is available. Normalize currency with `trim().toUpperCase()`, without defaulting to EUR. The item currency, when present, must equal the non-empty transaction currency; missing or conflicting source currency forces review.
- Build the following EUR evidence in exact precedence order: (1) `item.base_amount`; (2) `item.amount` when the resolved source currency is EUR; (3) `item.amount * item.currency_rate`; (4) `item.amount * tx.currency_rate`; (5) `item.amount * tx.base_amount / tx.amount`. Round each evidence value with `roundMoney`. The first available value is authoritative, but every additional available evidence value must agree with it within `0.01`; contradictory evidence forces review. If none of the five derivations is available, return `allocation_eur_evidence_missing`. Also reject matching nominal allocations whose sum exceeds the transaction amount by more than `0.01`, or whose resolved matching EUR allocations exceed a present transaction base amount by more than `0.01`.
- Sum the per-item EUR allocations and round the final `paidEur`. `settlementDate` is the latest valid date among contributing active transactions only; deleted, VOID, unconfirmed, relationless, or otherwise rejected transactions never influence it. Keep the existing invoice-date/today fallback only when every monetary/account provenance check passed but contributing transactions supplied no date.
- `effectiveBaseGross` is required. Missing/non-finite booked base evidence creates a review candidate instead of silently skipping the invoice. A fully valid settlement whose rounded booked-minus-paid difference is zero remains omitted, preserving current output behavior.
- Missing or conflicting provenance always emits a review candidate and blocks both mutation branches. Its `paid_eur` and `diff_eur` are `null` because neither a partial sum nor a fabricated difference is authoritative. It has no proposed patch/journal, never calls `purchaseInvoices.update`, `BookingGuard.createJournalOnce`, journal create/confirm, or `logAudit`, even with `execute: true`.
- Choose error codes deterministically in this order: booked base; liability account; liability dimension; deprecated assertion; linked-array/ID validity; load/identity; liveness; confirmed status; outgoing direction; canonical relation; transaction/item amount; currency; rate/base validity; missing EUR evidence; redundant/total conflicts; no active allocation. The resolver validates all distinct requested links into read-only evidence/error records before selecting the result. It first selects the earliest error class in this precedence list; when more than one error has that code, an error without `transaction_id` sorts first and otherwise the smallest requested linked transaction ID wins. Do not let response order, asynchronous completion, or exception timing choose the public error. Successful `contributingTransactionIds` are unique and sorted numerically ascending; keep only `linked_transaction_ids` in the invoice's original raw order.

Define and use these exact local/exported interfaces so the output and tests cannot collapse back to an unstructured string:

```ts
export type SettlementProvenanceErrorCode =
  | "booked_base_missing_or_invalid"
  | "invoice_liability_account_missing_or_invalid"
  | "invoice_liability_dimension_invalid"
  | "liability_account_assertion_conflict"
  | "linked_transactions_missing"
  | "linked_transaction_id_invalid"
  | "linked_transaction_load_failed"
  | "linked_transaction_identity_conflict"
  | "linked_transaction_not_confirmed"
  | "linked_transaction_direction_conflict"
  | "invoice_distribution_missing"
  | "allocation_amount_invalid"
  | "allocation_currency_missing"
  | "allocation_currency_conflict"
  | "allocation_rate_invalid"
  | "allocation_base_invalid"
  | "allocation_eur_evidence_missing"
  | "allocation_base_conflict"
  | "no_active_settlement_allocation";

export interface SettlementProvenanceError {
  code: SettlementProvenanceErrorCode;
  message: string;
  transaction_id?: number;
}

export const SETTLEMENT_PROVENANCE_MESSAGES: Record<SettlementProvenanceErrorCode, string> = {
  booked_base_missing_or_invalid: "The invoice has no finite positive booked EUR gross amount.",
  invoice_liability_account_missing_or_invalid: "The invoice liability account is missing or invalid.",
  invoice_liability_dimension_invalid: "The invoice liability dimension is invalid.",
  liability_account_assertion_conflict: "The deprecated liability account assertion conflicts with the invoice liability account.",
  linked_transactions_missing: "The partially paid invoice has no linked transactions.",
  linked_transaction_id_invalid: "A linked transaction ID is invalid.",
  linked_transaction_load_failed: "A linked transaction could not be loaded.",
  linked_transaction_identity_conflict: "A loaded transaction identity conflicts with the requested linked transaction ID.",
  linked_transaction_not_confirmed: "An active linked transaction is not confirmed.",
  linked_transaction_direction_conflict: "An active linked transaction is not an outgoing supplier payment.",
  invoice_distribution_missing: "An active linked transaction has no canonical allocation to this purchase invoice.",
  allocation_amount_invalid: "An invoice allocation amount is missing, non-finite, non-positive, or exceeds its transaction.",
  allocation_currency_missing: "An invoice allocation has no explicit source currency.",
  allocation_currency_conflict: "Invoice allocation and transaction currencies conflict.",
  allocation_rate_invalid: "An invoice allocation exchange rate is non-finite or non-positive.",
  allocation_base_invalid: "An allocation or transaction base amount is non-finite or non-positive.",
  allocation_eur_evidence_missing: "An invoice allocation has no authoritative EUR amount evidence.",
  allocation_base_conflict: "Available EUR allocation evidence conflicts by more than one cent or exceeds its transaction base.",
  no_active_settlement_allocation: "No active linked transaction provides a valid allocation to this purchase invoice.",
};

export type InvoiceSettlementProvenance =
  | {
      ok: true;
      liabilityAccountId: number;
      liabilityDimensionId?: number;
      paidEur: number;
      settlementDate?: string;
      contributingTransactionIds: number[];
    }
  | {
      ok: false;
      error: SettlementProvenanceError;
      contributingTransactionIds: number[];
    };

export async function resolveInvoiceSettlementProvenance(
  invoice: PurchaseInvoice,
  loadTransaction: (id: number) => Promise<Transaction>,
  liabilityAccountAssertion?: number,
): Promise<InvoiceSettlementProvenance>;
```

Every error message comes only from `SETTLEMENT_PROVENANCE_MESSAGES`; use `transaction_id` for row identity rather than interpolating IDs or upstream exception text into `message`. Normal candidates add `liability_account_id: number`, `liability_account_dimension_id: number | null`, and deduplicated `contributing_transaction_ids: number[]`. Change `ReconcileCandidate.paid_eur` and `.diff_eur` to `number | null`, add `provenance_error?: SettlementProvenanceError`, and keep `linked_transaction_ids: number[]` exactly as supplied by the invoice. Review candidates use `liability_account_id: number | null` and `liability_account_dimension_id: number | null` so independently proven header values survive while invalid values remain explicitly null; they set both monetary fields to null and carry only fully validated contributing IDs accumulated before failure. That partial list is diagnostic only and is never summed or mutated from. Successful FX-journal liability postings include the invoice dimension only when present. Both successful FX audit details and successful small-rounding audit details include `liability_account_id`, `liability_account_dimension_id`, `linked_transaction_ids`, `contributing_transaction_ids`, and `paid_eur`; audit only after the existing mutation succeeds.

- [ ] **Step 1: Record the clean H07 baseline**

Before editing either file, require `git status --short` to be empty and run:

```bash
npx vitest run src/tools/currency-rounding.test.ts
npm run build
git diff --check
```

Expected: the existing currency-rounding suite, build, and diff check pass. Record exact test counts for the ledger. If the baseline is not green, stop and diagnose rather than mixing an existing failure into H07.

- [ ] **Step 2: Add canonical fixture support and the account/allocation RED matrix**

Mock `logAudit` at module scope in `src/tools/currency-rounding.test.ts`. Update every legacy invoice fixture in this suite with a valid positive `liability_accounts_id` and either `liability_accounts_dimensions_id: null` for account-level posting or a valid positive integer dimension. Update every legacy transaction fixture to describe the accounting evidence it previously implied: a confirmed outgoing `type: "C"` transaction, a non-empty normalized currency, and one canonical matching `items` row for its invoice. Use explicit item `base_amount` for foreign/base fixtures and EUR item `amount` for EUR fixtures. Do not weaken production validation or make either test helper silently synthesize missing liability/allocation provenance; failure-matrix rows must be able to omit or corrupt each field deliberately.

Add `H07 valid provenance` tests proving:
1. An invoice on liability account `2120`, dimension `44`, with one transaction whose total is `100 USD / 90 EUR`, two matching allocations totalling `50 USD / 45 EUR`, and another invoice's allocation uses only `45 EUR`; a `0.50 EUR` residual posts the liability leg to `2120/44`, not `2310`, and never uses the whole `90 EUR` transaction.
2. Multiple matching rows and multiple distinct transactions/currencies sum all per-invoice EUR allocations; a duplicate linked transaction ID is fetched and counted once. The candidate preserves the raw linked-ID order while emitting unique contributing IDs in ascending numeric order.
3. Each derivation path works independently: explicit item base, EUR nominal, item rate, transaction rate, and proportional transaction base/nominal.
4. Redundant agreeing evidence is accepted to the cent; `null`/`undefined` liability dimension produces an account-level posting without an `accounts_dimensions_id` property.
5. An omitted deprecated account assertion and an exactly matching assertion produce identical invoice-derived postings. A conflicting assertion produces review and no mutation.
6. The latest settlement date comes from a contributing transaction, while a later deleted/VOID link cannot move the journal date.
7. The candidate and successful audit carry the exact invoice liability account/dimension, raw linked IDs, deduplicated contributing IDs, allocated paid EUR, and no default-account value.

- [ ] **Step 3: Add the fail-closed RED matrix**

Tag every new case with `H07`. Use table-driven tests where possible. For every review row invoke both dry-run and `execute: true`, assert the exact `provenance_error.code` and stable human-readable `message`, `paid_eur === null`, `diff_eur === null`, `category === "review"`, and zero calls to invoice update, guarded journal creation, journal create/confirm, and `logAudit`.

| Matrix | Required rows | Why the pre-H07 implementation must fail |
|---|---|---|
| Booked/liability | missing/non-finite booked base; missing/zero/fractional/non-finite liability account; zero/negative/fractional/non-finite dimension; conflicting deprecated assertion | It skips missing booked base and otherwise uses a caller/default liability account without validating header provenance. |
| Link identity/load | empty links; malformed ID; load rejection; fetched-ID mismatch | It sums whole fetched transactions and converts load failure into a generic partial-total review. |
| Liveness/status/direction | only deleted; only VOID; PROJECT; missing/unknown status; incoming `D`; valid active plus an invalid active link | It ignores only deleted/VOID, does not require confirmed outgoing settlement evidence, and may mutate from the remaining partial sum. |
| Relations | absent `items`; no canonical invoice relation; wrong `relation_table`; wrong `relation_id` | It never requires relation evidence and uses the entire transaction. |
| Amount/currency | zero/negative/NaN/infinite item amount; missing transaction currency; conflicting item/transaction currency; zero/negative/NaN/infinite present item or transaction rate | It defaults missing currency to EUR and does not validate allocation fields. |
| Base evidence | invalid present item base; invalid present transaction amount/base; foreign allocation with no item base, EUR nominal, item rate, transaction rate, or proportional transaction base; explicit-base vs EUR/item-rate/transaction-rate/proportional disagreement over `0.01`; matching nominal/base sums exceeding transaction totals | It accepts the whole transaction's base/rate and never compares redundant allocation evidence or reports missing EUR evidence precisely. |
| Mutation/output | missing provenance that numerically resembles `small_rounding`; missing provenance that resembles `fx_difference`; review in execute mode | It can update an invoice or create an FX journal from incomplete/defaulted evidence and does not expose exact structured provenance errors. |

Add deterministic-selection regressions with the raw links deliberately reversed and transaction loads completed out of order: two failures with the same code select the smaller requested transaction ID; failures with different codes select the earlier error class even when its transaction ID is larger; and successful contributors are sorted numerically while `linked_transaction_ids` remains raw. Add an explicit foreign-allocation row with no available derivation and require exactly `allocation_eur_evidence_missing` plus its mapped message.

Keep two explicit negative controls in the same tagged block: a valid zero-difference settlement is omitted as before, and deleted/VOID links alongside one valid contributing transaction are ignored without contaminating its amount/date. These controls may already pass and must be reported separately from intended RED assertions.

- [ ] **Step 4: Prove honest RED**

Run:

```bash
npx vitest run src/tools/currency-rounding.test.ts -t "H07"
```

Expected: every new account/allocation/provenance assertion intended to expose H07 fails against the old production code for the stated reason; only the declared zero-difference and ignored-liveness negative controls may pass. Record exact failing/passing counts and inspect each failure. If a supposed regression passes, strengthen its fixture/assertion before production edits instead of treating an unexercised test as RED.

- [ ] **Step 5: Implement the minimal provenance resolver and candidate integration**

In `src/tools/currency-rounding.ts`, remove only `DEFAULT_LIABILITY_ACCOUNT` from the import/use path, update the argument description to deprecated assertion semantics, add the exact types above, and implement small helpers for positive-integer validation, currency normalization, cent agreement, per-row EUR evidence, and `resolveInvoiceSettlementProvenance`. The resolver must perform the contracts in the stated order, fetch each unique link once, retain transaction-rate evidence, collect read-only validation results before deterministic error selection, sort successful contributing IDs numerically, sum all matching rows, and return a discriminated result; it must not catch unrelated errors outside the transaction-load boundary or mutate/audit.

Validate booked base before calling the resolver, then integrate the resolver before categorization. Build a structured review candidate immediately for invalid booked base or a resolver error, respecting the exact precedence above. For a successful result, calculate the existing diff/categories from allocated `paidEur`, preserve zero-diff omission, and carry liability/dimension/contributing IDs through preview and execute. Delete the old `transactionEurAmount` whole-transaction fallback and the default/caller-selected `liabilityAccount` variable. In the FX branch, construct the liability posting from `c.liability_account_id` and conditionally spread `accounts_dimensions_id`; never put the liability dimension on the FX gain/loss leg. Extend successful audit details with the exact provenance fields. Keep threshold classification, VAT/base patch arithmetic, `BookingGuard` idempotency, gain/loss account overrides/defaults, and unrelated response fields unchanged.

- [ ] **Step 6: Prove GREEN and affected behavior**

Run in order:

```bash
npx vitest run src/tools/currency-rounding.test.ts -t "H07"
npx vitest run src/tools/currency-rounding.test.ts
npm run build
git diff --check
```

Expected: all H07 rows and the complete legacy suite pass; TypeScript accepts nullable review amounts and narrowed executable candidates; no default liability import/use remains in `currency-rounding.ts`; diff check is empty. Confirm with:

```bash
rg -n "DEFAULT_LIABILITY_ACCOUNT|liabilityAccount = liability_accounts_id" src/tools/currency-rounding.ts
```

Expected: no output.

- [ ] **Step 7: Full repository verification**

Run each command freshly and retain exact counts/output:

```bash
npm run validate:release
npm test
npm run test:integration
git diff --check
```

Require release metadata, full unit, and integration PASS with only documented baseline skips. A failure must be diagnosed and fixed within the exact two-file scope or escalated before review.

- [ ] **Step 8: Freeze the exact two-file review artifact without touching the real index**

First prove exact tracked scope:

```bash
H07_EXPECTED="$(mktemp)"
H07_ACTUAL="$(mktemp)"
printf '%s\n' \
  src/tools/currency-rounding.test.ts \
  src/tools/currency-rounding.ts | sort -u > "$H07_EXPECTED"
{
  git diff --name-only HEAD
  git ls-files --others --exclude-standard
} | sort -u > "$H07_ACTUAL"
diff -u "$H07_EXPECTED" "$H07_ACTUAL"
rm -f "$H07_EXPECTED" "$H07_ACTUAL"
git diff --cached --quiet
```

Expected: the comparison and real-index check exit 0 with no output. Then package through a copied temporary index:

```bash
mkdir -p .omc/reviews
H07_INDEX="$(mktemp)"
cp "$(git rev-parse --git-path index)" "$H07_INDEX"
GIT_INDEX_FILE="$H07_INDEX" git add -- \
  src/tools/currency-rounding.ts \
  src/tools/currency-rounding.test.ts
GIT_INDEX_FILE="$H07_INDEX" git diff --cached --binary --output=/tmp/H07.frozen.diff
GIT_INDEX_FILE="$H07_INDEX" git diff --cached --check
GIT_INDEX_FILE="$H07_INDEX" git diff --cached --name-only
rm -f "$H07_INDEX"
git diff --cached --quiet
```

Expected: temporary staged names are exactly the two H07 paths, the frozen diff is non-empty, its diff check passes, and the real index remains empty. Use `apply_patch` to create/replace ignored `.omc/reviews/H07.diff` with the exact `/tmp/H07.frozen.diff` content, then require:

```bash
test -s .omc/reviews/H07.diff
cmp /tmp/H07.frozen.diff .omc/reviews/H07.diff
```

Expected: byte equality. Do not review an ordinary working-tree diff or a stale artifact.

- [ ] **Step 9: Independent SPEC review**

Give a fresh non-author reviewer the H07 spec row, this complete Task 10, `.omc/reviews/H07.diff`, baseline output, honest RED matrix/counts, and all GREEN/full verification. Require exactly:

```text
SPEC COMPLIANCE: APPROVED
```

The spec pass must audit invoice-header liability authority; deprecated assertion-only compatibility; optional-dimension semantics; raw/unique/contributing transaction IDs; deleted/VOID handling; confirmed outgoing status; canonical response-side relation names; all-row/multi-transaction allocation; exact item-base/EUR/item-rate/transaction-rate/proportional EUR evidence precedence and redundant-evidence conflict; the precise missing-evidence code/message; precedence-ranked and smallest-ID-stable error selection; numerically sorted contributing IDs with raw linked-ID compatibility; missing booked base; structured nullable review output; valid zero-diff omission; settlement-date provenance; no mutation/audit for review; invoice account/dimension on only the liability leg; successful audit provenance; preserved gain/loss/idempotency behavior; and exact two-file scope.

- [ ] **Step 10: Independent QUALITY review**

Only after SPEC approval, give a different fresh non-author reviewer the same frozen artifact and evidence. Require exactly:

```text
CODE QUALITY: APPROVED
```

The quality pass must inspect finite/positive guards before arithmetic, including present transaction rates; currency normalization without EUR default; exact item-base/EUR/item-rate/transaction-rate/proportional precedence; cent-consistency comparisons across every redundant evidence source; summing all matching rows without double-counting repeated IDs; precedence-ranked errors with smallest-ID tie-breaking independent of async completion; numerically sorted unique contributing IDs; partial diagnostic IDs never becoming executable totals; discriminated-union narrowing; deterministic exact error code/message selection including `allocation_eur_evidence_missing`; settlement-date contribution rules; conditional dimension spread; no broad catch/default fallback; explicit valid liability fields in every legacy invoice fixture; dry-run/execute mutation counts; audit timing/details; public output compatibility; and exact two-file scope. Any rejection or code/test edit invalidates both approvals: rerun Steps 6-8, overwrite the artifact, then restart SPEC followed by QUALITY with fresh reviewers.

- [ ] **Step 11: Final primary verification, exact staging, and commit**

After both approvals, rerun:

```bash
npx vitest run src/tools/currency-rounding.test.ts
npm run build
npm test
npm run test:integration
npm run validate:release
git diff --check
cmp /tmp/H07.frozen.diff .omc/reviews/H07.diff
```

Repeat the Step 8 exact-scope comparison. Only then run:

```bash
git status --short
git add src/tools/currency-rounding.ts src/tools/currency-rounding.test.ts
git diff --cached --name-only
git commit -m "fix(H07): reconcile allocated invoice settlement"
```

Expected: staged names are exactly the two reviewed paths. Do not stage ignored review/ledger artifacts and do not push.

- [ ] **Step 12: Ledger and clean sequential handoff**

Use `apply_patch` to append one H07 row to `.omc/full-codebase-remediation-ledger.md` containing baseline counts, intended RED failures and two negative controls, focused/build/full/integration/release/diff results, byte-matching artifact evidence, ordered fresh SPEC and QUALITY verdicts, and the commit hash. Then run:

```bash
git status --short
```

Expected: empty output. Do not begin H16 or any later finding until the H07 row is complete and the worktree is clean.

### Task 11: H16 — Carry explicit Lightyear FX orientation

**Exact tracked scope (freeze before review):**
- Modify: `src/tools/lightyear-investments.ts`
- Modify: `src/tools/lightyear-investments.test.ts`

Do not change CSV parsing, shared money utilities, public tool schemas, workflow Markdown/mirrors, accounting defaults, `BookingGuard`, audit infrastructure, distribution extraction/booking, gains matching, portfolio classification, or any H17/H18/M26 behavior. H16 may update every existing `tradeFeeInEur` consumer in this source file because they all depend on the corrected return contract, but it must not otherwise redesign their output.

**Authoritative contracts:**
- `AccountStatementRow.fee` is denominated in that row's `ccy`; the existing `InvestmentTrade.fee_eur` name is retained only for output/internal compatibility. For a EUR trade the fee is already EUR. For a foreign trade it is unbookable until a fully reconciled conversion pair proves both a rate and its orientation. Never return or book the raw foreign fee as though it were EUR.
- Export `FxRateOrientation = "eur_per_foreign" | "foreign_per_eur"`. `eur_per_foreign` converts a foreign amount with multiplication; `foreign_per_eur` converts it with division. Add `fx_orientation: FxRateOrientation | null` and `fx_review_reason: FxReviewReason | null` to `InvestmentTrade`; initialize both to `null`. Successful EUR trades keep a null rate/orientation/review reason.
- Shortlist a conversion reference when at least one of its foreign-currency rows is on the trade's statement date and its absolute gross amount matches the trade's absolute gross amount within `0.01`. Zero shortlisted references produce `invalid_conversion_pair`; more than one shortlisted reference retains the existing ambiguous-match stop even if one candidate later appears better. A shortlisted reference is valid only when it contains exactly two rows total: one EUR conversion row and one row in the trade currency. Missing, duplicate, or third rows make that reference review-required rather than allowing `.find()` to pick one.
- Before rate inference, require finite positive absolute gross and net amounts on both conversion rows; finite non-negative fees; gross and net with the same sign on each row; and opposite signs across the EUR and foreign net rows. On each row, `abs(abs(gross_amount) - abs(net_amount))` must equal `abs(fee)` within `0.01`. Both sides carrying a non-zero fee is ambiguous and stops for review. The trade row itself must have finite positive absolute gross/net values, finite non-negative fee, and Buy/Sell gross/net/fee arithmetic agreeing within `0.01`: Buy cash net is gross plus fee, Sell cash net is gross minus fee. A zero trade fee is valid.
- `resolveFxPair(eurNet, foreignNet, rates)` takes positive absolute **net** amounts. A blank CSV rate is represented by zero and is absent, not invalid. Any supplied non-zero rate must be finite and at least `MIN_FX_RATE`; otherwise return `invalid_rate`. At least one supplied rate is required.
- Derive candidates in amount space, never by array order: for each distinct supplied rate, `foreignNet * rate` is the `eur_per_foreign` candidate and `foreignNet / rate` is the `foreign_per_eur` candidate. A direction qualifies only when its rounded EUR result agrees with rounded `eurNet` within `0.01`. A rate qualifying in both directions is `ambiguous_orientation`; a supplied rate qualifying in neither is `contradictory_rate`. Collapse exact duplicate rate values before selection.
- Within one orientation, select the candidate with the smallest unrounded absolute EUR residual. If two distinct rates tie within `1e-12 * max(1, eurNet)` for best residual, return `ambiguous_rate`; exact duplicates were already collapsed and do not create ambiguity. If only one orientation survives, use it. If both survive, require the two selected rates to be reciprocal in amount space: converting `foreignNet` through each must agree within `0.01`; otherwise return `contradictory_rate`. When they agree, deterministically choose the canonical `eur_per_foreign` candidate. Thus `(1126.28, 1303.22, [1.15709, 0.86423])` resolves to `{ rate: 0.86423, orientation: "eur_per_foreign" }`, independent of input order; the current first-rate loop is forbidden.
- `resolveFxPair` returns a discriminated result with a stable code/message. Missing both rates, invalid rate, invalid net evidence, contradictory rates, and ties/orientation ambiguity remain distinct. Do not include raw CSV content in the stable message.
- Conversion-fee EUR uses the same resolved pair: an EUR-side fee is already EUR; a foreign-side fee uses multiply/divide according to the chosen orientation. Reconcile the converted foreign fee against gross-minus-net evidence. No independent `fgnConv.fx_rate`/`eurConv.fx_rate` preference or raw-fee fallback remains in `fxFeeToEur`.
- A reference is added to `consumedConversionRefs`, and its row indexes are added to `conversion_row_indexes`, only after row cardinality, gross/net/fee arithmetic, rate/orientation, and FX-fee conversion all succeed. Any failure leaves `eur_amount === 0`, rate/orientation/conversion reference unset, sets a stable review reason, emits a warning, and keeps both conversion rows unconsumed/unhandled for review.
- Redefine `tradeFeeInEur` to accept `{ ccy, fee_eur, fx_rate, fx_orientation }` and return `number | null`. It returns `0` for an exactly zero finite fee; returns the rounded fee for a EUR trade; converts a positive foreign fee using its proven orientation; and returns `null` for negative/non-finite fees or missing/invalid foreign provenance. No caller may coerce `null` through arithmetic. Booking skips the trade before journal creation/audit; statement and portfolio aggregation preserve their existing response shapes but exclude the unproven amount and carry a review warning instead of using the nominal fee.
- Every warning interpolating a statement `reference` or conversion reference wraps it with `wrapUntrustedOcr`, including parse, booking, and portfolio warnings touched by this finding. Keep ticker/currency tokens and stable reason messages trusted. Preserve registered tool names/input schemas, successful result keys, journal posting semantics, duplicate handling, titles, audit timing, and successful EUR behavior.
- Emit H16 review warnings through one helper in the stable form `<wrapped order ref>: FX review [<code>] <mapped message>` and append ` Conversion <wrapped conversion ref>.` only when a single reference was shortlisted. `parse_lightyear_statement` sets `needs_review: true` whenever any extracted trade has `fx_review_reason`, even if cash reconciliation happens to balance and no conversion row exists. Booking and portfolio reuse the same mapped reason instead of inventing a second explanation.
- H16 exports the orientation/result types and `resolveFxPair` in a form H17 can reuse for distribution FX provenance. Do not add distribution fields, pair distributions to conversions, or change distribution journal amounts in this task.

Use these exact public/local shapes:

```ts
export type FxRateOrientation = "eur_per_foreign" | "foreign_per_eur";

export type FxReviewCode =
  | "invalid_net_amount"
  | "missing_rate"
  | "invalid_rate"
  | "contradictory_rate"
  | "ambiguous_orientation"
  | "ambiguous_rate"
  | "invalid_conversion_pair"
  | "conversion_amount_conflict"
  | "conversion_fee_conflict"
  | "trade_amount_conflict"
  | "trade_fee_unresolved";

export interface FxReviewReason {
  code: FxReviewCode;
  message: string;
}

export type FxPairResolution =
  | { ok: true; rate: number; orientation: FxRateOrientation }
  | { ok: false; reason: FxReviewReason };

export const FX_REVIEW_MESSAGES: Record<FxReviewCode, string> = {
  invalid_net_amount: "The conversion pair has missing or invalid net amount evidence.",
  missing_rate: "The conversion pair has no exchange-rate evidence.",
  invalid_rate: "The conversion pair contains an invalid exchange rate.",
  contradictory_rate: "The conversion rates contradict the paired EUR and foreign net amounts.",
  ambiguous_orientation: "A conversion rate fits both exchange-rate orientations.",
  ambiguous_rate: "Multiple exchange rates fit equally well and cannot be selected deterministically.",
  invalid_conversion_pair: "The conversion reference does not contain one unambiguous EUR/foreign row pair.",
  conversion_amount_conflict: "The conversion gross, net, sign, or fee arithmetic is inconsistent.",
  conversion_fee_conflict: "The conversion fee cannot be attributed and converted to EUR unambiguously.",
  trade_amount_conflict: "The trade gross, net, or fee arithmetic is inconsistent.",
  trade_fee_unresolved: "The foreign-currency trade fee has no proven EUR conversion.",
};

export function resolveFxPair(
  eurNet: number,
  foreignNet: number,
  rates: number[],
): FxPairResolution;

export function tradeFeeInEur(trade: {
  ccy: string;
  fee_eur: number;
  fx_rate: number | null;
  fx_orientation: FxRateOrientation | null;
}): number | null;
```

Every review reason uses only `FX_REVIEW_MESSAGES[code]`. Conversion/trade references are separate wrapped warning context, never interpolated into `message`.

- [ ] **Step 1: Record the clean H16 baseline**

Before editing either file, require an empty worktree and run:

```bash
git status --short
npx vitest run src/tools/lightyear-investments.test.ts
npm run build
git diff --check
```

Expected at plan time: `src/tools/lightyear-investments.test.ts` passes **24/24**, the build passes, and the diff check is empty. Re-record the actual counts at execution time for the ledger. If baseline state differs, stop and diagnose instead of mixing it into H16.

- [ ] **Step 2: Add the rate-orientation and fee-conversion RED matrix**

Change the test import to a namespace import so the old module can load while the not-yet-exported resolver is asserted dynamically:

```ts
import * as lightyearInvestments from "./lightyear-investments.js";

const { registerLightyearTools, tradeFeeInEur } = lightyearInvestments;
```

Tag every new test with `H16`. Add direct tests that prove:
1. `tradeFeeInEur` multiplies `10` by `0.9` for `eur_per_foreign` and divides `10` by `1.111111...` for `foreign_per_eur`, returning `9` in each case.
2. EUR fee `1.50` with null rate/orientation remains `1.50`; an exact zero remains zero. These are negative controls.
3. A positive USD fee with missing rate, missing orientation, invalid/near-zero/non-finite rate, or ambiguous provenance returns `null`, never the raw fee. Negative/non-finite fees also return `null` rather than silently becoming zero.
4. Every current consumer is exercised: `parse_lightyear_statement` ticker totals, `book_lightyear_trades` buy and sell postings, and `lightyear_portfolio_summary` cost/proceeds. Use one coherent pair for each orientation and assert the exact converted fee, not just a successful status.

Use `(eurNet=1126.28, foreignNet=1303.22)` for resolver regressions. Through `(lightyearInvestments as any).resolveFxPair`, assert:
- `[1.15709, 0.86423]` and its reverse both choose `{ rate: 0.86423, orientation: "eur_per_foreign" }`;
- `[0.86423]` chooses multiply and `[1.15709]` chooses divide;
- duplicate `[0.86423, 0.86423]` is accepted once;
- no rates or `[0, 0]` return `missing_rate`; negative/near-zero/non-finite non-zero rates return `invalid_rate`; `[7]` and `[0.86423, 7]` return `contradictory_rate`;
- a near-parity amount/rate that qualifies in both directions returns `ambiguous_orientation`;
- two distinct same-orientation rates with an equal best residual return `ambiguous_rate` rather than depending on array order;
- zero, negative, NaN, or infinite EUR/foreign nets return `invalid_net_amount`;
- a valid reciprocal pair whose two directions disagree by more than a cent is rejected. Do not assert only truthiness: assert the entire discriminant, code, and stable mapped message.

- [ ] **Step 3: Add extraction, provenance, and fail-closed RED integration tests**

Build coherent CSV fixtures whose economics are explicit:

```ts
const coherentSellPair = [
  ["10/11/2025 13:40:29", "CN-GZUJLSKLL2", "", "", "Conversion", "", "EUR", "", "1126.28", "1.15709", "0.00", "1126.28", ""],
  ["10/11/2025 13:40:29", "CN-GZUJLSKLL2", "", "", "Conversion", "", "USD", "", "-1307.80", "0.86423", "4.58", "-1303.22", ""],
  ["10/11/2025 08:51:32", "OR-ARAW6RQL67", "VUAA", "IE00BK5BQT80", "Sell", "10", "USD", "130.78", "1307.80", "", "0.00", "1307.80", ""],
];
```

For a buy fixture, use opposite conversion signs and amounts/rates that reconcile to the same cent; do not retain the current incoherent `1307.80 EUR / 1131.92 USD` idempotency fixture. Update that legacy fixture's amounts only so its duplicate-guard purpose survives H16.

Add handler-level tests proving:
1. A fully coherent pair exposes no H16 warning, consumes exactly its two conversion rows, preserves the EUR net amount, converts the foreign conversion fee using the resolved orientation, converts the trade fee using that same orientation, and produces exact balanced buy/sell postings.
2. Net rather than gross amounts drive rate orientation. The `1126.28/1303.22` example must choose `0.86423 eur_per_foreign`, while the `4.58 USD` conversion fee becomes `3.96 EUR`; gross/net/fee reconciliation remains separately asserted.
3. Missing one rate succeeds when the other rate proves one direction; both rates missing stop. Reciprocal rate pairs are order-independent; exact duplicate rates are harmless.
4. Missing EUR or foreign row, duplicate EUR or foreign rows, any third row under the same conversion reference, same-sign pair rows, zero net evidence, negative fees, gross/net/fee mismatch, both conversion rows charging a fee, contradictory rates, ambiguous orientation/rate, and foreign trade gross not matching the conversion all leave the trade unbookable. Non-finite amounts/rates are tested directly on the pure resolver/converter because `parseNumber` rejects them before extraction; do not weaken CSV parsing merely to reach H16.
5. Buy `net = gross + fee` and Sell `net = gross - fee` are accepted to one cent; contradictions in either direction stop. EUR trades remain bookable without FX provenance, but malformed EUR trade fee arithmetic stops instead of bypassing H16.
6. Each stopped case emits the exact stable reason code/message in wrapped warning context; leaves rate/orientation/ref/indexes unset; does not add the conversion ref to consumed refs; leaves conversion rows in `unhandled`; sets `needs_review`; and, for `book_lightyear_trades` with `dry_run: false`, creates no journal and writes no audit event.
7. `parse_lightyear_statement`, `book_lightyear_trades`, and `lightyear_portfolio_summary` never add a raw foreign fee when `tradeFeeInEur` is null. Their output shapes and successful keys stay unchanged; affected totals omit the unproven amount and warnings identify review rather than fabricating EUR.
8. Every warning path touched here wraps both the order reference and conversion reference with `UNTRUSTED_OCR` delimiters. Add an injection-shaped value for each and assert raw text never appears outside a wrapper.

Keep explicit negative controls for a valid EUR trade with a fee, a valid foreign trade with zero fee, exact duplicate rate values, a valid single-rate pair, and the existing multiple-conversion-reference ambiguity behavior. Controls may pass against old code and must be reported separately from intended RED cases.

- [ ] **Step 4: Prove honest RED against old production**

Run:

```bash
npx vitest run src/tools/lightyear-investments.test.ts -t "H16"
```

Expected: the missing dynamic `resolveFxPair` export, multiply orientation, null-on-unproven-fee, pair reconciliation, fee provenance, consumption, and no-booking assertions fail for their stated H16 reasons. Only the declared EUR/zero-fee/legacy ambiguity negative controls may pass. Record exact pass/fail counts and inspect every failure. If an intended regression passes because the fixture does not reach the vulnerable arithmetic, strengthen the test before editing production.

- [ ] **Step 5: Implement the minimal orientation/provenance resolver**

In `src/tools/lightyear-investments.ts`, add the exact exported types/messages/signatures above near `InvestmentTrade`. Implement small pure helpers for normalized currency, finite positive/non-negative values, cent agreement, foreign-to-EUR conversion, trade gross/net/fee validation, conversion-row validation, deterministic best-rate selection, and pair reconciliation.

Replace `fxFeeToEur(eurConv, fgnConv)` with a resolver that accepts the already proven `FxPairResolution & { ok: true }`, rejects dual/unreconciled fees, and uses the chosen orientation for a foreign fee. Replace the unconditional divide in `tradeFeeInEur` with the exact nullable contract. Do not throw or return a nominal fallback for bad foreign provenance.

In `extractTrades`, retain date+foreign-gross candidate matching but validate row cardinality explicitly, call the pair/fee resolvers, and set `eur_amount`, `fx_rate`, `fx_orientation`, `fx_fee_eur`, `conversion_ref`, indexes, and consumed ref atomically only after full success. On failure set `fx_review_reason`, emit one stable wrapped warning for that trade/ref, and leave all monetary/provenance defaults untouched. Do not mark a failed candidate consumed.

Update every `tradeFeeInEur` call in the statement summary, booking loop, and portfolio summary. Narrow `number | null` explicitly before arithmetic. Booking treats `fx_review_reason !== null`, missing foreign orientation, or null trade-fee conversion as review/skipped before building postings or auditing. Summary/portfolio retain existing payload shapes and existing H16 warnings, but use zero only as an explicitly review-marked display aggregate after excluding the unproven fee; they never claim the raw nominal amount is EUR. Wrap references in the portfolio warning and all new warnings. Keep successful EUR, gain/cost-basis, FX-expense, idempotency, progress, and duplicate paths unchanged.

- [ ] **Step 6: Prove focused GREEN and call-site coverage**

Run in order:

```bash
npx vitest run src/tools/lightyear-investments.test.ts -t "H16"
npx vitest run src/tools/lightyear-investments.test.ts
npm run build
git diff --check
rg -n "tradeFeeInEur\(" src/tools/lightyear-investments.ts
```

Expected: all H16 and legacy Lightyear tests pass; build/diff check pass; the search shows the function definition plus exactly the statement-summary, booking, portfolio-buy, and portfolio-sell consumers, and manual inspection confirms every consumer narrows null before arithmetic. Also run:

```bash
rg -n "fee_eur / rate|return trade\.fee_eur|fgnConv\.fx_rate|eurConv\.fx_rate" src/tools/lightyear-investments.ts
```

Expected: no unconditional-divide/raw-fee fallback or row-order fee conversion remains. A legitimate orientation-specific division inside the new conversion helper is allowed only if this search pattern is adjusted and inspected explicitly rather than waived broadly.

- [ ] **Step 7: Full repository verification**

Run freshly and retain exact counts/output:

```bash
npm run validate:release
npm test
npm run test:integration
git diff --check
```

Require release metadata, full unit, and integration PASS with only documented baseline skips. Diagnose any failure; do not expand beyond the exact two-file H16 scope without stopping for plan review.

- [ ] **Step 8: Freeze the exact two-file artifact without touching the real index**

Prove exact tracked scope:

```bash
H16_EXPECTED="$(mktemp)"
H16_ACTUAL="$(mktemp)"
printf '%s\n' \
  src/tools/lightyear-investments.test.ts \
  src/tools/lightyear-investments.ts | sort -u > "$H16_EXPECTED"
{
  git diff --name-only HEAD
  git ls-files --others --exclude-standard
} | sort -u > "$H16_ACTUAL"
diff -u "$H16_EXPECTED" "$H16_ACTUAL"
rm -f "$H16_EXPECTED" "$H16_ACTUAL"
git diff --cached --quiet
```

Expected: comparison and real-index check exit 0 silently. Package with a copied temporary index:

```bash
mkdir -p .omc/reviews
H16_INDEX="$(mktemp)"
cp "$(git rev-parse --git-path index)" "$H16_INDEX"
GIT_INDEX_FILE="$H16_INDEX" git add -- \
  src/tools/lightyear-investments.ts \
  src/tools/lightyear-investments.test.ts
GIT_INDEX_FILE="$H16_INDEX" git diff --cached --binary --output=/tmp/H16.frozen.diff
GIT_INDEX_FILE="$H16_INDEX" git diff --cached --check
GIT_INDEX_FILE="$H16_INDEX" git diff --cached --name-only
rm -f "$H16_INDEX"
git diff --cached --quiet
```

Expected: temporary staged names are exactly the two H16 paths, the artifact is non-empty, and the real index remains empty. Use `apply_patch` to create/replace ignored `.omc/reviews/H16.diff` with the exact `/tmp/H16.frozen.diff` bytes, then require:

```bash
test -s .omc/reviews/H16.diff
cmp /tmp/H16.frozen.diff .omc/reviews/H16.diff
```

- [ ] **Step 9: Independent SPEC review**

Give a fresh non-author reviewer the H16 spec row, this complete Task 11, `.omc/reviews/H16.diff`, baseline output, honest RED counts/matrix, and all GREEN/full verification. Require exactly:

```text
SPEC COMPLIANCE: APPROVED
```

The SPEC pass must audit exact two-file scope; net-based rate inference; finite/positive amounts/rates; blank-versus-invalid rate semantics; exact duplicate handling; smallest-residual selection; deterministic canonical EUR-per-foreign preference for the `1126.28/1303.22` reciprocal pair independent of rate order; reciprocal consistency; tie/orientation ambiguity; gross/net/sign/fee reconciliation; one/both missing rates; contradiction stop; orientation-aware trade and conversion fees; no raw foreign-fee fallback; atomic consumed conversion provenance; wrapped warnings; no journal/audit on review; all four `tradeFeeInEur` consumers; successful EUR/output/idempotency compatibility; and reusable H17 types without H17 implementation.

- [ ] **Step 10: Independent QUALITY review**

Only after SPEC approval, give a different fresh non-author reviewer the same frozen artifact and evidence. Require exactly:

```text
CODE QUALITY: APPROVED
```

The QUALITY pass must inspect discriminated-union narrowing; finite guards before arithmetic; cent comparisons in amount space; exact-duplicate collapse; deterministic residual/tie ordering; no rate-array-order dependency; reciprocal canonicalization; cardinality checks instead of `.find()`; Buy/Sell and conversion gross/net/fee rules; atomic provenance assignment/consumption; nullable fee conversion at every call site; no broad catch or nominal fallback; stable mapped reason messages; untrusted reference wrapping; focused fixtures that fail old production; successful response/schema compatibility; and exact two-file scope. Any rejection or code/test edit invalidates both approvals: rerun Steps 6-8, overwrite the artifact, then restart SPEC followed by QUALITY with fresh reviewers.

- [ ] **Step 11: Final primary verification, exact staging, and commit**

After both approvals, rerun:

```bash
npx vitest run src/tools/lightyear-investments.test.ts
npm run build
npm test
npm run test:integration
npm run validate:release
git diff --check
cmp /tmp/H16.frozen.diff .omc/reviews/H16.diff
```

Repeat the Step 8 exact-scope comparison. Only then run:

```bash
git status --short
git add src/tools/lightyear-investments.ts src/tools/lightyear-investments.test.ts
git diff --cached --name-only
git commit -m "fix(H16): preserve Lightyear FX orientation"
```

Expected: staged names are exactly the two reviewed H16 paths. Do not stage ignored review/ledger artifacts and do not push.

- [ ] **Step 12: Ledger and clean sequential handoff**

Use `apply_patch` to append one H16 row to `.omc/full-codebase-remediation-ledger.md` containing the baseline count, intended RED failures and negative controls, focused/build/full/integration/release/diff evidence, byte-matching artifact evidence, ordered fresh SPEC and QUALITY verdicts, and the commit hash. Then run:

```bash
git status --short
```

Expected: empty output. Do not begin H17 or any later finding until H16 is committed, recorded, and clean.

### Task 12: H17 — Preserve distribution currency and EUR values

**Exact tracked scope (freeze before review):**
- Modify: `src/tools/lightyear-investments.ts`
- Modify: `src/tools/lightyear-investments.test.ts`

Do not change CSV parsing, shared money utilities, registered tool names/input schemas, workflow Markdown/mirrors, accounting defaults, `BookingGuard`, audit infrastructure, trade journal calculations, capital-gains matching, portfolio calculations, or any H18/M26 behavior. H17 may add one separate read-only trade-reservation pre-pass solely to prevent a distribution from reusing or laundering trade FX evidence. The committed H16 `extractTrades` implementation from `332605a` is a byte-for-byte boundary for H17: preserve its local `conversionsByRef` construction, full-reference shortlist scan, `consumedConversions` filtering/insertion, candidate order, validation/resolution flow, warnings, accepted/rejected trades, conversion provenance, and postings without edits or helper substitution. B uses an entirely separate reservation-only index and set; it must not be called by, shared with, or used to optimize/refactor `extractTrades`.

**Authoritative contracts:**
- `AccountStatementRow.gross_amount`, `net_amount`, `tax_amount`, and `fee` are denominated in that row's `ccy`. Preserve the normalized uppercase currency and the four original nominal values on every extracted distribution. Never label a foreign nominal value as EUR and never use it in an EUR journal posting, summary total, or audit amount.
- Export `LightyearDistribution` with explicit nullable EUR/provenance/review fields. A valid EUR row has rounded EUR values equal to its source values, null FX provenance, and null review reason. A valid foreign row has all four EUR values, one proven FX provenance object, and null review reason. Any unresolved/malformed row keeps its nominal evidence but has all four EUR values and provenance null plus one stable `FxReviewReason`.
- Before FX matching, normalize `ccy` with `trim().toUpperCase()` and require it to be non-empty. Require finite positive `gross_amount`; finite non-negative `net_amount`, `tax_amount`, and `fee`; and `gross_amount === net_amount + tax_amount + fee` within `0.01`. A foreign row additionally requires positive net cash because its authoritative EUR value must come from a cash conversion. Invalid source arithmetic is review-required even for EUR; it is never repaired from a subset of fields.
- Before either trade or distribution extraction, run a separate complete `collectTradeReservedConversionRefs(rows)` pre-pass over all statement Buy/Sell and Conversion rows. Build the entire reservation union before returning it; never derive it from H16's successful `consumedConversionRefs`, mutation timing, full shortlist/cardinality result, or row iteration order. The returned immutable set is exactly `strictH17Ownership ∪ legacyH16ShortlistOwnership`:
  - **A — strict H17 conservative ownership.** Define `statementDay(value)` as `parseLightyearDate(value).split(/[T ]/)[0]`, accepted only when it is a real calendar date in exact `YYYY-MM-DD` form (UTC year/month/day round-trip); use that helper on both trade and conversion rows. A Buy/Sell row supplies A evidence only when its strict day succeeds and `abs(trade.gross_amount)` is finite and positive. A conversion row supplies A evidence only when its strict day succeeds, `normalizedCurrency(conversion.ccy)` is non-empty and not EUR, and `abs(conversion.gross_amount)` is finite and positive. For a non-empty non-EUR trade currency, require the same strict day and the same normalized non-empty non-EUR conversion currency. For a blank/whitespace trade currency, conservatively accept any same-day non-empty non-EUR conversion currency. Explicit EUR trades match none. In both currency lanes require the actual raw absolute-gross residual to satisfy `residual <= 0.01 + min(1e-9, Number.EPSILON * max(1, abs(trade gross), abs(conversion gross)) * 4)`; no cent-rounding surrogate may replace this predicate. Blank-currency or zero/non-positive conversion evidence is not A evidence. Quantity, net, fee, reference text, pair cardinality/sign/rate, and eventual H16 acceptance do not weaken otherwise usable A evidence, so malformed-net/fee trades still reserve through A.
  - **B — frozen H16 legacy-shortlist ownership.** For every Buy/Sell row that passes the existing `validateTradeAmounts` gate, is not normalized EUR, and therefore reaches committed H16 matching, reserve every conversion reference with at least one conversion row for which the committed predicates hold: equal raw date prefix, exact normalized currency equality (including blank-equals-blank), and `agreesToCent(abs(conversion.gross_amount), abs(trade.gross_amount))`. B intentionally preserves committed H16 blank conversion currency, rounded-zero conversion gross, invalid-calendar raw-prefix, and cent-rounded shortlist semantics that A rejects. Preserve every matching reference when the committed full shortlist is ambiguous; candidate pair cardinality, rates, direction, later pair rejection, and whether another trade ultimately consumes the reference do not remove B ownership. Consequently a conversion gross of `85.014` is B-owned by a qualifying trade gross of `85.000` even though A's strict raw-residual predicate does not match it. A failed `statementDay` only disables A and is not a blanket “reserve nothing” rule.
- The union is ownership-only: it cannot change H16 extraction output, warnings, accepted/rejected trades, consumed references, postings, or handled/ignored/unhandled classification. Valid ordinary trades, cash-equivalent trades, ambiguous shortlists, and pair/rate-rejected trades reserve all A/B matches; malformed net/fee evidence reserves through A when its strict day/currency/gross evidence is usable; explicit EUR and evidence satisfying neither A nor B reserve nothing. `parse_lightyear_statement` and `book_lightyear_distributions` compute and pass the completed immutable union independently of `extractTrades`. A reference in this union is never available to a distribution, so no reference can be owned by both a trade and a distribution even where H16 and H17 amount tolerances differ.
- Keep the reservation pre-pass near-linear without materializing trade-to-reference edge arrays. A uses raw-gross-sorted indexes keyed by strict day plus exact non-empty non-EUR currency, with a second strict-day/all-non-EUR index for blank-trade wildcard probes; binary-search the exact raw interval implied by A's residual formula so both matches and misses are output-sensitive, then run the exact raw predicate above. Do not use adjacent rounded-cent bucket probes for A. B uses a separate raw-prefix/normalized-currency index sorted by the committed rounded amount; binary-bound the legacy interval and run the exact committed `agreesToCent` predicate. A/B probe-cache keys include the ownership mode, exact day or raw prefix, exact-versus-wildcard normalized currency rule, exact finite raw gross identity, and strict-residual-versus-legacy predicate identity; a rounded-cent bucket alone is not a valid cache identity. Mutable indexes exist only inside this reservation pre-pass: after a reference is inserted into the reservation set, unlink all of that reference's evidence memberships from both reservation indexes, allowing each indexed evidence row/reference to be processed and removed only a bounded number of times. Do not repeatedly rescan shared ranges for distinct raw misses, do not retain per-trade edge sets, and return only the final immutable set.
- Build each foreign distribution's `rawCandidateRefs` from every conversion reference having at least one row in the distribution currency, with the same successful `statementDay`, and absolute conversion **gross** equal to the distribution's positive nominal `net_amount` within `0.01`. Gross is the pre-conversion cash consumed; do not match against distribution gross income or select by input/reference order. `availableCandidateRefs = rawCandidateRefs - tradeReservedConversionRefs`. A sole reserved raw candidate therefore becomes an ownership failure with useful warning context; reserved references do not participate in distribution assignment.
- Build the complete distribution-to-available-reference candidate graph before consuming anything. A distribution must have exactly one available reference, and that reference must be available to exactly one distribution. Zero available candidates, multiple available candidates, or one available reference claimed by multiple distributions make every affected distribution review-required and consume no conversion row. This prevents greedy CSV-order-dependent assignment. A non-reserved unique candidate may still be used when an unrelated reserved raw candidate also matched; only the available graph controls assignment.
- A uniquely assigned reference is valid only when it contains exactly two rows total: one EUR row and one row in the distribution currency; both rows are on the distribution date; the EUR net is positive; and the foreign net is negative. Reuse H16's conversion gross/net/sign/finite/fee validation and `resolveFxPair(abs(eurNet), abs(foreignNet), rates)`. Missing/duplicate/third rows, wrong date/currency/flow, missing/invalid/contradictory/ambiguous rates, or amount disagreement stop for review. Canonicalize `fx_provenance.conversion_row_indexes` as `[eurRow.row_index, foreignRow.row_index]`, regardless of CSV row ordering.
- H17 does not invent an accounting allocation for an FX conversion fee. A non-zero fee on either conversion row uses the existing `conversion_fee_conflict` review reason, leaves both rows unconsumed, and creates no journal. Distribution-row `fee` is distinct and is converted like tax/income. Supporting a separately posted conversion fee would require a new reviewed contract and is outside this finding.
- On a proven zero-conversion-fee pair, `net_eur` is the rounded absolute EUR conversion net and is authoritative. Convert nominal tax and distribution fee with H16's proven multiply/divide orientation, rejecting non-finite results. Set `gross_eur = roundMoney(net_eur + tax_eur + fee_eur)` so the journal balances, and require it to agree within `0.01` with direct conversion of nominal gross. Any component/reconciliation contradiction stops for review. Add the conversion reference and its two row indexes to distribution provenance/consumed output only after every check succeeds.
- Use stable mapped reasons only. Add `distribution_currency_missing` and `distribution_amount_conflict` to `FxReviewCode`/`FX_REVIEW_MESSAGES`; reuse H16 rate/pair/conversion codes for shared failures. No mapped message contains raw CSV content. Emit one warning per reviewed distribution in the stable form `<wrapped distribution ref>: distribution review [<code>] <mapped message>`. Append ` Conversion <wrapped conversion ref>.` when the distribution's raw candidate set contains exactly one reference, including a shared-owner or structurally invalid candidate; omit candidate context for zero or multiple references. Wrap both reference contexts with `wrapUntrustedOcr`; do not broaden this task into M26's general imported-field output hardening.
- Choose one review reason deterministically with this precedence: (1) blank source currency -> `distribution_currency_missing`; (2) invalid nominal distribution finite/sign/reconciliation evidence -> `distribution_amount_conflict`; (3) zero/multiple/shared/reserved candidate ownership, wrong pair cardinality, missing/duplicate EUR or foreign side, third/other-currency row, or pair row on the wrong date -> `invalid_conversion_pair`; (4) zero or non-finite **absolute conversion-net magnitude** on either side -> `invalid_net_amount`; (5) conversion gross/net/sign/fee arithmetic or signed direction failure (anything other than EUR net positive and foreign net negative) -> `conversion_amount_conflict`; (6) any non-zero conversion fee after otherwise valid conversion arithmetic -> `conversion_fee_conflict`; (7) the exact `resolveFxPair` failure (`missing_rate`, `invalid_rate`, `ambiguous_orientation`, `ambiguous_rate`, or `contradictory_rate`); (8) non-finite component conversion or converted gross/component reconciliation failure -> `distribution_amount_conflict`. A valid foreign conversion net is signed negative but has a positive absolute magnitude and must never be classified as `invalid_net_amount` merely because of its sign. Validate/classify the complete candidate evidence before selecting this precedence, so CSV/rate order and exception timing cannot choose the public reason. Source-row defects outrank candidate defects; graph/cardinality defects outrank pair/rate defects; pair amount/flow and fee defects outrank rate defects.
- In `parse_lightyear_statement`, include successful distribution conversion row indexes in `handledRowIndexes`; failed/ambiguous distribution conversion rows remain unhandled. Keep H16 visibility categories distinct: conversion rows belonging to a valid ordinary trade are handled by that trade, conversion rows belonging to a successfully extracted cash-equivalent trade stay in `ignoredRowIndexes`, and conversion rows only reserved by a rejected/ambiguous trade remain unhandled. Do not assert that every distribution reservation makes its conversion rows unhandled. Add distribution warnings to `warnings` and set `needs_review` when any distribution has a review reason.
- The parse summary's exact structured distribution object is `{ count, bookable_count, review_count, total_eur }`, where `count = distributions.length`, `bookable_count = distributions.filter(isBookableDistribution).length`, `review_count = count - bookable_count`, and `total_eur = roundMoney(sum(bookable gross_eur))`; unresolved nominal values contribute zero only to this explicitly partial total and are disclosed by `review_count`. Preserve the existing top-level trade/deposit/withdrawal/cash/unhandled keys. With `include_rows=true`, render exactly `| Date | Ref | Ticker | CCY | Gross CCY | Tax CCY | Fee CCY | Net CCY | Gross EUR | Tax EUR | Fee EUR | Net EUR | Status | FX |`. Date is the parsed date; Ref is wrapped; Ticker is the existing ticker or `—`; CCY is normalized; all nominal and present EUR monetary cells use `.toFixed(2)` and absent EUR cells use `—`; Status is `bookable` or `manual_review:<code>`; and FX is `source_eur`, `<rate> <orientation> via <wrapped conversion ref>`, or `—`. The distribution and conversion references in this table are wrapped; existing trade/cash sections remain unchanged.
- `isBookableDistribution` is true only when `fx_review_reason === null`, all four EUR fields are finite/non-negative with positive `gross_eur`, their sum reconciles, and either `currency === "EUR" && fx_provenance === null` or `currency !== "EUR" && fx_provenance !== null`. Every parser and booking count/filter uses this one predicate; nullable fields are not independently reinterpreted at call sites.
- In `book_lightyear_distributions`, first partition `bookable` and `reviewed` before account requirements, duplicate lookup, or mutation. If `bookable.length === 0`, return the complete manual-review payload immediately without `getAccounts`, `BookingGuard.load`/journal `listAll`, journal create, or audit, even when the caller supplied optional overrides. If any bookable row exists, preserve caller-input compatibility: validate every caller-provided `reward_account`, `tax_account`, and `fee_account` override even when no bookable row uses that override. Demand/validate a **default** optional account only when a bookable consumer needs it: default reward account only for a bookable Reward, missing tax account errors only for bookable `tax_eur > 0`, and default fee account only for bookable `fee_eur > 0`. Validate broker/income as existing booking requires, then load `BookingGuard` and perform duplicate checks over bookable rows.
- Reviewed booking rows have exactly `{ reference, ticker, date, currency, gross_amount, tax_amount, fee, net_amount, gross_eur: null, tax_eur: null, fee_eur: null, net_eur: null, fx_provenance: null, status: "manual_review", review_reason: { code, message } }`. A bookable non-duplicate result has the same source/EUR/provenance fields, omits `review_reason`, and has status `would_create`, `created`, or the existing create-race `duplicate`. Top-level formulas are exact: `total_distributions = all.length`, `bookable_distributions = bookable.length`, `review_required = reviewed.length`, `new_entries = bookable non-duplicates after snapshot/in-file dedupe`, and `duplicates_skipped = bookable snapshot/in-file duplicates`; `results` contains every reviewed row plus every bookable non-snapshot/in-file-duplicate row in original source-row order, while `duplicate` create-race outcomes remain present as today. Existing pre-detected duplicates remain summarized by `duplicates_skipped` and absent from `results`. `warnings` is omitted when extraction warnings are empty and otherwise equals the source-order H17 warning list. The all-reviewed early response therefore has mode, the five zero/proven count fields (`total_distributions` remains the source count), manual-review results, warnings, and the existing note, but no duplicate/guard side effects. Reviewed rows never reach `BookingGuard`, create a journal, or emit audit.
- Every distribution journal remains `cl_currencies_id: "EUR"` and uses only `net_eur`, `tax_eur`, `fee_eur`, and `gross_eur`: debit broker/tax/fee and credit the existing reward-or-income account. Preserve titles, dimensions, project status, duplicate recovery, and audit timing. Dry-run/created results expose source currency and nominal amounts alongside the four EUR values and provenance. The CREATED audit summary uses `gross_eur`; details retain source currency/nominal evidence, EUR values, FX provenance, and exact postings. No dry-run, duplicate, or review result writes an audit event.
- Successful EUR dividends/interest/rewards remain backward-compatible: same accounts, postings, journal title/key, result status, and duplicate counts, with only additive currency/EUR/provenance fields. A stray conversion beside an EUR distribution is never consumed. H18 gains tolerance and M26 imported-string hardening remain untouched.

Use these exact shapes:

```ts
export interface DistributionFxProvenance {
  rate: number;
  orientation: FxRateOrientation;
  conversion_reference: string;
  conversion_row_indexes: [number, number];
}

export interface LightyearDistribution {
  row_index: number;
  date: string;
  reference: string;
  type: AccountStatementRow["type"];
  ticker: string;
  isin: string;
  currency: string;
  gross_amount: number;
  fee: number;
  net_amount: number;
  tax_amount: number;
  gross_eur: number | null;
  fee_eur: number | null;
  net_eur: number | null;
  tax_eur: number | null;
  fx_provenance: DistributionFxProvenance | null;
  fx_review_reason: FxReviewReason | null;
}

interface DistributionExtractionResult {
  distributions: LightyearDistribution[];
  warnings: string[];
  consumedConversionRefs: Set<string>;
}
```

`distribution_currency_missing` maps to `"The distribution has no explicit source currency."`; `distribution_amount_conflict` maps to `"The distribution gross, net, tax, fee, or converted EUR amounts are inconsistent."` Every failure uses `FX_REVIEW_MESSAGES[code]`, not an ad hoc string.

- [ ] **Step 1: Record the clean H17 baseline**

Before editing either implementation path, require that the H16 commit and ledger are complete and the worktree/index are clean. Run:

```bash
git status --short
npx vitest run src/tools/lightyear-investments.test.ts
npm run build
git diff --check
```

Plan-time evidence on 2026-07-16 is **87/87** tests passing in the Lightyear file, with build/diff check passing and empty status. Re-record actual execution-time counts for the ledger. If the baseline differs, diagnose it before adding H17 tests.

- [ ] **Step 2: Add the successful USD/EUR provenance RED tests**

Tag every new test with `H17`. Add a coherent USD dividend fixture with one foreign-to-EUR zero-fee conversion pair on the same date:

```ts
const rows = [
  ["01/03/2026 12:00:00", "CN-H17", "", "", "Conversion", "0", "USD", "0", "-85.00", "0.9", "0", "-85.00", "0"],
  ["01/03/2026 12:00:00", "CN-H17", "", "", "Conversion", "0", "EUR", "0", "76.50", "1.111111111111", "0", "76.50", "0"],
  ["01/03/2026 10:00:00", "DIV-H17", "USCO", "US0000000001", "Dividend", "0", "USD", "0", "100.00", "0", "0", "85.00", "15.00"],
];
```

Through `parse_lightyear_statement`, assert exact summary `{ count: 1, bookable_count: 1, review_count: 0, total_eur: 90 }`; the include-rows table shows normalized `USD`, nominal gross/net/tax/fee `100.00/85.00/15.00/0.00`, EUR gross/net/tax/fee `90.00/76.50/13.50/0.00`, status `bookable`, and FX `0.9 eur_per_foreign via <wrapped CN-H17>`; both conversion rows are handled rather than unhandled; and no warning appears. The parser does not expose structured `fx_provenance` or numeric conversion row indexes, so do not assert those fields on this surface. Repeat with only the reciprocal divide rate present and assert the corresponding table FX cell to prove H16 orientation reuse.

Through `book_lightyear_distributions` in dry-run and execute modes, provide `tax_account` and assert exactly these EUR postings: D broker `76.50`, D tax `13.50`, C income `90.00`; journal currency EUR; source nominal values remain visible separately; result and CREATED-audit provenance have the canonical `[eurRow.row_index, foreignRow.row_index]` tuple; and the audit summary says `90 EUR`, never `100 EUR`. Assert one create and one CREATED audit only on execute.

Add an EUR dividend/reward negative-control matrix with no conversion rows. Assert identical legacy postings/accounts/duplicate behavior, additive EUR fields equal the rounded nominal values, null FX provenance/review reason, and no H17 warning. Also prove a same-date stray conversion is not consumed by an EUR distribution.

- [ ] **Step 3: Add matching, arithmetic, and fail-closed RED matrices**

Add handler-level H17 tests for each finite, parseable failure below. Every distribution-owned candidate failure must assert the exact precedence-selected reason code/message, all four EUR fields/provenance null, `needs_review: true`, stable wrapped warning context, its unconsumed conversion rows in `unhandled`, and zero journal/audit calls under `dry_run: false`. Reservation tests use the separate visibility expectations below instead of falsely requiring every reserved conversion to be unhandled. Keep non-finite CSV tokens as separate parser negative controls: `parseNumber` must reject them before extraction and before any journal/audit call rather than weakening CSV parsing merely to manufacture an H17 review result.

1. blank/whitespace currency; zero/negative gross; negative net/tax/fee; nominal gross versus net+tax+fee disagreement; and foreign net zero; plus separate `NaN`/`Infinity`/overflow-token parser rejections with zero mutation/audit;
2. no conversion candidate; wrong date; wrong foreign currency; or foreign conversion gross differing from distribution net by more than `0.01`;
3. two matching references for one distribution, one reference claimed by two otherwise matching distributions, duplicate EUR row, duplicate foreign row, missing side, or any third row under the reference;
4. same-sign flow, reversed flow (EUR out/foreign in), conversion gross/net/fee inconsistency, missing/both-missing/invalid/contradictory rates, ambiguous orientation, and ambiguous best rate;
5. a non-zero conversion fee on either side, proving H17 stops rather than hiding the fee in income or booking a nominal amount;
6. component conversion overflow or converted gross disagreement beyond one cent; and
7. a conversion matched by the complete reservation pre-pass to a valid ordinary foreign trade, a cash-equivalent foreign trade, a trade with valid strict day/currency/positive gross but malformed net/fee (A ownership), an ambiguous trade with two matching references (all matches owned), and a blank-currency malformed trade that broad-reserves matching same-day non-empty non-EUR references through A. Add frozen-B boundary cases in both row orders: trade gross `85.000` versus conversion gross `85.014` is reserved through the H16 legacy lane even though the strict A raw residual rejects it, while a value outside H16's `agreesToCent` window is not B-owned. Add B controls for blank-equals-blank conversion currency, rounded-zero conversion gross paired to a positive H16-valid tiny trade, and matching invalid-calendar raw prefixes; pair each with an A-negative assertion showing blank/zero/invalid-day conversion evidence is not strict A evidence. Add a distinct nonblank currency control so B is not accidentally widened to A's wildcard. Prove every A/B match is reserved before extraction and cannot be reused by a distribution. Explicit EUR trades reserve none; a failed strict calendar day reserves nothing only when no raw-prefix B predicate matches. Non-positive/non-finite trade evidence satisfying neither lane reserves nothing, and non-finite CSV gross remains a separate parser rejection before the pre-pass.

For those reservation tests, assert the conversion-row visibility contract precisely: a successfully extracted ordinary trade's conversion rows are handled; a successfully extracted cash-equivalent trade's conversion rows are ignored; a malformed or ambiguous rejected trade's reserved-but-unconsumed conversion rows are unhandled. The trade row itself keeps committed H16 handled/review semantics. Replace any blanket “invalid day reserves none” expectation with the A/B distinction above. Permute trade rows before/after distributions and conversions, reverse conversion rows, reverse ambiguous candidate-reference order, and reverse strict-only versus legacy-only probes. Across reordered files compare semantic results only: accepted/rejected status, stable warnings, EUR amount, conversion reference, consumption/visibility, postings, and canonical provenance tuple meaning within each run. Numeric `row_index` and tuple index values legitimately follow each file's row order and must not be compared across runs.

Add one combined public-handler ownership regression containing a valid H16 trade gross `85.000`, a same-raw-prefix foreign conversion gross `85.014` with its valid EUR side, and an H17 distribution whose net cash is exactly `85.014`. Assert committed H16 still accepts the trade with the same EUR amount, conversion reference, warnings, consumption, and postings; H17 marks the distribution `invalid_conversion_pair` with null EUR/provenance; the conversion reference appears in only the trade's handled/ignored category as appropriate; and distribution booking performs no journal/audit mutation. Run the same fixture with trade/distribution/conversion order reversed and compare only those semantic fields plus `[EUR-row, foreign-row]` tuple meaning inside each run, never the raw numeric indexes across files. This is the load-bearing proof that the strict H17 residual gap cannot let one conversion reference serve both kinds.

Add a test named `H17 reservation prepass bounds 5000 varied A misses against 5000 conversion refs` around a real `book_lightyear_distributions` handler call. Generate exactly 5,000 parser-valid Buy/Sell rows with valid strict days and finite positive gross but deliberately malformed net/fee arithmetic, so every probe is eligible only for A and `validateTradeAmounts` rejects every trade before committed H16 matching/B. Generate exactly 5,000 non-EUR conversion references with raw-gross-sorted values; most trade probes are distinct raw misses concentrated around shared cent ranges, so the test detects repeated full-range scans while B and `extractTrades` are absent from the timed path. Include, within those counts, an outside-then-inside same-rounded-cent sentinel (`85.003` then `85.004` against foreign conversion gross `85.014`) and give that sentinel reference its valid EUR side plus one USD distribution with net `85.014`. The first sentinel probe is outside A and the second is inside A; therefore a cache keyed only by cent bucket would wrongly leave the reference available and change the distribution from `manual_review:invalid_conversion_pair` to bookable. Keep the complete generated CSV below 1,000,000 bytes and assert its byte length before starting the timer. Assert the exact all-reviewed booking counts/object, sentinel warning/provenance nulls, and zero account/guard/list/create/audit calls. Set the test timeout to `10_000` ms, require handler elapsed time `< 8_000` ms on the normal test runner, and retain the byte length/elapsed time in evidence. Keep the existing multi-distribution graph-cardinality stress test as a separate no-edge-array control.

Add deterministic distribution order tests through dry-run booking results and execute audit provenance: reverse conversion-row order, rate order, distribution-row order, and candidate-reference insertion order. Valid unique evidence yields the same rate/orientation, EUR amounts, postings, and canonical tuple **semantics**; each run asserts tuple element 0 equals that run's EUR row index and element 1 its foreign row index. Do not compare raw numeric row indexes across reordered CSV fixtures because row indexes legitimately change. The parser assertions remain limited to its summary/table/handled surfaces. Ambiguous shared evidence reviews all affected distributions and consumes none.

Add a table-driven multi-defect precedence matrix: source currency+amount -> `distribution_currency_missing`; source amount+candidate ambiguity -> `distribution_amount_conflict`; candidate ambiguity+bad pair/rate -> `invalid_conversion_pair`; zero absolute conversion-net magnitude+bad sign/fee/rate -> `invalid_net_amount`; non-finite absolute conversion-net magnitude is defensively the same code but CSV non-finite tokens still reject at parsing; non-zero signed nets with bad direction/arithmetic+fee/rate -> `conversion_amount_conflict`; valid arithmetic with non-zero conversion fee+bad rate -> `conversion_fee_conflict`; and valid pair with the resolver's own rate defects -> its exact H16 code. Include the valid negative foreign net as a control that proceeds past `invalid_net_amount`. Reverse rows/rates in each parseable case and require the same full `{ code, message }`.

Add parse/output tests proving:
- unresolved foreign gross is excluded from `total_eur` while count/review_count disclose the omission;
- a mixed valid EUR + unresolved USD statement totals only the EUR/proven foreign value and remains `needs_review`;
- the structured distribution summary equals the exact four-key/count formula and the include-rows table uses the exact 14 columns/status/FX formats above, labels nominal CCY and EUR separately, and never renders foreign `100.00` under an EUR heading;
- successfully consumed distribution conversions close `cash_reconciliation`, whereas rejected pairs remain visible as unhandled conversion rows; and
- warning references containing embedded instruction/newline text occur only inside `UNTRUSTED_OCR` delimiters. Keep ticker/ISIN/title hardening assertions for M26, not H17.

Add booking-output tests for the exact manual-review object and all five top-level formulas in an all-reviewed, mixed, duplicate, dry-run, execute, and create-race-duplicate batch. In the all-reviewed case assert zero `getAccounts`, journal `listAll`, create, and audit calls, including when invalid optional overrides were supplied. In mixed batches, prove a reviewed Reward/tax/fee row alone does not demand or validate a default optional account; a missing/default reward, tax, or fee account is demanded only when a bookable consumer needs it. Separately pass each caller-provided reward/tax/fee override while another row is bookable but does not use it, and assert that the override is still validated (invalid override returns account validation failure; valid override proceeds). Assert result order follows original non-pre-deduped rows and pre-detected duplicates remain absent from results.

- [ ] **Step 4: Prove honest RED against the H16 production baseline**

Run:

```bash
npx vitest run src/tools/lightyear-investments.test.ts -t "H17"
```

Expected: old production fails the intended assertions because it discards `ccy`, does not pair/consume distribution conversions, sums nominal foreign gross as EUR, books USD nominal amounts 1:1 into an EUR journal, and has no manual-review/provenance contract. Against any partially implemented H17 candidate, separately record RED evidence for the `85.000` trade/`85.014` conversion ownership gap, invalid-calendar/blank/rounded-zero B ownership, exact query-cache identity/order independence, and the A-isolated 5,000 malformed-trade probes plus 5,000 conversion-reference real-handler bound/sentinel; a test that lets benchmark trades pass `validateTradeAmounts` or enter committed H16 matching does not isolate the H17 pre-pass. The declared EUR behavior and no-audit dry-run controls may pass and must be reported separately. Zero selected tests, compile-only failures, tests failing before they reach the vulnerable parser/booking path, or a performance test that omits exact manual-review/zero-side-effect assertions are not an acceptable RED. Record the exact intended-failure/control counts and inspect every failure before editing production.

- [ ] **Step 5: Implement deterministic extraction and atomic FX provenance**

In `src/tools/lightyear-investments.ts`, first restore any draft H17 changes inside committed H16 `extractTrades` so its function body is byte-for-byte identical to `332605a`, including its locally built `conversionsByRef`, full map scan, `shortlisted` array/cardinality, `consumedConversions`, and candidate objects. Do not introduce `buildLegacyTradeCandidateIndex`, capped probes, removal helpers, or any other extraction optimization into that function. Then extend the H16 reason union/map and add the exact H17 interfaces outside the committed function. Add the separate complete `collectTradeReservedConversionRefs(rows)` pre-pass that returns the exact strict-A plus frozen-legacy-B union above; do not derive it from or add it to `TradeExtractionResult`, and keep every reservation index/state private to this helper. Implement A with strict-day/exact-currency and strict-day/all-non-EUR raw-gross-sorted indexes, binary residual bounds, and final exact raw-residual verification. Implement B with its separate raw-prefix/exact-normalized-currency index sorted by the committed rounded amount, binary legacy bounds, and final `agreesToCent` verification. Cache only full predicate identities, unlink a reference from all reservation-index memberships immediately after first reservation, and bound indexed evidence processing/removal per reference without building per-trade candidate edges or rescanning shared ranges for varied raw misses. Replace the array-returning `extractDistributions` with a `DistributionExtractionResult` helper that accepts the completed immutable union, validates nominal rows, constructs the complete distribution/reference candidate graph, rejects non-bijective matches, applies the exact multi-defect precedence, validates a unique two-row pair, calls H16 validation/resolution, rejects conversion fees, calculates/reconciles the four EUR amounts, and assigns/consumes provenance atomically with `[EUR index, foreign index]` ordering.

Use pure helpers for distribution validation, pair flow, safe foreign conversion, and one stable wrapped warning. Never mutate a caller-owned reserved set: create a local consumed set and add a reference only after full success. Preserve source-row output order for compatibility, while candidate decisions come from the complete graph and remain independent of CSV order.

Update the statement parser to compute/pass reservations before extraction, merge H17 warnings, include proven distribution conversion indexes internally in handled cash, preserve the handled/ignored/unhandled trade conversion categories, emit the exact four-key summary, and render the exact 14-column nominal/EUR/status/FX table without inventing a structured parser provenance/index surface. Update distribution booking to compute the same reservation set, partition bookable/reviewed before any account/guard work, short-circuit an all-reviewed batch without API reads, validate every caller-provided optional override when any bookable row exists while demanding defaults only for bookable consumers, emit the exact result/count formulas, expose canonical provenance in booking results/audit, and build postings/results/audit exclusively from proven EUR fields. Narrow every nullable field before arithmetic; no non-null assertion may be the only bookability guard.

- [ ] **Step 6: Prove focused GREEN and inspect nominal/EUR sinks**

Run in order:

```bash
npx vitest run src/tools/lightyear-investments.test.ts -t "H17"
npx vitest run src/tools/lightyear-investments.test.ts -t "H17 reservation prepass bounds 5000 varied A misses against 5000 conversion refs"
npx vitest run src/tools/lightyear-investments.test.ts
npm run build
git diff --check
node -e 'const fs=require("node:fs"),cp=require("node:child_process"),ts=require("typescript"); const pick=s=>{const f=ts.createSourceFile("lightyear-investments.ts",s,ts.ScriptTarget.Latest,true); const n=f.statements.find(x=>ts.isFunctionDeclaration(x)&&x.name?.text==="extractTrades"); if(!n) throw new Error("extractTrades not found"); return s.slice(n.getStart(f),n.end);}; const baseline=cp.execFileSync("git",["show","332605a:src/tools/lightyear-investments.ts"],{encoding:"utf8"}); const current=fs.readFileSync("src/tools/lightyear-investments.ts","utf8"); if(pick(baseline)!==pick(current)){process.stderr.write("extractTrades differs from committed H16 332605a\n"); process.exit(1);}'
rg -n "amount: dist\.(net_amount|tax_amount|fee|gross_amount)|s \+ d\.gross_amount" src/tools/lightyear-investments.ts
rg -n "extractDistributions\(|collectTradeReservedConversionRefs|strictH17|legacyH16|rawStatementDatePrefix|agreesToCent|reservedConversionRefs|fx_provenance|gross_eur|net_eur|tax_eur|fee_eur" src/tools/lightyear-investments.ts
```

Expected: all H17 and all legacy Lightyear tests pass, the named A-only benchmark passes its `<1,000,000`-byte/`<8,000`-ms and semantic sentinel assertions, build/diff check pass, and the TypeScript-AST byte comparison exits 0 silently, proving the complete committed `extractTrades` function text is unchanged. The first search has no journal-posting or EUR-summary nominal sink, and the second lists both reservation-only ownership lanes plus every extraction/parser/booking/audit consumer for manual reservation/nullable/provenance inspection. Inspect the pre-pass to confirm raw-sorted output-sensitive A misses, full query identity, bounded unlinking, and a separately sorted B reservation index; there must be no H17 reservation/index helper call from `extractTrades`. Source nominal values may remain in output and reconciliation code, but never in an EUR-labeled monetary sink. Confirm H16 focused tests still pass unchanged:

```bash
npx vitest run src/tools/lightyear-investments.test.ts -t "H16"
```

- [ ] **Step 7: Full repository verification**

Run freshly and retain exact counts/output:

```bash
npm run validate:release
npm test
npm run test:integration
git diff --check
```

Require release metadata, full unit, and integration PASS with only documented baseline skips. Diagnose any failure; do not expand beyond the exact two-file H17 scope without stopping for plan review. In particular, do not fix H18 gains tolerance or M26 general imported-string output while touching this file.

- [ ] **Step 8: Freeze the exact two-file artifact without touching the real index**

Prove exact tracked scope:

```bash
H17_EXPECTED="$(mktemp)"
H17_ACTUAL="$(mktemp)"
printf '%s\n' \
  src/tools/lightyear-investments.test.ts \
  src/tools/lightyear-investments.ts | sort -u > "$H17_EXPECTED"
{
  git diff --name-only HEAD
  git ls-files --others --exclude-standard
} | sort -u > "$H17_ACTUAL"
diff -u "$H17_EXPECTED" "$H17_ACTUAL"
rm -f "$H17_EXPECTED" "$H17_ACTUAL"
git diff --cached --quiet
```

Expected: comparison and real-index check exit 0 silently. Package with a copied temporary index:

```bash
mkdir -p .omc/reviews
H17_INDEX="$(mktemp)"
cp "$(git rev-parse --git-path index)" "$H17_INDEX"
GIT_INDEX_FILE="$H17_INDEX" git add -- \
  src/tools/lightyear-investments.ts \
  src/tools/lightyear-investments.test.ts
GIT_INDEX_FILE="$H17_INDEX" git diff --cached --binary --output=/tmp/H17.frozen.diff
GIT_INDEX_FILE="$H17_INDEX" git diff --cached --check
GIT_INDEX_FILE="$H17_INDEX" git diff --cached --name-only
rm -f "$H17_INDEX"
git diff --cached --quiet
```

Expected: temporary staged names are exactly the two H17 paths, the artifact is non-empty, and the real index remains empty. Use `apply_patch` to create/replace ignored `.omc/reviews/H17.diff` with the exact `/tmp/H17.frozen.diff` bytes, then require:

```bash
test -s .omc/reviews/H17.diff
cmp /tmp/H17.frozen.diff .omc/reviews/H17.diff
```

- [ ] **Step 9: Independent SPEC review**

Give a fresh non-author reviewer the H17 spec row, this complete Task 12, `.omc/reviews/H17.diff`, baseline output, honest RED matrix/counts, and all GREEN/full verification. Require exactly:

```text
SPEC COMPLIANCE: APPROVED
```

The SPEC pass must audit exact two-file scope; source currency/nominal preservation; EUR negative controls; nominal and converted arithmetic validation; raw-versus-available complete graph-based date/currency/net-cash matching; the separate complete trade reservation pre-pass returning exactly strict-A plus frozen-H16-legacy-B ownership; A's exact strict-day, non-empty positive conversion evidence, raw residual/IEEE bound, exact-currency and blank-trade wildcard rules; B's committed raw-prefix, exact normalized currency including blank, rounded-zero, and `agreesToCent` evidence; the `85.000`/`85.014` ownership boundary; invalid-calendar B ownership versus no-either-lane controls; all ambiguous B references reserved; no shared reference between trade and distribution; semantic row-order independence without cross-file numeric-index equality; a byte-identical committed `332605a` `extractTrades` body with its original full `conversionsByRef` scan/shortlist/consumption and unchanged warnings/EUR amounts/conversion refs/postings; valid-trade handled, cash-equivalent ignored, and rejected-trade unhandled conversion visibility; the <1 MB 5,000 malformed-trade A probes plus 5,000 conversion-reference real-handler benchmark, outside-then-inside cache sentinel, exact manual-review result, and zero side effects; canonical `[EUR, foreign]` provenance tuple semantics in booking results/audit without false parser-surface or cross-reorder numeric-index assertions; zero/non-finite absolute net magnitude versus signed-flow reason mapping and the exact case-to-code/multi-defect precedence; two-row cardinality and flow; H16 rate/orientation reuse; conversion-fee stop; component/gross reconciliation; atomic consumption/provenance; missing/malformed/ambiguous fail-closed behavior; no foreign nominal EUR sink; the exact four-key parse summary and 14-column table; exact booking manual-review object, five count formulas, result membership/order, and duplicate semantics; partition before account/guard work; all-reviewed zero-account/guard/list/create/audit calls even with overrides; every caller-provided optional override validated in any batch with a bookable row; default optional accounts demanded only by bookable consumers; exact journal postings; audit currency/provenance; stable wrapped warnings; and no H18/M26 drift.

- [ ] **Step 10: Independent QUALITY review**

Only after SPEC approval, give a different fresh non-author reviewer the same frozen artifact and evidence. Require exactly:

```text
CODE QUALITY: APPROVED
```

The QUALITY pass must inspect finite guards before arithmetic; normalized currencies/dates; a side-effect-free complete reservation pre-pass independent of H16 consumption; A's strict-day/exact-currency and strict-day/all-non-EUR raw-gross-sorted indexes with binary exact-residual bounds that make matches and misses output-sensitive; B's entirely separate reservation-only raw-prefix/currency index sorted by committed rounded amounts with binary bounds followed by the exact `agreesToCent` predicate; cache keys containing full raw predicate identity rather than only rounded buckets; no materialized ownership edge arrays or repeated full shared-range scans; newly reserved references unlinked from every A/B reservation membership and each indexed evidence row/reference processed/removed boundedly; an immutable returned union; the committed H16 `extractTrades` function byte-identical and still using its original full `conversionsByRef` scan rather than any new index; full raw/available distribution candidate graph and semantic row-order independence; no trade/distribution double ownership; no cross-reordered numeric row-index assertions; candidate cardinality instead of `.find()`; deterministic defect classification before precedence selection; absolute-net magnitude checks separated from signed-flow validation; H16 discriminated-union narrowing; zero-fee policy; cent rounding/reconciliation; canonical provenance tuple ordering only on booking/audit surfaces; atomic nullable EUR/provenance assignment; correct handled/ignored/unhandled conversion indexes; the single bookability predicate; no unsafe non-null arithmetic; partition and all-reviewed early return before account/guard work; caller-provided override validation preserved in mixed/bookable batches while default-account demand is driven only by bookable rows; exact result/count ordering under dedupe/create races; no raw nominal values in EUR postings/summaries/audit amounts; stable mapped messages and wrapped reference context; EUR/duplicate compatibility; focused fixtures that fail old production; the A-isolated 5,000+5,000 handler timing fixture with malformed trades, varied misses, exact cache sentinel, and functional/zero-side-effect assertions; and exact scope. Any rejection or source/test edit invalidates both approvals: rerun Steps 6-8, overwrite the artifact, then restart SPEC followed by QUALITY with fresh reviewers.

- [ ] **Step 11: Final primary verification, exact staging, and commit**

After both approvals, rerun:

```bash
npx vitest run src/tools/lightyear-investments.test.ts
npx vitest run src/tools/lightyear-investments.test.ts -t "H17 reservation prepass bounds 5000 varied A misses against 5000 conversion refs"
npm run build
npm test
npm run test:integration
npm run validate:release
git diff --check
cmp /tmp/H17.frozen.diff .omc/reviews/H17.diff
```

Repeat the Step 6 TypeScript-AST byte comparison against committed H16 `extractTrades` and the Step 8 exact-scope comparison. Only then run:

```bash
git status --short
git add src/tools/lightyear-investments.ts src/tools/lightyear-investments.test.ts
git diff --cached --name-only
git commit -m "fix(H17): retain distribution currency provenance"
```

Expected: staged names are exactly the two reviewed H17 paths. Do not stage ignored review/ledger artifacts and do not push.

- [ ] **Step 12: Ledger and clean sequential handoff**

Use `apply_patch` to append one H17 row to `.omc/full-codebase-remediation-ledger.md` containing the baseline count, intended RED failures and negative controls, the passing byte comparison against committed `332605a` `extractTrades`, focused H16/H17 compatibility including the `85.000`/`85.014` no-double-ownership regression, invalid-calendar/blank/rounded-zero B evidence, the exact byte size and measured elapsed time of the A-isolated 5,000 malformed-trade plus 5,000 conversion-reference handler fixture and its sentinel outcome, build/full/integration/release/diff evidence, byte-matching artifact evidence, ordered fresh SPEC and QUALITY verdicts, and the commit hash. Then run:

```bash
git status --short
```

Expected: empty output. Do not begin H18 or any later finding until H17 is committed, recorded, and clean.

### Task 13: H18 — Tolerant but bounded gains matching

**Files:**
- Modify: `src/tools/lightyear-investments.ts` — export the finite tolerance predicate and use it only in sell-to-capital-gains candidate classification.
- Test: `src/tools/lightyear-investments.test.ts` — helper-contract, matcher determinism, and public `book_lightyear_trades` side-effect regressions.

**Exact scope and non-goals:**
- The reviewed H18 patch must contain exactly the two paths above. Do not create files or change schemas, API clients, audit helpers, documentation, package metadata, or release configuration.
- Preserve H16 trade extraction and H17 distribution parsing, reservation, provenance, review routing, booking, and messages byte-for-byte. H18 must not change date/ticker/quantity candidate formation, trade/distribution ownership, CSV parsing, account selection, journal construction, or existing cent-exact proceeds semantics.
- Do not expose configurable tolerances through the MCP tool schema. The only new interface is the exported TypeScript helper with defaults shown below.
- Do not use row order as a tie-breaker, do not consume an outside-tolerance row, and do not silently turn a non-finite value into a match.

**Interfaces:**
- Consumes: the existing date/ticker/quantity candidate set and each sell/gains pair's EUR proceeds.
- Produces: `withinProceedsTolerance(actual, expected, absolute = 0.02, relative = 0.001): boolean`.
- Predicate contract: return `false` unless `actual`, `expected`, `absolute`, and `relative` are finite and both tolerances are nonnegative. Otherwise return the inclusive result `Math.abs(actual - expected) <= Math.max(absolute, Math.abs(expected) * relative)`.
- Candidate categories: retain the current raw exact rule `Math.abs(sellProceeds - gainProceeds) < 0.02` unchanged; `tolerant` means beyond that exact rule but within the new predicate; `outside` means beyond the predicate or invalid/non-finite. The eligible union is `exact + tolerant`.
- Consumption contract: after excluding gains rows already consumed by earlier sells, consume only when the eligible union contains exactly one row. Zero eligible rows remain unmatched; more than one is ambiguous and consumes none. Outside rows never enter the result map.
- Diagnostics contract: when a sell has shaped candidates but no eligible row because their proceeds are outside the bound, emit one actionable manual-review warning for that sell even if the outside candidate is unique. Include enough stable sell context (at least date/ticker/quantity and sell proceeds) to identify the row; do not emit one warning per candidate.
- Determinism contract: preserve input sell order, stable candidate classification, and one-to-one gains-row consumption. Reordering gains rows may change neither which unambiguous pair is selected nor which sells remain unmatched.

- [ ] **Step 1: Freeze scope, baselines, and H16/H17 behavior before RED**

Run:

```bash
git status --short
git diff --check
npx vitest run src/tools/lightyear-investments.test.ts
npm run build
```

Expected: clean worktree, empty diff-check output, the focused Lightyear suite passes, and the build passes. Record the exact focused test count in `.omc/full-codebase-remediation-ledger.md` notes without editing that ignored ledger yet.

Freeze executable slices of the protected H16/H17 source regions from committed H17:

```bash
git show HEAD:src/tools/lightyear-investments.ts > /tmp/H18.before.ts
awk '/^function extractTrades\(/{on=1} /^function rawStatementDatePrefix\(/{on=0} on' /tmp/H18.before.ts > /tmp/H18.before.h16-extractTrades.ts
awk '/^function rawStatementDatePrefix\(/{on=1} /^function findExistingJournalsByRef\(/{on=0} on' /tmp/H18.before.ts > /tmp/H18.before.h17-extraction-reservation.ts
awk '/registerTool\(server, "book_lightyear_distributions"/{on=1} /registerTool\(server, "lightyear_portfolio_summary"/{on=0} on' /tmp/H18.before.ts > /tmp/H18.before.h17-booking.ts
sha256sum /tmp/H18.before.h16-extractTrades.ts /tmp/H18.before.h17-extraction-reservation.ts /tmp/H18.before.h17-booking.ts
git rev-parse HEAD
```

Expected: all three slices are non-empty. Record the current H17 commit hash and the three hashes. These exact `awk` marker slices intentionally exclude the H18 gains matcher/helper. Step 9 regenerates the same slices from the working file and requires byte equality.

- [ ] **Step 2: Add helper-contract RED tests, including inclusive boundaries and invalid inputs**

Add a dedicated `describe("H18 bounded proceeds tolerance", ...)` block and import `withinProceedsTolerance` from the production module. The table must express the exact contract rather than duplicating production logic:

Use the test file's existing `testNextDown` helper so the outside cases are the nearest representable values beyond the mathematical boundary:

```ts
it.each([
  { actual: 9.98, expected: 10, absolute: 0.02, relative: 0.001, result: true, description: "absolute boundary is inclusive" },
  { actual: testNextDown(9.98), expected: 10, absolute: 0.02, relative: 0.001, result: false, description: "next float beyond absolute boundary" },
  { actual: 9990, expected: 10_000, absolute: 0.02, relative: 0.001, result: true, description: "relative boundary is inclusive" },
  { actual: testNextDown(9990), expected: 10_000, absolute: 0.02, relative: 0.001, result: false, description: "next float beyond relative boundary" },
  { actual: 100, expected: 100, absolute: 0, relative: 0, result: true, description: "zero tolerances allow equality" },
  { actual: Number.NaN, expected: 100, absolute: 0.02, relative: 0.001, result: false, description: "NaN actual" },
  { actual: 100, expected: Number.POSITIVE_INFINITY, absolute: 0.02, relative: 0.001, result: false, description: "infinite expected" },
  { actual: 100, expected: 100, absolute: Number.NaN, relative: 0.001, result: false, description: "NaN absolute tolerance" },
  { actual: 100, expected: 100, absolute: 0.02, relative: Number.POSITIVE_INFINITY, result: false, description: "infinite relative tolerance" },
  { actual: 100, expected: 100, absolute: -0.01, relative: 0.001, result: false, description: "negative absolute tolerance" },
  { actual: 100, expected: 100, absolute: 0.02, relative: -0.001, result: false, description: "negative relative tolerance" },
])("$description", ({ actual, expected, absolute, relative, result }) => {
  expect(withinProceedsTolerance(actual, expected, absolute, relative)).toBe(result);
});

it("uses the documented defaults", () => {
  expect(withinProceedsTolerance(9.98, 10)).toBe(true);
  expect(withinProceedsTolerance(testNextDown(9.98), 10)).toBe(false);
  expect(withinProceedsTolerance(9990, 10_000)).toBe(true);
  expect(withinProceedsTolerance(testNextDown(9990), 10_000)).toBe(false);
});
```

- [ ] **Step 3: Prove the helper tests are RED for the intended reason**

Run:

```bash
npx vitest run src/tools/lightyear-investments.test.ts -t "H18 bounded proceeds tolerance"
git diff --name-only
git diff -- src/tools/lightyear-investments.ts
```

Expected: the new tests fail because `withinProceedsTolerance` is not exported/implemented. The changed-name list contains only `src/tools/lightyear-investments.test.ts`, and the production-file diff is empty. Fix any test syntax or fixture error until failures are contract failures, not harness failures.

- [ ] **Step 4: Add public-tool tests with the real read/handler/API/audit harness**

Every public case must build `statement` with `buildStatementCsv(...)`, build `gains` with `buildCapitalGainsCsv(...)`, load them in that order, call the registered handler, and parse its real payload:

```ts
mockedReadFile.mockResolvedValueOnce(statement).mockResolvedValueOnce(gains);
vi.mocked(logAudit).mockClear();
const run = setupLightyearTool("book_lightyear_trades");
const response = await run.handler({
  file_path: "/tmp/lightyear.csv",
  capital_gains_file: "/tmp/gains.csv",
  investment_account: 1550,
  broker_account: 1120,
  gain_loss_account: 8320,
  dry_run: false,
});
const payload = parseMcpResponse(response.content[0]!.text) as any;
```

Use a EUR sell statement row with a unique reference, fixed `10/11/2025 08:51:32` date, `AAPL`, quantity `10`, zero fee, and `gross_amount`/`net_amount` equal to the sell proceeds. Use capital-gains rows with the same date/ticker/quantity and unique identifying name/ISIN fields. Assert only real fields and spies: `payload.created`, `payload.skipped`, `payload.results`, `payload.warnings`, `run.api.journals.create`, and `vi.mocked(logAudit)`.

Add these controls and RED regressions:

- Preserved raw-exact control: sell `9990`, one gains row `9990.004`; expect `created === 1`, `skipped === 0`, one journal create, and one audit.
- Public tolerant control: sell `9990`, one gains row `10000`; expect the same successful result. This is deliberately a passing pre-fix control because the old unique-inexact fallback already accepts it; it proves H18 preserves that useful match while adding a bound.
- Unique outside RED: sell `9989.99`, one gains row `10000` (one cent beyond the inclusive relative boundary); expect `created === 0`, `skipped === 1`, a skipped `payload.results` entry, one warning matching `/outside proceeds tolerance.*manual review/i` and containing `2025-11-10`, `AAPL`, quantity `10`, and proceeds `9989.99`, with zero journal creates and zero audits. Add the material mismatch `9990` versus `16000` with the same zero-side-effect oracle.
- Exact+tolerant-union ambiguity RED: one sell at `9990`; two same-shape gains rows at `9990.004` (preserved raw exact because difference is below `0.02`) and `10000` (tolerant at the inclusive relative boundary). Expect `created === 0`, `skipped === 1`, an ambiguity warning/result, zero creates, and zero audits. The old exact-first behavior should wrongly create, which makes this a load-bearing RED.

For one-to-one consumption and reorder determinism, use two same-shape sells with different statement references and two gains rows: one eligible (`10000`) and one outside (`16000`). Execute once in `[eligible, outside]` gains order and once in `[outside, eligible]` order after resetting mocks. In both runs the first sell consumes the eligible row, the second sell is skipped for manual review, `payload.created === 1`, `payload.skipped === 1`, and there is exactly one create and one audit. Normalize `payload.results` and `payload.warnings` only by unstable created object ID, then require the two runs to be equal.

Finally add public parser rejection controls for gains proceeds tokens `NaN`, `Infinity`, and `-Infinity`. For each, load the real statement and gains files, call the public handler, assert its existing explicit parse/rejection result, and assert zero `run.api.journals.create` and zero `vi.mocked(logAudit)` calls. Do not require a sell-level outside-tolerance warning: these tokens must be rejected before matcher classification. Direct helper tests are the proof that non-finite numeric arguments return `false`.

- [ ] **Step 5: Prove the public-tool matrix is RED and controls remain GREEN**

Run each load-bearing case independently, then the whole H18 block:

```bash
npx vitest run src/tools/lightyear-investments.test.ts -t "H18 preserves the raw-exact gains match"
npx vitest run src/tools/lightyear-investments.test.ts -t "H18 preserves the unique relative-boundary gains match"
npx vitest run src/tools/lightyear-investments.test.ts -t "H18 skips a unique just-outside candidate and performs zero mutation or audit"
npx vitest run src/tools/lightyear-investments.test.ts -t "H18 treats exact plus tolerant candidates as ambiguous"
npx vitest run src/tools/lightyear-investments.test.ts -t "H18"
```

Expected before production changes: helper tests fail because the export is missing; raw-exact and public `9990`/`10000` tolerant controls pass under existing behavior; unique outside fails because the old unbounded fallback consumes it; exact+tolerant ambiguity fails because the old exact-first branch creates a journal. Parser non-finite controls pass if existing rejection is already correct. Record those exact RED failures and passing controls before touching production code; do not claim the tolerant public control as RED.

- [ ] **Step 6: Implement the minimal finite-only exported predicate**

Add this helper beside the existing proceeds comparison logic without changing unrelated parsing or booking code:

```ts
export function withinProceedsTolerance(
  actual: number,
  expected: number,
  absolute = 0.02,
  relative = 0.001,
): boolean {
  if (
    !Number.isFinite(actual) ||
    !Number.isFinite(expected) ||
    !Number.isFinite(absolute) ||
    !Number.isFinite(relative) ||
    absolute < 0 ||
    relative < 0
  ) {
    return false;
  }

  const difference = Math.abs(actual - expected);
  return difference <= Math.max(absolute, Math.abs(expected) * relative);
}
```

Do not round either operand before this predicate. The current raw exact check `Math.abs(actual - expected) < 0.02` remains a distinct classification rule.

- [ ] **Step 7: Implement exact+tolerant union matching without changing candidate formation**

Inside the existing per-sell matcher, keep its date/ticker/quantity candidate lookup and consumed-row exclusion unchanged. Replace only the unbounded unique-inexact fallback with explicit categories equivalent to:

```ts
const availableCandidates = shapedCandidates.filter((candidate) => !consumedGainRows.has(candidate.rowIndex));
const exactCandidates = availableCandidates.filter(
  (candidate) => Math.abs(sell.proceedsEur - candidate.proceedsEur) < 0.02,
);
const tolerantCandidates = availableCandidates.filter(
  (candidate) =>
    Math.abs(sell.proceedsEur - candidate.proceedsEur) >= 0.02 &&
    withinProceedsTolerance(sell.proceedsEur, candidate.proceedsEur),
);
const eligibleCandidates = [...exactCandidates, ...tolerantCandidates];

if (eligibleCandidates.length === 1) {
  const [candidate] = eligibleCandidates;
  matches.set(sell.rowIndex, candidate);
  consumedGainRows.add(candidate.rowIndex);
} else if (eligibleCandidates.length > 1) {
  warnings.push(actionableAmbiguityWarning(sell, eligibleCandidates));
} else if (availableCandidates.length > 0) {
  warnings.push(actionableOutsideToleranceWarning(sell));
}
```

Use the actual existing symbol/property names rather than introducing parallel model types or placeholder helpers. The important invariants are: exact and tolerant rows are combined before counting; outside rows are excluded from that count and never consumed; the candidate row is marked consumed atomically with adding the match; warning order follows sell order; one outside-tolerance warning is emitted per unmatched sell, with stable identifying context.

- [ ] **Step 8: Prove GREEN for the helper and focused public behavior**

Run:

```bash
npx vitest run src/tools/lightyear-investments.test.ts -t "H18 bounded proceeds tolerance"
npx vitest run src/tools/lightyear-investments.test.ts -t "H18"
npx vitest run src/tools/lightyear-investments.test.ts
npm run build
git diff --check
```

Expected: every helper row and public H18 case passes; the full Lightyear file passes; TypeScript builds; diff-check is empty. Confirm unique outside cases report zero create/audit calls, raw exact and `9990`/`10000` tolerant controls create once, and exact+tolerant ambiguity creates neither candidate.

- [ ] **Step 9: Prove H16/H17 compatibility and exact two-file scope**

Run the focused H16 and H17 named groups already present in the test file, followed by the complete Lightyear suite. Regenerate and compare the exact protected marker slices from Step 1:

```bash
npx vitest run src/tools/lightyear-investments.test.ts -t "H16"
npx vitest run src/tools/lightyear-investments.test.ts -t "H17"
npx vitest run src/tools/lightyear-investments.test.ts
awk '/^function extractTrades\(/{on=1} /^function rawStatementDatePrefix\(/{on=0} on' src/tools/lightyear-investments.ts > /tmp/H18.current.h16-extractTrades.ts
awk '/^function rawStatementDatePrefix\(/{on=1} /^function findExistingJournalsByRef\(/{on=0} on' src/tools/lightyear-investments.ts > /tmp/H18.current.h17-extraction-reservation.ts
awk '/registerTool\(server, "book_lightyear_distributions"/{on=1} /registerTool\(server, "lightyear_portfolio_summary"/{on=0} on' src/tools/lightyear-investments.ts > /tmp/H18.current.h17-booking.ts
cmp /tmp/H18.before.h16-extractTrades.ts /tmp/H18.current.h16-extractTrades.ts
cmp /tmp/H18.before.h17-extraction-reservation.ts /tmp/H18.current.h17-extraction-reservation.ts
cmp /tmp/H18.before.h17-booking.ts /tmp/H18.current.h17-booking.ts
sha256sum /tmp/H18.current.h16-extractTrades.ts /tmp/H18.current.h17-extraction-reservation.ts /tmp/H18.current.h17-booking.ts
git diff --name-only
git diff --check
```

Expected: all H16/H17 tests pass; the H16 `extractTrades` and H17 distribution/reservation/booking regions are byte-identical; changed names are exactly:

```text
src/tools/lightyear-investments.test.ts
src/tools/lightyear-investments.ts
```

Inspect the full two-file diff for accidental parser, distribution, journal, schema, or message changes. Remove any change outside the H18 helper, gains candidate classification/warning, and H18 tests.

- [ ] **Step 10: Run full validation before review**

Run:

```bash
npm run build
npm test
npm run test:integration
npm run validate:release
git diff --check
git status --short
```

Expected: build, full unit suite, integration suite (apart from already documented environmental skips), and release validation pass; diff-check is empty; status lists only the exact two H18 paths. If any command fails, fix the cause and rerun the entire Step 8–10 sequence before requesting review.

- [ ] **Step 11: Freeze the exact two-file artifact**

After GREEN and before review, create the ignored immutable review artifact and record its byte count and SHA-256:

```bash
mkdir -p .omc/reviews
git diff -- src/tools/lightyear-investments.ts src/tools/lightyear-investments.test.ts > /tmp/H18.frozen.diff
cp /tmp/H18.frozen.diff .omc/reviews/H18.diff
cmp /tmp/H18.frozen.diff .omc/reviews/H18.diff
wc -c .omc/reviews/H18.diff
sha256sum .omc/reviews/H18.diff
git diff --name-only
```

Expected: `cmp` is silent, the artifact is non-empty, and the live changed-name list is exactly the two H18 paths. Do not edit either source/test file after freezing without regenerating the artifact and restarting both reviews.

- [ ] **Step 12: Obtain ordered independent spec and quality approvals**

First delegate a fresh spec-compliance reviewer with only the H18 requirements, the committed H17 base, and `.omc/reviews/H18.diff`. Require an explicit `SPEC COMPLIANCE: APPROVED` or actionable findings. The reviewer must verify finite/nonnegative validation, inclusive max-bound math, exact+tolerant union cardinality, outside no-consumption/manual-review behavior, deterministic one-to-one consumption, public zero-side-effect regressions, frozen H16/H17 behavior, and exact two-file scope.

Only after spec approval, delegate a different fresh code-quality reviewer. Require an explicit `CODE QUALITY APPROVED` or findings, with attention to floating-point boundary tests, stable warning cardinality/content, accidental quadratic scans, row-identity consumption, parser-to-public-handler coverage, and test controls that would fail under the old unbounded fallback.

If either reviewer finds an issue: amend tests first when the contract proof is missing, reproduce RED, implement the smallest correction, rerun Steps 8–10, regenerate `.omc/reviews/H18.diff`, and restart review from spec approval. Author and reviewer contexts must remain separate.

- [ ] **Step 13: Reverify the approved bytes and commit H18**

After both approvals, rerun:

```bash
npx vitest run src/tools/lightyear-investments.test.ts
npm run build
npm test
npm run test:integration
npm run validate:release
git diff --check
git diff -- src/tools/lightyear-investments.ts src/tools/lightyear-investments.test.ts > /tmp/H18.live.diff
cmp /tmp/H18.live.diff .omc/reviews/H18.diff
git diff --name-only
```

Repeat all three `awk` extraction, `cmp`, and `sha256sum` commands from Step 9. Expected: all validation passes; artifact and protected-region comparisons are silent; changed names are exactly the two reviewed H18 paths. Then run:

```bash
git add src/tools/lightyear-investments.ts src/tools/lightyear-investments.test.ts
git diff --cached --name-only
git diff --cached --check
git diff --cached > /tmp/H18.staged.diff
cmp /tmp/H18.staged.diff .omc/reviews/H18.diff
git commit -m "fix(H18): bound Lightyear proceeds matching"
```

Expected: staged names are exactly the two reviewed paths, staged diff-check passes, staged bytes match the frozen artifact, and the commit succeeds. Do not stage ignored artifacts and do not push.

- [ ] **Step 14: Record evidence and enforce the sequential handoff**

Use `apply_patch` to append one H18 row to `.omc/full-codebase-remediation-ledger.md` with: baseline test count; helper-missing, unique-outside-consumed, and exact+tolerant-union RED failures; passing raw-exact, public `9990`/`10000` tolerant, and parser rejection controls; helper absolute/relative boundary plus non-finite evidence; public just-outside/material mismatch, ambiguity, consumed-row, and reorder evidence; zero create/audit proof for review-only and parser-rejected cases; exact H16/H17 protected-slice hashes/comparisons; focused/full/build/integration/release/diff results; artifact byte count/SHA; ordered spec and quality verdicts; and commit hash.

Run:

```bash
git status --short
git log -1 --oneline
```

Expected: clean worktree and the H18 commit at `HEAD`. Do not begin Task 14/M19 until H18 is committed, recorded, and clean.

### Task 14: M19 — Surface opening-balance incompleteness

**Files:**
- Modify: `src/tools/account-balance.ts:155-220`
- Modify: `src/tools/account-balance.test.ts`
- Modify: `src/tools/annual-report.ts:689-730,1060-1145`
- Modify: `src/tools/annual-report.test.ts`

**Interfaces:**
- Consumes: `withOpeningBalanceApiLimitation()` from `src/opening-balance-limitations.ts`.
- Produces on both root outputs: `opening_balance_status: "api_incomplete" | "complete"`, `balance_scope: "journal_api_visible_entries_only" | "complete_balance"`, and a `warnings` array containing the opening-balance API limitation when it applies.
- Preserves: the existing `compute_account_balance` warning and calculation contract; client-debt totals and cache metadata; annual-report warnings and their existing order.

- [ ] **Step 1: Establish the clean M19 baseline and exact four-file boundary**

Run:

```bash
git status --short
git log -1 --oneline
npx vitest run src/tools/account-balance.test.ts src/tools/annual-report.test.ts
git diff --name-only
```

Expected: the worktree is clean with the committed H18 finding at `HEAD`; the two focused files pass their existing **27 tests**; and there is no diff. Record the baseline count in the remediation ledger evidence, but do not edit the ignored ledger until M19 is committed. Task 14 owns exactly the four paths listed above; do not start or stage Task 15/M20 work.

- [ ] **Step 2: Add two passing legacy controls and three isolated RED public-contract tests**

In `src/tools/account-balance.test.ts`, capture the real registered `compute_client_debt` handler and invoke it with `clients_id: 42`, `account_ids: "2110"`, and `fresh: true` rather than constructing an internal result object. Use one client C, one account `2110`, and registered journals containing a C 100 posting and a D 30 posting for client 42. Split the proof into two cases:

1. Legacy control, expected PASS before production edits: assert the exact existing payload shape `accounts: [{ account_id: 2110, account_name: <fixture name>, balance_type: "C", balance: 70, debit_total: 30, credit_total: 100, entry_count: 2 }]` and `summary: { total_debt_to_client: 70, total_receivable_from_client: 0, net_position: -70 }`; also assert the exact existing cache metadata object, `clearRuntimeCaches` once, and `listAllWithPostings` once.
2. Disclosure regression, expected RED before production edits: the same real handler result contains:

```ts
opening_balance_status: "api_incomplete"
balance_scope: "journal_api_visible_entries_only"
```

and `warnings` equals the opening-balance limitation result. Keep calculation/cache assertions in the separate legacy control so this RED fails only for the absent disclosure fields.

In `src/tools/annual-report.test.ts`, exercise `buildAnnualReportData` directly with the existing unclassified asset account `999` fixture. Reuse its real warning rather than injecting a warnings input or inventing an `existingWarnings` placeholder. The exact warning is:

```text
Some asset accounts fall outside the current (10–16) / non-current (17–19) balance-sheet ranges, so they count toward total assets but appear in neither asset line: 999. Review their classification.
```

Split the annual proof into three cases:

1. Legacy control, expected PASS before production edits: the account-999 fixture produces exactly the existing warning above, in its existing position and exactly once.
2. Disclosure regression, expected RED before production edits: the same report has the exact root `api_incomplete` status and `journal_api_visible_entries_only` scope, with final warnings exactly `[account999Warning, OPENING_BALANCE_API_LIMITATION_WARNING]`; assert each warning occurs once. This case must fail only because the root disclosure/limitation is absent.
3. Controlled complete-branch regression, expected RED before production edits: use a hoisted `vi.fn` module mock for the opening-balance helper. The mock must default to the real helper's append-and-dedupe semantics and be reset to that default in `afterEach`. In this one test only, make a no-argument call return `[]` while a call with nonempty warnings returns those warnings unchanged. The account-999 warning must persist, and the result must expose `opening_balance_status: "complete"`, `balance_scope: "complete_balance"`, and no limitation warning.

Because `annual-report.ts` statically imports the helper, declare a state holder with `vi.hoisted(...)` containing both the helper mock and a slot for the real helper implementation. Install an asynchronous partial module mock so the real constant and every unrelated export remain intact:

```ts
const openingBalanceHelperState = vi.hoisted(() => ({
  helper: vi.fn(),
  realHelper: undefined as undefined | typeof import("../opening-balance-limitations.js").withOpeningBalanceApiLimitation,
}));

vi.mock("../opening-balance-limitations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../opening-balance-limitations.js")>();
  openingBalanceHelperState.realHelper = actual.withOpeningBalanceApiLimitation;
  openingBalanceHelperState.helper.mockImplementation(openingBalanceHelperState.realHelper);
  return {
    ...actual,
    withOpeningBalanceApiLimitation: openingBalanceHelperState.helper,
  };
});

afterEach(() => {
  openingBalanceHelperState.helper.mockReset();
  openingBalanceHelperState.helper.mockImplementation(openingBalanceHelperState.realHelper!);
});
```

The factory must save the real helper in the hoisted state and install it immediately as the mock's default implementation. `afterEach` must reset the mock and reinstall `openingBalanceHelperState.realHelper!`; no code outside the factory may reference the factory-scoped `actual`. Delegation to the real helper preserves `OPENING_BALANCE_API_LIMITATION_WARNING` and production dedupe semantics. Changing a spy after importing the module without this hoisted partial module mock will not control the static binding.

Retain existing `compute_account_balance` coverage and confirm its current calculation/warning contract remains unchanged in the affected/full suite; M19 adds no new account-balance-handler behavior. Do not mock the result fields being introduced and do not use loose warning regexes.

- [ ] **Step 3: Prove the intended RED and the legacy controls**

Give the five new cases exact names and select only them:

```bash
npx vitest run src/tools/account-balance.test.ts src/tools/annual-report.test.ts -t "preserves client debt totals and cache metadata|adds client debt opening-balance disclosure|preserves the account 999 annual warning|adds annual opening-balance disclosure after the account 999 warning|reports a complete annual opening-balance scope when the helper has no limitation"
```

Expected before production edits: exactly **2 legacy controls PASS** (client totals/cache and the real annual account-999 warning) and exactly **3 regressions RED** (client disclosure, annual disclosure, and the mocked complete branch). The complete-branch test is RED because the report lacks metadata even though the controlled helper behavior is available. Record the exact 2-pass/3-fail result and failure messages before editing production code.

- [ ] **Step 4: Compute limitation state independently from existing warnings**

In each production surface, obtain the limitation state from a fresh no-argument call:

```ts
const openingBalanceWarnings = withOpeningBalanceApiLimitation();
const openingBalanceApiIncomplete = openingBalanceWarnings.length > 0;
```

Derive only the two metadata fields from that fresh limitation result:

```ts
const opening_balance_status = openingBalanceApiIncomplete
  ? "api_incomplete"
  : "complete";
const balance_scope = openingBalanceApiIncomplete
  ? "journal_api_visible_entries_only"
  : "complete_balance";
```

Do not infer `opening_balance_status` or `balance_scope` from an annual report's existing warning array: unrelated pre-existing warnings must never turn a complete opening-balance state into `api_incomplete`.

- [ ] **Step 5: Add the smallest client-debt disclosure without calculation drift**

In the real `compute_client_debt` return path, add the two root metadata fields and set root `warnings` to the fresh limitation warnings. Do not modify API requests, row filtering, debtor/creditor aggregation, rounding, response totals, cache reads/writes, cache-hit metadata, or the existing `compute_account_balance` handler and output. The only client-debt behavior change is the explicit limitation disclosure at the root.

- [ ] **Step 6: Merge the annual limitation warning without loss, reorder, or duplication**

In `buildAnnualReportData`, derive status/scope from the fresh no-argument limitation result, but construct final warnings from the function's real local `warnings` array with:

```ts
const finalWarnings = withOpeningBalanceApiLimitation(warnings);
```

Return `finalWarnings` plus the two root metadata fields. This helper call must preserve every existing annual warning in its original order and avoid adding a duplicate limitation warning. The real account-999 warning must therefore precede `OPENING_BALANCE_API_LIMITATION_WARNING`. Existing annual warnings are inputs to the final warning merge only; they do not determine status or scope. Do not alter annual calculations, section structure, or other report metadata.

- [ ] **Step 7: Prove focused GREEN and exact compatibility controls**

Run:

```bash
npx vitest run src/tools/account-balance.test.ts src/tools/annual-report.test.ts -t "preserves client debt totals and cache metadata|adds client debt opening-balance disclosure|preserves the account 999 annual warning|adds annual opening-balance disclosure after the account 999 warning|reports a complete annual opening-balance scope when the helper has no limitation"
npx vitest run src/tools/account-balance.test.ts src/tools/annual-report.test.ts
```

Expected: all **5 selected cases PASS**. Both real entry points expose exact status/scope/warning values; annual warnings equal `[account999Warning, OPENING_BALANCE_API_LIMITATION_WARNING]`, each exactly once; the controlled no-limitation branch preserves only `account999Warning` and reports `complete`/`complete_balance`; client payload remains exactly `accounts: [{ account_id: 2110, account_name: <fixture name>, balance_type: "C", balance: 70, debit_total: 30, credit_total: 100, entry_count: 2 }]` with `summary: { total_debt_to_client: 70, total_receivable_from_client: 0, net_position: -70 }`, exact cache metadata, and unchanged call counts; and the full affected files pass. Existing `compute_account_balance` calculation/current warning coverage must remain green.

- [ ] **Step 8: Inspect the exact M19 diff and exclude M20 drift**

Run:

```bash
git diff -- src/tools/account-balance.ts src/tools/account-balance.test.ts src/tools/annual-report.ts src/tools/annual-report.test.ts
git diff --name-only
git diff --check
```

Expected: changed names are exactly the four M19 paths, diff-check is clean, and the diff contains only tests plus root disclosure/merge logic. In particular, there must be no year-end-close detector or other Task 15/M20 change.

- [ ] **Step 9: Run affected, full, build, integration, and release validation**

Run:

```bash
npx vitest run src/tools/account-balance.test.ts src/tools/annual-report.test.ts
npm run build
npm test
npm run test:integration
npm run validate:release
git diff --check
git status --short
```

Expected: affected and full unit suites pass; build passes; integration passes apart from already documented environmental skips; release validation passes; diff-check is empty; and status lists only the exact four M19 paths. If any command fails, correct the cause and rerun the entire step before review.

- [ ] **Step 10: Freeze the exact four-file review artifact**

After GREEN and before review, create the ignored immutable artifact and record its byte count and SHA-256:

```bash
mkdir -p .omc/reviews
git diff -- src/tools/account-balance.ts src/tools/account-balance.test.ts src/tools/annual-report.ts src/tools/annual-report.test.ts > /tmp/M19.frozen.diff
cp /tmp/M19.frozen.diff .omc/reviews/M19.diff
cmp /tmp/M19.frozen.diff .omc/reviews/M19.diff
wc -c .omc/reviews/M19.diff
sha256sum .omc/reviews/M19.diff
git diff --name-only
```

Expected: `cmp` is silent, the artifact is non-empty, and the live changed-name list is exactly the four M19 paths. Any subsequent edit to those files invalidates the artifact and both approvals; regenerate it and restart review from Step 11.

- [ ] **Step 11: Obtain ordered independent spec and quality approvals**

First delegate a fresh spec-compliance reviewer with only the M19 requirements, the committed H18 base, and `.omc/reviews/M19.diff`. Require an explicit `SPEC COMPLIANCE: APPROVED` or actionable findings. The spec review must verify both root output contracts, fresh no-argument limitation-state derivation, the exact conservative scope literals, annual warning order/deduplication, real captured `compute_client_debt` coverage, direct `buildAnnualReportData` coverage, unchanged `compute_account_balance`, unchanged client totals/cache metadata, exact four-file scope, and absence of M20 drift.

Only after spec approval, delegate a different fresh code-quality reviewer and require `CODE QUALITY APPROVED` or findings. It must inspect type precision, duplicated metadata construction, warning identity/deduplication behavior, accidental dependence on unrelated annual warnings, strength of public-handler assertions, and compatibility controls. Author and reviewers must be separate contexts. If either review finds a defect, add or correct the failing test first where applicable, reproduce RED, make the smallest fix, rerun Steps 7–9, regenerate the artifact, and restart both reviews in order.

- [ ] **Step 12: Reverify the approved bytes and commit M19**

After both approvals, rerun:

```bash
npx vitest run src/tools/account-balance.test.ts src/tools/annual-report.test.ts
npm run build
npm test
npm run test:integration
npm run validate:release
git diff --check
git diff -- src/tools/account-balance.ts src/tools/account-balance.test.ts src/tools/annual-report.ts src/tools/annual-report.test.ts > /tmp/M19.live.diff
cmp /tmp/M19.live.diff .omc/reviews/M19.diff
git diff --name-only
```

Expected: every validation passes, artifact comparison is silent, and changed names are exactly the reviewed four paths. Then run:

```bash
git add src/tools/account-balance.ts src/tools/account-balance.test.ts src/tools/annual-report.ts src/tools/annual-report.test.ts
git diff --cached --name-only
git diff --cached --check
git diff --cached > /tmp/M19.staged.diff
cmp /tmp/M19.staged.diff .omc/reviews/M19.diff
git commit -m "fix(M19): warn on incomplete opening balances"
```

Expected: staged names are exactly the four reviewed paths, staged diff-check passes, staged bytes match the frozen artifact, and the commit succeeds. Do not stage ignored artifacts and do not push.

- [ ] **Step 13: Record evidence and enforce the sequential handoff**

Use `apply_patch` to append one M19 row to `.omc/full-codebase-remediation-ledger.md` containing: the 27-test baseline; the exact 2-PASS/3-RED selected-case result and 5/5 GREEN result; proof from the real captured `compute_client_debt` handler and direct `buildAnnualReportData`; exact status/scope literals; exact account-999 warning order and exactly-once limitation proof; mocked complete-branch proof with the account-999 warning retained and no limitation; unchanged `compute_account_balance` warning/calculation; unchanged exact client `accounts` entry `{ account_id: 2110, account_name: <fixture name>, balance_type: "C", balance: 70, debit_total: 30, credit_total: 100, entry_count: 2 }`, exact summary `{ total_debt_to_client: 70, total_receivable_from_client: 0, net_position: -70 }`, exact cache metadata, and API/cache call counts; full/build/integration/release/diff results; artifact byte count/SHA; ordered independent spec and quality verdicts; exact four-file scope/no-M20-drift check; and the commit hash.

Run:

```bash
git status --short
git log -1 --oneline
```

Expected: clean worktree and the M19 commit at `HEAD`. Do not begin Task 15/M20 until M19 is committed, recorded, and clean.

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
