import { describe, expect, it } from "vitest";
import {
  PROMPT_SURFACE_LIMIT,
  renderPromptSurface,
} from "./prompt-surface.js";
import {
  parseJsonObject,
  PROMPT_ARGUMENT_LIMITS,
} from "./prompt-arguments.js";

const MALFORMED_DATA_ERROR = "Prompt surface data must be canonical JSON";
const EXPECTED_SURFACE_DATA_LIMITS = {
  depth: 16,
  nodes: 4_096,
  keysPerObject: PROMPT_ARGUMENT_LIMITS.jsonKeysPerObject,
} as const;

describe("renderPromptSurface", () => {
  it("uses compact recursively sorted JSON inside a fresh matching nonce pair", () => {
    const first = renderPromptSurface("Trusted workflow body.", {
      derived: { zeta: 2, alpha: { zulu: true, able: false } },
      arguments: { z: "last", a: "first" },
    });
    const second = renderPromptSurface("Trusted workflow body.", {
      derived: { zeta: 2, alpha: { zulu: true, able: false } },
      arguments: { z: "last", a: "first" },
    });
    const boundary = /<<<E_ARVELDAJA_RUN_DATA:([A-Za-z0-9_-]{43})>>>\n([^\n]+)\n<<<END_E_ARVELDAJA_RUN_DATA:\1>>>/;
    const firstMatch = boundary.exec(first);
    const secondMatch = boundary.exec(second);

    expect(firstMatch).not.toBeNull();
    expect(secondMatch).not.toBeNull();
    expect(first.match(/<<<E_ARVELDAJA_RUN_DATA:[A-Za-z0-9_-]{43}>>>/g)).toHaveLength(1);
    expect(second.match(/<<<E_ARVELDAJA_RUN_DATA:[A-Za-z0-9_-]{43}>>>/g)).toHaveLength(1);
    expect(first.match(new RegExp(`<<<END_E_ARVELDAJA_RUN_DATA:${firstMatch![1]}>>>`, "g"))).toHaveLength(1);
    expect(second.match(new RegExp(`<<<END_E_ARVELDAJA_RUN_DATA:${secondMatch![1]}>>>`, "g"))).toHaveLength(1);
    expect(firstMatch![2]).toBe('{"arguments":{"a":"first","z":"last"},"derived":{"alpha":{"able":false,"zulu":true},"zeta":2}}');
    expect(firstMatch![1]).not.toBe(secondMatch![1]);
  });

  it("accepts exactly 64,000 characters and rejects 64,001", () => {
    const empty = renderPromptSurface("", { filler: "" });
    const exactFillerLength = PROMPT_SURFACE_LIMIT - empty.length;

    const exact = renderPromptSurface("", { filler: "x".repeat(exactFillerLength) });
    expect(exact).toHaveLength(PROMPT_SURFACE_LIMIT);
    expect(() => renderPromptSurface("", {
      filler: "x".repeat(exactFillerLength + 1),
    })).toThrow("Prompt surface exceeds the maximum length");
  });

  it("rejects non-JSON run data instead of rendering ambiguous values", () => {
    expect(() => renderPromptSurface("Trusted workflow body.", {
      arguments: { amount: Number.POSITIVE_INFINITY },
      derived: {},
    })).toThrow("Prompt surface data must be canonical JSON");
  });

  it("rejects cycles with the static error instead of overflowing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => renderPromptSurface("Trusted workflow body.", cyclic)).toThrow(MALFORMED_DATA_ERROR);
  });

  it("renders parser-valid JSON objects at the exact argument depth and node limits", () => {
    let deepest: Record<string, unknown> = { value: 1 };
    for (let depth = 1; depth < PROMPT_ARGUMENT_LIMITS.jsonDepth; depth += 1) {
      deepest = { nested: deepest };
    }
    const maxDepth = parseJsonObject(JSON.stringify(deepest));
    const maxNodeSource = JSON.stringify({
      items: Array.from(
        { length: PROMPT_ARGUMENT_LIMITS.jsonNodes - 2 },
        () => null,
      ),
    });
    const maxNodesFirst = parseJsonObject(maxNodeSource);
    const maxNodesSecond = parseJsonObject(maxNodeSource);

    expect(() => renderPromptSurface("Trusted workflow body.", {
      arguments: {
        max_depth_json: maxDepth,
        max_nodes_json: maxNodesFirst,
        second_max_nodes_json: maxNodesSecond,
      },
      derived: {},
    })).not.toThrow();
  });

  it("enforces depth, node, and per-object key limits", () => {
    const tooDeep: Record<string, unknown> = {};
    let cursor = tooDeep;
    for (let index = 0; index < EXPECTED_SURFACE_DATA_LIMITS.depth; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const tooManyNodes = {
      items: Array.from({ length: EXPECTED_SURFACE_DATA_LIMITS.nodes }, () => null),
    };
    const tooManyKeys = Object.fromEntries(
      Array.from(
        { length: EXPECTED_SURFACE_DATA_LIMITS.keysPerObject + 1 },
        (_, index) => [`key_${index}`, index],
      ),
    );

    for (const malformed of [tooDeep, tooManyNodes, tooManyKeys]) {
      expect(() => renderPromptSurface("Trusted workflow body.", malformed)).toThrow(MALFORMED_DATA_ERROR);
    }
  });

  it("rejects unsafe keys, custom prototypes, and Date instances", () => {
    const unsafeObjects = [
      JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>,
      { constructor: "not-safe" },
      { prototype: "not-safe" },
      Object.create({ inherited: true }) as Record<string, unknown>,
      { date: new Date("2026-07-19T00:00:00.000Z") },
    ];

    for (const malformed of unsafeObjects) {
      expect(() => renderPromptSurface("Trusted workflow body.", malformed)).toThrow(MALFORMED_DATA_ERROR);
    }
  });

  it("rejects accessors without invoking getters or setters", () => {
    let getterRuns = 0;
    let setterRuns = 0;
    const accessorData: Record<string, unknown> = {};
    Object.defineProperty(accessorData, "getter", {
      enumerable: true,
      get: () => {
        getterRuns += 1;
        return "secret";
      },
    });
    Object.defineProperty(accessorData, "setter", {
      enumerable: true,
      set: () => {
        setterRuns += 1;
      },
    });
    const emptyAccessor: Record<string, unknown> = {};
    Object.defineProperty(emptyAccessor, "still_an_accessor", {
      enumerable: true,
      get: undefined,
      set: undefined,
    });

    expect(() => renderPromptSurface("Trusted workflow body.", accessorData)).toThrow(MALFORMED_DATA_ERROR);
    expect(() => renderPromptSurface("Trusted workflow body.", emptyAccessor)).toThrow(MALFORMED_DATA_ERROR);
    expect(getterRuns).toBe(0);
    expect(setterRuns).toBe(0);
  });
});
