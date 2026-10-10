import { appendFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFileCapped, readFileHandleCapped } from "./bounded-read.js";
import { validateFilePath } from "./file-validation.js";

const roots: string[] = [];

async function tempFile(name: string, content: Buffer): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bounded-read-"));
  roots.push(root);
  const path = join(root, name);
  await writeFile(path, content);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("readFileCapped", () => {
  it("returns every byte of a file exactly at the limit", async () => {
    const content = Buffer.from("0123456789");
    const path = await tempFile("exact.csv", content);

    await expect(readFileCapped(path, 10)).resolves.toEqual(content);
  });

  it("returns an empty buffer for an empty file", async () => {
    const path = await tempFile("empty.csv", Buffer.alloc(0));

    await expect(readFileCapped(path, 10)).resolves.toEqual(Buffer.alloc(0));
  });

  it("rejects a file one byte over the limit with the validateFilePath size error", async () => {
    const path = await tempFile("over.csv", Buffer.from("0123456789A"));

    await expect(readFileCapped(path, 10)).rejects.toThrow(/^File too large: .* MB \(max .* MB\)$/);
  });

  it("reads a multi-chunk file exactly and rejects it one byte under its size", async () => {
    const content = Buffer.alloc(3 * 1024 * 1024 + 7);
    for (let i = 0; i < content.length; i++) content[i] = i % 251;
    const path = await tempFile("large.pdf", content);

    const bytes = await readFileCapped(path, content.length);
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe(createHash("sha256").update(content).digest("hex"));
    await expect(readFileCapped(path, content.length - 1)).rejects.toThrow("File too large");
  });

  it("rejects a file that grew past the limit after the stat-based validation passed", async () => {
    const path = await tempFile("grows.csv", Buffer.from("a,b\n"));
    const validated = await validateFilePath(path, [".csv"], 16);

    await appendFile(validated, Buffer.alloc(1024, 0x41));

    await expect(readFileCapped(validated, 16)).rejects.toThrow("File too large: 0.0 MB (max");
  });
});

describe("readFileHandleCapped", () => {
  it("reads from offset 0 regardless of the handle's position and stops at the cap", async () => {
    const path = await tempFile("handle.pdf", Buffer.from("%PDF-receipt"));
    const handle = await open(path, "r");
    try {
      await handle.read(Buffer.alloc(4), 0, 4, null);
      await expect(readFileHandleCapped(handle, 12)).resolves.toEqual(Buffer.from("%PDF-receipt"));
      await expect(readFileHandleCapped(handle, 11)).rejects.toThrow("File too large");
    } finally {
      await handle.close();
    }
  });
});
