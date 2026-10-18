// P2 D: the verified-reading modes of process_accounting_document, behind EARVELDAJA_DOCUMENT_READING.
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { registerProcessAccountingDocumentTool } from "./process-accounting-document.js";
import { parseDocument } from "../document-parser.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { parseMcpResponse } from "../mcp-json.js";
import { documentReadingEnabled } from "../config.js";
import { isToolVisibleForProfile, parseToolProfile } from "../tool-profile.js";
import { TOOL_CATALOG } from "../tool-catalog.js";
import { FIXTURE_NOW, packetFor, readingApi, readingFor, readingParse, type ReadingApiOptions } from "../__fixtures__/document-reading/verified-draft.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));
vi.mock("../document-parser.js", () => ({ parseDocument: vi.fn() }));
const mockedParse = vi.mocked(parseDocument);

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

function writePdf(contents = "%PDF-1.4 reading facade"): { path: string; sha256: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "reading-facade-")));
  const path = join(dir, "invoice.pdf");
  writeFileSync(path, contents);
  return { path, sha256: createHash("sha256").update(Buffer.from(contents)).digest("hex") };
}

function setupReading(documentReading: boolean, options: ReadingApiOptions = {}) {
  const createAndSetTotals = options.createAndSetTotals ?? vi.fn().mockRejectedValue(new Error("no write expected"));
  const api = readingApi({ ...options, createAndSetTotals });
  const runtime = createTestRuntimeSafetyContext();
  const server = { registerTool: vi.fn() } as any;
  registerProcessAccountingDocumentTool(server, api, runtime, { documentReading });
  const [, config, handler] = server.registerTool.mock.calls.find(([name]: [string]) => name === "process_accounting_document");
  return { api, runtime, config: config as { description: string; inputSchema: Record<string, z.ZodTypeAny> }, handler: handler as Handler, createAndSetTotals };
}

const parse = (result: { content: Array<{ text: string }> }) => parseMcpResponse(result.content[0]!.text) as any;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  mockedParse.mockResolvedValue(readingParse());
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("process_accounting_document reading modes: flag", () => {
  it("flag off: the reading modes and arguments are not declared and the description is the legacy one", () => {
    const { config } = setupReading(false);
    expect(Object.keys(config.inputSchema)).not.toContain("document_reading");
    expect(Object.keys(config.inputSchema)).not.toContain("proof");
    expect(config.inputSchema.mode!.safeParse("read").success).toBe(false);
    expect(config.inputSchema.mode!.safeParse("verify").success).toBe(false);
    expect(config.description).not.toContain("mode='read'");
    expect(config.description.startsWith("Unified single-document purchase-invoice entry point.")).toBe(true);
  });

  it("flag on: the modes are declared on the same tool and the guided profile stays guided with 19 tools", () => {
    const { config } = setupReading(true);
    expect(config.inputSchema.mode!.safeParse("read").success).toBe(true);
    expect(config.inputSchema.mode!.safeParse("verify").success).toBe(true);
    expect(Object.keys(config.inputSchema)).toEqual(expect.arrayContaining(["document_reading", "proof"]));
    const env = { EARVELDAJA_PROFILE: "guided", EARVELDAJA_DOCUMENT_READING: "1" } as NodeJS.ProcessEnv;
    expect(documentReadingEnabled(env)).toBe(true);
    expect(parseToolProfile(env)).toBe("guided");
    expect(TOOL_CATALOG.filter((entry) => isToolVisibleForProfile(entry.name, "guided"))).toHaveLength(19);
  });

  it("the flag is off unless set to 1 or true", () => {
    expect(documentReadingEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(documentReadingEnabled({ EARVELDAJA_DOCUMENT_READING: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(documentReadingEnabled({ EARVELDAJA_DOCUMENT_READING: "true" } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("process_accounting_document reading modes: read and verify", () => {
  it("read returns the wrapped packet with the instructions and no heuristic values", async () => {
    const { handler } = setupReading(true);
    const file = writePdf();
    const body = parse(await handler({ mode: "read", file_path: file.path }));
    expect(body.status).toBe("ready_to_read");
    expect(body.source_sha256).toBe(file.sha256);
    expect(body.packet).toMatch(/^<<UNTRUSTED_OCR_START:/);
    expect(body.reading_instructions).toBeTruthy();
    expect(body.proof_questions).toBeTruthy();
    for (const key of ["extracted", "supplier", "values", "plan_handle", "summary"]) expect(body).not.toHaveProperty(key);
  });

  it("verify refuses booking values and currency conversions passed beside the reading", async () => {
    const { handler } = setupReading(true);
    const file = writePdf();
    const { reading, proof } = readingFor(packetFor(file.sha256));
    for (const extra of [{ base_gross_price: 124 }, { currency_rate: 1 }, { gross_price: 124 }, { supplier_client_id: 4242 }]) {
      const result = await handler({ mode: "verify", file_path: file.path, document_reading: reading, proof, ...extra });
      expect(result.isError).toBe(true);
      expect(parse(result).category).toBe("reading_args_refused");
    }
  });

  it("verify on a clean reading returns the values, supplier and a plan handle; nothing is written", async () => {
    const { handler, createAndSetTotals } = setupReading(true);
    const file = writePdf();
    const { reading, proof } = readingFor(packetFor(file.sha256));
    const body = parse(await handler({ mode: "verify", file_path: file.path, document_reading: reading, proof }));
    expect(body.status).toBe("ready");
    expect(body.plan_handle).toEqual(expect.any(String));
    expect(body.supplier.client_id).toBe(4242);
    expect(body.mutation_occurred).toBe(false);
    expect(createAndSetTotals).not.toHaveBeenCalled();
  });

  it("verify on a held reading returns the hold codes and no plan handle", async () => {
    const { handler } = setupReading(true);
    const file = writePdf();
    const { reading, proof } = readingFor(packetFor(file.sha256), { values: { gross: 125 } });
    const body = parse(await handler({ mode: "verify", file_path: file.path, document_reading: reading, proof }));
    expect(body.status).toBe("blocked");
    expect(body.holds.length).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("plan_handle");
  });
});
