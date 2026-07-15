import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { BookingGuard } from "../booking-guard.js";
import type { Journal } from "../types/api.js";
import type { ApiContext } from "../tools/crud-tools.js";

const [statePath, fingerprint] = process.argv.slice(2);
if (!statePath || !fingerprint) throw new Error("Expected <statePath> <fingerprint>");

const readState = async (): Promise<Journal[]> => JSON.parse(await readFile(statePath, "utf8")) as Journal[];
const api = {
  journals: {
    connectionFingerprint: fingerprint,
    invalidateListCache() {},
    listAll: readState,
    listAllWithPostings: readState,
    async create(data: Partial<Journal>) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 75));
      const current = await readState();
      const id = current.reduce((max, item) => Math.max(max, item.id ?? 0), 0) + 1;
      const next = [...current, { ...data, id, registered: false, is_deleted: false } as Journal];
      const temp = resolve(dirname(statePath), `.state-${process.pid}-${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify(next), { flag: "wx", mode: 0o600 });
      await rename(temp, statePath);
      return { code: 200, messages: [], created_object_id: id };
    },
    async confirm() { return { code: 200, messages: [] }; },
    async get(id: number) { return (await readState()).find(item => item.id === id); },
  },
} as unknown as ApiContext;

try {
  const guard = await BookingGuard.load(api);
  const result = await guard.createJournalOnce(
    { ns: "FX", id: "child-proof" },
    { effective_date: "2026-01-01", postings: [] },
    { confirm: false },
  );
  await new Promise<void>((resolveWrite, rejectWrite) => {
    const rejectOnStreamError = (error: Error) => rejectWrite(error);
    process.stdout.once("error", rejectOnStreamError);
    process.stdout.write(`${JSON.stringify(result)}\n`, error => {
      process.stdout.off("error", rejectOnStreamError);
      if (error) {
        rejectWrite(error);
        return;
      }
      resolveWrite();
    });
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
