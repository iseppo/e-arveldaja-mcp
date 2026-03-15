import type { Config } from "./config.js";
import { createAuthHeaders } from "./auth.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
}

export class HttpClient {
  private lastRequest = Promise.resolve();
  private nextAllowedAt = 0;
  private readonly minIntervalMs = 100; // Max ~10 req/sec

  constructor(
    private config: Config,
    public readonly cacheNamespace = "connection:0",
  ) {}

  private async waitForRateLimitTurn(): Promise<void> {
    const waitTurn = this.lastRequest
      .catch(() => undefined)
      .then(async () => {
        const delayMs = Math.max(0, this.nextAllowedAt - Date.now());
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        this.nextAllowedAt = Date.now() + this.minIntervalMs;
      });

    this.lastRequest = waitTurn;
    await waitTurn;
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    await this.waitForRateLimitTurn();

    const { method = "GET", body, params } = options;

    // Build full URL: baseUrl already includes /v1
    const fullUrl = `${this.config.baseUrl}${path}`;
    const url = new URL(fullUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    // Sign with path only (no query params)
    const signingPath = url.pathname;
    const authHeaders = createAuthHeaders(this.config, signingPath);

    const headers: Record<string, string> = {
      ...authHeaders,
      Accept: "application/json",
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        // Parse structured error if available, but don't expose raw upstream details
        let errorMessage = `API request failed: ${method} ${path} → ${response.status}`;
        try {
          const body = await response.json() as { code?: number; messages?: string[] };
          if (body.messages && Array.isArray(body.messages)) {
            errorMessage += `: ${body.messages.join("; ")}`;
          }
        } catch {
          // Non-JSON error body — don't expose raw text
        }
        throw new Error(errorMessage);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return response.json() as Promise<T>;
      }

      // Binary response (e.g. PDF document download) — return as ApiFile-compatible object
      const arrayBuf = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuf).toString("base64");
      const disposition = response.headers.get("content-disposition") ?? "";
      const nameMatch = disposition.match(/filename="?([^";\n]+)"?/);
      const name = nameMatch?.[1] ?? "document";
      return { name, contents: base64 } as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async get<T = unknown>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>(path, { params });
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body });
  }

  async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PATCH", body });
  }

  async delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }
}
