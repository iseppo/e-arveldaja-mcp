import { describe, expect, it } from "vitest";
import { buildAuditLogLabels, sanitizeAuditLogName } from "./audit-log-labels.js";

describe("buildAuditLogLabels", () => {
  it("uses the company name directly when it is unique", () => {
    const labels = buildAuditLogLabels([
      { connectionName: "env", companyName: "Acme OÜ" },
      { connectionName: "demo", companyName: "Beta AS" },
    ]);

    expect(labels.get("env")).toBe("Acme OÜ");
    expect(labels.get("demo")).toBe("Beta AS");
  });

  it("adds the connection name when the same company name appears multiple times", () => {
    const labels = buildAuditLogLabels([
      { connectionName: "env", companyName: "Acme OÜ" },
      { connectionName: "env-file", companyName: "Acme OÜ" },
    ]);

    expect(labels.get("env")).toBe("Acme OÜ (env)");
    expect(labels.get("env-file")).toBe("Acme OÜ (env-file)");
  });

  it("treats filename collisions as duplicates even when the raw company names differ", () => {
    const labels = buildAuditLogLabels([
      { connectionName: "env", companyName: "Acme/OU" },
      { connectionName: "env-file", companyName: "Acme:OU" },
    ]);

    expect(sanitizeAuditLogName("Acme/OU")).toBe(sanitizeAuditLogName("Acme:OU"));
    expect(labels.get("env")).toBe("Acme/OU (env)");
    expect(labels.get("env-file")).toBe("Acme:OU (env-file)");
  });

  it("falls back to the connection name when the company name is missing", () => {
    const labels = buildAuditLogLabels([
      { connectionName: "env", companyName: null },
    ]);

    expect(labels.get("env")).toBe("env");
  });

  it("disambiguates a connection-name collision with another company's label", () => {
    const labels = buildAuditLogLabels([
      { connectionName: "Acme OÜ", companyName: null },
      { connectionName: "env", companyName: "Acme OÜ" },
    ]);

    expect(labels.get("env")).toBe("Acme OÜ");
    expect(labels.get("Acme OÜ")).toBe("Acme OÜ (connection)");
  });
});
