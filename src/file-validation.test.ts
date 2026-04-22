import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getAllowedRootsStartupWarning, isPathWithinRoot, resolveFileInput, splitAllowedPaths, validateFilePath } from "./file-validation.js";
import { writeFileSync, mkdirSync, symlinkSync, unlinkSync, rmdirSync, existsSync, readFileSync } from "fs";
import { join, win32, extname } from "path";
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
      expect(warning).toContain(tmpdir());
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

  it("splits EARVELDAJA_ALLOWED_PATHS using the provided platform separator", () => {
    expect(splitAllowedPaths("C:\\docs;D:\\tmp", ";")).toEqual(["C:\\docs", "D:\\tmp"]);
  });

  it("treats Windows-style child paths inside the allowed root as valid", () => {
    expect(isPathWithinRoot(
      "C:\\Users\\Seppo\\Documents\\invoice.pdf",
      "C:\\Users\\Seppo",
      win32,
    )).toBe(true);
  });
});

describe("resolveFileInput (base64 payload support)", () => {
  it("passes through a normal file path without materialising a tmp file", async () => {
    const dir = join(tmpdir(), "earveldaja-resolve-plain-" + Date.now());
    const file = join(dir, "invoice.pdf");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "plain pdf content");
    try {
      const result = await resolveFileInput(file, [".pdf"], 10 * 1024 * 1024);
      expect(result.path).toContain("invoice.pdf");
      expect(result.cleanup).toBeUndefined();
    } finally {
      try { unlinkSync(file); } catch {}
      try { rmdirSync(dir); } catch {}
    }
  });

  it("materialises a base64 PDF to a tmp file with the correct magic-byte extension", async () => {
    const pdfPayload = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("fake pdf body")]);
    const result = await resolveFileInput(
      `base64:${pdfPayload.toString("base64")}`,
      [".pdf"],
      10 * 1024 * 1024,
    );
    try {
      expect(extname(result.path)).toBe(".pdf");
      expect(existsSync(result.path)).toBe(true);
      expect(readFileSync(result.path).equals(pdfPayload)).toBe(true);
    } finally {
      await result.cleanup?.();
    }
    expect(existsSync(result.path)).toBe(false);
  });

  it("materialises base64 with explicit extension hint for content without magic bytes (CSV)", async () => {
    const csvPayload = Buffer.from("date,amount\n2026-03-01,12.50\n");
    const result = await resolveFileInput(
      `base64:csv:${csvPayload.toString("base64")}`,
      [".csv"],
      10 * 1024 * 1024,
    );
    try {
      expect(extname(result.path)).toBe(".csv");
      expect(readFileSync(result.path, "utf-8")).toContain("date,amount");
    } finally {
      await result.cleanup?.();
    }
  });

  it("rejects base64 payload without detectable extension and no hint", async () => {
    const opaquePayload = Buffer.from("just some bytes with no magic");
    await expect(
      resolveFileInput(`base64:${opaquePayload.toString("base64")}`, [".csv"], 1024),
    ).rejects.toThrow("Could not determine file type");
  });

  it("rejects base64 payload whose extension is not in the allowed list", async () => {
    const pdfPayload = Buffer.from("%PDF-1.7 body");
    await expect(
      resolveFileInput(`base64:${pdfPayload.toString("base64")}`, [".csv"], 1024),
    ).rejects.toThrow("disallowed extension");
  });

  it("rejects base64 payloads larger than maxSize before writing to disk", async () => {
    const big = Buffer.alloc(2048, 0x20);
    const bigPdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), big]);
    await expect(
      resolveFileInput(`base64:${bigPdf.toString("base64")}`, [".pdf"], 1024),
    ).rejects.toThrow("base64 payload too large");
  });

  it("rejects malformed base64 input", async () => {
    await expect(
      resolveFileInput("base64:pdf:%%%not-base64%%%", [".pdf"], 1024),
    ).rejects.toThrow("base64 payload could not be decoded");
  });

  it("rejects hint/content mismatch to prevent extension spoofing", async () => {
    const pdfPayload = Buffer.from("%PDF-1.7 body");
    await expect(
      resolveFileInput(`base64:xml:${pdfPayload.toString("base64")}`, [".pdf", ".xml"], 1024),
    ).rejects.toThrow("conflicts with detected content type");
  });
});
