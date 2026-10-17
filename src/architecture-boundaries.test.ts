import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Architecture guard (Task 19, Step 4). Two source-scanning assertions over
// PRODUCTION src (excludes *.test.ts):
//
//  1. Every `api.transactions.create(...)` CALL goes through the single
//     `createBankTransaction` boundary — the only call site is
//     `src/bank-transaction-create.ts`. A COMMENT/STRING that merely mentions
//     `transactions.create` must not count.
//  2. The modules the source spec designates PURE (CAMT parser/preflight/
//     duplicate-identity/projection, Wise preflight/projection, the
//     banking/reconciliation POLICY modules, resolution/*) must not reach into
//     the transport/IO layers: no MCP SDK, `McpServer`, `CallToolResult`,
//     `toMcpJson`, `HttpClient`, `node:fs`, audit, or environment/config
//     imports. Executors and presenters are EXEMPT (they are the IO adapters).

const SOURCE_ROOT = join(process.cwd(), "src");

function productionSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return productionSourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

// Remove line and block comments and string/template literals so a bare mention
// of an identifier inside prose or a literal cannot register as a real call.
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

describe("architecture boundary — transactions.create is funnelled through createBankTransaction", () => {
  it("has exactly one production call site: src/bank-transaction-create.ts", () => {
    const callSites = productionSourceFiles(SOURCE_ROOT)
      .filter((path) => {
        const code = stripCommentsAndStrings(readFileSync(path, "utf8"));
        return /\.transactions\.create\s*\(/.test(code);
      })
      .map((path) => relative(process.cwd(), path).split("\\").join("/"))
      .sort();

    expect(callSites).toEqual(["src/bank-transaction-create.ts"]);
  });
});

// --- Assertion 2: pure-domain import ban -----------------------------------

const PURE_DOMAIN_FILES = [
  "src/camt/parser.ts",
  "src/camt/preflight.ts",
  "src/camt/duplicate-identity.ts",
  "src/camt/projection.ts",
  "src/wise/preflight.ts",
  "src/wise/projection.ts",
  "src/banking/reconciliation/amount-resolution.ts",
  "src/banking/reconciliation/duplicate-policy.ts",
  "src/receipts/counterparty-booking-history.ts",
  "src/document-reading-packet.ts",
  "src/document-reading-tokens.ts",
  "src/document-reading-schemas.ts",
  "src/document-reading-check.ts",
  "src/document-reading-binding.ts",
];

function resolutionModules(): string[] {
  const dir = join(SOURCE_ROOT, "resolution");
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .map((entry) => `src/resolution/${entry}`);
}

interface ImportRecord {
  clause: string;
  module: string;
}

// Blank comments while KEEPING string, template and regex literals intact, so module specifiers survive
// (blanking literals, as stripCommentsAndStrings does, turned every `from "node:fs"` into `from ""` and
// made this guard vacuous). A single-pass lexer: `//` inside a string or regex is not a comment.
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let lastSignificant = "";
  const regexCanStart = () => lastSignificant === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSignificant) ||
    /\b(?:return|typeof|case|do|else|in|of|void|yield|await)$/.test(out.trimEnd());
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`" || (c === "/" && regexCanStart())) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const d = source[j]!;
        if (d === "\\") { j += 2; continue; }
        if (c === "/" && d === "[") inClass = true;
        else if (c === "/" && d === "]") inClass = false;
        else if (d === c && !inClass) break;
        else if (c !== "`" && d === "\n") break;
        j += 1;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      lastSignificant = c;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i += 1;
  }
  return out;
}

function importRecords(source: string): ImportRecord[] {
  const code = stripComments(source);
  const records: ImportRecord[] = [];
  // `import ... from "module"` (value + type imports) and `export ... from "module"` re-exports
  for (const match of code.matchAll(/\b(?:import|export)\s+([^;"'`]*?)\s*from\s*["']([^"']+)["']/g)) {
    records.push({ clause: match[1]!, module: match[2]! });
  }
  // Side-effect imports `import "module"`, dynamic `import("module")` and `require("module")`
  for (const match of code.matchAll(/\b(?:import\s*\(?|require\s*\()\s*["']([^"']+)["']/g)) {
    records.push({ clause: "", module: match[1]! });
  }
  return records;
}

const FORBIDDEN_MODULE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "MCP SDK", pattern: /@modelcontextprotocol\/sdk/ },
  { label: "node:fs", pattern: /(?:^|["'/])node:fs(?:\/|$|["'])/ },
  { label: "http-client", pattern: /http-client(?:\.js)?$/ },
  { label: "mcp-json", pattern: /mcp-json(?:\.js)?$/ },
  { label: "audit", pattern: /audit(?:-log)?(?:\.js)?$/ },
  { label: "env/config", pattern: /(?:^|\/)(?:env-)?config(?:\.js)?$/ },
];

const FORBIDDEN_NAME_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "McpServer", pattern: /\bMcpServer\b/ },
  { label: "CallToolResult", pattern: /\bCallToolResult\b/ },
  { label: "toMcpJson", pattern: /\btoMcpJson\b/ },
  { label: "HttpClient", pattern: /\bHttpClient\b/ },
];

function forbiddenImportViolations(relativePath: string, source = readFileSync(join(process.cwd(), relativePath), "utf8")): string[] {
  const violations: string[] = [];
  for (const { clause, module } of importRecords(source)) {
    for (const { label, pattern } of FORBIDDEN_MODULE_PATTERNS) {
      if (pattern.test(module)) violations.push(`${relativePath} imports forbidden module (${label}): "${module}"`);
    }
    for (const { label, pattern } of FORBIDDEN_NAME_PATTERNS) {
      if (pattern.test(clause)) violations.push(`${relativePath} imports forbidden symbol (${label}) from "${module}"`);
    }
  }
  return violations;
}

describe("architecture boundary — pure domain modules stay free of transport/IO imports", () => {
  const pureFiles = [...PURE_DOMAIN_FILES, ...resolutionModules()];

  it("scans a non-empty, existing set of pure modules", () => {
    expect(pureFiles.length).toBeGreaterThan(PURE_DOMAIN_FILES.length);
    for (const file of pureFiles) {
      expect(statSync(join(process.cwd(), file)).isFile(), `${file} should exist`).toBe(true);
    }
  });

  // Pre-existing violations the vacuous scanner hid, pinned EXACTLY: a new violation fails, and so does a
  // fixed one until it is removed from this list. Not an allowlist to grow.
  const KNOWN_VIOLATIONS = [
    'src/wise/projection.ts imports forbidden module (mcp-json): "../mcp-json.js"',
    'src/wise/projection.ts imports forbidden module (mcp-json): "../mcp-json.js"',
  ];

  it("has no forbidden imports in any pure module", () => {
    const allViolations = pureFiles.flatMap((file) => forbiddenImportViolations(file));
    expect(allViolations).toEqual(KNOWN_VIOLATIONS);
  });

  it("canary: the scanner sees every forbidden import form, even after literals with comment-like text", () => {
    const canary = [
      'const url = "https://example.test/*"; import { readFileSync } from "node:fs";',
      "const re = /[/*\"']+/g; // a regex holding quotes and a comment opener",
      'import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      "import {",
      "  HttpClient,",
      '} from "./http-client.js";',
      'export { toMcpJson } from "./mcp-json.js";',
      'import "./audit-log.js";',
      'const config = await import("../config.js");',
      "/* import { readFileSync } from \"node:fs\"; */ // import \"node:fs\"",
    ].join("\n");
    const violations = forbiddenImportViolations("canary.ts", canary);
    for (const label of ["node:fs", "MCP SDK", "McpServer", "http-client", "HttpClient", "mcp-json", "toMcpJson", "audit", "env/config"]) {
      expect(violations.some((violation) => violation.includes(`(${label})`)), label).toBe(true);
    }
    // the commented-out imports on the last line are not counted
    expect(violations.filter((violation) => violation.includes("(node:fs)"))).toHaveLength(1);
  });
});
