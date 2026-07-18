import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { buildConnectionFingerprint } from "./connection-fingerprint.js";
import { HttpClient } from "./http-client.js";
import { BaseResource } from "./api/base-resource.js";

const config: Config = {
  baseUrl: "https://rmp-api.rik.ee/v1/",
  apiKeyId: "key-id",
  apiPublicValue: "public-value",
  apiPassword: "password-one",
};

describe("H06-A connection fingerprint", () => {
  it("H06-A normalizes the URL and excludes process-local and secret values", () => {
    const expected = createHash("sha256")
      .update("https://rmp-api.rik.ee/v1\nkey-id\npublic-value")
      .digest("hex");
    const rotatedConfig: Config = {
      ...config,
      baseUrl: " https://rmp-api.rik.ee/v1 ",
      apiPassword: "password-two",
    };
    expect(buildConnectionFingerprint(config)).toBe(expected);
    expect(buildConnectionFingerprint(rotatedConfig)).toBe(expected);
  });

  it("H06-A initializes equal clients independently of cache namespace and password", () => {
    const a = new HttpClient(config, "connection:0");
    const b = new HttpClient({ ...config, apiPassword: "rotated" }, "connection:9");
    expect(a.connectionFingerprint).toBe(buildConnectionFingerprint(config));
    expect(b.connectionFingerprint).toBe(a.connectionFingerprint);
  });

  it("H06-A makes BaseResource expose the client fingerprint read-only", () => {
    const resource = new BaseResource<{ id: number }>(new HttpClient(config), "/items");
    expect(resource.connectionFingerprint).toBe(buildConnectionFingerprint(config));
  });

  it("H06-A makes index audit initialization reuse the shared helper", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("buildConnectionFingerprint(config.config)");
    expect(source).not.toMatch(/function buildConnectionFingerprint\s*\(/);
  });
});
