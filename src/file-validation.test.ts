import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { validateFilePath } from "./file-validation.js";
import { writeFileSync, mkdirSync, symlinkSync, unlinkSync, rmdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("validateFilePath", () => {
  const testDir = join(tmpdir(), "earveldaja-test-" + Date.now());
  const testPdf = join(testDir, "invoice.pdf");
  const testExe = join(testDir, "malware.exe");
  const testLargeFile = join(testDir, "huge.pdf");
  const testSymlink = join(testDir, "link.pdf");

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(testPdf, "fake pdf content");
    writeFileSync(testExe, "fake exe content");
    writeFileSync(testLargeFile, Buffer.alloc(1024)); // 1KB file
    try { symlinkSync(testPdf, testSymlink); } catch { /* symlink may fail on some systems */ }
  });

  afterAll(() => {
    try { unlinkSync(testPdf); } catch {}
    try { unlinkSync(testExe); } catch {}
    try { unlinkSync(testLargeFile); } catch {}
    try { unlinkSync(testSymlink); } catch {}
    try { rmdirSync(testDir); } catch {}
  });

  it("accepts valid PDF file", async () => {
    const result = await validateFilePath(testPdf, [".pdf"], 10 * 1024 * 1024);
    expect(result).toContain("invoice.pdf");
  });

  it("rejects disallowed extension", async () => {
    await expect(validateFilePath(testExe, [".pdf"], 10 * 1024 * 1024)).rejects.toThrow("Only .pdf files are allowed");
  });

  it("rejects files exceeding size limit", async () => {
    await expect(validateFilePath(testLargeFile, [".pdf"], 100)).rejects.toThrow("File too large");
  });

  it("rejects non-existent file", async () => {
    await expect(validateFilePath("/tmp/nonexistent-file-xyz.pdf", [".pdf"], 10 * 1024 * 1024)).rejects.toThrow();
  });

  it("accepts multiple allowed extensions", async () => {
    const result = await validateFilePath(testPdf, [".pdf", ".csv"], 10 * 1024 * 1024);
    expect(result).toContain("invoice.pdf");
  });
});
