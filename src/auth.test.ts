import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createAuthHeaders } from "./auth.js";

describe("createAuthHeaders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:30:45Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const config = {
    apiKeyId: "test-key-id",
    apiPublicValue: "test-public-value",
    apiPassword: "test-password",
    baseUrl: "https://rmp-api.rik.ee/v1",
  };

  it("returns X-AUTH-KEY and X-AUTH-QUERYTIME headers", () => {
    const headers = createAuthHeaders(config, "/v1/clients");
    expect(headers).toHaveProperty("X-AUTH-KEY");
    expect(headers).toHaveProperty("X-AUTH-QUERYTIME");
  });

  it("formats UTC time correctly", () => {
    const headers = createAuthHeaders(config, "/v1/clients");
    expect(headers["X-AUTH-QUERYTIME"]).toBe("2026-03-15T10:30:45");
  });

  it("X-AUTH-KEY has format publicValue:signature", () => {
    const headers = createAuthHeaders(config, "/v1/clients");
    const parts = headers["X-AUTH-KEY"]!.split(":");
    expect(parts[0]).toBe("test-public-value");
    expect(parts.length).toBe(2);
    // Signature should be base64-encoded
    expect(parts[1]).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("produces deterministic signatures", () => {
    const h1 = createAuthHeaders(config, "/v1/clients");
    const h2 = createAuthHeaders(config, "/v1/clients");
    expect(h1["X-AUTH-KEY"]).toBe(h2["X-AUTH-KEY"]);
  });

  it("different paths produce different signatures", () => {
    const h1 = createAuthHeaders(config, "/v1/clients");
    const h2 = createAuthHeaders(config, "/v1/journals");
    expect(h1["X-AUTH-KEY"]).not.toBe(h2["X-AUTH-KEY"]);
  });

  it("different passwords produce different signatures", () => {
    const h1 = createAuthHeaders(config, "/v1/clients");
    const h2 = createAuthHeaders({ ...config, apiPassword: "other-password" }, "/v1/clients");
    expect(h1["X-AUTH-KEY"]).not.toBe(h2["X-AUTH-KEY"]);
  });
});
