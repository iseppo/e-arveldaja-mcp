// P2 §4 C reading replay input: the frozen packet files with only `packet` rebuilt by the current builder from the
// frozen parse (cached-parser.ts), so the packet holds include C1's text_layer_value_lost. The heuristic view stays
// frozen. Every rebuilt packet must keep the frozen packet digest (same text); a mismatch refuses.
//
// Usage: npx tsx --import ./scripts/reading-p2/register.mjs scripts/reading-p2/repacket.ts --out <dir>
//   → <dir>/<id>.json for every corpus and held-out document; prints the packet-hold changes.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "../../src/document-parser.js";
import { buildReadingPacket } from "../../src/document-reading-packet.js";
import { packetInputFromParse } from "../../src/tools/document-text-hazards.js";
import { PARSER_VERSION, type PacketFile } from "../reading-p1/build-packets.js";
import { SCOPES, argValue, dataPath, manifest, readJson, sha256Hex, writeJson } from "../reading-p1/common.js";

if (process.argv[1]?.endsWith("/repacket.ts")) {
  const out = argValue(process.argv.slice(2), "--out");
  if (!out) throw new Error("--out <dir> required");
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const changes: string[] = [];
  for (const scope of SCOPES) for (const entry of manifest(scope)) {
    const frozen = readJson<PacketFile>(dataPath("packets", `${entry.id}.json`));
    const parsed = await parseDocument(entry.path);
    const packet = buildReadingPacket(packetInputFromParse(parsed, sha256Hex(readFileSync(entry.path)), PARSER_VERSION));
    if (packet.packet_digest !== frozen.packet.packet_digest) throw new Error(`${entry.id}: packet digest changed`);
    const before = frozen.packet.holds.map((hold) => hold.code).join(",");
    const after = packet.holds.map((hold) => hold.code).join(",");
    if (before !== after) changes.push(`${entry.id}: [${before}] → [${after}]`);
    writeJson(join(out, `${entry.id}.json`), { ...frozen, packet });
  }
  process.stdout.write(`${changes.length ? changes.join("\n") : "no packet-hold change"}\n`);
}
