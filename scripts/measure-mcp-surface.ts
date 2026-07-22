import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  captureToolSurface,
  TOOL_SURFACE_PROFILES,
  type MeasuredMcpSurface,
  type ToolSurfaceProfileName,
  type ToolSurfaceSnapshot,
} from "../src/__fixtures__/tool-surface.js";

export async function measureMcpSurfaces(): Promise<Record<ToolSurfaceProfileName, ToolSurfaceSnapshot>> {
  const entries = await Promise.all(
    TOOL_SURFACE_PROFILES.map(async (profile) => [profile, await captureToolSurface(profile)] as const),
  );
  return Object.fromEntries(entries) as Record<ToolSurfaceProfileName, ToolSurfaceSnapshot>;
}

function parseOutputPath(argv: string[]): string | undefined {
  const index = argv.indexOf("--output");
  if (index === -1) return undefined;
  const output = argv[index + 1];
  if (!output || output.startsWith("--")) throw new Error("--output requires an explicit path");
  return resolve(output);
}

async function writeSnapshots(
  outputPath: string,
  snapshots: Record<ToolSurfaceProfileName, ToolSurfaceSnapshot>,
): Promise<void> {
  if (extname(outputPath) === ".json") {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(snapshots, null, 2)}\n`, "utf8");
    return;
  }
  await mkdir(outputPath, { recursive: true });
  await Promise.all(TOOL_SURFACE_PROFILES.map((profile) =>
    writeFile(join(outputPath, `${profile}.json`), `${JSON.stringify(snapshots[profile], null, 2)}\n`, "utf8")
  ));
}

async function readBaseline(profile: ToolSurfaceProfileName): Promise<MeasuredMcpSurface | undefined> {
  try {
    const fixture = JSON.parse(await readFile(
      new URL(`../testdata/tool-surface/${profile}.json`, import.meta.url),
      "utf8",
    )) as { measurement?: MeasuredMcpSurface };
    return fixture.measurement;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function signedDelta(current: number, baseline: number | undefined): string {
  if (baseline === undefined) return "baseline unavailable";
  const delta = current - baseline;
  return `${delta >= 0 ? "+" : ""}${delta}`;
}

async function printReport(snapshots: Record<ToolSurfaceProfileName, ToolSurfaceSnapshot>): Promise<void> {
  for (const profile of TOOL_SURFACE_PROFILES) {
    const current = snapshots[profile].measurement;
    const baseline = await readBaseline(profile);
    process.stdout.write(
      `${profile}: tools=${current.toolCount} (${signedDelta(current.toolCount, baseline?.toolCount)}), ` +
      `tools/list=${current.toolsListBytes} B (${signedDelta(current.toolsListBytes, baseline?.toolsListBytes)}), ` +
      `descriptions=${current.descriptionsBytes} B (${signedDelta(current.descriptionsBytes, baseline?.descriptionsBytes)}), ` +
      `schemas=${current.inputSchemasBytes} B (${signedDelta(current.inputSchemasBytes, baseline?.inputSchemasBytes)}), ` +
      `largest=${current.largestTool.name}:${current.largestTool.bytes} B, ` +
      `largest-delta=${signedDelta(current.largestTool.bytes, baseline?.largestTool.bytes)}, ` +
      `instructions=${current.serverInstructionsBytes} B (${signedDelta(current.serverInstructionsBytes, baseline?.serverInstructionsBytes)}), ` +
      `prompts=${current.promptMetadataBytes} B (${signedDelta(current.promptMetadataBytes, baseline?.promptMetadataBytes)}), ` +
      `resources=${current.resourceMetadataBytes} B (${signedDelta(current.resourceMetadataBytes, baseline?.resourceMetadataBytes)})\n`,
    );
  }
}

async function main(): Promise<void> {
  const snapshots = await measureMcpSurfaces();
  const outputPath = parseOutputPath(process.argv.slice(2));
  if (outputPath) await writeSnapshots(outputPath, snapshots);
  await printReport(snapshots);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
