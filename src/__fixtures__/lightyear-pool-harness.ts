import { vi, type Mock } from "vitest";
import { createTestRuntimeSafetyContext } from "./runtime-safety.js";
import { parseToolPayload } from "./mcp-response.js";
import { memoryUsdPoolStore } from "./usd-pool-store.js";
import type { ApiContext } from "../tools/crud/shared.js";
import type { Journal } from "../types/api.js";
import type { EcbFetch, EcbFetchResponse, EcbRateDeps } from "../fx/ecb-rates.js";
import { endOfDaySeconds, type PoolKey, type UsdPoolCheckpoint, type UsdPoolEvent, type UsdPoolRecord } from "../lightyear/usd-pool.js";
import { registerLightyearTools } from "../tools/lightyear-investments.js";

/**
 * Offline harness for the USD-pool Lightyear tools (synthetic data only).
 * The calling test file mocks ../bounded-read.js, ../file-validation.js,
 * ../progress.js and ../audit-log.js and feeds the statement through
 * readFileCapped.
 */
export const POOL_CONNECTION = "lightyear-pool-harness-connection";
export const POOL_STATEMENT_PATH = "/tmp/AccountStatement-LY-TESTACCT1-2026-01-01_2026-10-30_en.csv";
export const POOL_KEY: PoolKey = { connection_fingerprint: POOL_CONNECTION, lightyear_account: "TESTACCT1", broker_account: 1120, broker_dimension_id: null, currency: "USD" };
const ECB_HEADER = "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS";

export function ecbResponse(body: string, status = 200): EcbFetchResponse {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body };
}

export type FetchMock = ReturnType<typeof vi.fn> & EcbFetch;

/** One observation per calendar day before 2026-10-31; `rates` maps a day to its rate, else `fallback`. */
export function rateFetch(fallback = "1.1225", rates: Record<string, string> = {}): FetchMock {
  return vi.fn(async (url: string) => {
    const params = new URL(url).searchParams;
    const days: string[] = [];
    for (let day = new Date(`${params.get("startPeriod")}T00:00:00Z`); day <= new Date(`${params.get("endPeriod")}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
      const iso = day.toISOString().slice(0, 10);
      if (iso < "2026-10-31") days.push(iso);
    }
    return ecbResponse([ECB_HEADER, ...days.map(day => `EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${day},${rates[day] ?? fallback},A`)].join("\n") + "\n");
  }) as FetchMock;
}

export function poolOpening(usd: number, eur: number, rate: string, asOf = "2025-12-31", key: PoolKey = POOL_KEY): UsdPoolCheckpoint {
  return {
    record: "checkpoint", pool_key: key, kind: "opening", as_of: asOf, ts: endOfDaySeconds(asOf),
    usd_cents: usd, eur_cents: eur, fx_cents: 0, journal_id: null, document_number: null,
    rate, rate_date: asOf, approved: true, postings: [], recorded_at: "t",
  };
}

/** A committed distribution_in event (statement time `iso`, read as UTC like the statement clock); postings as {@link poolJournal}. */
export function poolDistribution(ref: string, iso: string, usd: number, eur: number, journalId: number, incomeAccount = 8320): UsdPoolEvent {
  return {
    record: "event", pool_key: POOL_KEY, ref, ts: Date.parse(iso) / 1000, kind: "distribution_in", usd_cents: usd, eur_cents: eur,
    document_number: `LY:${ref}`, journal_id: journalId, journal_broker_net_cents: eur, state: "committed",
    postings: [
      { accounts_id: 1120, accounts_dimensions_id: null, type: "D", amount_cents: eur },
      { accounts_id: incomeAccount, accounts_dimensions_id: null, type: "C", amount_cents: eur },
    ],
    recorded_at: "t",
  };
}

export function poolJournal(id: number, ref: string, eurCents: number, incomeAccount = 8320): Journal {
  return {
    id, document_number: `LY:${ref}`, effective_date: "2026-01-01", registered: true, is_deleted: false,
    postings: [{ accounts_id: 1120, type: "D", amount: eurCents / 100 }, { accounts_id: incomeAccount, type: "C", amount: eurCents / 100 }],
  };
}

export interface CreatedJournal { document_number?: string; postings?: Array<{ accounts_id: number; type: string; amount: number; accounts_dimensions_id?: number }> }

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };

export interface PoolToolEnv<P> {
  api: {
    readonly: { getAccounts: Mock; getAccountDimensions: Mock };
    journals: {
      connectionFingerprint: string;
      invalidateListCache: Mock;
      listAll: Mock<() => Promise<Journal[]>>;
      get: Mock<(id: number) => Promise<Journal>>;
      create: Mock<(payload: CreatedJournal) => Promise<{ created_object_id: number }>>;
    };
  };
  ledger: Map<number, Journal>;
  create: Mock<(payload: CreatedJournal) => Promise<{ created_object_id: number }>>;
  created: CreatedJournal[];
  fetch: FetchMock;
  ecbCache: NonNullable<EcbRateDeps["cache"]>;
  store: ReturnType<typeof memoryUsdPoolStore>;
  context: ReturnType<typeof createTestRuntimeSafetyContext>;
  run: (args?: Record<string, unknown>) => Promise<{ result: ToolResult; payload: P }>;
  book: (args?: Record<string, unknown>) => Promise<{ dry: { result: ToolResult; payload: P }; exec: { result: ToolResult; payload: P } }>;
}

export function setupPoolTool<P>(toolName: string, defaults: Record<string, unknown>, options: { fetch?: FetchMock; pool?: UsdPoolRecord[]; journals?: Journal[]; store?: ReturnType<typeof memoryUsdPoolStore> } = {}): PoolToolEnv<P> {
  const server = { registerTool: vi.fn() };
  const ledger = new Map<number, Journal>((options.journals ?? []).map(j => [j.id!, structuredClone(j)]));
  const created: CreatedJournal[] = [];
  const create: PoolToolEnv<P>["create"] = vi.fn(async (payload: CreatedJournal) => {
    created.push(payload);
    const id = 9000 + created.length;
    ledger.set(id, { id, registered: false, is_deleted: false, ...payload } as unknown as Journal);
    return { created_object_id: id };
  });
  const accounts = [1120, 1550, 8320, 8330, 8335, 8400, 8500, 8610].map(id => ({ id, is_deleted: false, is_valid: true, code: String(id), title_est: `Konto ${id}`, name_est: `Konto ${id}` }));
  const api = {
    readonly: { getAccounts: vi.fn().mockResolvedValue(accounts), getAccountDimensions: vi.fn().mockResolvedValue([]) },
    journals: {
      connectionFingerprint: POOL_CONNECTION,
      invalidateListCache: vi.fn(),
      listAll: vi.fn(async (): Promise<Journal[]> => [...ledger.values()]),
      get: vi.fn(async (id: number): Promise<Journal> => ledger.get(id)!),
      create,
    },
  };
  const fetch = options.fetch ?? rateFetch();
  const ecbCache: NonNullable<EcbRateDeps["cache"]> = new Map();
  const store = options.store ?? memoryUsdPoolStore(options.pool ?? []);
  const context = createTestRuntimeSafetyContext();
  registerLightyearTools(server as unknown as Parameters<typeof registerLightyearTools>[0], api as unknown as ApiContext, context, {
    ecb: { fetch, today: () => "2026-10-31", now: () => new Date("2026-10-31T08:00:00Z"), cache: ecbCache },
    usdPoolStore: store,
  });
  const registration = server.registerTool.mock.calls.find(call => call[0] === toolName);
  if (!registration) throw new Error(`${toolName} not registered`);
  const handler = registration[2] as (args: Record<string, unknown>) => Promise<ToolResult>;
  const run = async (args: Record<string, unknown> = {}) => {
    const result = await handler({ file_path: POOL_STATEMENT_PATH, ...defaults, ...args });
    return { result, payload: parseToolPayload<P>(result.content[0]!.text) };
  };
  const book = async (args: Record<string, unknown> = {}) => {
    const dry = await run({ ...args, dry_run: true });
    const exec = await run({ ...args, dry_run: false, plan_handle: (dry.payload as { plan_handle?: string }).plan_handle });
    return { dry, exec };
  };
  return { api, ledger, create, created, fetch, ecbCache, store, context, run, book };
}
