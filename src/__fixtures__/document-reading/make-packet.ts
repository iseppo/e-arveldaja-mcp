// Synthetic packet fixtures for the P1 reading-checker tests. No corpus text.
import {
  buildReadingPacket,
  type PacketBuildInput,
  type PacketSourceItem,
  type PacketSourcePage,
  type ReadingPacket,
} from "../../document-reading-packet.js";

export const FIXTURE_SHA = "a".repeat(64);
export const FIXTURE_PARSER = "liteparse-test-1";

export interface FixturePageMeta extends Partial<Omit<PacketSourcePage, "pageNum" | "text">> {
  /** Extra items on the page (by default every line is one native item). */
  extraItems?: PacketSourceItem[];
}

/** Build the parser input: `lines` is one page, or an array of pages. */
export function makePacketInput(
  lines: string[] | string[][],
  pageMeta?: FixturePageMeta | FixturePageMeta[],
  overrides?: Partial<PacketBuildInput>,
): PacketBuildInput {
  const pages = (Array.isArray(lines[0]) ? lines : [lines]) as string[][];
  const metas = Array.isArray(pageMeta) ? pageMeta : pages.map(() => pageMeta ?? {});
  const sourcePages: PacketSourcePage[] = pages.map((pageLines, index) => {
    const meta = metas[index] ?? {};
    const items = meta.items ?? pageLines.map((text) => ({ text, ocr: false }));
    return {
      pageNum: index + 1,
      text: pageLines.join("\n"),
      items: [...items, ...(meta.extraItems ?? [])],
      fullPageImage: meta.fullPageImage ?? false,
      reasons: meta.reasons ?? [],
      isGarbled: meta.isGarbled ?? false,
    };
  });
  return {
    sourceSha256: FIXTURE_SHA,
    parserVersion: FIXTURE_PARSER,
    pages: sourcePages,
    totalPages: sourcePages.length,
    pageErrors: [],
    parseConfig: { maxPagesSet: false, targetPagesSet: false },
    ...overrides,
  };
}

export function makePacket(
  lines: string[] | string[][],
  pageMeta?: FixturePageMeta | FixturePageMeta[],
  overrides?: Partial<PacketBuildInput>,
): ReadingPacket {
  return buildReadingPacket(makePacketInput(lines, pageMeta, overrides));
}
