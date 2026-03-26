import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadAuditLogModule(tempDir: string) {
  vi.resetModules();
  const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
  try {
    return await import("./audit-log.js");
  } finally {
    cwdSpy.mockRestore();
  }
}

describe("audit log date filters", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("accepts ISO 8601 bounds when filtering entries", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-"));
    const auditLog = await loadAuditLogModule(tempDir);

    auditLog.initAuditLog(() => "acme");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T09:00:00Z"));
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 1,
      summary: "First entry",
      details: {},
    });

    vi.setSystemTime(new Date("2026-03-26T09:00:00Z"));
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 2,
      summary: "Second entry",
      details: {},
    });

    const filtered = auditLog.getAuditLog({
      date_from: "2026-03-25T00:00:00Z",
      date_to: "2026-03-25T23:59:59Z",
    });

    expect(filtered).toContain("2026-03-25 09:00:00");
    expect(filtered).not.toContain("2026-03-26 09:00:00");
    expect(filtered).toContain("create_purchase_invoice");
    expect(filtered).not.toContain("#2");
  });

  it("treats timezone-less ISO date-times as UTC to match audit headings", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-"));
    const auditLog = await loadAuditLogModule(tempDir);

    auditLog.initAuditLog(() => "acme");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T22:30:00Z"));
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 3,
      summary: "Late UTC entry",
      details: {},
    });

    vi.setSystemTime(new Date("2026-03-25T23:30:00Z"));
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 4,
      summary: "Too late",
      details: {},
    });

    const filtered = auditLog.getAuditLog({
      date_from: "2026-03-25T22:00:00",
      date_to: "2026-03-25T23:00:00",
    });

    expect(filtered).toContain("2026-03-25 22:30:00");
    expect(filtered).not.toContain("2026-03-25 23:30:00");
    expect(filtered).toContain("#3");
    expect(filtered).not.toContain("#4");
  });
});
