import { describe, expect, it } from "vitest";
import { bankPostingSideForInvoiceMatch, bankTransactionDirection } from "./bank-transaction-direction.js";

describe("bankTransactionDirection", () => {
  it("prefers persisted CAMT and Wise source direction over API type C", () => {
    // @ts-expect-error legacy API `type` is not part of the input; it must be ignored
    expect(bankTransactionDirection({ type: "C", description: "[e-arveldaja-mcp:camt dir=CRDT sig=abc123abc123abcd]" })).toBe("incoming");
    // @ts-expect-error legacy API `type` is not part of the input; it must be ignored
    expect(bankTransactionDirection({ type: "C", description: "WISE:one Customer [source_direction=IN]" })).toBe("incoming");
    // @ts-expect-error legacy API `type` is not part of the input; it must be ignored
    expect(bankTransactionDirection({ type: "C", description: "[e-arveldaja-mcp:camt dir=DBIT sig=abc123abc123abcd]" })).toBe("outgoing");
    // @ts-expect-error legacy API `type` is not part of the input; it must be ignored
    expect(bankTransactionDirection({ type: "C", description: "WISE:two Vendor [source_direction=OUT]" })).toBe("outgoing");
    // @ts-expect-error legacy API `type` is not part of the input; it must be ignored
    expect(bankTransactionDirection({ type: "C", description: "[e-arveldaja-mcp:camt h=abc i=EE1 d=CRDT s=abc123abc123abcd]" })).toBe("incoming");
  });

  it("does not trust source-direction lookalikes outside importer metadata", () => {
    // @ts-expect-error legacy API `type` is not part of the input; it must be ignored
    expect(bankTransactionDirection({ type: "C", description: "invoice source_direction=IN" })).toBe("unknown");
    // @ts-expect-error legacy API `type` is not part of the input; it must be ignored
    expect(bankTransactionDirection({ type: "C", description: "[e-arveldaja-mcp:camt dir=CRDT]" })).toBe("unknown");
  });

  it("treats legacy unsigned D and C rows as unknown when source metadata is absent", () => {
    // The live API reads every transaction back as type "C" whatever was
    // stored (verified 2026-10), so the stored type proves nothing.
    // @ts-expect-error legacy API `type` is not part of the input; it must be ignored
    expect(bankTransactionDirection({ type: "D" })).toBe("unknown");
    // @ts-expect-error legacy API `type` is not part of the input; it must be ignored
    expect(bankTransactionDirection({ type: "C" })).toBe("unknown");
  });
});

describe("bankPostingSideForInvoiceMatch", () => {
  it("uses the signed direction when present", () => {
    expect(bankPostingSideForInvoiceMatch({ description: "x\n[e-arveldaja-mcp:camt dir=CRDT sig=abc123abc123abcd]" }, "purchase_invoice")).toBe("D");
    expect(bankPostingSideForInvoiceMatch({ description: "WISE:T1 Vendor [source_direction=OUT]" }, "sale_invoice")).toBe("C");
  });

  it("falls back to the invoice kind for an unsigned row", () => {
    expect(bankPostingSideForInvoiceMatch({ description: "payment" }, "sale_invoice")).toBe("D");
    expect(bankPostingSideForInvoiceMatch({ description: "payment" }, "purchase_invoice")).toBe("C");
  });
});
