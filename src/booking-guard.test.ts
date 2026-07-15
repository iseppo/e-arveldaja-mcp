import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { text as consumeText } from "node:stream/consumers";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, it, expect, vi } from "vitest";
import {
  BookingGuard,
  formatDocNumber,
  parseDocNumber,
  type DocKey,
} from "./booking-guard.js";
import { HttpError } from "./http-client.js";
import { MutationIndeterminateError } from "./mutation-outcome.js";
import { withOwnedFileLock } from "./file-lock.js";
import type { ApiContext } from "./tools/crud-tools.js";
import type { Journal, Posting } from "./types/api.js";

const networkError = () => new HttpError("fetch failed", "network", "POST", "/journals");

interface ChildObservation {
  code: number | null;
  stdout: string;
  stderr: string;
}

function observeChild(child: ChildProcess, timeoutMs: number): Promise<ChildObservation> {
  return new Promise((resolveObserved, rejectObserved) => {
    let recordedError: Error | undefined;
    const streamsDone = Promise.all([
      child.stdout ? consumeText(child.stdout) : Promise.resolve(""),
      child.stderr ? consumeText(child.stderr) : Promise.resolve(""),
    ]).catch(error => {
      recordedError ??= error instanceof Error ? error : new Error(String(error));
      return ["", ""] as const;
    });
    const timer = setTimeout(() => {
      recordedError ??= new Error(`child timeout after ${timeoutMs}ms`);
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", error => {
      recordedError ??= error;
    });
    child.once("close", code => {
      clearTimeout(timer);
      void streamsDone.then(([stdout, stderr]) => {
        if (recordedError) {
          if (stderr) recordedError.message += `; stderr: ${stderr}`;
          rejectObserved(recordedError);
        }
        else resolveObserved({ code, stdout, stderr });
      });
    });
  });
}

// ---- helpers ------------------------------------------------------------

function journal(overrides: Partial<Journal>): Journal {
  return {
    id: 1,
    effective_date: "2026-01-01",
    registered: true,
    is_deleted: false,
    postings: [],
    ...overrides,
  };
}

function bankPosting(dim: number, type: "D" | "C", amount: number): Posting {
  return {
    accounts_id: 1000,
    accounts_dimensions_id: dim,
    type,
    amount,
    is_deleted: false,
  } as Posting;
}

interface SetupOptions {
  journals?: Journal[];
  ownDimensionIds?: Set<number>;
  createResult?: { created_object_id?: number };
  createImpl?: (data: Partial<Journal>) => Promise<{ created_object_id?: number }>;
  confirmImpl?: (id: number) => Promise<unknown>;
}

function setup(options: SetupOptions = {}) {
  const state = [...(options.journals ?? [])];
  const create = vi.fn(async (data: Partial<Journal>) => {
    const result = options.createImpl
      ? await options.createImpl(data)
      : (options.createResult ?? { code: 200, messages: [], created_object_id: 999 });
    if (result.created_object_id != null) {
      state.push(journal({ ...data, id: result.created_object_id, registered: false, is_deleted: false }));
    }
    return result;
  });
  const confirm = options.confirmImpl
    ? vi.fn(options.confirmImpl)
    : vi.fn().mockResolvedValue({});
  const listAll = vi.fn(async () => state);
  const listAllWithPostings = vi.fn(async () => state);
  const get = vi.fn(async (id: number) => state.find(item => item.id === id));
  const invalidateListCache = vi.fn();

  const api = {
    journals: {
      connectionFingerprint: "test-connection-fingerprint",
      create, confirm, listAll, listAllWithPostings, get, invalidateListCache,
    },
  } as unknown as ApiContext;

  return { api, state, create, confirm, get, listAll, listAllWithPostings, invalidateListCache };
}

// ---- document_number parsing -------------------------------------------

describe("formatDocNumber / parseDocNumber", () => {
  it("round-trips a known namespace key", () => {
    const key: DocKey = { ns: "FX", id: "123" };
    expect(formatDocNumber(key)).toBe("FX:123");
    expect(parseDocNumber("FX:123")).toEqual(key);
  });

  it("parses Lightyear references containing dashes", () => {
    expect(parseDocNumber("LY:OR-EVN9C76R7A")).toEqual({ ns: "LY", id: "OR-EVN9C76R7A" });
  });

  it("keeps everything after the first colon as the id", () => {
    expect(parseDocNumber("LY:OR:WEIRD")).toEqual({ ns: "LY", id: "OR:WEIRD" });
  });

  it("rejects unknown namespaces and malformed values", () => {
    expect(parseDocNumber("WISE:1")).toBeUndefined(); // not a Lane A namespace here
    expect(parseDocNumber("nocolon")).toBeUndefined();
    expect(parseDocNumber(":123")).toBeUndefined();
    expect(parseDocNumber("FX:")).toBeUndefined();
    expect(parseDocNumber(null)).toBeUndefined();
    expect(parseDocNumber(undefined)).toBeUndefined();
  });
});

// ---- load: snapshot source ---------------------------------------------

describe("BookingGuard.load — snapshot source", () => {
  it("uses the cheap listAll for a Lane-A-only load (no dims)", async () => {
    const { api, listAll, listAllWithPostings } = setup();
    await BookingGuard.load(api);
    expect(listAll).toHaveBeenCalledTimes(1);
    expect(listAllWithPostings).not.toHaveBeenCalled();
  });

  it("hydrates postings when Lane B dims are supplied", async () => {
    const { api, listAll, listAllWithPostings } = setup({ ownDimensionIds: new Set([1]) });
    await BookingGuard.load(api, { ownDimensionIds: new Set([1]) });
    expect(listAllWithPostings).toHaveBeenCalledTimes(1);
    expect(listAll).not.toHaveBeenCalled();
  });
});

// ---- Lane A: find / record ---------------------------------------------

describe("BookingGuard Lane A — find", () => {
  it("finds an existing FX journal by key", async () => {
    const { api } = setup({
      journals: [journal({ id: 42, document_number: "FX:100" })],
    });
    const guard = await BookingGuard.load(api);
    const found = guard.find({ ns: "FX", id: "100" });
    expect(found?.journal_id).toBe(42);
  });

  it("ignores journals without a known namespace prefix", async () => {
    const { api } = setup({
      journals: [journal({ id: 7, document_number: "MANUAL-2026" })],
    });
    const guard = await BookingGuard.load(api);
    expect(guard.find({ ns: "FX", id: "100" })).toBeUndefined();
  });

  it("excludes deleted journals by default (not_deleted liveness)", async () => {
    const { api } = setup({
      journals: [journal({ id: 42, document_number: "FX:100", is_deleted: true })],
    });
    const guard = await BookingGuard.load(api);
    expect(guard.find({ ns: "FX", id: "100" })).toBeUndefined();
    // ...but "any" still surfaces it
    expect(guard.find({ ns: "FX", id: "100" }, "any")?.journal_id).toBe(42);
  });

  it("registered_only excludes unconfirmed journals", async () => {
    const { api } = setup({
      journals: [journal({ id: 42, document_number: "FX:100", registered: false })],
    });
    const guard = await BookingGuard.load(api);
    expect(guard.find({ ns: "FX", id: "100" }, "not_deleted")?.journal_id).toBe(42);
    expect(guard.find({ ns: "FX", id: "100" }, "registered_only")).toBeUndefined();
  });

  it("prefers a live artifact when a deleted duplicate exists", async () => {
    const { api } = setup({
      journals: [
        journal({ id: 1, document_number: "FX:100", is_deleted: true }),
        journal({ id: 2, document_number: "FX:100", is_deleted: false }),
      ],
    });
    const guard = await BookingGuard.load(api);
    expect(guard.find({ ns: "FX", id: "100" })?.journal_id).toBe(2);
  });

  it("record makes a subsequent find succeed in-run", async () => {
    const { api } = setup();
    const guard = await BookingGuard.load(api);
    expect(guard.find({ ns: "FX", id: "5" })).toBeUndefined();
    guard.record({ ns: "FX", id: "5" }, 321);
    expect(guard.find({ ns: "FX", id: "5" })?.journal_id).toBe(321);
  });
});

// ---- Lane A: createJournalOnce -----------------------------------------

describe("BookingGuard Lane A — createJournalOnce", () => {
  it("creates, stamps the document_number, confirms, and records", async () => {
    const { api, create, confirm } = setup({ createResult: { created_object_id: 555 } });
    const guard = await BookingGuard.load(api);

    const result = await guard.createJournalOnce(
      { ns: "FX", id: "77" },
      { effective_date: "2026-02-02", title: "FX", document_number: "IGNORED" as never, postings: [] },
    );

    expect(result).toMatchObject({ status: "created", journal_id: 555, registered: true });
    expect(result.status === "created" && result.upstream_response).toEqual({ created_object_id: 555 });
    expect(create).toHaveBeenCalledTimes(1);
    // Caller-provided document_number is overwritten from the key.
    expect(create.mock.calls[0]![0].document_number).toBe("FX:77");
    expect(confirm).toHaveBeenCalledWith(555);
    // Recorded in-run: a second call is a duplicate, no second create.
    const second = await guard.createJournalOnce({ ns: "FX", id: "77" }, { effective_date: "2026-02-02", postings: [] });
    expect(second).toEqual({ status: "duplicate", journal_id: 555 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("returns duplicate without creating when a live journal already exists", async () => {
    const { api, create } = setup({
      journals: [journal({ id: 9, document_number: "FX:100" })],
    });
    const guard = await BookingGuard.load(api);
    const result = await guard.createJournalOnce({ ns: "FX", id: "100" }, { effective_date: "2026-01-01", postings: [] });
    expect(result).toEqual({ status: "duplicate", journal_id: 9 });
    expect(create).not.toHaveBeenCalled();
  });

  it("re-books over a deleted journal (deleted does not block)", async () => {
    const { api, create } = setup({
      journals: [journal({ id: 9, document_number: "FX:100", is_deleted: true })],
      createResult: { created_object_id: 1001 },
    });
    const guard = await BookingGuard.load(api);
    const result = await guard.createJournalOnce({ ns: "FX", id: "100" }, { effective_date: "2026-01-01", postings: [] });
    expect(result).toMatchObject({ status: "created", journal_id: 1001, registered: true });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("H06-C propagates a definite confirm rejection with createdJournalId", async () => {
    const { api } = setup({
      createResult: { created_object_id: 200 },
      confirmImpl: async () => {
        throw new HttpError("confirm failed", 400, "PATCH", "/journals/200/register");
      },
    });
    const guard = await BookingGuard.load(api);
    await expect(guard.createJournalOnce(
      { ns: "FX", id: "1" }, { effective_date: "2026-01-01", postings: [] },
    )).rejects.toMatchObject({ status: 400, createdJournalId: 200 });
  });

  it("does not confirm when confirm:false", async () => {
    const { api, confirm } = setup({ createResult: { created_object_id: 300 } });
    const guard = await BookingGuard.load(api);
    const result = await guard.createJournalOnce(
      { ns: "FX", id: "1" },
      { effective_date: "2026-01-01", postings: [] },
      { confirm: false },
    );
    expect(result).toMatchObject({ status: "created", journal_id: 300, registered: false });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("H06-C rejects indeterminately rather than recording a sentinel when the API returns no object id", async () => {
    const { api, create } = setup({ createResult: {} });
    const guard = await BookingGuard.load(api);
    await expect(guard.createJournalOnce(
      { ns: "FX", id: "1" }, { effective_date: "2026-01-01", postings: [] },
    )).rejects.toMatchObject({ category: "mutation_indeterminate", operation: "create" });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

// ---- Lane A: createJournalOnce verify-then-retry -----------------------

describe("BookingGuard.createJournalOnce — verify-then-retry", () => {
  it("recovers the committed journal when a network error is ambiguous (no retry)", async () => {
    const { api, state, create, confirm, listAll, invalidateListCache } = setup();
    const guard = await BookingGuard.load(api); // loads with []

    // The create POST times out ambiguously...
    create.mockRejectedValueOnce(networkError());
    // ...but the re-scan shows it actually committed as journal 4242.
    listAll.mockResolvedValueOnce([]).mockResolvedValueOnce([
      journal({ id: 4242, document_number: "FX:9", registered: true }),
    ]);

    const result = await guard.createJournalOnce(
      { ns: "FX", id: "9" },
      { effective_date: "2026-01-01", postings: [] },
    );

    expect(result).toEqual({ status: "created", journal_id: 4242, registered: true, recovered: true });
    expect(invalidateListCache).toHaveBeenCalledTimes(2); // fresh check + ambiguity verification
    expect(create).toHaveBeenCalledTimes(1); // NOT retried — already committed
    expect(confirm).not.toHaveBeenCalled(); // recovered journal, not re-confirmed
    state.push(journal({ id: 4242, document_number: "FX:9", registered: true }));
    // A second fresh upstream check is deduped.
    const second = await guard.createJournalOnce({ ns: "FX", id: "9" }, { effective_date: "2026-01-01", postings: [] });
    expect(second).toEqual({ status: "duplicate", journal_id: 4242 });
  });

  it("confirms a recovered journal that committed in PROJECT state", async () => {
    const { api, create, confirm, listAll } = setup();
    const guard = await BookingGuard.load(api);

    create.mockRejectedValueOnce(networkError());
    // The committed journal exists but was never confirmed (create doesn't
    // auto-confirm, and the network error cut off before our confirm call).
    listAll.mockResolvedValueOnce([]).mockResolvedValueOnce([
      journal({ id: 55, document_number: "FX:9", registered: false }),
    ]);

    const result = await guard.createJournalOnce(
      { ns: "FX", id: "9" },
      { effective_date: "2026-01-01", postings: [] },
    );

    expect(result).toEqual({ status: "created", journal_id: 55, registered: true, recovered: true });
    expect(confirm).toHaveBeenCalledWith(55); // recovered PROJECT journal is confirmed
    expect(create).toHaveBeenCalledTimes(1); // still not retried
  });

  it("does not confirm a recovered journal when confirm:false", async () => {
    const { api, confirm, create, listAll } = setup();
    const guard = await BookingGuard.load(api);

    create.mockRejectedValueOnce(networkError());
    listAll.mockResolvedValueOnce([]).mockResolvedValueOnce([
      journal({ id: 55, document_number: "LY:R1", registered: false }),
    ]);

    const result = await guard.createJournalOnce(
      { ns: "LY", id: "R1" },
      { effective_date: "2026-01-01", postings: [] },
      { confirm: false },
    );

    expect(result).toEqual({ status: "created", journal_id: 55, registered: false, recovered: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("H06-C absent verification stays indeterminate and never retries", async () => {
    const { api, create, listAll } = setup();
    const guard = await BookingGuard.load(api);

    create.mockRejectedValueOnce(networkError());
    listAll.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await expect(guard.createJournalOnce(
      { ns: "FX", id: "9" },
      { effective_date: "2026-01-01", postings: [] },
    )).rejects.toMatchObject({ category: "mutation_indeterminate", operation: "create" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("H06-C verification-read failure stays indeterminate without a retry", async () => {
    const { api, create, listAll } = setup();
    const guard = await BookingGuard.load(api);

    create.mockRejectedValueOnce(networkError());
    listAll.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("verify read failed"));

    await expect(
      guard.createJournalOnce({ ns: "FX", id: "9" }, { effective_date: "2026-01-01", postings: [] }),
    ).rejects.toMatchObject({ category: "mutation_indeterminate", operation: "create" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not verify or retry on a non-network HTTP error", async () => {
    const { api, create, listAll, invalidateListCache } = setup();
    const guard = await BookingGuard.load(api);

    const badRequest = new HttpError("bad request", 400, "POST", "/journals");
    create.mockRejectedValueOnce(badRequest);

    await expect(
      guard.createJournalOnce({ ns: "FX", id: "9" }, { effective_date: "2026-01-01", postings: [] }),
    ).rejects.toThrow(badRequest);
    expect(create).toHaveBeenCalledTimes(1); // no retry
    expect(invalidateListCache).toHaveBeenCalledTimes(1); // guarded fresh pre-check only
    expect(listAll).toHaveBeenCalledTimes(2); // initial load + guarded fresh pre-check
  });
});

const structuredAmbiguity = (operation: "create" | "confirm" = "create") =>
  new MutationIndeterminateError({
    operation,
    entity: "journal",
    businessKey: "upstream-key",
    affectedCaches: ["/journals"],
    cause: new Error("ambiguous"),
    nextAction: "verify",
  });

describe("H06-C cross-process create-once", () => {
  it("H06-C keeps the fresh pre-check inside the booking-key lock", async () => {
    const prior = process.env.EARVELDAJA_LOCK_DIR;
    const lockDir = await mkdtemp(resolve(tmpdir(), "h06-booking-held-"));
    process.env.EARVELDAJA_LOCK_DIR = lockDir;
    const key: DocKey = { ns: "FX", id: "held" };
    const { api, state, create, listAll, invalidateListCache } = setup();
    const guard = await BookingGuard.load(api);
    listAll.mockClear();
    invalidateListCache.mockClear();
    create.mockClear();
    const digest = createHash("sha256")
      .update(`test-connection-fingerprint\0journal\0${formatDocNumber(key)}`)
      .digest("hex");
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolveHeld => { release = resolveHeld; });
    const acquired = new Promise<void>(resolveAcquired => { entered = resolveAcquired; });
    const holder = withOwnedFileLock(resolve(lockDir, `${digest}.lock`), async () => {
      entered();
      await held;
    });
    await acquired;
    let createStarted!: () => void;
    const createSignal = new Promise<void>(resolveCreate => { createStarted = resolveCreate; });
    create.mockImplementationOnce(async data => {
      createStarted();
      return { code: 200, messages: [], created_object_id: 999 };
    });
    const pending = guard.createJournalOnce(key, { effective_date: "2026-01-01", postings: [] }, { confirm: false });
    let settled: PromiseSettledResult<Awaited<typeof pending>> | undefined;
    try {
      const ran = await Promise.race([
        createSignal.then(() => true),
        new Promise<false>(resolveTimer => setTimeout(() => resolveTimer(false), 75)),
      ]);
      expect(ran).toBe(false);
      expect(invalidateListCache).not.toHaveBeenCalled();
      expect(listAll).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    } finally {
      state.push(journal({ id: 42, document_number: "FX:held", registered: true }));
      release();
      await holder;
      [settled] = await Promise.allSettled([pending]);
      if (prior === undefined) delete process.env.EARVELDAJA_LOCK_DIR;
      else process.env.EARVELDAJA_LOCK_DIR = prior;
      await rm(lockDir, { recursive: true, force: true });
    }
    expect(settled).toMatchObject({ status: "fulfilled", value: { status: "duplicate", journal_id: 42 } });
    expect(invalidateListCache.mock.invocationCallOrder[0]).toBeLessThan(listAll.mock.invocationCallOrder[0]!);
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["raw", "structured"])("H06-C recovers a found %s ambiguous create without retry", async kind => {
    const { api, create, listAll, invalidateListCache } = setup();
    const guard = await BookingGuard.load(api);
    listAll.mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([journal({ id: 77, document_number: "FX:amb", registered: true })]);
    create.mockRejectedValueOnce(kind === "raw" ? networkError() : structuredAmbiguity());
    const result = await guard.createJournalOnce({ ns: "FX", id: "amb" }, { effective_date: "2026-01-01", postings: [] });
    expect(result).toMatchObject({ status: "created", journal_id: 77, recovered: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(invalidateListCache).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["raw", "absent"], ["raw", "throwing"], ["structured", "absent"], ["structured", "throwing"],
  ])("H06-C makes a %s ambiguous create with %s verification indeterminate", async (kind, verification) => {
    const { api, create, listAll } = setup();
    const guard = await BookingGuard.load(api);
    listAll.mockReset().mockResolvedValueOnce([]);
    if (verification === "throwing") listAll.mockRejectedValueOnce(new Error("verify failed"));
    else listAll.mockResolvedValueOnce([]);
    create.mockRejectedValueOnce(kind === "raw" ? networkError() : structuredAmbiguity());
    await expect(guard.createJournalOnce(
      { ns: "FX", id: "absent" }, { effective_date: "2026-01-01", postings: [] },
    )).rejects.toMatchObject({ category: "mutation_indeterminate", operation: "create", businessKey: "FX:absent" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("H06-C does not ambiguity-verify a definite create rejection", async () => {
    const { api, create, listAll, invalidateListCache } = setup();
    const guard = await BookingGuard.load(api);
    listAll.mockClear();
    invalidateListCache.mockClear();
    const error = new HttpError("bad", 400, "POST", "/journals");
    create.mockRejectedValueOnce(error);
    await expect(guard.createJournalOnce(
      { ns: "FX", id: "bad" }, { effective_date: "2026-01-01", postings: [] },
    )).rejects.toBe(error);
    expect(create).toHaveBeenCalledTimes(1);
    expect(listAll).toHaveBeenCalledTimes(1);
    expect(invalidateListCache).toHaveBeenCalledTimes(1);
  });

  it.each(["found", "absent", "throwing"])("H06-C handles missing created id with %s verification", async verification => {
    const { api, create, listAll } = setup({ createResult: {} });
    const guard = await BookingGuard.load(api);
    listAll.mockReset().mockResolvedValueOnce([]);
    if (verification === "found") {
      listAll.mockResolvedValueOnce([journal({ id: 88, document_number: "FX:no-id", registered: false })]);
    } else if (verification === "throwing") {
      listAll.mockRejectedValueOnce(new Error("verify failed"));
    } else {
      listAll.mockResolvedValueOnce([]);
    }
    const promise = guard.createJournalOnce(
      { ns: "FX", id: "no-id" }, { effective_date: "2026-01-01", postings: [] }, { confirm: false },
    );
    if (verification === "found") {
      await expect(promise).resolves.toMatchObject({ journal_id: 88, recovered: true });
    } else {
      await expect(promise).rejects.toMatchObject({ category: "mutation_indeterminate", operation: "create" });
    }
    expect(create).toHaveBeenCalledTimes(1);
    expect(guard.find({ ns: "FX", id: "no-id" }, "any")?.journal_id).not.toBe(-1);
  });

  it.each(["raw", "structured"])("H06-C verifies exact-id %s confirm ambiguity", async kind => {
    const { api, create, confirm, get, invalidateListCache } = setup({ createResult: { created_object_id: 66 } });
    const guard = await BookingGuard.load(api);
    confirm.mockRejectedValueOnce(kind === "raw" ? networkError() : structuredAmbiguity("confirm"));
    get.mockResolvedValueOnce(journal({ id: 66, document_number: "FX:confirm", registered: true }));
    const result = await guard.createJournalOnce(
      { ns: "FX", id: "confirm" }, { effective_date: "2026-01-01", postings: [] },
    );
    expect(result).toMatchObject({ journal_id: 66, registered: true, recovered: true });
    expect(result.status === "created" && result.upstream_response).toEqual({ created_object_id: 66 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(66);
    const lastInvalidation = invalidateListCache.mock.invocationCallOrder.at(-1)!;
    expect(get.mock.invocationCallOrder.at(-1)).toBe(lastInvalidation + 1);
  });

  it.each([
    ["raw", "false"],
    ["raw", "throwing"],
    ["structured", "false"],
    ["structured", "throwing"],
  ])("H06-C makes %s confirm ambiguity with %s verification indeterminate", async (kind, outcome) => {
    const { api, create, confirm, get, invalidateListCache } = setup({ createResult: { created_object_id: 67 } });
    const guard = await BookingGuard.load(api);
    confirm.mockRejectedValueOnce(kind === "raw" ? networkError() : structuredAmbiguity("confirm"));
    if (outcome === "throwing") get.mockRejectedValueOnce(new Error("get failed"));
    else get.mockResolvedValueOnce(journal({ id: 67, document_number: "FX:c", registered: false }));
    await expect(guard.createJournalOnce(
      { ns: "FX", id: "c" }, { effective_date: "2026-01-01", postings: [] },
    )).rejects.toMatchObject({
      category: "mutation_indeterminate", operation: "confirm", entityId: 67,
      businessKey: "FX:c", affectedCaches: ["/journals"],
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(67);
    const lastInvalidation = invalidateListCache.mock.invocationCallOrder.at(-1)!;
    expect(get.mock.invocationCallOrder.at(-1)).toBe(lastInvalidation + 1);
  });

  it.each(["http", "unexpected"])("H06-C propagates definite %s confirm errors with createdJournalId", async kind => {
    const error = kind === "http" ? new HttpError("bad", 400, "PATCH", "/journals/68/register") : new Error("boom");
    const { api, confirm } = setup({ createResult: { created_object_id: 68 } });
    const guard = await BookingGuard.load(api);
    confirm.mockRejectedValueOnce(error);
    await expect(guard.createJournalOnce(
      { ns: "FX", id: "def" }, { effective_date: "2026-01-01", postings: [] },
    )).rejects.toMatchObject({ createdJournalId: 68 });
  });

  it("H06-C supports legacy DIV spelling only", () => {
    const key: DocKey = { ns: "DIV", id: "2026-06-01-42" };
    expect(formatDocNumber(key)).toBe("DIV-2026-06-01-42");
    expect(parseDocNumber("DIV-2026-06-01-42")).toEqual(key);
    expect(parseDocNumber("DIV:2026-06-01-42")).toBeUndefined();
  });

  it("H06-C settles a timed-out child observer only after close", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let closeFired = false;
    child.once("close", () => { closeFired = true; });
    const observed = observeChild(child, 25);
    try {
      await expect(observed).rejects.toThrow("child timeout");
      expect(closeFired).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.allSettled([observed]);
    }
  });

  it("H06-C captures one stdout line from each concurrent child", async () => {
    const children = ["first", "second"].map(value => spawn(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(`${value}\n`)})`],
      { stdio: ["ignore", "pipe", "pipe"] },
    ));
    const observed = children.map(child => observeChild(child, 1_000));
    try {
      const outcomes = await Promise.all(observed);
      expect(outcomes.map(outcome => outcome.stdout.trim())).toEqual(["first", "second"]);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await Promise.allSettled(observed);
    }
  });

  it("H06-C creates at most one journal across two processes", { timeout: 15_000 }, async () => {
    const prior = process.env.EARVELDAJA_LOCK_DIR;
    const stateDir = await mkdtemp(resolve(tmpdir(), "h06-child-state-"));
    const lockDir = await mkdtemp(resolve(tmpdir(), "h06-child-lock-"));
    const statePath = resolve(stateDir, "journals.json");
    const fixture = fileURLToPath(new URL("./__fixtures__/booking-guard-child.ts", import.meta.url));
    await writeFile(statePath, "[]");
    process.env.EARVELDAJA_LOCK_DIR = lockDir;
    const children: ChildProcess[] = [];
    const closes: Promise<ChildObservation>[] = [];
    const runChild = () => {
      const child = spawn(process.execPath, ["--import", "tsx", fixture, statePath, "child-fingerprint"], {
        env: { ...process.env, EARVELDAJA_LOCK_DIR: lockDir }, stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      const closed = observeChild(child, 5_000);
      closes.push(closed);
      return closed;
    };
    try {
      const firstChild = runChild();
      await new Promise(resolveTurn => setImmediate(resolveTurn));
      const secondChild = runChild();
      const outcomes = await Promise.all([firstChild, secondChild]);
      for (const outcome of outcomes) expect(outcome.code, outcome.stderr).toBe(0);
      const statuses = outcomes.map((outcome, index) => {
        const lines = outcome.stdout.split(/\r?\n/).filter(line => line.trim() !== "");
        expect(lines, `child ${index + 1} must emit exactly one JSON line; stderr: ${outcome.stderr}`)
          .toHaveLength(1);
        try {
          return (JSON.parse(lines[0]!) as { status: string }).status;
        } catch (error) {
          throw new Error(
            `child ${index + 1} emitted invalid JSON ${JSON.stringify(lines[0])}; stderr: ${outcome.stderr}`,
            { cause: error },
          );
        }
      }).sort();
      expect(statuses).toEqual(["created", "duplicate"]);
      expect(JSON.parse(await readFile(statePath, "utf8"))).toHaveLength(1);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.allSettled(closes);
      if (prior === undefined) delete process.env.EARVELDAJA_LOCK_DIR;
      else process.env.EARVELDAJA_LOCK_DIR = prior;
      await rm(stateDir, { recursive: true, force: true });
      await rm(lockDir, { recursive: true, force: true });
    }
  });
});

// ---- Lane B: inter-account -------------------------------------------

describe("BookingGuard Lane B — findInterAccount", () => {
  const ownDims = new Set([10, 20]);

  function interAccountJournal(id: number, ref: string | null): Journal {
    return journal({
      id,
      document_number: ref,
      registered: true,
      postings: [bankPosting(10, "C", 500), bankPosting(20, "D", 500)],
    });
  }

  it("matches an inter-account transfer regardless of direction", async () => {
    const { api } = setup({ journals: [interAccountJournal(1, null)], ownDimensionIds: ownDims });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    expect(guard.findInterAccount({ sourceDim: 10, targetDim: 20, amount: 500, date: "2026-01-01" })).toBe(1);
    expect(guard.findInterAccount({ sourceDim: 20, targetDim: 10, amount: 500, date: "2026-01-01" })).toBe(1);
  });

  it("returns undefined when amount or date differs", async () => {
    const { api } = setup({ journals: [interAccountJournal(1, null)], ownDimensionIds: ownDims });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    expect(guard.findInterAccount({ sourceDim: 10, targetDim: 20, amount: 501, date: "2026-01-01" })).toBeUndefined();
    expect(guard.findInterAccount({ sourceDim: 10, targetDim: 20, amount: 500, date: "2026-01-02" })).toBeUndefined();
  });

  it("disambiguates same-amount/date transfers by reference", async () => {
    const { api } = setup({
      journals: [interAccountJournal(1, "REF-A"), interAccountJournal(2, "REF-B")],
      ownDimensionIds: ownDims,
    });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    expect(guard.findInterAccount({ sourceDim: 10, targetDim: 20, amount: 500, date: "2026-01-01", reference: "REF-B" })).toBe(2);
    // A ref not present, with labelled candidates ⇒ treat as a distinct transfer.
    expect(guard.findInterAccount({ sourceDim: 10, targetDim: 20, amount: 500, date: "2026-01-01", reference: "REF-C" })).toBeUndefined();
  });

  it("finds within a maxGapDays window, nearest-first", async () => {
    const { api } = setup({ journals: [interAccountJournal(1, null)], ownDimensionIds: ownDims });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    // Journal is on 2026-01-01; query on 2026-01-03 with a 2-day window matches.
    expect(guard.findInterAccount({ sourceDim: 10, targetDim: 20, amount: 500, date: "2026-01-03", maxGapDays: 2 })).toBe(1);
    // Outside the window: no match.
    expect(guard.findInterAccount({ sourceDim: 10, targetDim: 20, amount: 500, date: "2026-01-04", maxGapDays: 2 })).toBeUndefined();
  });

  it("recordInterAccount makes a subsequent lookup succeed in-run", async () => {
    const { api } = setup({ ownDimensionIds: ownDims });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    expect(guard.findInterAccount({ sourceDim: 10, targetDim: 20, amount: 750, date: "2026-03-01" })).toBeUndefined();
    guard.recordInterAccount({ sourceDim: 10, targetDim: 20, amount: 750, date: "2026-03-01", reference: "T1" }, 88);
    expect(guard.findInterAccount({ sourceDim: 20, targetDim: 10, amount: 750, date: "2026-03-01" })).toBe(88);
  });
});

describe("BookingGuard Lane B — resolveInterAccount (cardinality-aware)", () => {
  const ownDims = new Set([10, 20]);

  // A confirmed inter-account journal between dims 10 and 20. `ref` becomes the
  // journal's document_number (native e-arveldaja confirmations carry null).
  function interAccountJournal(
    id: number,
    ref: string | null,
    opts: { amount?: number; date?: string } = {},
  ): Journal {
    const amount = opts.amount ?? 500;
    return journal({
      id,
      document_number: ref,
      effective_date: opts.date ?? "2026-01-01",
      registered: true,
      postings: [bankPosting(10, "C", amount), bankPosting(20, "D", amount)],
    });
  }

  const q = (over: Partial<Parameters<BookingGuard["resolveInterAccount"]>[0]> = {}) => ({
    sourceDim: 10,
    targetDim: 20,
    amount: 500,
    date: "2026-01-01",
    ...over,
  });

  // 1. Exact-ref snapshot match → matched(reference), and NOT consumed: a
  //    same-ref re-import must keep being suppressed indefinitely.
  it("exact-ref match returns matched(reference) and never consumes", async () => {
    const { api } = setup({ journals: [interAccountJournal(1, "REF-A")], ownDimensionIds: ownDims });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    const first = guard.resolveInterAccount(q({ reference: "REF-A" }));
    expect(first).toEqual({ status: "matched", journal_id: 1, matched_on: "reference", pool: "snapshot" });
    // Re-query with the same ref still matches — the reference entry stays live.
    const second = guard.resolveInterAccount(q({ reference: "REF-A" }));
    expect(second).toEqual({ status: "matched", journal_id: 1, matched_on: "reference", pool: "snapshot" });
  });

  // 2. Ref-less snapshot match → matched(refless), consumed, AND a ref-less
  //    in-run marker is dropped. A SECOND same-key ref-less row (the mirror leg
  //    of this transfer, OR a genuine second transfer — structurally identical)
  //    hits that marker → ambiguous_refless (review), never a silent duplicate.
  //    One journal spans two legs, so one prior-run journal suppresses exactly
  //    one leg and turns any further same-key row into a review item.
  it("ref-less snapshot match consumes and drops a marker; the second same-key row goes to review", async () => {
    const { api } = setup({ journals: [interAccountJournal(1, null)], ownDimensionIds: ownDims });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    const first = guard.resolveInterAccount(q());
    expect(first).toEqual({ status: "matched", journal_id: 1, matched_on: "refless", pool: "snapshot" });
    // The snapshot is consumed and a tripwire marker remains — the mirror leg is
    // surfaced for review rather than silently booked into a duplicate journal.
    expect(guard.resolveInterAccount(q())).toEqual({ status: "ambiguous_refless" });
  });

  // 3. Cardinality: two ref-less snapshot journals absorb exactly two rows (each
  //    consumed via a DISTINCT journal — invariant "K=J re-import ⇒ no false
  //    ambiguity"); the third same-key row exceeds the cover → review.
  it("two ref-less snapshot journals absorb two rows via distinct journals, then review", async () => {
    const { api } = setup({
      journals: [interAccountJournal(1, null), interAccountJournal(2, null)],
      ownDimensionIds: ownDims,
    });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    const a = guard.resolveInterAccount(q());
    const b = guard.resolveInterAccount(q());
    const c = guard.resolveInterAccount(q());
    expect(a.status).toBe("matched");
    expect(b.status).toBe("matched");
    // Distinct journals were consumed, not the same one twice, and neither of
    // the two covered rows was spuriously flagged.
    expect((a as { journal_id: number }).journal_id).not.toBe((b as { journal_id: number }).journal_id);
    // The third row exceeds the two-journal cover → review, not a silent book.
    expect(c).toEqual({ status: "ambiguous_refless" });
  });

  // 4. Differing-ref against a labelled candidate → none (book). A mismatched
  //    label is stronger evidence of a distinct transfer than the shared key.
  it("returns none when a labelled candidate carries a different reference", async () => {
    const { api } = setup({ journals: [interAccountJournal(1, "REF-A")], ownDimensionIds: ownDims });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    expect(guard.resolveInterAccount(q({ reference: "REF-B" }))).toEqual({ status: "none" });
  });

  // 5. Ref-less match landing only on an in_run journal → ambiguous_refless. We
  //    cannot tell a genuine second transfer from a duplicate re-import of the
  //    first, so the caller must surface it for review.
  it("ref-less match on an in_run-only journal is ambiguous_refless", async () => {
    const { api } = setup({ ownDimensionIds: ownDims });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    guard.recordInterAccount(q(), 77); // in_run, ref-less
    expect(guard.resolveInterAccount(q())).toEqual({ status: "ambiguous_refless" });
  });

  // 6. Snapshot preferred over in_run: a ref-less query consumes the snapshot
  //    first; only once it is exhausted does the in_run leftover turn ambiguous.
  it("consumes the snapshot before the in_run entry turns a re-query ambiguous", async () => {
    const { api } = setup({ journals: [interAccountJournal(1, null)], ownDimensionIds: ownDims });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    guard.recordInterAccount(q(), 77); // an in_run entry now co-exists with the snapshot
    // First query consumes the snapshot journal (id 1), not the in_run one.
    expect(guard.resolveInterAccount(q())).toEqual({
      status: "matched", journal_id: 1, matched_on: "refless", pool: "snapshot",
    });
    // Snapshot exhausted; only the in_run entry remains → ambiguous.
    expect(guard.resolveInterAccount(q())).toEqual({ status: "ambiguous_refless" });
  });

  // 7. consume:false is a non-destructive probe (dry-run / candidate scoring):
  //    the snapshot stays live AND no marker is dropped, so a later real
  //    resolution still matches it and only THEN arms the tripwire.
  it("consume:false leaves the snapshot entry live and drops no marker", async () => {
    const { api } = setup({ journals: [interAccountJournal(1, null)], ownDimensionIds: ownDims });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    expect(guard.resolveInterAccount(q(), { consume: false }).status).toBe("matched");
    // Not consumed and no marker armed — a subsequent consuming resolution still
    // matches the same journal (a probe must not have mutated any state).
    expect(guard.resolveInterAccount(q())).toEqual({
      status: "matched", journal_id: 1, matched_on: "refless", pool: "snapshot",
    });
    // That consuming resolution armed the marker — a further row goes to review.
    expect(guard.resolveInterAccount(q())).toEqual({ status: "ambiguous_refless" });
  });

  // 8. The mirror leg at the UNIT level: consuming a leg via (10→20) both clears
  //    the shared entry in the reverse direction AND drops a bidirectional
  //    marker, so the mirror leg queried as (20→10) resolves to review — never a
  //    silent duplicate. (Marker anchoring is exercised in the maxGap test.)
  it("consuming a leg surfaces the reverse-direction mirror leg for review", async () => {
    const { api } = setup({ journals: [interAccountJournal(1, null)], ownDimensionIds: ownDims });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    expect(guard.resolveInterAccount(q({ sourceDim: 10, targetDim: 20 })).status).toBe("matched");
    // The reverse-direction mirror leg: shared entry consumed + marker present → review.
    expect(guard.resolveInterAccount(q({ sourceDim: 20, targetDim: 10 }))).toEqual({ status: "ambiguous_refless" });
  });

  // 9. Reference match is never consumed even at default consume=true: a labelled
  //    journal is an identity, so repeated same-ref imports all suppress.
  it("a reference match survives repeated resolutions (never consumed)", async () => {
    const { api } = setup({ journals: [interAccountJournal(1, "REF-A")], ownDimensionIds: ownDims });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    for (let i = 0; i < 3; i++) {
      expect(guard.resolveInterAccount(q({ reference: "REF-A" }))).toEqual({
        status: "matched", journal_id: 1, matched_on: "reference", pool: "snapshot",
      });
    }
  });

  // 10. maxGapDays MARKER ANCHORING (architect invariant #2): the marker must be
  //     dropped at the date where the journal was FOUND (01-01), not the query
  //     date (01-03). Leg 1 queries 01-03 and matches the 01-01 journal within a
  //     2-day window; leg 2 queried at 01-03 must still find the marker at 01-01
  //     inside its own window → review, never a silent book.
  it("anchors the marker to the matched date so a windowed mirror leg is caught", async () => {
    const { api } = setup({
      journals: [interAccountJournal(1, null, { date: "2026-01-01" })],
      ownDimensionIds: ownDims,
    });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    // Journal on 01-01; query on 01-03 with a 2-day window matches nearest-first.
    expect(guard.resolveInterAccount(q({ date: "2026-01-03", maxGapDays: 2 }))).toEqual({
      status: "matched", journal_id: 1, matched_on: "refless", pool: "snapshot",
    });
    // The marker was anchored to 01-01; the second windowed query finds it → review.
    expect(guard.resolveInterAccount(q({ date: "2026-01-03", maxGapDays: 2 }))).toEqual({ status: "ambiguous_refless" });
  });

  // 11. reflessSkipsLabelled (Fix A): a labelled snapshot journal (e.g. an FX:
  //     conversion) is IDENTITY-ONLY — a ref-less query does NOT match it, so it
  //     never masks a genuine ref-less journal/marker behind it. Its own exact
  //     reference still matches.
  it("a ref-less query does not match a labelled-only snapshot; its exact ref does", async () => {
    const { api } = setup({ journals: [interAccountJournal(1, "FX:USD-EUR")], ownDimensionIds: ownDims });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    // A ref-less transfer sharing the key with only a labelled journal is a
    // distinct transfer → book, not suppressed against the FX identity.
    expect(guard.resolveInterAccount(q())).toEqual({ status: "none" });
    // The labelled journal is still suppressed by its own exact reference.
    expect(guard.resolveInterAccount(q({ reference: "FX:USD-EUR" }))).toEqual({
      status: "matched", journal_id: 1, matched_on: "reference", pool: "snapshot",
    });
  });

  // 12. Fix #2: two legs of one transfer legitimately carry DIFFERENT bank refs.
  //     After leg A books (in_run ref A), a differing-ref same-key leg B must
  //     resolve to ambiguous_refless — indistinguishable from a real second
  //     transfer — rather than booking a duplicate.
  it("differing-ref collision against an in_run journal is ambiguous, not a book", async () => {
    const { api } = setup({ ownDimensionIds: ownDims });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    guard.recordInterAccount(q({ reference: "LEG-A" }), 55); // in_run, ref A
    expect(guard.resolveInterAccount(q({ reference: "LEG-B" }))).toEqual({ status: "ambiguous_refless" });
  });

  // 13. Fix #2 boundary: a differing-ref SNAPSHOT journal is a distinct
  //     prior-run identity and must NOT block — a genuinely different transfer
  //     books rather than being forced to review.
  it("differing-ref collision against a snapshot journal still books", async () => {
    const { api } = setup({ journals: [interAccountJournal(1, "REF-A")], ownDimensionIds: ownDims });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    expect(guard.resolveInterAccount(q({ reference: "REF-B" }))).toEqual({ status: "none" });
  });

  // 14. Labelled masking (architect invariant #4): under a key holding a labelled
  //     journal ORDERED BEFORE a ref-less journal, a ref-less query must consume
  //     the REF-LESS one (id 2), never loose-match the labelled catch-all (id 1)
  //     which would mask it. A genuine second same-key row then hits the marker
  //     → review; the labelled journal stays matchable by its exact ref.
  it("a ref-less query consumes the ref-less journal, not a labelled one ordered before it", async () => {
    const { api } = setup({
      journals: [interAccountJournal(1, "FX:X"), interAccountJournal(2, null)],
      ownDimensionIds: ownDims,
    });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    // Ref-less query skips the labelled journal (id 1) and consumes the ref-less one (id 2).
    expect(guard.resolveInterAccount(q())).toEqual({
      status: "matched", journal_id: 2, matched_on: "refless", pool: "snapshot",
    });
    // The next same-key ref-less row is no longer masked by id 1 → review.
    expect(guard.resolveInterAccount(q())).toEqual({ status: "ambiguous_refless" });
    // The labelled journal remains suppressed by its own exact reference.
    expect(guard.resolveInterAccount(q({ reference: "FX:X" }))).toEqual({
      status: "matched", journal_id: 1, matched_on: "reference", pool: "snapshot",
    });
  });

  // 15. Marker hygiene (architect invariant #6): the tripwire marker is never
  //     itself consumed and never surfaces a real journal id — every same-key
  //     ref-less row after the first stays ambiguous_refless, indefinitely.
  it("the tripwire marker persists — every subsequent same-key row stays review", async () => {
    const { api } = setup({ journals: [interAccountJournal(1, null)], ownDimensionIds: ownDims });
    const guard = await BookingGuard.load(api, { ownDimensionIds: ownDims });
    expect(guard.resolveInterAccount(q()).status).toBe("matched");
    for (let i = 0; i < 3; i++) {
      expect(guard.resolveInterAccount(q())).toEqual({ status: "ambiguous_refless" });
    }
  });
});
