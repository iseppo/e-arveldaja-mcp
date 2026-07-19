import { describe, expect, it, vi } from "vitest";
import {
  PROMPT_NAMES,
  PROMPT_REGISTRY,
  PROMPT_SLUGS,
  enabledPromptDefinitions,
} from "./prompt-registry.js";

const ALL_FEATURES = {
  enableLightyear: true,
  exposeGranularTools: false,
  exposeSetupTools: false,
  enableTaxTools: true,
  enableReferenceAdmin: true,
  enableAnnualReport: true,
  enableSales: true,
  enableProducts: true,
} as const;

describe("canonical prompt registry", () => {
  it("owns the unique prompt names, slugs, schemas, setup options, and variants", () => {
    expect(PROMPT_REGISTRY).toHaveLength(16);
    expect(new Set(PROMPT_NAMES).size).toBe(PROMPT_REGISTRY.length);
    expect(new Set(PROMPT_SLUGS).size).toBe(PROMPT_REGISTRY.length);
    expect(PROMPT_NAMES).toEqual(PROMPT_REGISTRY.map(definition => definition.name));
    expect(PROMPT_SLUGS).toEqual(PROMPT_REGISTRY.map(definition => definition.slug));

    for (const definition of PROMPT_REGISTRY) {
      expect(definition.description.length, definition.name).toBeGreaterThan(0);
      expect(definition).toHaveProperty("argsSchema");
      expect(definition).toHaveProperty("setupOptions");
      expect(definition).toHaveProperty("featurePredicate");
      expect(definition).toHaveProperty("variants");
    }
  });

  it("exports enabled definitions from registry feature predicates", () => {
    expect(enabledPromptDefinitions(ALL_FEATURES).map(definition => definition.name)).toEqual(PROMPT_NAMES);
    expect(enabledPromptDefinitions({ ...ALL_FEATURES, enableTaxTools: false }).map(definition => definition.name))
      .not.toContain("vat-registration-threshold");
    expect(enabledPromptDefinitions({ ...ALL_FEATURES, enableLightyear: false }).map(definition => definition.name))
      .not.toContain("lightyear-booking");

    const defaultNames = enabledPromptDefinitions().map(definition => definition.name);
    expect(defaultNames).toContain("vat-registration-threshold");
    expect(defaultNames).toContain("lightyear-booking");
  });

  it("freezes canonical definitions and their owned metadata without freezing schemas", () => {
    expect(Object.isFrozen(PROMPT_REGISTRY)).toBe(true);
    for (const definition of PROMPT_REGISTRY) {
      expect(Object.isFrozen(definition), definition.name).toBe(true);
      expect(Object.isFrozen(definition.variants), definition.name).toBe(true);
      if (definition.argsSchema) {
        expect(Object.isFrozen(definition.argsSchema), `${definition.name} schema`).toBe(false);
      }
      if (definition.setupOptions) {
        expect(Object.isFrozen(definition.setupOptions), definition.name).toBe(true);
        if (definition.setupOptions.offlineTools) {
          expect(Object.isFrozen(definition.setupOptions.offlineTools), definition.name).toBe(true);
        }
      }
    }

    const originalNames = [...PROMPT_NAMES];
    const first = PROMPT_REGISTRY[0];
    const setup = PROMPT_REGISTRY.find(definition => definition.setupOptions?.offlineTools);
    expect(() => ((PROMPT_REGISTRY as unknown as unknown[]).push({}))).toThrow(TypeError);
    expect(() => Object.assign(first, { name: "diverged-name" })).toThrow(TypeError);
    expect(() => Object.assign(first.setupOptions!, { note: "diverged-note" })).toThrow(TypeError);
    expect(() => ((setup!.setupOptions!.offlineTools as unknown as string[]).push("diverged-tool")))
      .toThrow(TypeError);
    expect(() => ((first.variants as unknown as unknown[]).push({}))).toThrow(TypeError);
    expect(PROMPT_NAMES).toEqual(originalNames);
    expect(PROMPT_NAMES).toEqual(PROMPT_REGISTRY.map(definition => definition.name));
  });

  it("invokes a strict parser once for each accepted argument", async () => {
    vi.resetModules();
    const actual = await vi.importActual<typeof import("./prompt-arguments.js")>("./prompt-arguments.js");
    let parserCalls = 0;
    vi.doMock("./prompt-arguments.js", () => ({
      ...actual,
      parseIdentifier(value: string) {
        parserCalls += 1;
        return actual.parseIdentifier(value);
      },
    }));

    try {
      const isolated = await import("./prompt-registry.js");
      const definition = isolated.PROMPT_REGISTRY.find(entry => entry.name === "new-supplier")!;
      const schema = definition.argsSchema.identifier;
      expect(schema.safeParse("Registry OÜ")).toMatchObject({ success: true, data: "Registry OÜ" });
      expect(parserCalls).toBe(1);
    } finally {
      vi.doUnmock("./prompt-arguments.js");
      vi.resetModules();
    }
  });
});
