import { beforeEach, describe, expect, it, vi } from "vitest";
import { PurchaseInvoicesApi } from "./purchase-invoices.api.js";
import { SaleInvoicesApi } from "./sale-invoices.api.js";
import { JournalsApi } from "./journals.api.js";
import { TransactionsApi } from "./transactions.api.js";
import { cache } from "./base-resource.js";
import type { HttpClient } from "../http-client.js";

vi.mock("../logger.js", () => ({ log: vi.fn() }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));

function makeClient(): HttpClient {
  return {
    cacheNamespace: "connection:0",
    get: vi.fn().mockResolvedValue({ name: "doc.pdf", contents: "YmFzZTY0" }),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn().mockResolvedValue({ code: 200, messages: [] }),
    request: vi.fn().mockResolvedValue({ code: 200, messages: [] }),
  } as unknown as HttpClient;
}

// Each document-capable resource must reach /{basePath}/{id}/document_user via
// the methods inherited from BaseResource. This pins the path per class and
// specifically guards the removal of the old PurchaseInvoicesApi overrides.
const CLASSES = [
  ["PurchaseInvoicesApi", (c: HttpClient) => new PurchaseInvoicesApi(c), "/purchase_invoices"],
  ["SaleInvoicesApi", (c: HttpClient) => new SaleInvoicesApi(c), "/sale_invoices"],
  ["JournalsApi", (c: HttpClient) => new JournalsApi(c), "/journals"],
  ["TransactionsApi", (c: HttpClient) => new TransactionsApi(c), "/transactions"],
] as const;

describe("document_user methods inherited on each document-capable API class", () => {
  beforeEach(() => cache.invalidate());

  for (const [name, make, base] of CLASSES) {
    it(`${name} routes upload/get/delete to ${base}/{id}/document_user`, async () => {
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = make(client) as any;

      await api.uploadDocument(7, "scan.pdf", "Zm9v");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((client as any).request).toHaveBeenCalledWith(`${base}/7/document_user`, {
        method: "PUT",
        body: { name: "scan.pdf", contents: "Zm9v" },
      });

      await api.getDocument(7);
      expect(client.get).toHaveBeenCalledWith(`${base}/7/document_user`);

      await api.deleteDocument(7);
      expect(client.delete).toHaveBeenCalledWith(`${base}/7/document_user`);
    });
  }
});
