import type { Config } from "./config.js";
import { createAuthHeaders } from "./auth.js";
import { wrapUntrustedOcr } from "./mcp-json.js";
import { buildConnectionFingerprint } from "./connection-fingerprint.js";
import { AUTH_BRAKE, authBrakeFor, type AuthBrake } from "./api-health.js";

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
  /**
   * Set on a 409 whose upstream messages are all "No such object." — RIK's
   * answer for a record that no longer exists. `status` stays 409; use
   * `isNotFoundHttpError` to treat it like a 404.
   */
  readonly upstream_not_found?: true;
  readonly next_actions?: Array<{
    tool: string;
    args?: Record<string, unknown>;
    why: string;
  }>;
  /** `"auth_cooldown"`: refused locally by the per-server consecutive-401 brake, nothing sent. */
  readonly code?: "auth_cooldown" | "account_not_bank_bindable";
  readonly cooldown_seconds_remaining?: number;
  /** On `auth_cooldown`: distinct connections to this server whose 401s tripped the brake. */
  readonly distinct_connections_401?: number;

  constructor(
    message: string,
    public readonly status: number | "network",
    public readonly method: HttpMethod,
    public readonly path: string,
    options?: {
      upstream_detail?: string;
      recovery_hint?: string;
      upstream_not_found?: boolean;
      next_actions?: Array<{ tool: string; args?: Record<string, unknown>; why: string }>;
      code?: "auth_cooldown";
      cooldown_seconds_remaining?: number;
      distinct_connections_401?: number;
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
    if (options?.upstream_not_found === true) {
      this.upstream_not_found = true;
    }
    if (options?.next_actions !== undefined) {
      this.next_actions = options.next_actions;
    }
    if (options?.code !== undefined) this.code = options.code;
    if (options?.cooldown_seconds_remaining !== undefined) {
      this.cooldown_seconds_remaining = options.cooldown_seconds_remaining;
    }
    if (options?.distinct_connections_401 !== undefined) {
      this.distinct_connections_401 = options.distinct_connections_401;
    }
  }
}

/** True for a 404, or a 409 the upstream flagged as "No such object." (record gone). */
export function isNotFoundHttpError(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 404 || error.upstream_not_found === true);
}

/**
 * Strict: a non-empty array whose every element is a string matching
 * "No such object." after trimming. Anything else stays a conflict.
 */
function isNoSuchObjectMessages(messages: unknown): boolean {
  return Array.isArray(messages)
    && messages.length > 0
    && messages.every(message => typeof message === "string" && /^No such object\.?$/i.test(message.trim()));
}

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
  /**
   * A 401 on this request does not feed the per-server 401 brake. Only for
   * hidden background lookups the user never asked for (the audit-label
   * `GET /invoice_info`); the brake still refuses the request while cooling down.
   */
  excludeFromAuthBrake?: boolean;
}

const MAX_RETRIES = 3;

const UNAUTHORIZED_TROUBLESHOOTING =
  `\n\nTroubleshooting 401 Unauthorized:\n` +
  `  1. Is the API key downloaded and configured, and still valid? Check apikey*.txt or environment variables; ` +
  `a key that has expired, was replaced by a new one, or belongs to another company is refused.\n` +
  `  2. Is this machine's public IP address allowed in e-arveldaja API settings?\n` +
  `     Find the current public IP locally (for example, open https://api.ipify.org in your browser) ` +
  `and add it to: e-arveldaja → Seaded → API võtmed → Lubatud IP-aadressid\n` +
  `     Multiple IP addresses can be added, separated by ;\n` +
  `  3. Is this computer's clock correct? Requests are signed with the current time, so a wrong clock is refused.`;

/** Added to every 401: the failing request alone cannot tell a stale key from a server- or IP-side block. */
const UNAUTHORIZED_BLOCK_ADVICE =
  "If several connections fail at once, or this connection worked moments ago, suspect a server- or IP-side block: " +
  "wait and retry, do not change API keys.";

/** Timeout / network / TLS error / 5xx on the request itself. */
const API_DOWN_ADVICE =
  "The e-arveldaja API did not answer (timeout, network/TLS error or server error); it may be down or unreachable " +
  "from this machine. This is probably not a credentials problem — retry in a few minutes.";
const INITIAL_RETRY_DELAY_MS = 1_000;

export class HttpClient {
  public readonly connectionFingerprint: string;
  /** API environment (demo vs live server), normalised like the fingerprint's. */
  public readonly apiBaseUrl: string;
  private lastRequest = Promise.resolve();
  private nextAllowedAt = 0;
  private readonly minIntervalMs = 100; // Max ~10 req/sec
  /** Shared by every connection to the same API server. */
  private readonly authBrake: AuthBrake;

  constructor(
    private config: Config,
    public readonly cacheNamespace = "connection:0",
    private readonly requestGuard?: () => void,
  ) {
    this.connectionFingerprint = buildConnectionFingerprint(config);
    this.apiBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    this.authBrake = authBrakeFor(this.apiBaseUrl);
  }

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
        actions.push({ tool: "reconcile_bank_transactions", args: { mode: "suggest", min_confidence: 30 }, why: "Check whether the transaction is already matched or conflicts with another booking." });
        break;
    }
    const listAction = HttpClient.listActionForPath(path);
    if (listAction) actions.push(listAction);
    return actions;
  }

  private static buildRecoveryAdvice(
    status: number,
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
            "Resolve the conflict before retrying. This often means a duplicate record, stale status, an operation that must happen in a different order, or a field over its length limit (read upstream_detail for the exact cause).",
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

  /**
   * Only idempotent methods may be retried after a network error / timeout.
   * A timed-out or connection-dropped POST/PATCH/DELETE is ambiguous: the
   * server may have already committed the mutation, so a blind retry risks a
   * duplicate booking (invoice, journal, transaction). GET and PUT (full
   * replace) are safe to repeat. Mirrors the GET-only gate in
   * shouldRetryStatus for 5xx responses.
   */
  private static isIdempotentMethod(method: HttpMethod): boolean {
    return method === "GET" || method === "PUT";
  }

  private static formatNetworkError(method: HttpMethod, path: string, error: unknown): HttpError {
    // Only surface the error NAME and a known error CODE — never the raw
    // message. Node's fetch echoes offending values into the message for some
    // failures (e.g. an invalid header value includes the header content), so a
    // malformed apiPublicValue / signature could otherwise leak into
    // HttpError.message, stderr, and the stderr tee.
    const name = error instanceof Error ? error.name : "";
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
    const detail = [name, code].filter(Boolean).join(" ");
    const suffix = detail ? `: ${detail}` : "";
    return new HttpError(
      `API request failed: ${method} ${path} → network error${suffix}`,
      "network",
      method,
      path,
    );
  }

  /**
   * Sends the request, guarded by the per-server 401 brake. A 401, 5xx or
   * network failure gets advice derived from that failure alone; no other
   * request is ever sent.
   */
  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    this.assertAuthBrakeOpen(options.method ?? "GET", path);
    let result: T;
    try {
      result = await this.sendRequest<T>(path, options);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      // A local refusal is not an upstream 401: don't count it, keep its metadata.
      if (error.code === "auth_cooldown") throw error;
      if (error.status === 401 && options.excludeFromAuthBrake !== true) {
        this.authBrake.recordUnauthorized(this.cacheNamespace);
      }
      throw HttpClient.enrichFailure(error);
    }
    this.authBrake.recordSuccess(this.cacheNamespace);
    return result;
  }

  /**
   * Refuses locally while the server's 401 brake is cooling down. Checked when
   * a request starts and again immediately before every fetch, so a request
   * queued for its rate-limit turn or sleeping before a retry cannot slip past
   * a cooldown another request tripped meanwhile.
   */
  private assertAuthBrakeOpen(method: HttpMethod, path: string): void {
    const remainingMs = this.authBrake.remainingMs();
    if (remainingMs <= 0) return;
    const seconds = Math.ceil(remainingMs / 1000);
    const connections = this.authBrake.distinctConnections401;
    const scope = connections >= 2
      ? `${connections} different connections got 401 Unauthorized from this API server within ` +
        `${AUTH_BRAKE.windowMs / 1000} s, which points to a server- or IP-side problem, not one stale API key.`
      : `${AUTH_BRAKE.threshold} consecutive 401 Unauthorized answers came from this API server on one connection.`;
    throw new HttpError(
      `API request refused locally: ${method} ${path} → auth_cooldown (${seconds} s remaining). ` +
        `${scope} Further requests to this server are paused on every connection, because repeated failed ` +
        `authentications can trigger a server-side lockout. Nothing was sent.`,
      401,
      method,
      path,
      {
        code: "auth_cooldown",
        cooldown_seconds_remaining: seconds,
        distinct_connections_401: connections,
        recovery_hint: `Wait ${seconds} s before retrying; do not loop over connections or retry in a tight loop.`,
      },
    );
  }

  /** Advice for a 401, 5xx or network failure, derived from the failure alone. */
  private static enrichFailure(error: HttpError): HttpError {
    const status = error.status;
    let message = error.message;
    let recovery_hint = error.recovery_hint;
    if (status === 401) {
      message += `${UNAUTHORIZED_TROUBLESHOOTING}\n\n${UNAUTHORIZED_BLOCK_ADVICE}`;
      recovery_hint = recovery_hint ? `${recovery_hint} ${UNAUTHORIZED_BLOCK_ADVICE}` : UNAUTHORIZED_BLOCK_ADVICE;
    } else if (status === "network" || status >= 500) {
      recovery_hint = API_DOWN_ADVICE;
    } else {
      return error;
    }
    return new HttpError(message, status, error.method, error.path, {
      upstream_detail: error.upstream_detail,
      recovery_hint,
      upstream_not_found: error.upstream_not_found === true,
      next_actions: error.next_actions,
    });
  }

  private async sendRequest<T>(path: string, options: RequestOptions): Promise<T> {
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
      this.assertAuthBrakeOpen(method, path);

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
            // Never auto-follow redirects: fetch would forward the custom
            // X-AUTH-* headers (public value + HMAC signature) to the redirect
            // target, and the signature — which signs only the ORIGINAL path —
            // could be captured/replayed. A trusted HTTPS API does not redirect.
            redirect: "manual",
          });
        } catch (error) {
          if (
            HttpClient.isRetryableError(error) &&
            HttpClient.isIdempotentMethod(method) &&
            attempt < MAX_RETRIES
          ) {
            this.assertRequestAllowed();
            await HttpClient.sleep(INITIAL_RETRY_DELAY_MS * (2 ** attempt));
            continue;
          }
          throw HttpClient.formatNetworkError(method, path, error);
        }

        // With redirect:"manual", a 3xx is surfaced (not followed) as an opaque
        // redirect or a bare 3xx status. Refuse it explicitly rather than let it
        // fall through as a generic error — the auth headers were NOT forwarded.
        if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
          throw new HttpError(
            `API request failed: ${method} ${path} → unexpected redirect refused (auth headers not forwarded)`,
            response.status || 502,
            method,
            path,
          );
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
          let upstreamNotFound = false;
          try {
            const body = await response.json() as { code?: number; messages?: string[] };
            upstreamNotFound = response.status === 409 && isNoSuchObjectMessages(body.messages);
            if (body.messages && Array.isArray(body.messages)) {
              const msgs = body.messages.join("; ").substring(0, 500);
              upstreamDetail = wrapUntrustedOcr(msgs);
            }
          } catch {
            // Non-JSON error body — don't expose raw text
          }

          // 401 troubleshooting text and 5xx outage advice are added by
          // request() from this failure alone.
          throw new HttpError(errorMessage, response.status, method, path, {
            upstream_detail: upstreamDetail,
            ...(upstreamNotFound ? { upstream_not_found: true } : {}),
            ...HttpClient.buildRecoveryAdvice(upstreamNotFound ? 404 : response.status, path),
          });
        }

        if (response.status === 204) {
          return { code: 204, messages: [] } as T;
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          // `await` (not a bare `return response.json()`) so the 60s timeout in
          // `finally` clears only AFTER the body is fully read — otherwise a
          // stalled body hangs forever. A body-read failure (connection dropped
          // mid-body after a committed mutation) is classified as a network
          // error so ambiguous-write recovery (TransactionsApi.confirm) treats
          // it as an indeterminate commit rather than a raw TypeError.
          try {
            return await response.json() as T;
          } catch (bodyError) {
            throw HttpClient.formatNetworkError(method, path, bodyError);
          }
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
  async get<T = unknown>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    options: Pick<RequestOptions, "excludeFromAuthBrake"> = {},
  ): Promise<T> {
    return this.request<T>(path, { params, ...options });
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
