import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportProgress, toolExtraStorage, type ToolExtra } from "./progress.js";

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

  it("throttles bursts of progress notifications within an invocation", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const extra: ToolExtra = { sendNotification, _meta: { progressToken: "tok" } };

    await toolExtraStorage.run(extra, async () => {
      for (let i = 1; i < 50; i++) await reportProgress(i, 100);
    });

    // First call goes through; the rest land within the throttle window
    // (100ms) and are dropped. The final i=49 is below total=100 so it is
    // still subject to throttling, not the trailing-100% skip.
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: { progressToken: "tok", progress: 1, total: 100 },
    });
  });

  it("re-enables emission after the throttle window elapses", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const extra: ToolExtra = { sendNotification, _meta: { progressToken: "tok" } };

    let nowMs = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      await toolExtraStorage.run(extra, async () => {
        await reportProgress(1, 100);
        nowMs += 200; // past the 100ms throttle
        await reportProgress(2, 100);
      });
      expect(sendNotification).toHaveBeenCalledTimes(2);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("skips the trailing progress=total notification (response signals completion)", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);

    await toolExtraStorage.run({
      sendNotification,
      _meta: { progressToken: 0 },
    }, async () => {
      await reportProgress(2, 2);
    });

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("skips emission when EARVELDAJA_DISABLE_PROGRESS=1", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const original = process.env.EARVELDAJA_DISABLE_PROGRESS;
    process.env.EARVELDAJA_DISABLE_PROGRESS = "1";
    try {
      await toolExtraStorage.run({
        sendNotification,
        _meta: { progressToken: 0 },
      }, async () => {
        await reportProgress(1, 2);
      });
      expect(sendNotification).not.toHaveBeenCalled();
    } finally {
      process.env.EARVELDAJA_DISABLE_PROGRESS = original;
    }
  });

  it("isolates throttle state per invocation (different extras)", async () => {
    const sendA = vi.fn().mockResolvedValue(undefined);
    const sendB = vi.fn().mockResolvedValue(undefined);

    await toolExtraStorage.run({ sendNotification: sendA, _meta: { progressToken: "a" } }, async () => {
      await reportProgress(1, 100);
      await reportProgress(2, 100); // throttled
    });

    await toolExtraStorage.run({ sendNotification: sendB, _meta: { progressToken: "b" } }, async () => {
      // Fresh invocation — first emit goes through even if it is within
      // 100ms of the previous invocation's emit.
      await reportProgress(1, 100);
    });

    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).toHaveBeenCalledTimes(1);
  });
});
