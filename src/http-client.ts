import type { Config } from "./config.js";
import { createAuthHeaders } from "./auth.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Thrown for HTTP-level failures (any non-2xx response or retries-exhausted
 * network error). The structured `status` lets callers distinguish 404
 * ("row is gone — safe to drop from reconciliation") from 5xx/network
 * ("transient — retry or surface as unknown") without parsing error.message.
 *
 * `status === "network"` means the request never got an HTTP status code
 * (connection refused, DNS failure, retries exhausted).
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number | "network",
    public readonly method: HttpMethod,
    public readonly path: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
}

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1_000;

export class HttpClient {
  private lastRequest = Promise.resolve();
  private nextAllowedAt = 0;
  private readonly minIntervalMs = 100; // Max ~10 req/sec

  constructor(
    private config: Config,
    public readonly cacheNamespace = "connection:0",
    private readonly requestGuard?: () => void,
  ) {}

  private assertRequestAllowed(): void {
    this.requestGuard?.();
  }

  private async waitForRateLimitTurn(): Promise<void> {
    const enforce = async () => {
      const delayMs = Math.max(0, this.nextAllowedAt - Date.now());
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      this.nextAllowedAt = Date.now() + this.minIntervalMs;
    };
    // Assign before awaiting so concurrent callers chain off this promise
    const myTurn = this.lastRequest.then(enforce, enforce);
    this.lastRequest = myTurn;
    await myTurn;
  }

  private static async sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  private static shouldRetryStatus(method: HttpMethod, status: number): boolean {
    return status === 429 || (method === "GET" && status >= 500);
  }

  private static isRetryableError(error: unknown): boolean {
    return error instanceof Error && (
      error.name === "AbortError" ||
      error.name === "TypeError" ||
      /fetch failed|network/i.test(error.message)
    );
  }

  private static formatNetworkError(method: HttpMethod, path: string, error: unknown): HttpError {
    const suffix = error instanceof Error && error.message ? `: ${error.message}` : "";
    return new HttpError(
      `API request failed: ${method} ${path} → network error${suffix}`,
      "network",
      method,
      path,
    );
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
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

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      this.assertRequestAllowed();

      // Fresh auth headers for each attempt (timestamp must be current)
      const authHeaders = createAuthHeaders(this.config, signingPath);

      const headers: Record<string, string> = {
        ...authHeaders,
        Accept: "application/json",
      };

      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      await this.waitForRateLimitTurn();
      this.assertRequestAllowed();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60_000);

      try {
        let response: Response;
        try {
          response = await fetch(url.toString(), {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal,
          });
        } catch (error) {
          if (HttpClient.isRetryableError(error) && attempt < MAX_RETRIES) {
            this.assertRequestAllowed();
            await HttpClient.sleep(INITIAL_RETRY_DELAY_MS * (2 ** attempt));
            continue;
          }
          throw HttpClient.formatNetworkError(method, path, error);
        }

        if (!response.ok) {
          if (HttpClient.shouldRetryStatus(method, response.status) && attempt < MAX_RETRIES) {
            this.assertRequestAllowed();
            await HttpClient.sleep(INITIAL_RETRY_DELAY_MS * (2 ** attempt));
            continue;
          }

          // Parse structured error if available, but don't expose raw upstream details
          let errorMessage = `API request failed: ${method} ${path} → ${response.status}`;
          try {
            const body = await response.json() as { code?: number; messages?: string[] };
            if (body.messages && Array.isArray(body.messages)) {
              const msgs = body.messages.join("; ").substring(0, 500);
              errorMessage += `: ${msgs}`;
            }
          } catch {
            // Non-JSON error body — don't expose raw text
          }

          if (response.status === 401) {
            errorMessage += `\n\nTroubleshooting 401 Unauthorized:\n` +
              `  1. Is the API key downloaded and configured? Check apikey*.txt or environment variables.\n` +
              `  2. Is this machine's public IP address allowed in e-arveldaja API settings?\n` +
              `     Find the current public IP locally (for example, open https://api.ipify.org in your browser) ` +
              `and add it to: e-arveldaja → Seaded → API võtmed → Lubatud IP-aadressid\n` +
              `     Multiple IP addresses can be added, separated by ;`;
          }

          throw new HttpError(errorMessage, response.status, method, path);
        }

        if (response.status === 204) {
          return { code: 204, messages: [] } as T;
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          return response.json() as Promise<T>;
        }

        // Binary response (e.g. PDF document download) — return as ApiFile-compatible object.
        // Cap buffered size to prevent OOM if the upstream returns an
        // unexpectedly large payload. Invoice PDFs are tiny (<1MB); keep a
        // generous ceiling for occasional legitimate bulk downloads.
        //
        // Caveat: against a hostile/buggy upstream the post-buffer check is
        // reached only AFTER `arrayBuffer()` has already allocated the full
        // body, so it does not prevent memory pressure from a streamed
        // 1 GB body lacking a truthful content-length. A real cap requires
        // streaming the body and aborting once cumulative bytes exceed the
        // limit. Defensible today because e-arveldaja is a trusted upstream
        // under HTTPS; treat this as defense-in-depth, not attacker-proof.
        const BINARY_RESPONSE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
        const contentLengthHeader = response.headers.get("content-length");
        if (contentLengthHeader) {
          const declaredSize = Number(contentLengthHeader);
          if (Number.isFinite(declaredSize) && declaredSize > BINARY_RESPONSE_MAX_BYTES) {
            throw new HttpError(
              `Binary response too large: ${declaredSize} bytes exceeds ${BINARY_RESPONSE_MAX_BYTES}-byte ceiling`,
              response.status,
              method,
              path,
            );
          }
        }
        const arrayBuf = await response.arrayBuffer();
        if (arrayBuf.byteLength > BINARY_RESPONSE_MAX_BYTES) {
          throw new HttpError(
            `Binary response too large: ${arrayBuf.byteLength} bytes exceeds ${BINARY_RESPONSE_MAX_BYTES}-byte ceiling`,
            response.status,
            method,
            path,
          );
        }
        const base64 = Buffer.from(arrayBuf).toString("base64");
        const disposition = response.headers.get("content-disposition") ?? "";
        const nameMatch = disposition.match(/filename="?([^";\n]+)"?/);
        const name = nameMatch?.[1] ?? "document";
        return { name, contents: base64 } as T;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw new HttpError(
      `API request failed: ${method} ${path} → retries exhausted`,
      "network",
      method,
      path,
    );
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
