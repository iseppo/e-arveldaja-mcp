import { describe, expect, it } from "vitest";
import { buildCamtDescriptionWithMetadataV1 } from "./marker-render-v1.js";
import { GOLDEN_CASES, V1_GOLDEN } from "../__fixtures__/camt-marker-golden.js";
import type { ParsedCamtEntry } from "./types.js";

const asEntry = (name: keyof typeof GOLDEN_CASES): ParsedCamtEntry =>
  ({ ...GOLDEN_CASES[name], duplicate: false, duplicate_transaction_ids: [] });

describe("frozen V1 CAMT description renderer", () => {
  it.each(Object.keys(GOLDEN_CASES) as Array<keyof typeof GOLDEN_CASES>)("%s renders exactly as before #64", (name) => {
    const entry = asEntry(name);
    expect(buildCamtDescriptionWithMetadataV1(entry.description, entry) ?? null).toBe(V1_GOLDEN[name]);
  });
});
