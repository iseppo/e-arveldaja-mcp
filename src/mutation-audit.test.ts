import { describe, expect, it, vi } from "vitest";
import { HttpError } from "./http-client.js";
import { parseMcpResponse } from "./mcp-json.js";
import { MutationIndeterminateError } from "./mutation-outcome.js";
import { toolError } from "./tool-error.js";
import {
  auditMutationIndeterminate,
  serializeToolMutationError,
} from "./mutation-audit.js";

function ambiguousClientUpdate(): MutationIndeterminateError {
  return new MutationIndeterminateError({
    operation: "update",
    entity: "client",
    entityId: 5,
    businessKey: "/clients:5",
    affectedCaches: ["/products", "/clients", "/products"],
    cause: new HttpError(
      "connection reset after request body",
      "network",
      "PATCH",
      "/clients/5",
    ),
    nextAction: "Re-read client 5 before deciding whether to retry.",
  });
}

function payloadOf(result: ReturnType<typeof serializeToolMutationError>): Record<string, unknown> {
  return parseMcpResponse(result.content[0]!.text) as Record<string, unknown>;
}

function structuralMutation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    error: "structural mutation ambiguity",
    category: "mutation_indeterminate",
    mutationMayHaveOccurred: true,
    operation: "update",
    entity: "client",
    entityId: 5,
    businessKey: "/clients:5",
    affectedCaches: ["/clients"],
    cause: {
      name: "HttpError",
      message: "network ambiguity",
      status: "network",
      method: "PATCH",
      path: "/clients/5",
    },
    nextAction: "Inspect remote state before retrying.",
    ...overrides,
  };
}

describe("M01 mutation ambiguity audit", () => {
  it("M01 writes the complete flattened neutral recovery entry to the original company", () => {
    const writeAudit = vi.fn().mockReturnValue(true);
    const error = ambiguousClientUpdate();

    const persisted = auditMutationIndeterminate({
      toolName: "update_client",
      error,
      connectionName: "original-company",
      writeAudit,
    });

    expect(persisted).toBe(true);
    expect(writeAudit).toHaveBeenCalledWith({
      tool: "update_client",
      action: "MUTATION_INDETERMINATE",
      entity_type: "client",
      entity_id: 5,
      summary: "Mutation outcome is indeterminate; inspect remote state before retrying.",
      details: {
        category: "mutation_indeterminate",
        mutation_may_have_occurred: true,
        operation: "update",
        business_key: "/clients:5",
        affected_caches: "/clients,/products",
        cause_name: "HttpError",
        cause_message: "connection reset after request body",
        cause_status: "network",
        cause_method: "PATCH",
        cause_path: "/clients/5",
        next_action: "Re-read client 5 before deciding whether to retry.",
      },
    }, { connectionName: "original-company" });
  });

  it("M01 serialization audits snapshot index zero and preserves every original neutral field", () => {
    const writeAudit = vi.fn().mockReturnValue(true);
    const error = ambiguousClientUpdate();

    const result = serializeToolMutationError({
      toolName: "update_client",
      error,
      trackMutation: true,
      snapshotIndex: 0,
      connectionNames: ["original-company", "currently-active-company"],
      writeAudit,
    });

    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit.mock.calls[0]![1]).toEqual({ connectionName: "original-company" });
    expect(payloadOf(result)).toMatchObject({
      error: error.message,
      name: "MutationIndeterminateError",
      category: "mutation_indeterminate",
      mutationMayHaveOccurred: true,
      operation: "update",
      entity: "client",
      entityId: 5,
      businessKey: "/clients:5",
      affectedCaches: ["/products", "/clients", "/products"],
      cause: {
        name: "HttpError",
        message: "connection reset after request body",
        status: "network",
        method: "PATCH",
        path: "/clients/5",
      },
      nextAction: "Re-read client 5 before deciding whether to retry.",
    });
  });

  it.each([
    ["read-only", false],
    ["setup-mode", false],
  ])("M01 skips persistence when %s call-site tracking is disabled", (_label, trackMutation) => {
    const writeAudit = vi.fn().mockReturnValue(true);

    serializeToolMutationError({
      toolName: "list_clients",
      error: ambiguousClientUpdate(),
      trackMutation,
      snapshotIndex: 0,
      connectionNames: ["original-company"],
      writeAudit,
    });

    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("M01 does not audit response-backed numeric HTTP failures", () => {
    const writeAudit = vi.fn().mockReturnValue(true);
    const error = new HttpError("service unavailable", 503, "PATCH", "/clients/5");

    const result = serializeToolMutationError({
      toolName: "update_client",
      error,
      trackMutation: true,
      snapshotIndex: 0,
      connectionNames: ["original-company"],
      writeAudit,
    });

    expect(writeAudit).not.toHaveBeenCalled();
    expect(payloadOf(result)).toMatchObject({ error: "service unavailable", status: 503 });
  });

  it.each([
    ["returns false", vi.fn().mockReturnValue(false)],
    ["throws", vi.fn().mockImplementation(() => { throw new Error("secret writer failure"); })],
  ])("M01 contains an audit writer that %s and returns the original tool error", (_label, writeAudit) => {
    const logError = vi.fn();
    const error = ambiguousClientUpdate();

    const result = serializeToolMutationError({
      toolName: "update_client",
      error,
      trackMutation: true,
      snapshotIndex: 0,
      connectionNames: ["original-company"],
      writeAudit,
      logError,
    });

    expect(logError).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith("Failed to persist MUTATION_INDETERMINATE audit entry");
    expect(JSON.stringify(logError.mock.calls)).not.toContain("secret writer failure");
    expect(payloadOf(result)).toMatchObject({
      error: error.message,
      category: "mutation_indeterminate",
      businessKey: "/clients:5",
    });
  });

  it.each([
    ["out-of-range snapshot", 2, ["original-company"]],
    ["empty original connection", 0, ["   "]],
  ] as const)("M01 skips persistence for an %s instead of choosing another connection", (_label, snapshotIndex, connectionNames) => {
    const writeAudit = vi.fn().mockReturnValue(true);

    serializeToolMutationError({
      toolName: "update_client",
      error: ambiguousClientUpdate(),
      trackMutation: true,
      snapshotIndex,
      connectionNames,
      writeAudit,
    });

    expect(writeAudit).not.toHaveBeenCalled();
  });

  it.each(["clients", "unknown_entity"])("M01 safeParse blocks structural entity %s while preserving its payload", entity => {
    const writeAudit = vi.fn().mockReturnValue(true);
    const structural = {
      error: "ambiguous structural mutation",
      category: "mutation_indeterminate",
      mutationMayHaveOccurred: true,
      operation: "update",
      entity,
      entityId: 5,
      businessKey: "/clients:5",
      affectedCaches: ["/clients"],
      cause: { name: "HttpError", message: "network", status: "network" },
      nextAction: "Inspect state.",
    };

    const result = serializeToolMutationError({
      toolName: "update_client",
      error: structural,
      trackMutation: true,
      snapshotIndex: 0,
      connectionNames: ["original-company"],
      writeAudit,
    });

    expect(writeAudit).not.toHaveBeenCalled();
    expect(result).toEqual(toolError(structural));
  });

  it.each([
    ["unknown operation", { operation: "execute" }],
    ["fractional entity ID", { entityId: 5.5 }],
    ["nonfinite entity ID", { entityId: Number.POSITIVE_INFINITY }],
    ["empty business key", { businessKey: "   " }],
    ["non-array caches", { affectedCaches: "/clients" }],
    ["empty cache prefix", { affectedCaches: [""] }],
    ["unknown cache prefix", { affectedCaches: ["/unknown"] }],
    ["missing cause object", { cause: null }],
    ["non-scalar cause name", { cause: { name: {}, message: "network" } }],
    ["non-scalar cause status", { cause: { name: "HttpError", message: "network", status: {} } }],
    ["empty next action", { nextAction: "" }],
  ] as const)("M01 skips an incomplete structural recovery shape with %s", (_label, overrides) => {
    const writeAudit = vi.fn().mockReturnValue(true);
    const structural = structuralMutation(overrides);

    const result = serializeToolMutationError({
      toolName: "update_client",
      error: structural,
      trackMutation: true,
      snapshotIndex: 0,
      connectionNames: ["original-company"],
      writeAudit,
    });

    expect(writeAudit).not.toHaveBeenCalled();
    expect(result).toEqual(toolError(structural));
  });

  it("M01 contains a throwing getter during protected audit-shape parsing", () => {
    const writeAudit = vi.fn().mockReturnValue(true);
    const structural = Object.assign(new Error("getter-backed ambiguity"), {
      category: "mutation_indeterminate" as const,
      mutationMayHaveOccurred: true as const,
      operation: "update",
      entityId: 5,
      businessKey: "/clients:5",
      affectedCaches: ["/clients"],
      cause: { name: "HttpError", message: "network" },
      nextAction: "Inspect state.",
    });
    Object.defineProperty(structural, "entity", {
      enumerable: false,
      get() {
        throw new Error("malicious entity getter");
      },
    });

    const result = serializeToolMutationError({
      toolName: "update_client",
      error: structural,
      trackMutation: true,
      snapshotIndex: 0,
      connectionNames: ["original-company"],
      writeAudit,
    });

    expect(writeAudit).not.toHaveBeenCalled();
    expect(result).toEqual(toolError(structural));
  });
});
