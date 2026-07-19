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
    expect(bankTransactionDirection({ type: "C", description: "invoice source_direction=IN" })).toBe("outgoing");
    expect(bankTransactionDirection({ type: "C", description: "[e-arveldaja-mcp:camt dir=CRDT]" })).toBe("outgoing");
  });

  it("keeps legacy D and C rows compatible when source metadata is absent", () => {
    expect(bankTransactionDirection({ type: "D" })).toBe("incoming");
    expect(bankTransactionDirection({ type: "C" })).toBe("outgoing");
  });
});
