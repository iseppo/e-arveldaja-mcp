import { afterEach, describe, expect, it, vi } from "vitest";
import { win32 } from "path";
import { parseMcpResponse } from "../mcp-json.js";
import type { registerReceiptInboxTools as registerReceiptInboxToolsType } from "./receipt-inbox.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { scanReceiptFolderInternal } from "./receipt-inbox-files.js";

vi.mock("fs/promises", () => ({
  realpath: vi.fn().mockImplementation(async (path: unknown) => {
    if (String(path).startsWith("/proc/") || String(path).startsWith("/dev/fd/")) {
      throw Object.assign(new Error("descriptor namespace unavailable"), { code: "ENOENT" });
    }
    return "C:\\Allowed\\Receipts";
  }),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true, dev: 1, ino: 2 }),
  open: vi.fn().mockResolvedValue({
    fd: 42,
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true, dev: 1, ino: 2 }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn(),
}));

vi.mock("../file-validation.js", async () => {
  const actual = await vi.importActual<typeof import("../file-validation.js")>("../file-validation.js");
  return {
    ...actual,
    resolveFilePath: (path: string) => path,
    getAllowedRoots: () => ["C:\\Allowed"],
    isPathWithinRoot: (targetPath: string, rootPath: string) =>
      actual.isPathWithinRoot(targetPath, rootPath, win32),
  };
});

const { registerReceiptInboxTools } = await import("./receipt-inbox.js") as {
  registerReceiptInboxTools: typeof registerReceiptInboxToolsType;
};

const hostPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => setPlatform(hostPlatform));

describe("receipt inbox folder path validation", () => {
  it("accepts Windows-style child folders under an allowed root", async () => {
    const server = { registerTool: vi.fn() } as any;
    // scan_receipt_folder is granular-gated by default, so expose it here.
    registerReceiptInboxTools(server, {} as any, createTestRuntimeSafetyContext(), { enableLightyear: true, exposeGranularTools: true, exposeSetupTools: true, enableTaxTools: true, enableReferenceAdmin: true, enableAnnualReport: true, enableSales: true, enableProducts: true });

    const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "scan_receipt_folder");
    if (!registration) throw new Error("scan_receipt_folder was not registered");

    const result = await registration[2]({ folder_path: "C:\\Allowed\\Receipts" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(win32.relative("C:\\Allowed", payload.folder_path)).toBe("Receipts");
    expect(payload.files).toEqual([]);
    expect(payload.skipped).toEqual([]);
  });

  it("uses portable expected-reference binding on macOS when descriptor paths are unavailable", async () => {
    setPlatform("darwin");

    await expect(scanReceiptFolderInternal(
      "C:\\Allowed\\Receipts",
      undefined,
      undefined,
      undefined,
      { expectedCanonicalPath: "C:\\Allowed\\Receipts" },
    )).resolves.toMatchObject({
      folder_path: "C:\\Allowed\\Receipts",
      files: [],
      skipped: [],
    });
  });

  it("fails closed on other platforms when descriptor namespaces are unavailable", async () => {
    setPlatform("win32");

    await expect(scanReceiptFolderInternal(
      "C:\\Allowed\\Receipts",
      undefined,
      undefined,
      undefined,
      { expectedCanonicalPath: "C:\\Allowed\\Receipts" },
    ))
      .rejects.toThrow("The referenced filesystem location no longer resolves to the reviewed path.");
  });
});
