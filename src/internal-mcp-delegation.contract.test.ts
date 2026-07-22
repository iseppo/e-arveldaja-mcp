import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve("src");

const ALLOWED_PRODUCTION_CONSUMERS = [
  "src/tools/accounting-inbox-autopilot-service.ts",
  "src/tools/accounting-inbox.ts",
  "src/tools/bank-reconciliation.ts",
  "src/tools/camt-import.ts",
  "src/tools/receipt-inbox.ts",
] as const;

async function productionTypeScriptFiles(directory = SOURCE_ROOT): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__fixtures__" || entry.name === "__integration__") return [];
      return productionTypeScriptFiles(path);
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [path];
  }));
  return nested.flat();
}

function usesInternalMcpDelegation(relativePath: string, source: string): boolean {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"], allowReturnOutsideFunction: true });
  let detected = false;

  type AstNode = { type: string; [key: string]: unknown };
  const isNode = (value: unknown): value is AstNode =>
    typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
  const identifierName = (node: unknown): string | undefined =>
    isNode(node) && node.type === "Identifier" ? node.name as string : undefined;
  const isMember = (node: unknown): node is AstNode =>
    isNode(node) && (node.type === "MemberExpression" || node.type === "OptionalMemberExpression");
  const isContentAccess = (node: unknown): boolean =>
    isMember(node) && identifierName(node.property) === "content";
  const isNumericZero = (node: unknown): boolean =>
    isNode(node) && ((node.type === "NumericLiteral" && node.value === 0) || (node.type === "Literal" && node.value === 0));
  const readsFirstContentItem = (node: AstNode): boolean => {
    if (isMember(node) && node.computed === true) {
      return isContentAccess(node.object) && isNumericZero(node.property);
    }
    if ((node.type === "CallExpression" || node.type === "OptionalCallExpression") && isMember(node.callee)) {
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      return identifierName(node.callee.property) === "at" && isContentAccess(node.callee.object) && isNumericZero(args[0]);
    }
    return node.type === "VariableDeclarator"
      && isNode(node.id)
      && node.id.type === "ArrayPattern"
      && isContentAccess(node.init);
  };

  const visit = (node: AstNode): void => {
    if (detected) return;
    if (relativePath !== "src/mcp-json.ts" && node.type === "Identifier" && node.name === "parseMcpResponse") {
      detected = true;
      return;
    }
    if (readsFirstContentItem(node)) {
      detected = true;
      return;
    }
    if ((node.type === "ObjectMethod" || node.type === "ClassMethod") && identifierName(node.key) === "registerTool") {
      detected = true;
      return;
    }
    if (
      (node.type === "ObjectProperty" || node.type === "ClassProperty")
      && identifierName(node.key) === "registerTool"
      && isNode(node.value)
      && (node.value.type === "ArrowFunctionExpression" || node.value.type === "FunctionExpression")
    ) {
      detected = true;
      return;
    }
    for (const value of Object.values(node)) {
      if (isNode(value)) visit(value);
      else if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) visit(child);
      }
    }
  };
  visit(ast.program as unknown as AstNode);
  return detected;
}

async function currentProductionConsumers(): Promise<string[]> {
  const consumers: string[] = [];
  for (const path of await productionTypeScriptFiles()) {
    const relativePath = relative(resolve("."), path).split("\\").join("/");
    const source = await readFile(path, "utf8");
    if (usesInternalMcpDelegation(relativePath, source)) consumers.push(relativePath);
  }
  return consumers.sort();
}

describe("internal MCP delegation architecture contract", () => {
  it("allows exactly the five current production consumers and no new ones", async () => {
    expect(await currentProductionConsumers()).toEqual(ALLOWED_PRODUCTION_CONSUMERS);
  });

  it("keeps the parser definition isolated from the production allowlist", async () => {
    const parser = await readFile(resolve("src/mcp-json.ts"), "utf8");
    expect(parser).toContain("export function parseMcpResponse");
    expect(ALLOWED_PRODUCTION_CONSUMERS).not.toContain("src/mcp-json.ts" as never);
  });

  it("detects equivalent delegation syntax rather than only today's spellings", () => {
    const variants = [
      `const first = result.content.at(0); return JSON.parse(first.text);`,
      `const callbacks = new Map(); const server = { registerTool(name, config, fn) { callbacks.set(name, fn); } };`,
      `const handlers = new Map(); const server = { registerTool: (name, cfg, cb) => handlers.set(name, cb) }; const delegated = handlers.get(tool); return delegated(args);`,
      `const delegated = callbackMap.get(tool); const result = await delegated(args); const [first] = result.content; return first.text;`,
    ];
    for (const source of variants) {
      expect(usesInternalMcpDelegation("src/tools/new-consumer.ts", source), source).toBe(true);
    }
  });
});
