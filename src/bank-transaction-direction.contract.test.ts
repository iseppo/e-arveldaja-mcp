import { describe, expect, it, vi } from "vitest";
import { createBankTransaction } from "./bank-transaction-create.js";
import { bankTransactionDirection } from "./bank-transaction-direction.js";

// Direction contract (Task 19, Step 3). Pins the FULL statement-direction → API
// `type` chain through the REAL `bankTransactionDirection` + `createBankTransaction`
// path (no reimplementation):
//
//   CAMT CRDT  /  Wise IN   → incoming → API type "D"  (cash debited  / "Laekumine")
//   CAMT DBIT  /  Wise OUT  → outgoing → API type "C"  (cash credited / "Tasumine")
//
// `type="D"` books the cash leg on the DEBIT side at confirmation, `type="C"` on
// the CREDIT side, so this mapping is semantic on the write path — an inversion
// books every affected row's cash on the wrong side.

// A signed CAMT description marker, exactly as the importer stores it (the sig
// gate in `bankTransactionDirection` requires a 16–64 hex signature).
const camtDescription = (dir: "CRDT" | "DBIT"): string =>
  `omanikulaen\n[e-arveldaja-mcp:camt dir=${dir} sig=abc123abc123abcd]`;

// A signed Wise description marker, exactly as the importer stores it.
const wiseDescription = (dir: "IN" | "OUT"): string =>
  `WISE:123 Customer [source_direction=${dir}]`;

const basePayload = {
  accounts_dimensions_id: 7,
  amount: 100,
  cl_currencies_id: "EUR",
  date: "2026-07-19",
};

async function emittedType(description: string): Promise<string> {
  const create = vi.fn().mockResolvedValue({ created_object_id: 1 });
  await createBankTransaction({ transactions: { create } }, { ...basePayload, description });
  return (create.mock.calls[0]![0] as { type: string }).type;
}

describe("direction contract — bankTransactionDirection classification", () => {
  it("maps CAMT CRDT and Wise IN to incoming", () => {
    expect(bankTransactionDirection({ description: camtDescription("CRDT") })).toBe("incoming");
    expect(bankTransactionDirection({ description: wiseDescription("IN") })).toBe("incoming");
  });

  it("maps CAMT DBIT and Wise OUT to outgoing", () => {
    expect(bankTransactionDirection({ description: camtDescription("DBIT") })).toBe("outgoing");
    expect(bankTransactionDirection({ description: wiseDescription("OUT") })).toBe("outgoing");
  });
});

describe("direction contract — createBankTransaction emits the pinned API type", () => {
  it("CAMT CRDT → type D", async () => {
    expect(await emittedType(camtDescription("CRDT"))).toBe("D");
  });

  it("Wise IN → type D", async () => {
    expect(await emittedType(wiseDescription("IN"))).toBe("D");
  });

  it("CAMT DBIT → type C", async () => {
    expect(await emittedType(camtDescription("DBIT"))).toBe("C");
  });

  it("Wise OUT → type C", async () => {
    expect(await emittedType(wiseDescription("OUT"))).toBe("C");
  });

  it("honours an explicit incoming/outgoing direction argument (the CAMT/Wise executor path)", async () => {
    const create = vi.fn().mockResolvedValue({ created_object_id: 2 });
    await createBankTransaction({ transactions: { create } }, basePayload, "incoming");
    expect((create.mock.calls[0]![0] as { type: string }).type).toBe("D");

    const create2 = vi.fn().mockResolvedValue({ created_object_id: 3 });
    await createBankTransaction({ transactions: { create: create2 } }, basePayload, "outgoing");
    expect((create2.mock.calls[0]![0] as { type: string }).type).toBe("C");
  });
});
