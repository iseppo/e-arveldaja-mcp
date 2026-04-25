import type { Config } from "./config.js";
import { createAuthHeaders } from "./auth.js";
import { wrapUntrustedOcr } from "./mcp-json.js";

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
  /**
   * Upstream body.messages joined text, already OCR-sandbox-wrapped so a
   * downstream LLM treats it as untrusted data. Present only when the
   * upstream returned a structured JSON body with `messages`. Kept off
   * `Error.message` so audit logs / stderr remain clean; tool-error
   * serialization forwards this property to the MCP response.
   */
  readonly upstream_detail?: string;
  readonly recovery_hint?: string;
  readonly next_actions?: Array<{
    tool: string;
    args?: Record<string, unknown>;
    why: string;
  }>;

  constructor(
    message: string,
    public readonly status: number | "network",
    public readonly method: HttpMethod,
    public readonly path: string,
    options?: {
      upstream_detail?: string;
      recovery_hint?: string;
      next_actions?: Array<{ tool: string; args?: Record<string, unknown>; why: string }>;
    },
  ) {
    super(message);
    this.name = "HttpError";
    if (options?.upstream_detail !== undefined) {
      this.upstream_detail = options.upstream_detail;
    }
    if (options?.recovery_hint !== undefined) {
      this.recovery_hint = options.recovery_hint;
    }
    if (options?.next_actions !== undefined) {
      this.next_actions = options.next_actions;
    }
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

  private static getResourceName(path: string): string | undefined {
    return path.split("?")[0]!.split("/").filter(Boolean)[0];
  }

  private static getPathId(path: string): number | undefined {
    const raw = path.split("?")[0]!.split("/").filter(Boolean)[1];
    if (!raw) return undefined;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  private static listActionForPath(path: string): { tool: string; why: string } | undefined {
    switch (HttpClient.getResourceName(path)) {
      case "clients":
        return { tool: "list_clients", why: "List clients and verify the target client ID." };
      case "products":
        return { tool: "list_products", why: "List products and verify the target product ID." };
      case "journals":
        return { tool: "list_journals", why: "List journals and verify the target journal ID/status." };
      case "transactions":
        return { tool: "list_transactions", why: "List transactions and verify the target transaction ID/status." };
      case "sale_invoices":
        return { tool: "list_sale_invoices", why: "List sale invoices and verify the target invoice ID/status." };
      case "purchase_invoices":
        return { tool: "list_purchase_invoices", why: "List purchase invoices and verify the target invoice ID/status." };
      default:
        return undefined;
    }
  }

  private static recoveryActionsForNotFound(path: string): Array<{ tool: string; args?: Record<string, unknown>; why: string }> {
    const id = HttpClient.getPathId(path);
    const listAction = HttpClient.listActionForPath(path);
    const actions: Array<{ tool: string; args?: Record<string, unknown>; why: string }> = [];

    if (id !== undefined) {
      const resource = HttpClient.getResourceName(path);
      const singular = resource?.endsWith("s") ? resource.slice(0, -1) : resource;
      if (singular && ["client", "product", "journal", "transaction"].includes(singular)) {
        actions.push({
          tool: `get_${singular}`,
          args: { id },
          why: "Re-read the record by ID to confirm whether it still exists.",
        });
      }
      if (resource === "sale_invoices") {
        actions.push({ tool: "get_sale_invoice", args: { id }, why: "Re-read the sale invoice by ID." });
      }
      if (resource === "purchase_invoices") {
        actions.push({ tool: "get_purchase_invoice", args: { id }, why: "Re-read the purchase invoice by ID." });
      }
    }

    if (HttpClient.getResourceName(path) === "clients") {
      actions.push(
        { tool: "search_client", args: { name: "<client name>" }, why: "Search by name when the stored client ID may be stale." },
        { tool: "find_client_by_code", args: { code: "<registry code>" }, why: "Find the current client by registry code." },
      );
    }
    if (listAction) actions.push(listAction);
    return actions;
  }

  private static recoveryActionsForValidation(path: string): Array<{ tool: string; args?: Record<string, unknown>; why: string }> {
    const actions: Array<{ tool: string; args?: Record<string, unknown>; why: string }> = [
      { tool: "list_accounts", why: "Verify account IDs and whether the account requires dimensions." },
      { tool: "list_account_dimensions", why: "Find required sub-account/dimension IDs for dimensional accounts." },
      { tool: "get_vat_info", why: "Check VAT registration before retrying invoice or VAT-sensitive postings." },
    ];

    switch (HttpClient.getResourceName(path)) {
      case "purchase_invoices":
        actions.push({ tool: "list_purchase_articles", why: "Verify purchase article and VAT article IDs." });
        break;
      case "sale_invoices":
        actions.push({ tool: "list_sale_articles", why: "Verify sale article and VAT/account defaults." });
        break;
      case "transactions":
        actions.push({ tool: "get_transaction", args: { id: HttpClient.getPathId(path) ?? "<transaction id>" }, why: "Inspect the transaction before retrying confirmation/update." });
        break;
    }

    return actions;
  }

  private static recoveryActionsForConflict(path: string): Array<{ tool: string; args?: Record<string, unknown>; why: string }> {
    const actions: Array<{ tool: string; args?: Record<string, unknown>; why: string }> = [];
    switch (HttpClient.getResourceName(path)) {
      case "purchase_invoices":
        actions.push({
          tool: "detect_duplicate_purchase_invoice",
          args: { invoice_number: "<invoice number>", gross_price: "<gross price>", invoice_date: "<YYYY-MM-DD>" },
          why: "Check whether the invoice already exists before retrying creation.",
        });
        break;
      case "transactions":
        actions.push({ tool: "reconcile_transactions", args: { min_confidence: 30 }, why: "Check whether the transaction is already matched or conflicts with another booking." });
        break;
    }
    const listAction = HttpClient.listActionForPath(path);
    if (listAction) actions.push(listAction);
    return actions;
  }

  private static buildRecoveryAdvice(
    status: number,
    method: HttpMethod,
    path: string,
  ): { recovery_hint?: string; next_actions?: Array<{ tool: string; args?: Record<string, unknown>; why: string }> } {
    switch (status) {
      case 400:
      case 422:
        return {
          recovery_hint:
            "Validate the request body before retrying. Common causes are missing required fields, invalid date format, invoice total mismatches, inactive accounts, or missing account dimensions.",
          next_actions: HttpClient.recoveryActionsForValidation(path),
        };
      case 401:
        return {
          recovery_hint:
            "Check API credentials and the allowed public IP address. Restart the MCP server after changing stored credentials.",
          next_actions: [
            { tool: "get_setup_instructions", why: "Review the credential sources and import options for this working directory." },
            { tool: "list_connections", why: "Verify which company connection is currently active." },
          ],
        };
      case 403:
        return {
          recovery_hint:
            "Check API token permissions, company access, and whether the active connection points to the intended company.",
          next_actions: [
            { tool: "list_connections", why: "Confirm the active company connection before retrying." },
            { tool: "get_setup_instructions", why: "Review credential setup and storage scope." },
          ],
        };
      case 404:
        return {
          recovery_hint:
            "Verify that the referenced record still exists and is not deleted, voided, or in another company connection.",
          next_actions: HttpClient.recoveryActionsForNotFound(path),
        };
      case 409:
        return {
          recovery_hint:
            "Resolve the conflict before retrying. This often means a duplicate record, stale status, or an operation that must happen in a different order.",
          next_actions: HttpClient.recoveryActionsForConflict(path),
        };
      case 429:
        return {
          recovery_hint:
            "Wait before retrying. The upstream API is rate-limiting requests; reduce batch size or retry the same tool after a short delay.",
        };
      default:
        return {};
    }
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

          // Parse structured error if available. Upstream API messages may
          // echo user-supplied content (invoice notes, supplier names), so
          // we keep `Error.message` free of raw upstream text and stash the
          // sandbox-wrapped detail on a dedicated property for MCP output.
          // Audit logs and stderr show only the clean top-line; the LLM sees
          // the detail through tool-error serialization, sandboxed.
          let errorMessage = `API request failed: ${method} ${path} → ${response.status}`;
          let upstreamDetail: string | undefined;
          try {
            const body = await response.json() as { code?: number; messages?: string[] };
            if (body.messages && Array.isArray(body.messages)) {
              const msgs = body.messages.join("; ").substring(0, 500);
              upstreamDetail = wrapUntrustedOcr(msgs);
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

          throw new HttpError(errorMessage, response.status, method, path, {
            upstream_detail: upstreamDetail,
            ...HttpClient.buildRecoveryAdvice(response.status, method, path),
          });
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
