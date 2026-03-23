import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getAllowedRootsStartupWarning, validateFilePath } from "./file-validation.js";
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

  it("rejects a .pdf symlink that points to a disallowed target extension", async () => {
    const disguisedLink = join(testDir, "disguised.pdf");
    try {
      symlinkSync(testExe, disguisedLink);
    } catch {
      return; // symlinks may not work on all systems
    }
    try {
      await expect(
        validateFilePath(disguisedLink, [".pdf"], 10 * 1024 * 1024)
      ).rejects.toThrow("Symlink target has disallowed extension");
    } finally {
      try { unlinkSync(disguisedLink); } catch {}
    }
  });

  it("rejects files outside EARVELDAJA_ALLOWED_PATHS", async () => {
    const previous = process.env.EARVELDAJA_ALLOWED_PATHS;
    const restrictedDir = join(testDir, "restricted-root");
    mkdirSync(restrictedDir, { recursive: true });
    process.env.EARVELDAJA_ALLOWED_PATHS = restrictedDir;
    try {
      await expect(
        validateFilePath(testPdf, [".pdf"], 10 * 1024 * 1024)
      ).rejects.toThrow("outside allowed directories");
    } finally {
      if (previous === undefined) delete process.env.EARVELDAJA_ALLOWED_PATHS;
      else process.env.EARVELDAJA_ALLOWED_PATHS = previous;
      try { rmdirSync(restrictedDir); } catch {}
    }
  });

  it("warns with default roots (project parent + /tmp) when no paths configured", () => {
    const previous = process.env.EARVELDAJA_ALLOWED_PATHS;
    const previousHome = process.env.EARVELDAJA_ALLOW_HOME;
    delete process.env.EARVELDAJA_ALLOWED_PATHS;
    delete process.env.EARVELDAJA_ALLOW_HOME;
    try {
      const warning = getAllowedRootsStartupWarning();
      expect(warning).toContain("/tmp");
      expect(warning).toContain("EARVELDAJA_ALLOWED_PATHS");
      expect(warning).toContain("EARVELDAJA_ALLOW_HOME");
    } finally {
      if (previous === undefined) delete process.env.EARVELDAJA_ALLOWED_PATHS;
      else process.env.EARVELDAJA_ALLOWED_PATHS = previous;
      if (previousHome === undefined) delete process.env.EARVELDAJA_ALLOW_HOME;
      else process.env.EARVELDAJA_ALLOW_HOME = previousHome;
    }
  });

  it("does not warn when EARVELDAJA_ALLOWED_PATHS is configured", () => {
    const previous = process.env.EARVELDAJA_ALLOWED_PATHS;
    process.env.EARVELDAJA_ALLOWED_PATHS = testDir;
    try {
      expect(getAllowedRootsStartupWarning()).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.EARVELDAJA_ALLOWED_PATHS;
      else process.env.EARVELDAJA_ALLOWED_PATHS = previous;
    }
  });
});
