import { describe, expect, it } from "vitest";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { captureSaleCreateScope, saleCreateIntent, saleCreateRecoveryFor, SaleCreateRecoveryGuard } from "./create-recovery.js";

const intent = saleCreateIntent({ action: "create", client: { name: "Buyer", reg_code: "123" }, create_date: "2026-10-18", gross_price: 124, cl_currencies_id: "EUR", items: [] });

describe("sale create recovery", () => {
  it("retains both inline and resolved client aliases across generation changes", async () => {
    const runtime = createTestRuntimeSafetyContext();
    const guard = saleCreateRecoveryFor(runtime);
    const scope = captureSaleCreateScope(runtime);
    let marker = "";
    await guard.withLock(scope, async s => {
      const r = s.reserve(intent);
      s.bindResolvedClient(r, 77);
      marker = s.markIndeterminate(r, { intent, clientsId: 77, createdClientId: 77 }).publicContext.marker;
    });
    runtime.setScope({ connectionGeneration: 100 });
    const explicit = { ...intent, clientsId: 77, inlineIdentity: undefined };
    await guard.withLock(captureSaleCreateScope(runtime), async s => {
      expect(s.findPending(intent)?.publicContext.marker).toBe(marker);
      expect(s.findPending(explicit)?.clientsId).toBe(77);
      expect(s.release("wrong", intent)).toBe(false);
      expect(s.release(marker, { ...intent, invoicePayload: { ...intent.invoicePayload, items: [{ amount: 99 }] } })).toBe(false);
      expect(s.release(marker, explicit)).toBe(true);
      expect(s.findPending(intent)).toBeUndefined();
      expect(s.findReleased(explicit)?.clientsId).toBe(77);
      expect(s.findReleased(intent)?.publicContext.marker).toBe(marker);
      expect(s.release(marker, intent)).toBe(false);
      expect(s.requiresFreshScan(intent)).toBe(true);
      expect(s.requiresFreshScan(explicit)).toBe(true);
    });
  });

  it("captures stable company before queue waiting and never migrates a pending hold", async () => {
    const runtime = createTestRuntimeSafetyContext();
    const guard = saleCreateRecoveryFor(runtime);
    const original = captureSaleCreateScope(runtime);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const first = guard.withLock(original, async s => {
      await pending;
      const r = s.reserve(intent);
      s.markIndeterminate(r, { intent, clientsId: 77 });
    });
    const queuedScope = captureSaleCreateScope(runtime);
    const queued = guard.withLock(queuedScope, async s => expect(s.findPending(intent)?.clientsId).toBe(77));
    runtime.setScope({ connectionFingerprint: "other-company", baseUrl: "https://other.example/api", connectionGeneration: 999 });
    await guard.withLock(captureSaleCreateScope(runtime), async s => expect(s.findPending(intent)).toBeUndefined());
    release();
    await Promise.all([first, queued]);
    await guard.withLock(original, async s => expect(s.findPending(intent)?.clientsId).toBe(77));
  });

  it("refuses capacity without evicting a hold and rejects unsafe successful IDs", async () => {
    const guard = new SaleCreateRecoveryGuard(1);
    const scope = captureSaleCreateScope(createTestRuntimeSafetyContext());
    await guard.withLock(scope, async s => {
      const r = s.reserve(intent);
      expect(() => s.complete(r, 0)).toThrow("positive safe-integer");
      s.markIndeterminate(r, { intent, clientsId: 77 });
      expect(() => s.reserve({ ...intent, invoicePayload: { ...intent.invoicePayload, gross_price: 999 } })).toThrow("capacity");
      expect(s.findPending(intent)).toBeDefined();
    });
  });
});
