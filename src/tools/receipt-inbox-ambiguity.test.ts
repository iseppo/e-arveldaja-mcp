import { describe, expect, it } from "vitest";
import { HttpError } from "../http-client.js";
import { MutationIndeterminateError } from "../mutation-outcome.js";
import { isAmbiguousPostCreateFailure } from "./receipt-inbox.js";

describe("isAmbiguousPostCreateFailure", () => {
  it.each(["network", 408, 500, 503] as const)("treats an HTTP %s outcome as ambiguous", status => {
    expect(isAmbiguousPostCreateFailure(new HttpError("x", status, "PATCH", "/purchase_invoices/1/register")))
      .toBe(true);
  });

  it.each([400, 404, 409, 422, 429])("treats an HTTP %s rejection as definitive", status => {
    expect(isAmbiguousPostCreateFailure(new HttpError("x", status, "PATCH", "/purchase_invoices/1/register")))
      .toBe(false);
  });

  it("treats a wrapped MutationIndeterminateError as ambiguous", () => {
    expect(isAmbiguousPostCreateFailure(new MutationIndeterminateError({
      operation: "confirm",
      entity: "purchase_invoice",
      entityId: 1,
      businessKey: "/purchase_invoices:1:register",
      affectedCaches: ["/purchase_invoices"],
      cause: new HttpError("x", 500, "PATCH", "/purchase_invoices/1/register"),
      nextAction: "Re-read.",
    }))).toBe(true);
  });

  it("keeps a local pre-mutation guard error definitive", () => {
    expect(isAmbiguousPostCreateFailure(new Error("correction preview required"))).toBe(false);
  });
});
