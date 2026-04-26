import { AsyncLocalStorage } from "node:async_hooks";

export interface ToolExtra {
  sendNotification: (notification: unknown) => Promise<void>;
  _meta?: { progressToken?: string | number };
}

export const toolExtraStorage = new AsyncLocalStorage<ToolExtra>();

/**
 * Minimum interval between emitted progress notifications within a single
 * tool invocation. Tight per-item loops (50 CAMT entries, 69 reconcile rows,
 * etc.) would otherwise flood the stdio transport. Any notification that
 * arrives at the client *after* the tool's response is matched gets dropped
 * with "Received a progress notification for an unknown token" — and on
 * Claude Code that drop is fatal: the transport is closed and the server
 * must be reconnected. Throttling cuts the volume and shrinks the race
 * window; the trailing 100% emit is also skipped because the response itself
 * already signals completion.
 *
 * Set EARVELDAJA_DISABLE_PROGRESS=1 to disable progress entirely on clients
 * that still mishandle late-arriving events.
 */
const PROGRESS_THROTTLE_MS = 100;

const lastEmitByExtra = new WeakMap<ToolExtra, number>();

function progressDisabled(): boolean {
  const v = process.env.EARVELDAJA_DISABLE_PROGRESS;
  return v === "1" || v === "true";
}

/**
 * Report progress for long-running operations.
 * No-op if the client didn't supply a progress token.
 */
export async function reportProgress(progress: number, total?: number): Promise<void> {
  if (progressDisabled()) return;
  const extra = toolExtraStorage.getStore();
  if (!extra) return;
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined) return;

  // Skip the trailing 100% notification: the response signals completion,
  // and the final emit is the most likely to lose the race against it.
  if (total !== undefined && progress >= total) return;

  // Throttle within an invocation: at most one notification per window.
  const now = Date.now();
  const last = lastEmitByExtra.get(extra) ?? 0;
  if (now - last < PROGRESS_THROTTLE_MS) return;
  lastEmitByExtra.set(extra, now);

  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        ...(total !== undefined && { total }),
      },
    });
  } catch {
    // Client may not support progress — ignore
  }
}
