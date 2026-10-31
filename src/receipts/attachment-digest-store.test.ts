import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initAccountingRulesConnection } from "../accounting-rules.js";
import { createConnectionScopedBundleStore } from "../connection-scoped-bundle-store.js";
import { receiptAttachmentDigestStore, recordReceiptAttachmentDigest, sha256OfBase64 } from "./attachment-digest-store.js";
import { uploadSourceDocumentOrInvalidate } from "../tools/pdf-workflow.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "digest-store-"));
  process.env.EARVELDAJA_RULES_DIR = dir;
  receiptAttachmentDigestStore.reset();
});
afterEach(() => {
  delete process.env.EARVELDAJA_RULES_DIR;
  delete process.env.EARVELDAJA_RULES_FILE;
  initAccountingRulesConnection(() => ({ name: "default", stableIdentity: "default" }));
  rmSync(dir, { recursive: true, force: true });
});

const record = (entityId: number, sha = "a".repeat(64)) => ({
  sha256: sha, entity_id: entityId, base_document_files_id: 9000 + entityId, number: `INV-${entityId}`, clients_id: 7, gross_price: 10,
});

describe("connection-scoped bundle store", () => {
  type Row = { key: string; value: number };
  const makeStore = (maxEntries = 3) => createConnectionScopedBundleStore<Row>({ fileName: "rows.json", label: "rows", maxEntries, keyOf: row => row.key });

  it("upserts by key, drops the oldest beyond maxEntries, removes by key", () => {
    const store = makeStore();
    expect(store.read()).toEqual([]);
    store.upsert([{ key: "a", value: 1 }, { key: "b", value: 2 }]);
    store.upsert([{ key: "a", value: 3 }]);
    expect(store.read()).toEqual([{ key: "b", value: 2 }, { key: "a", value: 3 }]);
    store.upsert([{ key: "c", value: 4 }, { key: "d", value: 5 }]);
    expect(store.read()!.map(row => row.key)).toEqual(["a", "c", "d"]);
    store.remove(["c"]);
    expect(store.read()!.map(row => row.key)).toEqual(["a", "d"]);
  });

  it("keeps each connection's records apart in a shared bundle", () => {
    const store = makeStore(10);
    initAccountingRulesConnection(() => ({ name: "one", stableIdentity: "one", connectionCount: 2 }));
    store.upsert([{ key: "a", value: 1 }]);
    initAccountingRulesConnection(() => ({ name: "two", stableIdentity: "two", connectionCount: 2 }));
    expect(store.read()).toEqual([]);
    store.upsert([{ key: "a", value: 2 }]);
    store.remove(["a"]);
    initAccountingRulesConnection(() => ({ name: "one", stableIdentity: "one", connectionCount: 2 }));
    expect(store.read()).toEqual([{ key: "a", value: 1 }]);
  });

  it("is off in single-file rules mode: read() is null and writes refuse", () => {
    delete process.env.EARVELDAJA_RULES_DIR;
    process.env.EARVELDAJA_RULES_FILE = join(dir, "accounting-rules.md");
    const store = makeStore();
    expect(store.read()).toBeNull();
    expect(() => store.upsert([{ key: "a", value: 1 }])).toThrow("single-file");
  });
});

describe("receipt attachment digest store", () => {
  it("records an upload and never throws (single-file mode returns a note)", () => {
    expect(recordReceiptAttachmentDigest(record(1))).toBeUndefined();
    expect(receiptAttachmentDigestStore.read()).toEqual([expect.objectContaining({ ...record(1), entity: "purchase_invoice" })]);
    delete process.env.EARVELDAJA_RULES_DIR;
    process.env.EARVELDAJA_RULES_FILE = join(dir, "accounting-rules.md");
    expect(recordReceiptAttachmentDigest(record(2))).toContain("single-file");
  });

  it("uploadSourceDocumentOrInvalidate records the uploaded bytes' digest after a successful upload only", async () => {
    const contents = Buffer.from("invoice pdf bytes").toString("base64");
    const uploadDocument = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("boom"));
    const api = { purchaseInvoices: { uploadDocument, invalidate: vi.fn().mockResolvedValue({}) } } as never;
    expect(await uploadSourceDocumentOrInvalidate(api, 41, "a.pdf", contents)).toBeUndefined();
    expect(await uploadSourceDocumentOrInvalidate(api, 42, "b.pdf", contents)).toContain("upload failed");
    expect(receiptAttachmentDigestStore.read()).toEqual([expect.objectContaining({ sha256: sha256OfBase64(contents), entity_id: 41 })]);
  });
});
