import { describe, expect, it } from "vitest";
import { validateReleaseMetadata } from "../scripts/validate-release-metadata.mjs";

const validPackage = {
  name: "e-arveldaja-mcp",
  version: "0.11.8",
  mcpName: "io.github.iseppo/e-arveldaja-mcp",
  files: ["dist/", "workflows/", ".claude/commands/", "LICENSE", "README.md", "CLAUDE.md", "CHANGELOG.md", "server.json"],
};

const validLockfile = {
  version: "0.11.8",
  packages: {
    "": {
      version: "0.11.8",
    },
  },
};

const validServer = {
  name: "io.github.iseppo/e-arveldaja-mcp",
  version: "0.11.8",
  packages: [
    {
      registryType: "npm",
      identifier: "e-arveldaja-mcp",
      version: "0.11.8",
    },
  ],
};

describe("validateReleaseMetadata", () => {
  it("accepts matching release metadata", () => {
    expect(validateReleaseMetadata(validPackage, validLockfile, validServer)).toEqual([]);
  });

  it("reports version, mcpName, package identifier, and npm files drift", () => {
    const errors = validateReleaseMetadata(
      {
        ...validPackage,
        version: "0.11.9",
        mcpName: "io.github.iseppo/wrong",
        files: ["dist/", "README.md"],
      },
      validLockfile,
      {
        ...validServer,
        packages: [{ ...validServer.packages[0], identifier: "wrong-package", version: "0.11.7" }],
      },
    );

    expect(errors).toEqual([
      "package-lock.json version (0.11.8) must match package.json version (0.11.9)",
      "package-lock.json packages[\"\"] version (0.11.8) must match package.json version (0.11.9)",
      "server.json name (io.github.iseppo/e-arveldaja-mcp) must match package.json mcpName (io.github.iseppo/wrong)",
      "server.json version (0.11.8) must match package.json version (0.11.9)",
      "server.json packages[0].identifier (wrong-package) must match package.json name (e-arveldaja-mcp)",
      "server.json packages[0].version (0.11.7) must match package.json version (0.11.9)",
      "package.json files must include CHANGELOG.md",
      "package.json files must include server.json",
    ]);
  });
});
