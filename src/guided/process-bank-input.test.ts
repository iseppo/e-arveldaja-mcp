import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { registerProcessBankInputTool, type ProcessBankInputDeps } from "./process-bank-input.js";
import {
  createAccountingWorkflowApi,
  fixtureAccountDimension,
  fixtureBankAccount,
  fixtureCamtXml,
} from "../__fixtures__/accounting-workflow.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { FILE_REFERENCE_OPERATIONS } from "../file-reference-store.js";
import { parseMcpResponse } from "../mcp-json.js";
import { createConnectionDefaultsStore } from "../connection-defaults-store.js";
import type { ElicitOutcome, Elicitor } from "../elicitation.js";

vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

const inlineXml = (xml: string) => `base64:${Buffer.from(xml, "utf8").toString("base64")}`;

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

function setup(options: {
  bankAccounts?: unknown[];
  accountDimensions?: unknown[];
  deps?: ProcessBankInputDeps;
} = {}) {
  const runtime = createTestRuntimeSafetyContext();
  const api = createAccountingWorkflowApi({
    bankAccounts: options.bankAccounts ?? [fixtureBankAccount({ accounts_dimensions_id: 7 })],
    accountDimensions: options.accountDimensions ?? [fixtureAccountDimension({ id: 7 })],
    transactionRows: [],
  });
  const server = { registerTool: vi.fn() } as any;
  registerProcessBankInputTool(server, api, runtime, options.deps ?? {});
  const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "process_bank_input");
  if (!registration) throw new Error("process_bank_input was not registered");
  const handler = registration[2] as Handler;
  return { runtime, api, handler };
}

const AMBIGUOUS_BANKS = [
  fixtureBankAccount({ accounts_dimensions_id: 7, iban_code: "EE111111111111111111", account_no: "EE111111111111111111" }),
  fixtureBankAccount({ accounts_dimensions_id: 8, iban_code: "EE222222222222222222", account_no: "EE222222222222222222" }),
];
const AMBIGUOUS_DIMS = [fixtureAccountDimension({ id: 7 }), fixtureAccountDimension({ id: 8 })];

// Two candidate dimensions that BOTH carry the statement IBAN: rung 2 (unique
// IBAN) can't tie-break (two matches ⇒ ambiguous), so the resolver reaches the
// elicitation/saved-default rungs. Both share ledger account 1020, so
// expectedLedgerAccountId is defined and rung 3 / persistence can engage. (The
// downstream CAMT statement-identity gate is orthogonal to resolution and not
// under test here.)
const STATEMENT_IBAN = "EE637700771011212909";
const BOTH_MATCH_BANKS = [
  fixtureBankAccount({ accounts_dimensions_id: 7, iban_code: STATEMENT_IBAN, account_no: STATEMENT_IBAN }),
  fixtureBankAccount({ accounts_dimensions_id: 8, iban_code: STATEMENT_IBAN, account_no: STATEMENT_IBAN }),
];

function stubElicitor(outcome: ElicitOutcome, calls: { count: number; lastFields?: Record<string, unknown> }): Elicitor {
  return async (opts) => {
    calls.count += 1;
    calls.lastFields = opts.fields as Record<string, unknown>;
    return outcome;
  };
}

// Resolution (incl. elicit + consented persist) happens BEFORE the CAMT
// statement-identity booking gate. That gate is orthogonal to what these tests
// assert (the resolution/elicit/persist layer), and — because a bookable-yet-
// ambiguous CAMT is unreachable (a statement IBAN either uniquely matches one
// dimension, auto-resolving, or matches several, which the gate rejects) — it
// throws here. Swallow it so the resolution-layer side effects can be asserted.
async function prepareSwallowingBookingGate(handler: Handler, source: string): Promise<void> {
  try { await handler({ mode: "prepare", file_path: source }); } catch { /* downstream booking gate — orthogonal */ }
}

const parse = (result: { content: Array<{ text: string }> }) => parseMcpResponse(result.content[0]!.text) as any;

describe("process_bank_input", () => {
  it("prepares a CAMT statement, resolves the unique bank dimension silently, and returns a compact plan handle", async () => {
    const { handler } = setup();
    const result = await handler({ mode: "prepare", file_path: inlineXml(fixtureCamtXml()) });
    expect(result.isError).toBeFalsy();
    const payload = parse(result);
    expect(payload.summary).toBeDefined();
    expect(payload.summary.status).toBe("ready_for_approval");
    expect(typeof payload.summary.plan_handle).toBe("string");
    // No technical dimension id was demanded from the user, and no delegated
    // granular tool name / MCP-response parsing leaks into the output.
    const text = result.content[0]!.text;
    expect(text).not.toContain("import_camt053");
    expect(text).not.toContain("parse_camt053");
    expect(text).not.toContain("import_wise_transactions");
    expect(text).not.toContain("delegated_tool");
  });

  it("runs the two-call prepare -> execute path over the same immutable snapshot", async () => {
    const { handler, api } = setup();
    const source = inlineXml(fixtureCamtXml());
    const dry = parse(await handler({ mode: "prepare", file_path: source }));
    const planHandle = dry.summary.plan_handle as string;
    expect(planHandle).toBeTruthy();
    const executed = parse(await handler({ mode: "execute", file_path: source, plan_handle: planHandle }));
    expect(executed.summary.status).toMatch(/completed|partial/);
    expect(api.transactions.create).toHaveBeenCalled();
  });

  it("accepts a bank_input file_ref and rejects a camt_input ref passed to the façade", async () => {
    const { handler, runtime } = setup();
    const dir = await mkdtemp(join(tmpdir(), "bank-facade-"));
    const xmlPath = join(dir, "statement.xml");
    await writeFile(xmlPath, fixtureCamtXml(), "utf8");

    const bankRef = runtime.fileReferenceStore.issue({ canonicalPath: xmlPath, kind: "file", operation: FILE_REFERENCE_OPERATIONS.bank });
    const ok = await handler({ mode: "prepare", file_ref: bankRef });
    expect(ok.isError).toBeFalsy();
    expect(parse(ok).summary).toBeDefined();

    const camtRef = runtime.fileReferenceStore.issue({ canonicalPath: xmlPath, kind: "file", operation: FILE_REFERENCE_OPERATIONS.camt });
    const rejected = await handler({ mode: "prepare", file_ref: camtRef });
    expect(rejected.isError).toBe(true);
  });

  it("asks a compact, OCR-wrapped question when the bank dimension is ambiguous", async () => {
    const { handler } = setup({
      bankAccounts: [
        fixtureBankAccount({ accounts_dimensions_id: 7, iban_code: "EE111111111111111111", account_no: "EE111111111111111111" }),
        fixtureBankAccount({ accounts_dimensions_id: 8, iban_code: "EE222222222222222222", account_no: "EE222222222222222222" }),
      ],
      accountDimensions: [fixtureAccountDimension({ id: 7 }), fixtureAccountDimension({ id: 8 })],
    });
    const result = await handler({ mode: "prepare", file_path: inlineXml(fixtureCamtXml()) });
    const payload = parse(result);
    expect(payload.status).toBe("needs_input");
    expect(Array.isArray(payload.choices)).toBe(true);
    // F-RESOLVER-FACADE-WRAP: question + choice labels are OCR-sandbox-wrapped.
    expect(payload.question).toContain("UNTRUSTED_OCR_START");
    expect(payload.choices[0].label).toContain("UNTRUSTED_OCR_START");
  });

  it("rejects an unsupported input without mutation or raw-byte echo", async () => {
    const { handler, api } = setup();
    const result = await handler({ mode: "prepare", file_path: `base64:csv:${Buffer.from("not,a,bank\nfile,x,y\n", "utf8").toString("base64")}` });
    expect(result.isError).toBe(true);
    const payload = parse(result);
    expect(payload.category).toBe("bank_input_unsupported");
    expect(api.transactions.create).not.toHaveBeenCalled();
    expect(result.content[0]!.text).not.toContain("not,a,bank");
  });
});

describe("process_bank_input — capability-aware elicitation + persisted default", () => {
  const storePath = () => {
    const dir = mkdtempSync(join(tmpdir(), "pbi-defaults-"));
    tempDirs.push(dir);
    return join(dir, "connection-defaults.json");
  };
  const tempDirs: string[] = [];
  afterEach(() => { while (tempDirs.length) { try { rmSync(tempDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ } } });

  it("offers the ambiguous bank dimension as a NON-SECRET, bounded form", async () => {
    const calls = { count: 0 } as { count: number; lastFields?: Record<string, unknown> };
    const elicit = stubElicitor({ kind: "answered", content: { accounts_dimensions_id: "8" } }, calls);
    const { handler } = setup({ bankAccounts: BOTH_MATCH_BANKS, accountDimensions: AMBIGUOUS_DIMS, deps: { elicit } });
    await prepareSwallowingBookingGate(handler, inlineXml(fixtureCamtXml()));
    expect(calls.count).toBe(1);
    // No secret field is ever elicited; only the bounded dimension + consent flag.
    expect(Object.keys(calls.lastFields!)).toEqual(["accounts_dimensions_id", "remember_for_connection"]);
    for (const key of Object.keys(calls.lastFields!)) expect(key).not.toMatch(/api.?key|password|secret|token|public.?value/i);
  });

  it("does NOT persist a resolved choice without remember_for_connection consent", async () => {
    const store = createConnectionDefaultsStore(storePath());
    const calls = { count: 0 } as { count: number; lastFields?: Record<string, unknown> };
    const elicit = stubElicitor({ kind: "answered", content: { accounts_dimensions_id: "8", remember_for_connection: false } }, calls);
    const { handler } = setup({ bankAccounts: BOTH_MATCH_BANKS, accountDimensions: AMBIGUOUS_DIMS, deps: { elicit, defaultsStore: store } });
    await prepareSwallowingBookingGate(handler, inlineXml(fixtureCamtXml()));
    expect(calls.count).toBe(1);
    expect(store.entryCount()).toBe(0); // never persisted without consent
  });

  it("persists a NON-SECRET hint on consent, and a SUBSEQUENT scan resolves via rung 3 WITHOUT another question", async () => {
    const path = storePath();
    const store = createConnectionDefaultsStore(path);
    const firstCalls = { count: 0 } as { count: number; lastFields?: Record<string, unknown> };
    const consentElicit = stubElicitor({ kind: "answered", content: { accounts_dimensions_id: "8", remember_for_connection: true } }, firstCalls);
    const first = setup({ bankAccounts: BOTH_MATCH_BANKS, accountDimensions: AMBIGUOUS_DIMS, deps: { elicit: consentElicit, defaultsStore: store } });
    await prepareSwallowingBookingGate(first.handler, inlineXml(fixtureCamtXml()));
    expect(firstCalls.count).toBe(1);
    expect(store.entryCount()).toBe(1); // persisted the hint

    // The persisted document holds NO secret material.
    expect(JSON.stringify(store.readBankDefault({ connectionId: "test-fingerprint", environmentKind: "demo", expectedLedgerAccountId: 1020 })))
      .not.toMatch(/api.?key|password|secret|public.?value/i);

    // Second scan, SAME connection/store: rung 3 resolves silently. The elicitor
    // throws if consulted — proving no fresh question was asked.
    const throwingCalls = { count: 0 } as { count: number };
    const throwingElicit: Elicitor = async () => { throwingCalls.count += 1; throw new Error("elicitor must NOT be called when a saved default resolves"); };
    const second = setup({ bankAccounts: BOTH_MATCH_BANKS, accountDimensions: AMBIGUOUS_DIMS, deps: { elicit: throwingElicit, defaultsStore: store } });
    await prepareSwallowingBookingGate(second.handler, inlineXml(fixtureCamtXml()));
    expect(throwingCalls.count).toBe(0);
  });

  it("falls back to the compact text needs_input question on an unsupported client", async () => {
    const elicit: Elicitor = async (opts) => ({ kind: "unsupported", needsInput: opts.needsInput });
    const { handler } = setup({ bankAccounts: BOTH_MATCH_BANKS, accountDimensions: AMBIGUOUS_DIMS, deps: { elicit } });
    const payload = parse(await handler({ mode: "prepare", file_path: inlineXml(fixtureCamtXml()) }));
    expect(payload.status).toBe("needs_input");
    expect(payload.question).toContain("UNTRUSTED_OCR_START");
    expect(payload.choices[0].label).toContain("UNTRUSTED_OCR_START");
  });
});
