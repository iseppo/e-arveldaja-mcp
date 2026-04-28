import { describe, expect, it, vi } from "vitest";
import { win32 } from "path";
import { parseMcpResponse } from "../mcp-json.js";

vi.mock("fs/promises", () => ({
  realpath: vi.fn().mockResolvedValue("C:\\Allowed\\Receipts"),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
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

describe("receipt inbox folder path validation", () => {
  it("accepts Windows-style child folders under an allowed root", async () => {
    const { registerReceiptInboxTools } = await import("./receipt-inbox.js");
    const server = { registerTool: vi.fn() } as any;
    registerReceiptInboxTools(server, {} as any);

    const registration = server.registerTool.mock.calls.find(([name]: [string]) => name === "scan_receipt_folder");
    if (!registration) throw new Error("scan_receipt_folder was not registered");

    const result = await registration[2]({ folder_path: "C:\\Allowed\\Receipts" });
    const payload = parseMcpResponse(result.content[0]!.text);

    expect(win32.relative("C:\\Allowed", payload.folder_path)).toBe("Receipts");
    expect(payload.files).toEqual([]);
    expect(payload.skipped).toEqual([]);
  });
});
