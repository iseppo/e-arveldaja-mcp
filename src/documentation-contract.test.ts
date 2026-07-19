import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { getProjectRoot } from "./paths.js";

/**
 * Documentation contract.
 *
 * These assertions pin the project docs to the SHIPPED prompt architecture
 * delivered by the P01–P25 remediation. They fail if a future edit reverts a
 * doc to a stale claim (e.g. "prompt text lives in src/prompts.ts") or drops
 * one of the load-bearing safety statements the pipeline depends on.
 *
 * Every asserted phrase must describe real behaviour — see
 * `.omc/prompt-remediation-ledger.md` for the evidence trail.
 */

function readDoc(relativePath: string): string {
  return readFileSync(resolve(getProjectRoot(), relativePath), "utf8");
}

const README = () => readDoc("README.md");
const ARCHITECTURE = () => readDoc("ARCHITECTURE.md");
const AGENTS = () => readDoc("AGENTS.md");
const CLAUDE = () => readDoc("CLAUDE.md");
const CHANGELOG = () => readDoc("CHANGELOG.md");

describe("documentation contract: safe prompt pipeline", () => {
  describe("ARCHITECTURE.md describes the real prompt pipeline", () => {
    it("names every stage of the registry → workflow → shared renderer → MCP/command pipeline", () => {
      const doc = ARCHITECTURE();
      // Canonical registry stage.
      expect(doc).toContain("src/prompt-registry.ts");
      // Workflow markdown source + its loader.
      expect(doc).toContain("workflows/");
      expect(doc).toContain("src/workflow-prompt-source.ts");
      // Shared renderer stage.
      expect(doc).toContain("src/prompt-surface.ts");
      // Both output surfaces.
      expect(doc).toContain("MCP prompts");
      expect(doc).toContain(".claude/commands");
      // The pipeline ordering must be stated explicitly.
      expect(doc).toContain(
        "registry → workflow source → shared renderer → MCP prompts and slash commands",
      );
    });

    it("states prompt arguments are strings, not numeric or boolean", () => {
      const doc = ARCHITECTURE();
      expect(doc).toMatch(/prompt argument[s]? (are|is) (a )?string/i);
      expect(doc).toMatch(/not numeric or boolean|never numeric\/boolean|not numbers or booleans/i);
    });

    it("states a plan handle is not user approval", () => {
      expect(ARCHITECTURE()).toMatch(/plan handle is not (user )?approval/i);
    });

    it("documents sales-aware prompt variants", () => {
      expect(ARCHITECTURE()).toMatch(/sales-aware variant|sales variant/i);
    });

    it("documents opaque file references", () => {
      expect(ARCHITECTURE()).toMatch(/opaque file reference/i);
    });

    it("documents staged receipts: create/upload then confirm/link are separate", () => {
      const doc = ARCHITECTURE();
      expect(doc).toMatch(/staged/i);
      expect(doc).toContain("create/upload");
      expect(doc).toContain("confirm");
    });

    it("documents dated VAT/tax metadata", () => {
      expect(ARCHITECTURE()).toMatch(/dated VAT|versioned VAT|dated tax metadata/i);
    });

    it("documents the sync and validation flow", () => {
      const doc = ARCHITECTURE();
      expect(doc).toContain("npm run sync:workflow-prompts");
      expect(doc).toContain("npm run validate:release");
    });
  });

  describe("README.md reflects shipped prompt behaviour", () => {
    it("keeps the exhaustive 16-prompt workflow table the validator requires", () => {
      const doc = README();
      expect(doc).toContain("## Workflows (MCP Prompts)");
      expect(doc).toMatch(/The server includes 16 built-in workflow prompts/);
    });

    it("tells the user a plan handle is not their approval", () => {
      expect(README()).toMatch(/plan handle is not (user )?approval/i);
    });

    it("describes staged receipt creation separate from confirmation", () => {
      expect(README()).toMatch(/staged, not one pass|confirmation is a separate approval step/i);
    });
  });

  describe("AGENTS.md no longer claims prompt text lives in src/prompts.ts", () => {
    it("does not describe src/prompts.ts as the home of workflow prompt text", () => {
      const doc = AGENTS();
      expect(doc).not.toMatch(/`src\/prompts\.ts` contains workflow prompt text/);
    });

    it("points at the canonical registry and workflow source for prompt text", () => {
      const doc = AGENTS();
      expect(doc).toContain("src/prompt-registry.ts");
      expect(doc).toContain("workflows/");
      expect(doc).toContain("src/prompt-surface.ts");
    });
  });

  describe("CLAUDE.md architecture map references the prompt pipeline", () => {
    it("lists the canonical registry and shared renderer modules", () => {
      const doc = CLAUDE();
      expect(doc).toContain("src/prompt-registry.ts");
      expect(doc).toContain("src/prompt-surface.ts");
    });
  });

  describe("CHANGELOG.md records the P01–P25 prompt remediation", () => {
    it("documents the safe prompt pipeline in the 0.22.0 release section", () => {
      const doc = CHANGELOG();
      // The P01–P25 remediation shipped in 0.22.0, so its documentation now
      // lives under that versioned heading (it was under [Unreleased] until the
      // release was cut). A fresh, possibly-empty [Unreleased] section must
      // still exist for the next cycle.
      expect(doc).toContain("## [Unreleased]");
      const start = doc.indexOf("## [0.22.0]");
      expect(start).toBeGreaterThanOrEqual(0);
      const nextRelease = doc.indexOf("\n## [", start + 1);
      const section = doc.slice(start, nextRelease === -1 ? undefined : nextRelease);
      expect(section).toMatch(/prompt/i);
      expect(section).toContain("src/prompt-registry.ts");
      expect(section).toMatch(/plan handle is not (user )?approval/i);
      expect(section).toMatch(/string prompt argument/i);
    });
  });
});
