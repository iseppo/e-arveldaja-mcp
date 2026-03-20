import { describe, expect, it, vi } from "vitest";
import { registerPrompts } from "./prompts.js";

describe("registerPrompts", () => {
  it("registers the current prompt set without a VAT filing workflow", () => {
    const server = { registerPrompt: vi.fn() } as any;
    registerPrompts(server);

    const names = server.registerPrompt.mock.calls.map(([name]) => name);
    expect(names).toEqual([
      "book-invoice",
      "reconcile-bank",
      "month-end-close",
      "new-supplier",
      "company-overview",
      "lightyear-booking",
    ]);
  });
});
