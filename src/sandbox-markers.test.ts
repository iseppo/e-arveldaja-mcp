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
});
