import { describe, expect, it, vi } from "vitest";
import { createElicitor, type ElicitOptions } from "./elicitation.js";

interface FakeServerOptions {
  elicitation?: Record<string, unknown> | undefined;
  elicitResult?: { action: string; content?: Record<string, unknown> };
  elicitThrows?: Error;
}

function fakeServer(opts: FakeServerOptions) {
  const elicitInput = vi.fn(async (params: unknown) => {
    if (opts.elicitThrows) throw opts.elicitThrows;
    return opts.elicitResult ?? { action: "cancel" };
  });
  const getClientCapabilities = vi.fn(() =>
    opts.elicitation === undefined ? {} : { elicitation: opts.elicitation },
  );
  const server = { server: { elicitInput, getClientCapabilities } };
  return { server: server as never, elicitInput, getClientCapabilities };
}

const bankOptions: ElicitOptions = {
  message: "Which bank account dimension should be used?",
  fields: {
    accounts_dimensions_id: {
      type: "enum",
      title: "Bank account",
      choices: [
        { const: "101", title: "LHV" },
        { const: "102", title: "SEB" },
      ],
    },
    remember_for_connection: { type: "boolean", title: "Remember for this connection", default: false },
  },
  required: ["accounts_dimensions_id"],
  needsInput: {
    status: "needs_input",
    category: "bank_account_dimension_required",
    question: "Which bank account dimension should be used?",
    choices: [{ id: "101", label: "LHV" }, { id: "102", label: "SEB" }],
  },
};

describe("createElicitor — capability gating + fallback", () => {
  it("returns 'unsupported' with the needs_input payload and NEVER calls elicitInput when the client lacks the capability", async () => {
    const { server, elicitInput } = fakeServer({ elicitation: undefined });
    const outcome = await createElicitor(server)(bankOptions);
    expect(outcome.kind).toBe("unsupported");
    if (outcome.kind === "unsupported") expect(outcome.needsInput).toEqual(bankOptions.needsInput);
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it("maps action:accept to 'answered' with content", async () => {
    const { server } = fakeServer({
      elicitation: {},
      elicitResult: { action: "accept", content: { accounts_dimensions_id: "102", remember_for_connection: true } },
    });
    const outcome = await createElicitor(server)(bankOptions);
    expect(outcome).toEqual({ kind: "answered", content: { accounts_dimensions_id: "102", remember_for_connection: true } });
  });

  it("maps action:decline and action:cancel to 'declined'", async () => {
    for (const action of ["decline", "cancel"]) {
      const { server } = fakeServer({ elicitation: {}, elicitResult: { action } });
      const outcome = await createElicitor(server)(bankOptions);
      expect(outcome).toEqual({ kind: "declined" });
    }
  });

  it("treats a thrown 'does not support form elicitation' error as unsupported (defensive double-guard)", async () => {
    const { server } = fakeServer({
      elicitation: {},
      elicitThrows: new Error("Client does not support form elicitation."),
    });
    const outcome = await createElicitor(server)(bankOptions);
    expect(outcome.kind).toBe("unsupported");
  });

  it("re-throws an unrelated elicitInput error", async () => {
    const { server } = fakeServer({ elicitation: {}, elicitThrows: new Error("network exploded") });
    await expect(createElicitor(server)(bankOptions)).rejects.toThrow(/network exploded/);
  });

  it("builds a flat requestedSchema of primitives (enum→oneOf, boolean, required propagated)", async () => {
    const { server, elicitInput } = fakeServer({
      elicitation: {},
      elicitResult: { action: "accept", content: { accounts_dimensions_id: "101" } },
    });
    await createElicitor(server)(bankOptions);
    const params = elicitInput.mock.calls[0]![0] as {
      mode: string; message: string; requestedSchema: { type: string; properties: Record<string, any>; required?: string[] };
    };
    expect(params.mode).toBe("form");
    expect(params.requestedSchema.type).toBe("object");
    expect(params.requestedSchema.properties.accounts_dimensions_id).toMatchObject({
      type: "string",
      oneOf: [{ const: "101", title: "LHV" }, { const: "102", title: "SEB" }],
    });
    expect(params.requestedSchema.properties.remember_for_connection).toMatchObject({ type: "boolean", default: false });
    expect(params.requestedSchema.required).toEqual(["accounts_dimensions_id"]);
  });
});

describe("createElicitor — NEVER elicit credentials", () => {
  const secretFieldCases: Array<{ label: string; fields: ElicitOptions["fields"] }> = [
    { label: "api_key key", fields: { api_key: { type: "string" } } },
    { label: "password key", fields: { password: { type: "string" } } },
    { label: "apiKey camel key", fields: { apiKey: { type: "string" } } },
    { label: "public_value key", fields: { public_value: { type: "string" } } },
    { label: "secret in title", fields: { blob: { type: "string", title: "Your API Secret" } } },
    { label: "password in title", fields: { blob: { type: "string", title: "Account Password" } } },
    { label: "secret in description", fields: { blob: { type: "string", description: "Enter your API password" } } },
    {
      label: "secret in enum choice title",
      fields: { pick: { type: "enum", choices: [{ const: "a", title: "Use API secret" }] } },
    },
    {
      label: "secret in enum choice const",
      fields: { pick: { type: "enum", choices: [{ const: "api_key", title: "First" }] } },
    },
  ];

  it.each(secretFieldCases)("throws at schema build for a $label", async ({ fields }) => {
    const { server, elicitInput } = fakeServer({ elicitation: {} });
    const opts: ElicitOptions = { message: "m", fields, needsInput: { status: "needs_input" } };
    await expect(createElicitor(server)(opts)).rejects.toThrow(/never elicit|secret|credential|password|api.?key/i);
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it("refuses a secret field even when the client lacks elicitation (guard is unconditional)", async () => {
    const { server } = fakeServer({ elicitation: undefined });
    const opts: ElicitOptions = { message: "m", fields: { password: { type: "string" } }, needsInput: { status: "needs_input" } };
    await expect(createElicitor(server)(opts)).rejects.toThrow();
  });
});
