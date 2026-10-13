import { beforeEach, describe, expect, it, vi } from "vitest";
import { logAudit } from "../../audit-log.js";
import { lifecycleHandler } from "./lifecycle-handler.js";

vi.mock("../../audit-log.js", () => ({ logAudit: vi.fn() }));

describe("lifecycleHandler", () => {
  beforeEach(() => vi.mocked(logAudit).mockClear());

  it("calls the API, then audits and returns the standard envelope", async () => {
    const run = vi.fn().mockResolvedValue({ code: 200, messages: [] });
    const result = await lifecycleHandler("invalidate_sale_invoice", "Invalidated", "sale_invoice", run)({ id: 42 });

    expect(run).toHaveBeenCalledWith(42);
    expect(JSON.stringify(vi.mocked(logAudit).mock.calls)).toBe(JSON.stringify([[{
      tool: "invalidate_sale_invoice", action: "INVALIDATED", entity_type: "sale_invoice", entity_id: 42,
      summary: "Invalidated sale invoice 42",
      details: {},
    }]]));
    expect(result).toEqual({
      content: [{
        type: "text",
        text: "ok: true\naction: invalidated\nentity: sale_invoice\nid: 42\nmessage: Invalidated sale invoice 42.\nraw:\n  code: 200\n  messages: []",
      }],
    });
  });

  it("does not audit when the API call fails", async () => {
    const run = vi.fn().mockRejectedValue(new Error("upstream refused"));
    await expect(lifecycleHandler("delete_client", "Deleted", "client", run)({ id: 7 }))
      .rejects.toThrow("upstream refused");
    expect(logAudit).not.toHaveBeenCalled();
  });
});
