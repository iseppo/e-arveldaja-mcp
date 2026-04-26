import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportProgress, runWithExtra, toolExtraStorage, type ToolExtra } from "./progress.js";

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

  it("runWithExtra suppresses progress emitted within the leading throttle window", async () => {
    // Reproduces the production race: paginated tools that complete in
    // <100 ms (e.g. cached `list_transactions` with 6 pages) used to emit
    // `progress: 0` on the first page fetch. That notification arrived at
    // the client *after* the response, the SDK had already cleared the
    // progressToken, and Claude Code closed the transport. Pre-seeding the
    // throttle baseline at invocation start keeps the emit silent.
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const extra: ToolExtra = { sendNotification, _meta: { progressToken: "tok" } };

    let nowMs = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      await runWithExtra(extra, async () => {
        nowMs += 1; // 1 ms into invocation — fast page fetch
        await reportProgress(0, 6);
        nowMs += 50; // 51 ms in — still inside the leading window
        await reportProgress(1, 6);
        nowMs += 40; // 91 ms in — still inside
        await reportProgress(2, 6);
      });
      expect(sendNotification).not.toHaveBeenCalled();
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("runWithExtra emits once the leading throttle window has elapsed", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const extra: ToolExtra = { sendNotification, _meta: { progressToken: "tok" } };

    let nowMs = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      await runWithExtra(extra, async () => {
        nowMs += 150; // past the 100 ms leading window
        await reportProgress(1, 6);
      });
      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(sendNotification).toHaveBeenCalledWith({
        method: "notifications/progress",
        params: { progressToken: "tok", progress: 1, total: 6 },
      });
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("runWithExtra emits at the exact +100 ms boundary (strict-less-than throttle)", async () => {
    // Pin the boundary: `now - last < PROGRESS_THROTTLE_MS` is strict, so an
    // emit at exactly +100 ms is allowed. Defends against an accidental flip
    // to `<=`, which would re-open the leading-window race for tools that
    // first attempt to emit at the threshold.
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const extra: ToolExtra = { sendNotification, _meta: { progressToken: "tok" } };

    let nowMs = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      await runWithExtra(extra, async () => {
        nowMs += 100;
        await reportProgress(1, 6);
      });
      expect(sendNotification).toHaveBeenCalledTimes(1);
    } finally {
      dateSpy.mockRestore();
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
