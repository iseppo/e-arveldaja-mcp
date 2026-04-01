import { describe, expect, it, vi } from "vitest";
import { reportProgress, toolExtraStorage } from "./progress.js";

describe("reportProgress", () => {
  it("sends progress notifications when the client supplies progressToken=0", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);

    await toolExtraStorage.run({
      sendNotification,
      _meta: { progressToken: 0 },
    }, async () => {
      await reportProgress(1, 2);
    });

    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: {
        progressToken: 0,
        progress: 1,
        total: 2,
      },
    });
  });

  it("does nothing when the client did not supply a progress token", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);

    await toolExtraStorage.run({
      sendNotification,
      _meta: {},
    }, async () => {
      await reportProgress(1, 2);
    });

    expect(sendNotification).not.toHaveBeenCalled();
  });
});
