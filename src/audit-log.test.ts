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

  it("accepts explicit timezone offsets in ISO date filters", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-"));
    const auditLog = await loadAuditLogModule(tempDir);

    auditLog.initAuditLog(() => "acme");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T22:30:00Z"));
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 5,
      summary: "Offset match",
      details: {},
    });

    vi.setSystemTime(new Date("2026-03-25T23:30:00Z"));
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 6,
      summary: "Offset miss",
      details: {},
    });

    const filtered = auditLog.getAuditLog({
      date_from: "2026-03-26T00:00:00+02:00",
      date_to: "2026-03-26T01:00:00+02:00",
    });

    expect(filtered).toContain("2026-03-25 22:30:00");
    expect(filtered).not.toContain("2026-03-25 23:30:00");
    expect(filtered).toContain("#5");
    expect(filtered).not.toContain("#6");
  });

  it("treats YYYY-MM-DD bounds as inclusive full-day filters", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-"));
    const auditLog = await loadAuditLogModule(tempDir);

    auditLog.initAuditLog(() => "acme");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T00:00:00Z"));
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 7,
      summary: "Day start",
      details: {},
    });

    vi.setSystemTime(new Date("2026-03-25T23:59:59Z"));
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 8,
      summary: "Day end",
      details: {},
    });

    vi.setSystemTime(new Date("2026-03-26T00:00:00Z"));
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 9,
      summary: "Next day",
      details: {},
    });

    const filtered = auditLog.getAuditLog({
      date_from: "2026-03-25",
      date_to: "2026-03-25",
    });

    expect(filtered).toContain("2026-03-25 00:00:00");
    expect(filtered).toContain("2026-03-25 23:59:59");
    expect(filtered).not.toContain("2026-03-26 00:00:00");
    expect(filtered).toContain("#7");
    expect(filtered).toContain("#8");
    expect(filtered).not.toContain("#9");
  });

  it("throws a stable validation error for invalid date filters", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-"));
    const auditLog = await loadAuditLogModule(tempDir);

    auditLog.initAuditLog(() => "acme");

    expect(() => auditLog.getAuditLog({ date_from: "not-a-date" })).toThrow(
      'Invalid date_from filter: "not-a-date". Expected YYYY-MM-DD or ISO 8601.',
    );
  });

  it("applies limit after date filtering so the newest matching entry is kept", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-"));
    const auditLog = await loadAuditLogModule(tempDir);

    auditLog.initAuditLog(() => "acme");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T10:00:00Z"));
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 10,
      summary: "Older same-day entry",
      details: {},
    });

    vi.setSystemTime(new Date("2026-03-25T11:00:00Z"));
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 11,
      summary: "Newest same-day entry",
      details: {},
    });

    vi.setSystemTime(new Date("2026-03-26T09:00:00Z"));
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 12,
      summary: "Other day entry",
      details: {},
    });

    const filtered = auditLog.getAuditLog({
      date_from: "2026-03-25",
      date_to: "2026-03-25",
      limit: 1,
    });

    expect(filtered).toContain("2026-03-25 11:00:00");
    expect(filtered).toContain("#11");
    expect(filtered).not.toContain("#10");
    expect(filtered).not.toContain("#12");
  });
});

describe("audit log labels", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("migrates an existing log file when a company label is assigned", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-label-"));
    const auditLog = await loadAuditLogModule(tempDir);

    auditLog.initAuditLog(() => "env-file");
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 13,
      summary: "Migrated entry",
      details: {},
    });

    expect(auditLog.listAuditLogs().map((log: { file: string }) => log.file)).toEqual(["env-file.audit.md"]);

    auditLog.setAuditLogLabel("env-file", "Acme OÜ");

    const logs = auditLog.listAuditLogs();
    expect(logs.map((log: { file: string }) => log.file)).toEqual(["Acme OÜ.audit.md"]);
    expect(auditLog.getAuditLog()).toContain("#13");
    expect(auditLog.getAuditLogByConnection("env-file")).toContain("#13");
    expect(auditLog.getAuditLogByConnection("Acme OÜ")).toContain("#13");
  });

  it("relabels colliding audit logs without merging the wrong connection's history", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-collision-"));
    const auditLog = await loadAuditLogModule(tempDir);

    auditLog.initAuditLog(() => "env");
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 20,
      summary: "Env entry",
      details: {},
    });

    auditLog.initAuditLog(() => "Acme OÜ");
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 21,
      summary: "Connection-name entry",
      details: {},
    });

    auditLog.setAuditLogLabels([
      { connectionName: "env", label: "Acme OÜ" },
      { connectionName: "Acme OÜ", label: "Acme OÜ (connection)" },
    ]);

    expect(auditLog.getAuditLogByConnection("env")).toContain("#20");
    expect(auditLog.getAuditLogByConnection("env")).not.toContain("#21");
    expect(auditLog.getAuditLogByConnection("Acme OÜ")).toContain("#21");
    expect(auditLog.getAuditLogByConnection("Acme OÜ")).not.toContain("#20");
  });

  it("persists the resolved company label across module reloads", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-persist-"));
    let auditLog = await loadAuditLogModule(tempDir);

    auditLog.initAuditLog(() => "env", { env: "fingerprint-1" });
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 14,
      summary: "Persisted entry",
      details: {},
    });
    auditLog.setAuditLogLabel("env", "Acme OÜ");

    auditLog = await loadAuditLogModule(tempDir);
    auditLog.initAuditLog(() => "env", { env: "fingerprint-1" });

    expect(auditLog.getAuditLog()).toContain("#14");
    expect(auditLog.listAuditLogs().map((log: { file: string }) => log.file)).toEqual(["Acme OÜ.audit.md"]);
  });

  it("ignores persisted labels when the connection fingerprint changes", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-fingerprint-"));
    let auditLog = await loadAuditLogModule(tempDir);

    auditLog.initAuditLog(() => "env", { env: "fingerprint-old" });
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 15,
      summary: "Old company entry",
      details: {},
    });
    auditLog.setAuditLogLabel("env", "Acme OÜ");

    auditLog = await loadAuditLogModule(tempDir);
    auditLog.initAuditLog(() => "env", { env: "fingerprint-new" });

    expect(auditLog.getAuditLog()).toBe("");
    expect(auditLog.getAuditLogByConnection("Acme OÜ")).toContain("#15");
  });

  it("keeps merged audit logs in chronological order for limit and last-entry metadata", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-merge-order-"));
    const auditLog = await loadAuditLogModule(tempDir);

    vi.useFakeTimers();

    auditLog.initAuditLog(() => "target");
    vi.setSystemTime(new Date("2026-03-27T10:00:00Z"));
    auditLog.logAudit({
      tool: "confirm_purchase_invoice",
      action: "CONFIRMED",
      entity_type: "purchase_invoice",
      entity_id: 17,
      summary: "Newer entry",
      details: {},
    });

    auditLog.initAuditLog(() => "source");
    vi.setSystemTime(new Date("2026-03-25T10:00:00Z"));
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 16,
      summary: "Older entry",
      details: {},
    });

    auditLog.setAuditLogLabel("source", "target");

    const limited = auditLog.getAuditLogByConnection("target", { limit: 1 });
    const logs = auditLog.listAuditLogs();

    expect(limited).toContain("#17");
    expect(limited).not.toContain("#16");
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        file: "target.audit.md",
        last_entry: "2026-03-27 10:00:00",
      }),
    ]));
  });
});
