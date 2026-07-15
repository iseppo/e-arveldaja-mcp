import { chmod, mkdtemp, readdir, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadAuditLogModule(
  tempDir: string,
  fsOverrides?: Partial<typeof import("fs")>,
) {
  vi.resetModules();
  if (fsOverrides) {
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return { ...actual, ...fsOverrides };
    });
  } else {
    vi.doUnmock("fs");
  }
  const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
  try {
    return await import("./audit-log.js");
  } finally {
    cwdSpy.mockRestore();
    vi.doUnmock("fs");
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

  it("truncates an oversized entry to stay within PIPE_BUF (cross-process write atomicity)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-"));
    const auditLog = await loadAuditLogModule(tempDir);
    auditLog.initAuditLog(() => "acme");

    const huge = "X".repeat(20_000);
    auditLog.logAudit({
      tool: "reconcile_currency_rounding",
      action: "CREATED",
      entity_type: "journal",
      entity_id: 1,
      summary: huge,
      details: { blob: huge },
    });

    const content = auditLog.getAuditLog({});
    // The oversized entry is trimmed with a marker, not written whole.
    expect(content).toContain("audit entry truncated to preserve cross-process write atomicity");
    expect(content).not.toContain(huge);

    // The persisted entry stays within PIPE_BUF so the O_APPEND write is atomic.
    const entries = await readdir(tempDir, { recursive: true });
    const mdFiles = entries
      .filter((e) => String(e).endsWith(".md"))
      .map((e) => join(tempDir!, String(e)));
    expect(mdFiles.length).toBeGreaterThan(0);
    const sizes = await Promise.all(mdFiles.map(async (f) => (await stat(f)).size));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(4096);
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

  it("throws a stable validation error for invalid limit filters", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-"));
    const auditLog = await loadAuditLogModule(tempDir);

    auditLog.initAuditLog(() => "acme");

    expect(() => auditLog.getAuditLog({ limit: 0 })).toThrow(
      'Invalid limit filter: "0". Expected a positive integer.',
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

describe("audit log Markdown rendering", () => {
  let tempDir: string | undefined;
  const originalAuditLang = process.env.EARVELDAJA_AUDIT_LANG;

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalAuditLang === undefined) {
      delete process.env.EARVELDAJA_AUDIT_LANG;
    } else {
      process.env.EARVELDAJA_AUDIT_LANG = originalAuditLang;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("renders journal entries with visible summary, friendly labels, and readable tables", async () => {
    process.env.EARVELDAJA_AUDIT_LANG = "et";
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-render-"));
    const auditLog = await loadAuditLogModule(tempDir);

    auditLog.initAuditLog(() => "acme");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T10:39:30Z"));
    auditLog.logAudit({
      tool: "create_journal",
      action: "CREATED",
      entity_type: "journal",
      entity_id: 27404497,
      summary: 'Created journal "Lightyear konto sulgemine" on 2026-03-31',
      details: {
        effective_date: "2026-03-31",
        title: "Lightyear konto sulgemine",
        document_number: "LY:CLOSE",
        postings: [
          { accounts_id: 1020, type: "D", amount: 2236.84 },
          { accounts_id: 1100, type: "C", amount: 2222.34 },
          { accounts_id: 8600, type: "C", amount: 14.5 },
        ],
      },
    });

    const log = auditLog.getAuditLog();

    expect(log).toContain("### 2026-04-26 10:39:30 — Kanne loodud #27404497");
    expect(log).toContain('<!-- audit:{"t":"create_journal","a":"CREATED","e":"journal","id":27404497} -->');
    expect(log).toContain("Kanne #27404497 loodud.");
    expect(log).toContain("| Väli | Väärtus |");
    expect(log).toContain("| Tööriist | `create_journal` |");
    expect(log).toContain("| Kuupäev | 2026-03-31 |");
    expect(log).toContain("| Pealkiri | Lightyear konto sulgemine |");
    expect(log).toContain("| Dokumendi nr | LY:CLOSE |");
    expect(log).toContain("**Kanded**");
    expect(log).toContain("| 8600 | K | 14.50 |");
    expect(log).not.toContain("**Tööriist:**");
    expect(log).not.toContain("**title:**");
    expect(log).not.toContain("**document_number:**");
  });

  it("renders batch reasons with a human label instead of the raw detail key", async () => {
    process.env.EARVELDAJA_AUDIT_LANG = "et";
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-render-batch-"));
    const auditLog = await loadAuditLogModule(tempDir);

    auditLog.initAuditLog(() => "acme");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T10:41:36Z"));
    auditLog.logAudit({
      tool: "batch_delete_transactions",
      action: "DELETED",
      entity_type: "transaction",
      entity_id: 13254705,
      summary: "Deleted transaction 13254705: duplicate CAMT import",
      details: {
        reason: "LHV CAMT kordusimport: alles jäi varaseim ID.",
      },
    });

    const log = auditLog.getAuditLog();

    expect(log).toContain("Pangatehing #13254705 kustutatud.");
    expect(log).toContain("| Põhjus | LHV CAMT kordusimport: alles jäi varaseim ID. |");
    expect(log).not.toContain("**reason:**");
  });

  it("keeps multiple totals inside one Markdown table cell", async () => {
    process.env.EARVELDAJA_AUDIT_LANG = "et";
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-render-totals-"));
    const auditLog = await loadAuditLogModule(tempDir);

    auditLog.initAuditLog(() => "acme");

    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 42,
      summary: "Created purchase invoice",
      details: {
        supplier_name: "Acme OÜ",
        total_net: 10,
        total_vat: 2.2,
        total_gross: 12.2,
      },
    });

    const log = auditLog.getAuditLog();

    expect(log).toContain("| Kokku | neto 10.00 \\| KM 2.20 \\| bruto 12.20 |");
    expect(log).not.toContain("| Kokku | neto 10.00 | KM 2.20 | bruto 12.20 |");
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
    expect(auditLog.getAuditLogByLabel("Acme OÜ")).toContain("#20");
    expect(auditLog.getAuditLogByLabel("Acme OÜ")).not.toContain("#21");
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

  it("refreshes persisted labels before resolving raw connection lookups", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-refresh-"));
    const auditLogReader = await loadAuditLogModule(tempDir);

    auditLogReader.initAuditLog(() => "env");
    auditLogReader.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 140,
      summary: "Pre-label entry",
      details: {},
    });

    const auditLogWriter = await loadAuditLogModule(tempDir);
    auditLogWriter.initAuditLog(() => "env");
    auditLogWriter.setAuditLogLabel("env", "Acme OÜ");

    expect(auditLogReader.getAuditLogByConnection("env")).toContain("#140");
    expect(auditLogReader.getAuditLogByLabel("Acme OÜ")).toContain("#140");
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

  it("rolls back partial batched relabels without leaving temp audit files behind", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-rollback-"));
    const actualFs = await vi.importActual<typeof import("fs")>("fs");
    const auditLog = await loadAuditLogModule(tempDir, {
      renameSync: (sourcePath, targetPath) => {
        if (sourcePath.includes("__audit_tmp__") && targetPath.endsWith("Acme OÜ.audit.md")) {
          throw new Error("simulated relabel failure");
        }
        return actualFs.renameSync(sourcePath, targetPath);
      },
    });

    auditLog.initAuditLog(() => "env");
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 18,
      summary: "Rollback entry",
      details: {},
    });

    expect(() => auditLog.setAuditLogLabels([
      { connectionName: "env", label: "Acme OÜ" },
    ])).toThrow("simulated relabel failure");

    const files = (await readdir(join(tempDir, "logs"))).sort();
    expect(files).toEqual(["env.audit.md"]);
    expect(auditLog.getAuditLogByConnection("env")).toContain("#18");
    expect(auditLog.getAuditLogByConnection("Acme OÜ")).toBe("");
  });

  it("rolls back relabeling when persisting the label cache fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-persist-failure-"));
    const actualFs = await vi.importActual<typeof import("fs")>("fs");
    const labelsPath = join(tempDir, "logs", ".audit-labels.json");
    let failLabelWrite = true;
    const auditLog = await loadAuditLogModule(tempDir, {
      writeFileSync: ((filePath: Parameters<typeof actualFs.writeFileSync>[0], data: Parameters<typeof actualFs.writeFileSync>[1], options?: Parameters<typeof actualFs.writeFileSync>[2]) => {
        if (String(filePath) === labelsPath && failLabelWrite) {
          failLabelWrite = false;
          throw new Error("simulated label-cache failure");
        }
        return actualFs.writeFileSync(filePath, data as never, options as never);
      }) as typeof actualFs.writeFileSync,
    });

    auditLog.initAuditLog(() => "env");
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 21,
      summary: "Persist failure entry",
      details: {},
    });

    expect(() => auditLog.setAuditLogLabel("env", "Acme OÜ")).toThrow("simulated label-cache failure");

    const files = (await readdir(join(tempDir, "logs"))).sort();
    expect(files).toEqual(["env.audit.md"]);
    expect(auditLog.getAuditLogByConnection("env")).toContain("#21");
    expect(auditLog.getAuditLogByLabel("Acme OÜ")).toBe("");
  });

  it("tightens permissions when rewriting existing audit files and label cache", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-permissions-"));
    const auditLog = await loadAuditLogModule(tempDir);
    const logsDir = join(tempDir, "logs");
    const envPath = join(logsDir, "env.audit.md");
    const labelsPath = join(logsDir, ".audit-labels.json");
    const acmePath = join(logsDir, "Acme OÜ.audit.md");
    const betaPath = join(logsDir, "Beta AS.audit.md");

    auditLog.initAuditLog(() => "env");
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 22,
      summary: "Permissions entry",
      details: {},
    });

    await chmod(envPath, 0o644);
    auditLog.clearAuditLog();
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);

    auditLog.setAuditLogLabel("env", "Acme OÜ");
    await chmod(acmePath, 0o644);
    await chmod(labelsPath, 0o644);

    auditLog.setAuditLogLabel("env", "Beta AS");
    expect((await stat(betaPath)).mode & 0o777).toBe(0o600);
    expect((await stat(labelsPath)).mode & 0o777).toBe(0o600);
  });

  it("keeps persisted labels separate for raw-distinct connection names", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-raw-keys-"));
    let auditLog = await loadAuditLogModule(tempDir);
    const connectionFingerprints = {
      "apikey foo": "fingerprint-1",
      "apikey  foo": "fingerprint-2",
    };

    auditLog.initAuditLog(() => "apikey foo", connectionFingerprints);
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 19,
      summary: "First raw-name entry",
      details: {},
    });
    auditLog.setAuditLogLabel("apikey foo", "Acme OÜ");

    auditLog.initAuditLog(() => "apikey  foo", connectionFingerprints);
    auditLog.logAudit({
      tool: "create_purchase_invoice",
      action: "CREATED",
      entity_type: "purchase_invoice",
      entity_id: 20,
      summary: "Second raw-name entry",
      details: {},
    });
    auditLog.setAuditLogLabel("apikey  foo", "Beta AS");

    auditLog = await loadAuditLogModule(tempDir);
    auditLog.initAuditLog(() => "apikey foo", connectionFingerprints);

    expect(auditLog.getAuditLog()).toContain("#19");
    expect(auditLog.getAuditLog()).not.toContain("#20");
    expect(auditLog.getAuditLogByConnection("apikey  foo")).toContain("#20");
    expect(auditLog.getAuditLogByConnection("apikey  foo")).not.toContain("#19");
  });

  it("directs logAudit to an override connection's log when connectionName is passed", async () => {
    // Connection-switch-interruption path: the mutation's audit entry
    // belongs on the ORIGINAL (interrupted) connection's log, not the
    // new active one. Verify that the override routes writes correctly.
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-"));
    const auditLog = await loadAuditLogModule(tempDir);

    // Active connection is "new_co" — that's what a default logAudit
    // would write to. We want the entry to land in "old_co" instead.
    auditLog.initAuditLog(() => "new_co");

    auditLog.logAudit({
      tool: "confirm_transaction",
      action: "CONNECTION_SWITCH_INTERRUPTED",
      entity_type: "tool_execution",
      summary: "Interrupted by switch",
      details: { original_connection_index: 0 },
    }, { connectionName: "old_co" });

    // The interrupted-connection log should contain the entry.
    expect(auditLog.getAuditLogByConnection("old_co")).toContain("CONNECTION_SWITCH_INTERRUPTED");
    // The current-active log should NOT — otherwise the entry would be
    // misfiled on the wrong company.
    expect(auditLog.getAuditLog()).not.toContain("CONNECTION_SWITCH_INTERRUPTED");
  });

  it.each([
    ["et", "mutatsiooni tulemus määramatu"],
    ["en", "mutation outcome indeterminate"],
  ] as const)("M01 renders the localized MUTATION_INDETERMINATE action in %s", async (lang, label) => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-m01-label-"));
    const previousLang = process.env.EARVELDAJA_AUDIT_LANG;
    process.env.EARVELDAJA_AUDIT_LANG = lang;
    try {
      const auditLog = await loadAuditLogModule(tempDir);
      auditLog.initAuditLog(() => "original-company");

      expect(auditLog.AuditAction.parse("MUTATION_INDETERMINATE"))
        .toBe("MUTATION_INDETERMINATE");
      expect(auditLog.logAudit({
        tool: "update_client",
        action: "MUTATION_INDETERMINATE",
        entity_type: "client",
        entity_id: 5,
        summary: "Mutation outcome is indeterminate.",
        details: { category: "mutation_indeterminate" },
      }, { connectionName: "original-company" })).toBe(true);

      const humanReadable = auditLog.getAuditLogByConnection("original-company")
        .split("<!-- audit:")[0]!;
      expect(humanReadable).toContain(label);
      expect(humanReadable).not.toContain("MUTATION_INDETERMINATE");
    } finally {
      if (previousLang === undefined) delete process.env.EARVELDAJA_AUDIT_LANG;
      else process.env.EARVELDAJA_AUDIT_LANG = previousLang;
    }
  });

  it("M01 persists every flattened mutation recovery field through the real Markdown log", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-m01-fields-"));
    const auditLog = await loadAuditLogModule(tempDir);
    auditLog.initAuditLog(() => "currently-active-company");

    const persisted = auditLog.logAudit({
      tool: "update_client",
      action: "MUTATION_INDETERMINATE",
      entity_type: "client",
      entity_id: 5,
      summary: "Mutation outcome is indeterminate; inspect remote state before retrying.",
      details: {
        category: "mutation_indeterminate",
        mutation_may_have_occurred: true,
        operation: "update",
        business_key: "/clients:5",
        affected_caches: "/clients,/products",
        cause_name: "HttpError",
        cause_message: "connection reset after request body",
        cause_status: "network",
        cause_method: "PATCH",
        cause_path: "/clients/5",
        next_action: "Re-read client 5 before deciding whether to retry.",
      },
    }, { connectionName: "original-company" });

    expect(persisted).toBe(true);
    const markdown = auditLog.getAuditLogByConnection("original-company");
    for (const value of [
      "mutation\\_indeterminate",
      "true",
      "update",
      "/clients:5",
      "/clients,/products",
      "HttpError",
      "connection reset after request body",
      "network",
      "PATCH",
      "/clients/5",
      "Re-read client 5 before deciding whether to retry.",
    ]) {
      expect(markdown).toContain(value);
    }
    expect(auditLog.getAuditLogByConnection("currently-active-company")).toBe("");
  });

  it("M01 returns false without throwing when the production append fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "e-arveldaja-audit-log-m01-failure-"));
    const auditLog = await loadAuditLogModule(tempDir, {
      appendFileSync: vi.fn(() => {
        throw new Error("simulated append failure");
      }) as unknown as typeof import("fs").appendFileSync,
    });
    auditLog.initAuditLog(() => "original-company");

    expect(auditLog.logAudit({
      tool: "update_client",
      action: "MUTATION_INDETERMINATE",
      entity_type: "client",
      entity_id: 5,
      summary: "Mutation outcome is indeterminate.",
      details: { category: "mutation_indeterminate" },
    })).toBe(false);
  });
});
