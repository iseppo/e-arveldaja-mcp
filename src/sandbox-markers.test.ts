import { describe, expect, it } from "vitest";
import { stripSandboxMarkers } from "./sandbox-markers.js";

describe("stripSandboxMarkers", () => {
  it("returns marker-free text unchanged, whitespace included", () => {
    const text = "  Vendor OÜ\n<< not a marker >> UNTRUSTED_OCR_START  ";
    expect(stripSandboxMarkers(text)).toBe(text);
  });

  it("removes start/end tokens and nested tokens to a fixpoint", () => {
    expect(stripSandboxMarkers("<<UNTRUSTED_OCR_START:ab>>\nx\n<<UNTRUSTED_OCR_END:ab>>")).toBe("\nx\n");
    expect(stripSandboxMarkers("a<<UNTRUSTED_OCR_<<UNTRUSTED_OCR_START:ab>>END:cd>>b")).toBe("ab");
  });

  it("neutralises adversarially deep nesting in linear time", () => {
    const depth = 20_000;
    const nested = "a" + "<<UNTRUSTED_OCR_".repeat(depth) + "START:ab>>" + "END:cd>>".repeat(depth - 1) + "b";
    const started = Date.now();
    const out = stripSandboxMarkers(nested);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out).not.toMatch(/<<UNTRUSTED_OCR_(?:START|END):[0-9a-f]*>>/);
    expect(stripSandboxMarkers(out)).toBe(out);
  });
});
