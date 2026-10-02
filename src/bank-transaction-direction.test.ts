import { describe, expect, it } from "vitest";
import { bankTransactionDirection } from "./bank-transaction-direction.js";

describe("bankTransactionDirection", () => {
  it("prefers persisted CAMT and Wise source direction over API type C", () => {
    expect(bankTransactionDirection({ type: "C", description: "[e-arveldaja-mcp:camt dir=CRDT sig=abc123abc123abcd]" })).toBe("incoming");
    expect(bankTransactionDirection({ type: "C", description: "WISE:one Customer [source_direction=IN]" })).toBe("incoming");
    expect(bankTransactionDirection({ type: "C", description: "[e-arveldaja-mcp:camt dir=DBIT sig=abc123abc123abcd]" })).toBe("outgoing");
    expect(bankTransactionDirection({ type: "C", description: "WISE:two Vendor [source_direction=OUT]" })).toBe("outgoing");
    expect(bankTransactionDirection({ type: "C", description: "[e-arveldaja-mcp:camt h=abc i=EE1 d=CRDT s=abc123abc123abcd]" })).toBe("incoming");
  });

  it("does not trust source-direction lookalikes outside importer metadata", () => {
    expect(bankTransactionDirection({ type: "C", description: "invoice source_direction=IN" })).toBe("unknown");
    expect(bankTransactionDirection({ type: "C", description: "[e-arveldaja-mcp:camt dir=CRDT]" })).toBe("unknown");
  });

  it("treats legacy unsigned D and C rows as unknown when source metadata is absent", () => {
    // The live API reads every transaction back as type "C" whatever was
    // stored (verified 2026-10), so the stored type proves nothing.
    expect(bankTransactionDirection({ type: "D" })).toBe("unknown");
    expect(bankTransactionDirection({ type: "C" })).toBe("unknown");
  });
});
