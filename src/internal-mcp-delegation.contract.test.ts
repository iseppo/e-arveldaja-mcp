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
  const registriesWithStoredHandlers = new Set<string>();
  const retrievedHandlerBindings = new Map<string, string>();
  const invokedBindings = new Set<string>();
  const directlyInvokedRegistries = new Set<string>();
  const contentAliases = new Set<string>();

  type AstNode = { type: string; [key: string]: unknown };
  const isNode = (value: unknown): value is AstNode =>
    typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
  const identifierName = (node: unknown): string | undefined =>
    isNode(node) && node.type === "Identifier" ? node.name as string : undefined;
  const staticPropertyName = (node: unknown): string | undefined => {
    if (!isNode(node)) return undefined;
    if (node.type === "Identifier") return node.name as string;
    if (node.type === "StringLiteral" || node.type === "Literal") {
      return typeof node.value === "string" ? node.value : undefined;
    }
    return undefined;
  };
  const unwrapExpression = (node: unknown): AstNode | undefined => {
    let current = isNode(node) ? node : undefined;
    while (
      current
      && ["TSAsExpression", "TSTypeAssertion", "TSNonNullExpression", "TSInstantiationExpression"].includes(current.type)
    ) {
      current = isNode(current.expression) ? current.expression : undefined;
    }
    return current;
  };
  const isMember = (node: unknown): node is AstNode =>
    isNode(node) && (node.type === "MemberExpression" || node.type === "OptionalMemberExpression");
  const expressionKey = (node: unknown): string | undefined => {
    const expression = unwrapExpression(node);
    if (!expression) return undefined;
    if (expression.type === "Identifier") return expression.name as string;
    if (expression.type === "ThisExpression") return "this";
    if (!isMember(expression)) return undefined;
    const object = expressionKey(expression.object);
    const property = staticPropertyName(expression.property);
    return object && property ? `${object}.${property}` : undefined;
  };
  const isCall = (node: unknown): node is AstNode =>
    isNode(node) && (node.type === "CallExpression" || node.type === "OptionalCallExpression");
  const calledMethodReceiver = (node: unknown, method: string): string | undefined => {
    const call = unwrapExpression(node);
    if (!call || !isCall(call)) return undefined;
    const callee = unwrapExpression(call.callee);
    if (!callee || !isMember(callee) || staticPropertyName(callee.property) !== method) return undefined;
    return expressionKey(callee.object);
  };
  const accessedRegistry = (node: unknown): string | undefined => {
    const expression = unwrapExpression(node);
    return expression && isMember(expression) ? expressionKey(expression.object) : undefined;
  };
  const bindingNames = (node: unknown): string[] => {
    const pattern = unwrapExpression(node);
    if (!pattern) return [];
    if (pattern.type === "Identifier") return [pattern.name as string];
    if (pattern.type === "AssignmentPattern" || pattern.type === "RestElement") {
      return bindingNames(pattern.left ?? pattern.argument);
    }
    if (pattern.type === "ObjectProperty") return bindingNames(pattern.value);
    if (pattern.type === "ArrayPattern") {
      return (Array.isArray(pattern.elements) ? pattern.elements : []).flatMap(bindingNames);
    }
    if (pattern.type === "ObjectPattern") {
      return (Array.isArray(pattern.properties) ? pattern.properties : []).flatMap(bindingNames);
    }
    return [];
  };
  const isContentAccess = (node: unknown): boolean =>
    isMember(node) && staticPropertyName(node.property) === "content";
  const isNumericZero = (node: unknown): boolean =>
    isNode(node) && (
      (node.type === "NumericLiteral" && node.value === 0)
      || ((node.type === "StringLiteral" || node.type === "Literal") && (node.value === 0 || node.value === "0"))
    );
  const readsFirstContentItem = (node: AstNode): boolean => {
    if (isMember(node) && node.computed === true) {
      const receiver = expressionKey(node.object);
      return isNumericZero(node.property) && (isContentAccess(node.object) || (receiver !== undefined && contentAliases.has(receiver)));
    }
    if ((node.type === "CallExpression" || node.type === "OptionalCallExpression") && isMember(node.callee)) {
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      const receiver = expressionKey(node.callee.object);
      return staticPropertyName(node.callee.property) === "at"
        && isNumericZero(args[0])
        && (isContentAccess(node.callee.object) || (receiver !== undefined && contentAliases.has(receiver)));
    }
    return node.type === "VariableDeclarator"
      && isNode(node.id)
      && node.id.type === "ArrayPattern"
      && (isContentAccess(node.init) || contentAliases.has(expressionKey(node.init) ?? ""));
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
    const storedMap = calledMethodReceiver(node, "set");
    if (storedMap) registriesWithStoredHandlers.add(storedMap);
    for (const method of ["push", "unshift"]) {
      const storedArray = calledMethodReceiver(node, method);
      if (storedArray) registriesWithStoredHandlers.add(storedArray);
    }

    if (node.type === "AssignmentExpression" && isMember(node.left)) {
      const registry = expressionKey(node.left.object);
      if (registry) registriesWithStoredHandlers.add(registry);
    }
    if (node.type === "AssignmentExpression") {
      const alias = identifierName(node.left);
      const source = expressionKey(node.right);
      if (alias && (isContentAccess(node.right) || (source !== undefined && contentAliases.has(source)))) {
        contentAliases.add(alias);
      }
    }

    if (node.type === "VariableDeclarator") {
      const binding = identifierName(node.id);
      const retrievedMap = calledMethodReceiver(node.init, "get");
      if (binding && retrievedMap) retrievedHandlerBindings.set(binding, retrievedMap);
      const initializer = unwrapExpression(node.init);
      if (
        binding
        && initializer
        && (
          (initializer.type === "ObjectExpression" && Array.isArray(initializer.properties) && initializer.properties.length > 0)
          || (initializer.type === "ArrayExpression" && Array.isArray(initializer.elements) && initializer.elements.length > 0)
        )
      ) {
        registriesWithStoredHandlers.add(binding);
      }
      const accessed = accessedRegistry(node.init);
      if (accessed) {
        for (const name of bindingNames(node.id)) retrievedHandlerBindings.set(name, accessed);
      }
      if (isNode(node.id) && (node.id.type === "ArrayPattern" || node.id.type === "ObjectPattern")) {
        const sourceRegistry = expressionKey(node.init);
        if (sourceRegistry) {
          for (const name of bindingNames(node.id)) retrievedHandlerBindings.set(name, sourceRegistry);
        }
      }
      const initializerKey = expressionKey(node.init);
      if (binding && (isContentAccess(node.init) || (initializerKey !== undefined && contentAliases.has(initializerKey)))) {
        contentAliases.add(binding);
      }
      if (isNode(node.id) && node.id.type === "ObjectPattern") {
        const properties = Array.isArray(node.id.properties) ? node.id.properties : [];
        for (const property of properties) {
          if (isNode(property) && property.type === "ObjectProperty" && staticPropertyName(property.key) === "content") {
            if (isNode(property.value) && property.value.type === "ArrayPattern") {
              detected = true;
              return;
            }
            for (const name of bindingNames(property.value)) contentAliases.add(name);
          }
        }
      }
    }

    if (isCall(node)) {
      const callee = unwrapExpression(node.callee);
      let binding = identifierName(callee);
      if (
        !binding
        && callee
        && isMember(callee)
        && ["call", "apply"].includes(staticPropertyName(callee.property) ?? "")
      ) {
        binding = identifierName(unwrapExpression(callee.object));
        const directlyInvokedMap = calledMethodReceiver(callee.object, "get");
        if (directlyInvokedMap) directlyInvokedRegistries.add(directlyInvokedMap);
        const directlyInvokedRegistry = accessedRegistry(callee.object);
        if (directlyInvokedRegistry) directlyInvokedRegistries.add(directlyInvokedRegistry);
      }
      if (binding) invokedBindings.add(binding);
      const directlyInvokedMap = calledMethodReceiver(callee, "get");
      if (directlyInvokedMap) directlyInvokedRegistries.add(directlyInvokedMap);
      if (callee && isMember(callee) && callee.computed === true) {
        const directlyInvokedRegistry = expressionKey(callee.object);
        if (directlyInvokedRegistry) directlyInvokedRegistries.add(directlyInvokedRegistry);
      }
    }
    for (const value of Object.values(node)) {
      if (isNode(value)) visit(value);
      else if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) visit(child);
      }
    }
  };
  visit(ast.program as unknown as AstNode);
  if (detected) return true;
  for (const [binding, registry] of retrievedHandlerBindings) {
    if (invokedBindings.has(binding) && registriesWithStoredHandlers.has(registry)) return true;
  }
  for (const registry of directlyInvokedRegistries) {
    if (registriesWithStoredHandlers.has(registry)) return true;
  }
  return false;
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

  it("detects map-backed captured handler registration and invocation without serialized-result reads", () => {
    const variants = [
      `
        const handlers = new Map();
        function registerCapturedTool(name, config, cb) { handlers.set(name, cb); }
        const handler = handlers.get(tool);
        return handler(args);
      `,
      `
        const dispatchTable = new Map();
        const bindHiddenAction = (key, callback) => { dispatchTable.set(key, callback); };
        const selectedAction = dispatchTable.get(requestedAction);
        return await selectedAction(payload);
      `,
      `
        const routes = new Map();
        function retainRoute(routeName, implementation) {
          routes.set(routeName, implementation as unknown as (input: unknown) => unknown);
        }
        async function invokeRoute(routeName, input) {
          const implementation = routes.get(routeName);
          return implementation?.(input);
        }
      `,
      `
        const registry = new Map();
        const retain = (key, fn) => registry.set(key, fn);
        return registry.get(action)?.(payload);
      `,
      `
        const callbackTable = new Map();
        const capture = (key, fn) => callbackTable["set"](key, fn);
        const chosen = callbackTable["get"](action);
        return chosen.call(undefined, payload);
      `,
    ];
    for (const source of variants) {
      expect(usesInternalMcpDelegation("src/tools/new-consumer.ts", source), source).toBe(true);
    }
  });

  it("detects callable handlers retained in object and array registries", () => {
    const variants = [
      `
        const handlers = Object.create(null);
        handlers[name] = callback;
        const delegated = handlers[requestedTool];
        return delegated(args);
      `,
      `
        const handlers = [];
        handlers.push(callback);
        const delegated = handlers[index];
        return delegated.apply(undefined, [args]);
      `,
      `
        const handlers = { parse: parseHandler };
        return handlers[requestedTool](args);
      `,
      `
        const handlers = [firstHandler, secondHandler];
        const [delegated] = handlers;
        return delegated(args);
      `,
    ];
    for (const source of variants) {
      expect(usesInternalMcpDelegation("src/tools/new-consumer.ts", source), source).toBe(true);
    }
  });

  it("detects destructured, aliased, and computed reads of serialized handler content", () => {
    const variants = [
      `const result = await delegated(args); const blocks = result.content; const first = blocks[0]; return first.text;`,
      `const result = await delegated(args); const { content: blocks } = result; return blocks.at(0)?.text;`,
      `const result = await delegated(args); const { content } = result; const [first] = content; return first.text;`,
      `const result = await delegated(args); return result["content"][0]["text"];`,
      `const result = await delegated(args); const blocks = result.content; const alias = blocks; return alias["0"]["text"];`,
      `const result = await delegated(args); let blocks; blocks = result["content"]; return blocks.at(0)?.text;`,
      `const { content: [first] } = await delegated(args); return first.text;`,
    ];
    for (const source of variants) {
      expect(usesInternalMcpDelegation("src/tools/new-consumer.ts", source), source).toBe(true);
    }
  });

  it("does not classify ordinary data containers or non-invoked callback storage as delegation", () => {
    const controls = [
      `const records = []; records.push({ text: "row" }); const first = records[0]; return first.text;`,
      `const article = { content: ["intro"] }; const { content: sections } = article; return sections.map(render);`,
      `const registry = { current: "daily" }; const chosen = registry[current]; return format(chosen);`,
      `const handlers = {}; handlers[name] = callback; return Object.keys(handlers);`,
    ];
    for (const source of controls) {
      expect(usesInternalMcpDelegation("src/tools/data-only.ts", source), source).toBe(false);
    }
  });
});
