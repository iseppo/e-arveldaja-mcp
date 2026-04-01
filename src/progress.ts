import { AsyncLocalStorage } from "node:async_hooks";

export interface ToolExtra {
  sendNotification: (notification: unknown) => Promise<void>;
  _meta?: { progressToken?: string | number };
}

export const toolExtraStorage = new AsyncLocalStorage<ToolExtra>();

/**
 * Report progress for long-running operations.
 * No-op if the client didn't supply a progress token.
 */
export async function reportProgress(progress: number, total?: number): Promise<void> {
  const extra = toolExtraStorage.getStore();
  if (!extra) return;
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined) return;
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
