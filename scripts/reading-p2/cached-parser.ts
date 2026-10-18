// Frozen parses for the P2 §4 batch replay: parseDocument memoized on disk by the file's SHA-256, so every replay
// (and every mode and registry state of one replay) books from the same parse. The first parse of a file is the
// real one; the replay checks its packet digest against the frozen packet.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as real from "../../src/document-parser.js";
import { dataPath, readJson, writeJson } from "../reading-p1/common.js";

export const buildDocumentParserConfig = real.buildDocumentParserConfig;
export const getDocumentParser = real.getDocumentParser;
export const analyzeDocumentComplexity = real.analyzeDocumentComplexity;

export async function parseDocument(filePath: string): Promise<real.ParsedDocument> {
  const sha = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  const path = dataPath("p2-batch", "parses", `${sha}.json`);
  if (existsSync(path)) return readJson<real.ParsedDocument>(path);
  const parsed = await real.parseDocument(filePath);
  mkdirSync(dataPath("p2-batch", "parses"), { recursive: true, mode: 0o700 });
  writeJson(path, parsed);
  return parsed;
}
