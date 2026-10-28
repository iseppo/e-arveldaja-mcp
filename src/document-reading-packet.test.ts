import { describe, expect, it } from "vitest";
import {
  PACKET_BUILDER_VERSION,
  PACKET_MAX_LINES,
  buildReadingPacket,
  citedTokenOriginHolds,
  computePacketDigest,
  matchOffsets,
  packetLostLeaders,
  normalizeForMatch,
} from "./document-reading-packet.js";
import { FIXTURE_PARSER, FIXTURE_SHA, makePacket, makePacketInput } from "./__fixtures__/document-reading/make-packet.js";

const codes = (packet: { holds: Array<{ code: string }> }) => packet.holds.map((hold) => hold.code);

describe("document-reading packet: line normalisation", () => {
  it("T-PK-blank-line: drops a whitespace-only line instead of turning it into a column mark", () => {
    const packet = makePacket(["Arve nr 17", "   \t  ", "Kokku 44,70"]);
    expect(packet.lines.map((line) => line.text)).toEqual(["Arve nr 17", "Kokku 44,70"]);
    expect(packet.text).not.toContain("¦");
  });

  it("T-PK-column-mark: replaces a run of two or more whitespace characters with ` ¦ `", () => {
    const packet = makePacket(["Arve summa     44,70", "Netto 15,92"]);
    expect(packet.lines[0]!.text).toBe("Arve summa ¦ 44,70");
    expect(packet.lines[1]!.text).toBe("Netto 15,92");
    expect(packet.text.split("\n")[0]).toBe("p1:001 │ Arve summa ¦ 44,70");
  });

  it("T-PK-nbsp: NBSP and U+202F count as whitespace (single → space, run → column mark)", () => {
    const packet = makePacket(["Kokku 44,70", "A  B"]);
    expect(packet.lines[0]!.text).toBe("Kokku 44,70");
    expect(packet.lines[1]!.text).toBe("A ¦ B");
  });

  it("T-PK-marker: strips sandbox markers and maps control characters to a space", () => {
    const packet = makePacket(["<<UNTRUSTED_OCR_START:abcd>>Arve\u0007nr 5<<UNTRUSTED_OCR_END:abcd>>"]);
    expect(packet.lines[0]!.text).toBe("Arve nr 5");
  });

  it("T-PK-numbering: numbers kept lines per page", () => {
    const packet = makePacket([["a", "", "b"], ["c"]]);
    expect(packet.lines.map((line) => line.id)).toEqual(["p1:001", "p1:002", "p2:001"]);
  });
});

describe("document-reading packet: matching", () => {
  it("T-PK-bare-mark: a bare ¦ and a column mark both match as one space", () => {
    expect(normalizeForMatch("Arve¦summa")).toBe("Arve summa");
    expect(normalizeForMatch("  Arve ¦  summa ")).toBe("Arve summa");
    const line = { text: "Arve summa ¦ 44,70" };
    expect(matchOffsets("summa 44,70", line)).toEqual([{ start: 5, end: 18 }]);
    expect(matchOffsets("summa¦44,70", line)).toEqual([{ start: 5, end: 18 }]);
  });

  it("T-PK-match-all: returns every occurrence as spans of line.text", () => {
    expect(matchOffsets("5", { text: "5 x 5" })).toEqual([{ start: 0, end: 1 }, { start: 4, end: 5 }]);
    expect(matchOffsets("  ", { text: "5 x 5" })).toEqual([]);
  });
});

describe("document-reading packet: digest", () => {
  const base = { sourceSha256: FIXTURE_SHA, parserVersion: FIXTURE_PARSER, builderVersion: PACKET_BUILDER_VERSION, text: "p1:001 │ x" };

  it("T-PK-digest: changes with each of its four inputs", () => {
    const digest = computePacketDigest(base);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(computePacketDigest({ ...base, sourceSha256: "b".repeat(64) })).not.toBe(digest);
    expect(computePacketDigest({ ...base, parserVersion: "other" })).not.toBe(digest);
    expect(computePacketDigest({ ...base, builderVersion: "2" })).not.toBe(digest);
    expect(computePacketDigest({ ...base, text: "p1:001 │ y" })).not.toBe(digest);
    // the separator keeps field boundaries apart
    expect(computePacketDigest({ ...base, sourceSha256: "a", parserVersion: "b" }))
      .not.toBe(computePacketDigest({ ...base, sourceSha256: "ab", parserVersion: "" }));
  });

  it("T-PK-digest-packet: the packet carries the digest of its own text", () => {
    const packet = makePacket(["x"]);
    expect(packet.packet_digest).toBe(computePacketDigest({ ...base, text: packet.text }));
  });
});

describe("document-reading packet: holds", () => {
  it("T-PK-clean: a native single-page packet carries no hold", () => {
    expect(codes(makePacket(["Arve 1", "Kokku 5,00"]))).toEqual([]);
  });

  it("T-PK-partial-config: holds partial_parse_config for maxPages or targetPages", () => {
    expect(codes(makePacket(["x"], undefined, { parseConfig: { maxPagesSet: true, targetPagesSet: false } }))).toEqual(["partial_parse_config"]);
    expect(codes(makePacket(["x"], undefined, { parseConfig: { maxPagesSet: false, targetPagesSet: true } }))).toEqual(["partial_parse_config"]);
  });

  it("T-PK-page-count: holds page_count_mismatch", () => {
    expect(codes(makePacket(["x"], undefined, { totalPages: 2 }))).toEqual(["page_count_mismatch"]);
  });

  it("T-PK-page-error: holds page_extraction_failed", () => {
    expect(codes(makePacket(["x"], undefined, { pageErrors: [{ pageNum: 1 }] }))).toEqual(["page_extraction_failed"]);
  });

  it("T-PK-oversize: holds packet_oversize over 24 KiB or over 1500 lines", () => {
    expect(codes(makePacket(["x".repeat(25000)]))).toEqual(["packet_oversize"]);
    const many = Array.from({ length: PACKET_MAX_LINES + 1 }, () => "x");
    expect(codes(makePacket(many))).toEqual(["packet_oversize"]);
    expect(codes(makePacket(many.slice(0, PACKET_MAX_LINES)))).toEqual([]);
  });

  it("T-PK-leader-cell: holds text_layer_value_lost for a leader no amount follows (C1)", () => {
    const holds = (line: string) => expect(codes(makePacket([line])), line).toContain("text_layer_value_lost");
    holds("Arve kuupäev    ....................    Kogusumma (EUR)    13,60 €");
    holds("Arve number    _____");
    holds("Arve number    ·····");
    holds("Arve number    …………………");
    holds("Arve number    ....");
    // Codex r4 counterexamples: single-space label, spaced dots, other leader glyphs.
    holds("Arve kuupäev ....................");
    holds("Arve kuupäev . . . . . . . .");
    holds("Arve kuupäev ••••••••");
    holds("Arve kuupäev ‧‧‧‧‧‧‧‧");
    holds("Arve kuupäev ．．．．．．");
    holds("Arve kuupäev ........ Periood");
    holds("Võttis vastu: .............................................");
  });

  // A signature-line exemption was tried and reverted (Codex r5): a label blacklist cannot prove that a leader
  // hides no payload. Every line below must keep holding on its text. The only exemption is the server's image
  // proof (`blankLeaderLines`, T-PK-blank-leader), which never looks at the label.
  it("T-KILL-signature: signature-label leaders hold, including every known exemption bypass", () => {
    const holds = (lines: string[]) => expect(codes(makePacket(lines)), JSON.stringify(lines)).toContain("text_layer_value_lost");
    // The #15 / #17 shapes: accepted false holds.
    holds(["Arve koostas: PIM i Allkiri ....................................................."]);
    holds(["Arve väljastas: Mart Parve    Võttis vastu: ............................................."]);
    holds(["Received by: ________"]);
    // Owner kill list.
    holds(["Allkiri .... Kuupäev ...."]);
    holds(["Kuupäev / Allkiri ...."]);
    holds(["Allkiri    Kokku ........"]);
    holds(["Allkirjastatud arve kuupäev ...."]);
    holds(["Võttis\u00a0vastu: ........"]);
    holds(["Аllkiri ........"]); // Cyrillic А
    holds(["Kinnitusallkiri ........"]);
    holds(["Allkiri / ........"]);
    // Codex r5 bypasses.
    holds(["Arve kuupäev", "Allkiri ........"]);
    holds(["Kuup. / Allkiri ........"]);
    holds(["Datum / Signature ........"]);
    holds(["Дата / Signature ........"]);
    holds(["Kuu    päev / Allkiri ........"]);
    holds(["Kuu\u200bpäev / Allkiri ........"]);
    holds(["Kuupäеv / Allkiri ........"]); // Cyrillic е
    holds(["Kogusumma / Allkiri ........"]);
    holds(["Vahesumma / Allkiri ........"]);
    holds(["Tasumiseks / Allkiri ........"]);
  });

  it("T-PK-blank-leader: a line the server proved blank does not hold; the others still do; the digest is unchanged", () => {
    const lines = ["Arve kuupäev ........", "Allkiri ........"];
    const plain = buildReadingPacket(makePacketInput(lines));
    expect(packetLostLeaders(plain).map((hit) => hit.line)).toEqual(["p1:001", "p1:002"]);
    const signed = buildReadingPacket(makePacketInput(lines, undefined, { blankLeaderLines: ["p1:002", "p1:002", "p9:001"] }));
    expect(signed.blank_leader_lines).toEqual(["p1:002"]);
    expect(codes(signed)).toContain("text_layer_value_lost");
    expect(packetLostLeaders(signed).map((hit) => hit.line)).toEqual(["p1:001"]);
    expect(signed.packet_digest).toBe(plain.packet_digest);
    const both = buildReadingPacket(makePacketInput(lines, undefined, { blankLeaderLines: ["p1:001", "p1:002"] }));
    expect(codes(both)).not.toContain("text_layer_value_lost");
    expect("blank_leader_lines" in plain).toBe(false);
    expect("blank_leader_lines" in buildReadingPacket(makePacketInput(lines, undefined, { blankLeaderLines: ["p9:001"] }))).toBe(false);
  });

  it("T-PK-leader-in-cell: a leader an amount follows, or 3 leader glyphs, does not hold (C1)", () => {
    const passes = (line: string) => expect(codes(makePacket([line])), line).not.toContain("text_layer_value_lost");
    passes("Total ........ 13,60");
    passes("Total ........13,60");
    passes("Total . . . . . 13,60");
    passes("Allahindlus ........ -5,00");
    passes("Kokku ........ €13,60");
    passes("Arve number    ...");
    passes("Vaata lisa...");
  });

  it("T-PK-ocr-full-page: holds ocr_document for fullPageImage", () => {
    expect(codes(makePacket(["x"], { fullPageImage: true }))).toEqual(["ocr_document"]);
  });

  it("T-PK-ocr-scanned: holds ocr_document for the scanned reason", () => {
    expect(codes(makePacket(["x"], { reasons: ["sparse-text", "scanned"] }))).toEqual(["ocr_document"]);
    expect(codes(makePacket(["x"], { reasons: ["sparse-text", "embedded-images"] }))).toEqual([]);
  });

  it("T-PK-ocr-garbled: holds ocr_document for isGarbled", () => {
    expect(codes(makePacket(["x"], { isGarbled: true }))).toEqual(["ocr_document"]);
  });

  it("T-PK-ocr-majority: holds ocr_document when OCR items are at least the native items", () => {
    expect(codes(makePacket(["Kokku 5,00"], { items: [{ text: "Kokku 5,00", ocr: true }] }))).toEqual(["ocr_document"]);
    expect(codes(makePacket(["a", "b"], { extraItems: [{ text: "logo", ocr: true }] }))).toEqual([]);
  });

  it("T-PK-blank-page: a blank page (no items at all) does not hold ocr_document", () => {
    expect(codes(makePacket([["Arve 1"], []]))).toEqual([]);
  });
});

describe("document-reading packet: cited-token origin", () => {
  it("T-PK-ocr-short: a 2-character OCR item `50` holds a cited `EUR 50` amount token", () => {
    const packet = makePacket(["Kokku EUR 50"], { extraItems: [{ text: "50", ocr: true }] });
    expect(packet.origin[0]!.ocr).toEqual(["50"]);
    expect(citedTokenOriginHolds(packet, 1, "50", "gross")).toEqual(["ocr_cited_text"]);
  });

  it("T-PK-origin-unestablished: a token absent from the page's native text holds", () => {
    const packet = makePacket(["Kokku 44,70"], { items: [{ text: "Kokku", ocr: false }] });
    expect(citedTokenOriginHolds(packet, 1, "44,70", "gross")).toEqual(["cited_origin_unestablished"]);
    expect(citedTokenOriginHolds(packet, 1, "Kokku", "invoice_number")).toEqual([]);
  });

  it("T-PK-name-exempt: logo OCR `Telia` does not hold a cited supplier_name, but holds an id containing it", () => {
    const packet = makePacket(["Telia Eesti AS", "Arve Telia-2026-01"], { extraItems: [{ text: "Telia", ocr: true }] });
    expect(citedTokenOriginHolds(packet, 1, "Telia Eesti AS", "supplier_name")).toEqual([]);
    expect(citedTokenOriginHolds(packet, 1, "Telia-2026-01", "invoice_number")).toEqual(["ocr_cited_text"]);
  });

  it("T-PK-origin-native-compact: native text is compared without whitespace", () => {
    const packet = buildReadingPacket(makePacketInput(["Reg 102 349 57"]));
    expect(citedTokenOriginHolds(packet, 1, "102 349 57", "supplier_reg")).toEqual([]);
  });

  describe("geometry (live 2026-10-28: logo fragments are not where the value is printed)", () => {
    const box = (x: number, y: number, width = 40, height = 10) => ({ x, y, width, height });
    const lines = ["Tele2 Eesti AS", "IBAN EE382200221001178223", "Kokku 599,00", "Arve 60E2BBAF-0027"];
    const native = [
      { text: "Tele2 Eesti AS", ocr: false, box: box(50, 100) },
      { text: "IBAN EE382200221001178223", ocr: false, box: box(50, 300, 200) },
      { text: "Kokku 599,00", ocr: false, box: box(50, 700) },
      { text: "Arve 60E2BBAF-0027", ocr: false, box: box(50, 120, 120) },
    ];
    const logo = [{ text: "9", ocr: true, box: box(400, 790, 12, 25) }, { text: "EE", ocr: true, box: box(420, 788, 30, 25) }, { text: "A", ocr: true, box: box(500, 40, 20, 23) }];

    it("T-PK-geo-released: logo OCR away from the printed value does not hold", () => {
      const packet = makePacket(lines, { items: [...native, ...logo] });
      expect(citedTokenOriginHolds(packet, 1, "599,00", "gross")).toEqual([]);
      expect(citedTokenOriginHolds(packet, 1, "EE382200221001178223", "supplier_iban")).toEqual([]);
      expect(citedTokenOriginHolds(packet, 1, "60E2BBAF-0027", "invoice_number")).toEqual([]);
    });

    it("T-PK-geo-touching: an OCR fragment overlapping the value's own item still holds (the D2 completion case)", () => {
      const packet = makePacket(["Arve A-1"], { items: [{ text: "Arve A-1", ocr: false, box: box(50, 100) }, { text: "7", ocr: true, box: box(85, 101, 8, 9) }] });
      expect(citedTokenOriginHolds(packet, 1, "A-17", "invoice_number")).toEqual(["ocr_cited_text", "cited_origin_unestablished"]);
      // The text rule is unchanged: "7" is no substring of the printed "A-1", so that citation is clean.
      expect(citedTokenOriginHolds(packet, 1, "A-1", "invoice_number")).toEqual([]);
    });

    it("T-PK-geo-slack: an OCR item just beside the native box (within a quarter height) is touching", () => {
      const packet = makePacket(["Kokku 599,00"], { items: [{ text: "Kokku 599,00", ocr: false, box: box(50, 700) }, { text: "9", ocr: true, box: box(91, 700, 5, 10) }] });
      expect(citedTokenOriginHolds(packet, 1, "599,00", "gross")).toEqual(["ocr_cited_text"]);
    });

    it("T-PK-geo-ocr-no-box: an OCR item without a box falls back to the substring rule", () => {
      const packet = makePacket(["Kokku 599,00"], { items: [{ text: "Kokku 599,00", ocr: false, box: box(50, 700) }, { text: "9", ocr: true }] });
      expect(citedTokenOriginHolds(packet, 1, "599,00", "gross")).toEqual(["ocr_cited_text"]);
    });

    it("T-PK-geo-native-no-box: a printing native item without a box falls back to the substring rule", () => {
      const packet = makePacket(["Kokku 599,00"], { items: [{ text: "Kokku 599,00", ocr: false }, { text: "9", ocr: true, box: box(400, 790, 12, 25) }] });
      expect(citedTokenOriginHolds(packet, 1, "599,00", "gross")).toEqual(["ocr_cited_text"]);
    });

    it("T-PK-geo-same-column: a native item overlapping only in x (same column, other row) releases", () => {
      const packet = makePacket(["Kokku 599,00"], { items: [{ text: "Kokku 599,00", ocr: false, box: box(50, 700) }, { text: "9", ocr: true, box: box(60, 790, 12, 25) }] });
      expect(citedTokenOriginHolds(packet, 1, "599,00", "gross")).toEqual([]);
    });

    it("T-PK-geo-same-row: a native item overlapping only in y (same row, other column) releases", () => {
      const packet = makePacket(["Kokku 599,00"], { items: [{ text: "Kokku 599,00", ocr: false, box: box(50, 700) }, { text: "9", ocr: true, box: box(400, 702, 12, 8) }] });
      expect(citedTokenOriginHolds(packet, 1, "599,00", "gross")).toEqual([]);
    });

    it("T-PK-geo-any-printing-item: the OCR fragment touching any item that prints the token holds", () => {
      const twice = [{ text: "Kokku 599,00", ocr: false, box: box(50, 700) }, { text: "Tasuda 599,00", ocr: false, box: box(50, 780, 60) }, { text: "9", ocr: true, box: box(95, 781, 8, 9) }];
      expect(citedTokenOriginHolds(makePacket(["Kokku 599,00", "Tasuda 599,00"], { items: twice }), 1, "599,00", "gross")).toEqual(["ocr_cited_text"]);
    });

    it("T-PK-geo-digest: boxes do not enter the packet digest or text", () => {
      const withBoxes = makePacket(lines, { items: [...native, ...logo] });
      const without = makePacket(lines, { items: [...native, ...logo].map(({ text, ocr }) => ({ text, ocr })) });
      expect(withBoxes.packet_digest).toBe(without.packet_digest);
      expect(withBoxes.text).toBe(without.text);
      expect(withBoxes.origin[0]!.ocr).toEqual(["9", "EE", "A"]);
    });
  });
});
