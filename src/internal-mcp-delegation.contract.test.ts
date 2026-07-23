import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve("src");

const ALLOWED_PRODUCTION_CONSUMERS = [
  "src/tools/accounting-inbox-autopilot-service.ts",
  "src/tools/accounting-inbox.ts",
  "src/tools/bank-reconciliation.ts",
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
  type AstNode = { type: string; [key: string]: unknown };
  type AliasFact = { target: string; source: string };
  type RetrievalFact = { bindings: string[]; registry: string };
  type CallFact = { binding?: string; registry?: string };
  type ResultFact = { target: string; call: CallFact };
  type ContentSourceFact = { alias: string; owner: string };
  type ContentCallSourceFact = { alias: string; call: CallFact };

  let directDetected = false;
  const registrySeeds = new Set<string>();
  const aliasFacts: AliasFact[] = [];
  const retrievalFacts: RetrievalFact[] = [];
  const invocationFacts: CallFact[] = [];
  const resultFacts: ResultFact[] = [];
  const contentSourceFacts: ContentSourceFact[] = [];
  const contentCallSourceFacts: ContentCallSourceFact[] = [];
  const contentFirstOwners = new Set<string>();
  const contentFirstAliases = new Set<string>();
  const contentFirstCalls: CallFact[] = [];

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
  const callFromExpression = (node: unknown): AstNode | undefined => {
    let expression = unwrapExpression(node);
    if (expression?.type === "AwaitExpression") expression = unwrapExpression(expression.argument);
    return expression && isCall(expression) ? expression : undefined;
  };
  const describeCall = (node: unknown): CallFact | undefined => {
    const call = callFromExpression(node);
    if (!call) return undefined;
    const callee = unwrapExpression(call.callee);
    if (!callee) return undefined;
    if (callee.type === "Identifier") return { binding: callee.name as string };
    if (isMember(callee) && ["call", "apply"].includes(staticPropertyName(callee.property) ?? "")) {
      const receiver = unwrapExpression(callee.object);
      return {
        ...(expressionKey(receiver) ? { binding: expressionKey(receiver) } : {}),
        ...(calledMethodReceiver(receiver, "get") ?? accessedRegistry(receiver)
          ? { registry: calledMethodReceiver(receiver, "get") ?? accessedRegistry(receiver) }
          : {}),
      };
    }
    const directRegistry = calledMethodReceiver(callee, "get")
      ?? (isMember(callee) && callee.computed === true ? expressionKey(callee.object) : undefined);
    return {
      ...(expressionKey(callee) ? { binding: expressionKey(callee) } : {}),
      ...(directRegistry ? { registry: directRegistry } : {}),
    };
  };
  const recordContentFirst = (node: AstNode): void => {
    let contentExpression: AstNode | undefined;
    let alias: string | undefined;

    if (isMember(node) && node.computed === true && isNumericZero(node.property)) {
      contentExpression = unwrapExpression(node.object);
    } else if (isCall(node) && isMember(node.callee)) {
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      if (staticPropertyName(node.callee.property) === "at" && isNumericZero(args[0])) {
        contentExpression = unwrapExpression(node.callee.object);
      }
    } else if (node.type === "VariableDeclarator" && isNode(node.id) && node.id.type === "ArrayPattern") {
      contentExpression = unwrapExpression(node.init);
    }

    if (!contentExpression) return;
    if (isContentAccess(contentExpression)) {
      const owner = expressionKey(contentExpression.object);
      const ownerCall = describeCall(contentExpression.object);
      if (owner) contentFirstOwners.add(owner);
      else if (ownerCall) contentFirstCalls.push(ownerCall);
      return;
    }
    alias = expressionKey(contentExpression);
    if (alias) contentFirstAliases.add(alias);
  };

  const visit = (node: AstNode): void => {
    if (relativePath !== "src/mcp-json.ts" && node.type === "Identifier" && node.name === "parseMcpResponse") {
      directDetected = true;
    }
    if ((node.type === "ObjectMethod" || node.type === "ClassMethod") && staticPropertyName(node.key) === "registerTool") {
      directDetected = true;
    }
    if (
      (node.type === "ObjectProperty" || node.type === "ClassProperty")
      && staticPropertyName(node.key) === "registerTool"
      && isNode(node.value)
      && (node.value.type === "ArrowFunctionExpression" || node.value.type === "FunctionExpression")
    ) {
      directDetected = true;
    }

    const storedMap = calledMethodReceiver(node, "set");
    if (storedMap) registrySeeds.add(storedMap);
    for (const method of ["push", "unshift"]) {
      const storedArray = calledMethodReceiver(node, method);
      if (storedArray) registrySeeds.add(storedArray);
    }

    if (node.type === "AssignmentExpression" && isMember(node.left)) {
      const registry = expressionKey(node.left.object);
      if (registry) registrySeeds.add(registry);
    }

    if (node.type === "AssignmentExpression") {
      const targets = bindingNames(node.left);
      const sourceKey = expressionKey(node.right);
      if (sourceKey) {
        for (const target of targets) aliasFacts.push({ target, source: sourceKey });
      }
      const retrievedRegistry = calledMethodReceiver(node.right, "get") ?? accessedRegistry(node.right);
      if (retrievedRegistry && targets.length > 0) retrievalFacts.push({ bindings: targets, registry: retrievedRegistry });
      const call = describeCall(node.right);
      if (call) {
        for (const target of targets) resultFacts.push({ target, call });
      }
      if (isContentAccess(node.right)) {
        const owner = expressionKey((unwrapExpression(node.right) as AstNode).object);
        const ownerCall = describeCall((unwrapExpression(node.right) as AstNode).object);
        for (const alias of targets) {
          if (owner) contentSourceFacts.push({ alias, owner });
          else if (ownerCall) contentCallSourceFacts.push({ alias, call: ownerCall });
        }
      }
    }

    if (node.type === "VariableDeclarator") {
      const binding = identifierName(node.id);
      const names = bindingNames(node.id);
      const sourceKey = expressionKey(node.init);
      if (binding && sourceKey) aliasFacts.push({ target: binding, source: sourceKey });
      const retrievedRegistry = calledMethodReceiver(node.init, "get") ?? accessedRegistry(node.init);
      if (retrievedRegistry && names.length > 0) retrievalFacts.push({ bindings: names, registry: retrievedRegistry });

      const initializer = unwrapExpression(node.init);
      if (
        binding
        && initializer
        && (
          (initializer.type === "ObjectExpression" && Array.isArray(initializer.properties) && initializer.properties.length > 0)
          || (initializer.type === "ArrayExpression" && Array.isArray(initializer.elements) && initializer.elements.length > 0)
        )
      ) {
        registrySeeds.add(binding);
      }

      if (isNode(node.id) && (node.id.type === "ArrayPattern" || node.id.type === "ObjectPattern")) {
        const sourceRegistry = expressionKey(node.init);
        if (sourceRegistry) retrievalFacts.push({ bindings: names, registry: sourceRegistry });
      }

      const call = describeCall(node.init);
      if (call && binding) resultFacts.push({ target: binding, call });

      if (binding && isContentAccess(node.init)) {
        const contentAccess = unwrapExpression(node.init)!;
        const owner = expressionKey(contentAccess.object);
        const ownerCall = describeCall(contentAccess.object);
        if (owner) contentSourceFacts.push({ alias: binding, owner });
        else if (ownerCall) contentCallSourceFacts.push({ alias: binding, call: ownerCall });
      }

      if (isNode(node.id) && node.id.type === "ObjectPattern") {
        const properties = Array.isArray(node.id.properties) ? node.id.properties : [];
        for (const property of properties) {
          if (isNode(property) && property.type === "ObjectProperty" && staticPropertyName(property.key) === "content") {
            const owner = expressionKey(node.init);
            const ownerCall = describeCall(node.init);
            if (isNode(property.value) && property.value.type === "ArrayPattern") {
              if (owner) contentFirstOwners.add(owner);
              else if (ownerCall) contentFirstCalls.push(ownerCall);
            } else {
              for (const alias of bindingNames(property.value)) {
                if (owner) contentSourceFacts.push({ alias, owner });
                else if (ownerCall) contentCallSourceFacts.push({ alias, call: ownerCall });
              }
            }
          }
        }
      }
    }

    if (isCall(node)) {
      const call = describeCall(node);
      if (call) invocationFacts.push(call);
    }

    recordContentFirst(node);

    for (const value of Object.values(node)) {
      if (isNode(value)) visit(value);
      else if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) visit(child);
      }
    }
  };
  visit(ast.program as unknown as AstNode);

  const registries = new Set(registrySeeds);
  const handlers = new Set<string>();
  const handlerResults = new Set<string>();
  const contentAliases = new Set<string>();
  const add = (set: Set<string>, value: string | undefined): boolean => {
    if (!value || set.has(value)) return false;
    set.add(value);
    return true;
  };
  const callHasHandlerProvenance = (call: CallFact): boolean =>
    (call.binding !== undefined && handlers.has(call.binding))
    || (call.registry !== undefined && registries.has(call.registry));

  let changed: boolean;
  do {
    changed = false;
    for (const fact of aliasFacts) {
      if (registries.has(fact.source)) changed = add(registries, fact.target) || changed;
      if (handlers.has(fact.source)) changed = add(handlers, fact.target) || changed;
      if (handlerResults.has(fact.source)) changed = add(handlerResults, fact.target) || changed;
      if (contentAliases.has(fact.source)) changed = add(contentAliases, fact.target) || changed;
    }
    for (const fact of retrievalFacts) {
      if (!registries.has(fact.registry)) continue;
      for (const binding of fact.bindings) changed = add(handlers, binding) || changed;
    }
    for (const fact of resultFacts) {
      if (callHasHandlerProvenance(fact.call)) changed = add(handlerResults, fact.target) || changed;
    }
    for (const fact of contentSourceFacts) {
      if (handlerResults.has(fact.owner)) changed = add(contentAliases, fact.alias) || changed;
    }
    for (const fact of contentCallSourceFacts) {
      if (callHasHandlerProvenance(fact.call)) changed = add(contentAliases, fact.alias) || changed;
    }
  } while (changed);

  if (directDetected) return true;
  if (invocationFacts.some(callHasHandlerProvenance)) return true;
  if ([...contentFirstOwners].some(owner => handlerResults.has(owner))) return true;
  if ([...contentFirstAliases].some(alias => contentAliases.has(alias))) return true;
  return contentFirstCalls.some(callHasHandlerProvenance);
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
  it("allows exactly the four current production consumers and no new ones", async () => {
    expect(await currentProductionConsumers()).toEqual(ALLOWED_PRODUCTION_CONSUMERS);
  });

  it("keeps the parser definition isolated from the production allowlist", async () => {
    const parser = await readFile(resolve("src/mcp-json.ts"), "utf8");
    expect(parser).toContain("export function parseMcpResponse");
    expect(ALLOWED_PRODUCTION_CONSUMERS).not.toContain("src/mcp-json.ts" as never);
  });

  it("detects equivalent delegation syntax rather than only today's spellings", () => {
    const variants = [
      `const callbacks = new Map(); callbacks.set(tool, handler); const delegated = callbacks.get(tool); const result = await delegated(args); const first = result.content.at(0); return JSON.parse(first.text);`,
      `const callbacks = new Map(); const server = { registerTool(name, config, fn) { callbacks.set(name, fn); } };`,
      `const handlers = new Map(); const server = { registerTool: (name, cfg, cb) => handlers.set(name, cb) }; const delegated = handlers.get(tool); return delegated(args);`,
      `const callbackMap = new Map(); callbackMap.set(tool, handler); const delegated = callbackMap.get(tool); const result = await delegated(args); const [first] = result.content; return first.text;`,
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
    const capturedResult = (body: string): string => `
      const handlers = new Map();
      handlers.set(tool, callback);
      const delegated = handlers.get(tool);
      ${body}
    `;
    const variants = [
      capturedResult(`const result = await delegated(args); const blocks = result.content; const first = blocks[0]; return first.text;`),
      capturedResult(`const result = await delegated(args); const { content: blocks } = result; return blocks.at(0)?.text;`),
      capturedResult(`const result = await delegated(args); const { content } = result; const [first] = content; return first.text;`),
      capturedResult(`const result = await delegated(args); return result["content"][0]["text"];`),
      capturedResult(`const result = await delegated(args); const blocks = result.content; const alias = blocks; return alias["0"]["text"];`),
      capturedResult(`const result = await delegated(args); let blocks; blocks = result["content"]; return blocks.at(0)?.text;`),
      capturedResult(`const { content: [first] } = await delegated(args); return first.text;`),
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

  it("converges handler, registry, and result provenance across aliases and assignments", () => {
    const cases = [
      {
        name: "handler alias chain",
        expected: true,
        source: `
          const handlers = new Map();
          handlers.set(name, callback);
          const handler = handlers.get(tool);
          const handlerAlias = handler;
          return handlerAlias(args);
        `,
      },
      {
        name: "assignment-based handler retrieval",
        expected: true,
        source: `
          const handlers = new Map();
          handlers.set(name, callback);
          let handler;
          handler = handlers.get(tool);
          return handler(args);
        `,
      },
      {
        name: "registry alias chain",
        expected: true,
        source: `
          const handlers = new Map();
          handlers.set(name, callback);
          const registryAlias = handlers;
          const secondAlias = registryAlias;
          const handler = secondAlias.get(tool);
          return handler(args);
        `,
      },
      {
        name: "ordinary article content",
        expected: false,
        source: `const article = { content: ["intro"] }; return article.content[0];`,
      },
    ];

    for (const testCase of cases) {
      expect.soft(
        usesInternalMcpDelegation("src/tools/provenance-case.ts", testCase.source),
        testCase.name,
      ).toBe(testCase.expected);
    }
  });
});
