import { describe, expect, it } from "vitest";
import {
  checkWorkflowTrace,
  type MutationEvent,
  type WorkflowTraceEvent,
} from "./workflow-trace.js";

// A canonical, well-formed single-workflow trace: prompt advertises the tools,
// a dry run issues a plan handle and previews the scope, the user approves that
// exact scope, and the execute mutation stays inside it consuming the handle
// once. Every invariant test clones this and breaks exactly one property so a
// green trace and a flagged trace are proven for each rule.
function wellFormedTrace(): WorkflowTraceEvent[] {
  return [
    {
      type: "PROMPT",
      workflow: "camt_import",
      advertisedTools: ["process_camt053", "import_camt053", "confirm_transaction"],
    },
    { type: "TOOL_CALL", workflow: "camt_import", tool: "process_camt053" },
    {
      type: "TOOL_RESULT",
      workflow: "camt_import",
      tool: "process_camt053",
      issuesPlanHandle: "handle-A",
      planPreview: {
        domain: "camt_import",
        categories: ["create_bank_transaction"],
        accounts: ["1120"],
        sources: ["camt:entry:1", "camt:entry:2"],
      },
    },
    {
      type: "USER_APPROVAL",
      workflow: "camt_import",
      scope: {
        workflow: "camt_import",
        planHandle: "handle-A",
        domain: "camt_import",
        categories: ["create_bank_transaction"],
        accounts: ["1120"],
        sources: ["camt:entry:1", "camt:entry:2"],
      },
    },
    {
      type: "MUTATION",
      workflow: "camt_import",
      tool: "import_camt053",
      domain: "camt_import",
      planHandle: "handle-A",
      category: "create_bank_transaction",
      account: "1120",
      sources: ["camt:entry:1"],
    },
  ];
}

function lastMutation(events: WorkflowTraceEvent[]): MutationEvent {
  const mutation = [...events].reverse().find((event): event is MutationEvent => event.type === "MUTATION");
  if (!mutation) throw new Error("fixture has no mutation");
  return mutation;
}

function replaceMutation(events: WorkflowTraceEvent[], patch: Partial<MutationEvent>): WorkflowTraceEvent[] {
  return events.map(event => (event.type === "MUTATION" ? { ...event, ...patch } : event));
}

describe("checkWorkflowTrace", () => {
  it("passes a well-formed approval-bound trace with no violations", () => {
    expect(checkWorkflowTrace(wellFormedTrace())).toEqual([]);
  });

  describe("invariant 1: no MUTATION before a covering USER_APPROVAL", () => {
    it("passes when a covering approval precedes the mutation", () => {
      const violations = checkWorkflowTrace(wellFormedTrace());
      expect(violations.filter(v => v.invariant === "mutation_requires_prior_approval")).toEqual([]);
    });

    it("flags a mutation whose only precedent is a plan handle (a handle is NOT approval)", () => {
      const events = wellFormedTrace().filter(event => event.type !== "USER_APPROVAL");
      const violations = checkWorkflowTrace(events);
      expect(violations.map(v => v.invariant)).toContain("mutation_requires_prior_approval");
    });

    it("flags a mutation approved only AFTER the fact", () => {
      const base = wellFormedTrace();
      const approval = base.find(event => event.type === "USER_APPROVAL")!;
      const withoutApproval = base.filter(event => event.type !== "USER_APPROVAL");
      const violations = checkWorkflowTrace([...withoutApproval, approval]);
      expect(violations.map(v => v.invariant)).toContain("mutation_requires_prior_approval");
    });
  });

  describe("invariant 2: no TOOL_CALL/MUTATION to an unadvertised tool", () => {
    it("passes when every tool is advertised in the surface", () => {
      expect(checkWorkflowTrace(wellFormedTrace()).filter(v => v.invariant === "tool_must_be_advertised")).toEqual([]);
    });

    it("flags a TOOL_CALL to a tool absent from the surface", () => {
      const events = wellFormedTrace();
      events.splice(1, 0, { type: "TOOL_CALL", workflow: "camt_import", tool: "delete_client" });
      const violations = checkWorkflowTrace(events);
      expect(violations.map(v => v.invariant)).toContain("tool_must_be_advertised");
    });

    it("flags a MUTATION performed by an unadvertised tool", () => {
      const violations = checkWorkflowTrace(replaceMutation(wellFormedTrace(), { tool: "delete_client" }));
      expect(violations.map(v => v.invariant)).toContain("tool_must_be_advertised");
    });
  });

  describe("invariant 3: every MUTATION lies inside the approved scope", () => {
    it("flags a domain mismatch between mutation and approval", () => {
      const violations = checkWorkflowTrace(replaceMutation(wellFormedTrace(), { domain: "wise_import" }));
      expect(violations.map(v => v.invariant)).toContain("mutation_within_approved_scope");
    });

    it("flags a manifest mismatch against an approved manifest", () => {
      const events = wellFormedTrace().map(event => {
        if (event.type === "USER_APPROVAL") {
          return { ...event, scope: { ...event.scope, manifest: "sha-approved" } };
        }
        return event;
      });
      const violations = checkWorkflowTrace(replaceMutation(events, { manifest: "sha-other" }));
      expect(violations.map(v => v.invariant)).toContain("mutation_within_approved_scope");
    });
  });

  describe("invariant 4: subset/category/account change requires a new preview", () => {
    it("flags a category outside the approved plan", () => {
      const violations = checkWorkflowTrace(replaceMutation(wellFormedTrace(), { category: "confirm_match" }));
      expect(violations.map(v => v.invariant)).toContain("scope_change_requires_new_preview");
    });

    it("flags an account outside the approved plan", () => {
      const violations = checkWorkflowTrace(replaceMutation(wellFormedTrace(), { account: "9999" }));
      expect(violations.map(v => v.invariant)).toContain("scope_change_requires_new_preview");
    });

    it("flags a subset that exceeds the approved sources", () => {
      const violations = checkWorkflowTrace(
        replaceMutation(wellFormedTrace(), { sources: ["camt:entry:1", "camt:entry:99"] }),
      );
      expect(violations.map(v => v.invariant)).toContain("scope_change_requires_new_preview");
    });

    it("passes a strict subset of the approved sources", () => {
      const violations = checkWorkflowTrace(replaceMutation(wellFormedTrace(), { sources: ["camt:entry:2"] }));
      expect(violations).toEqual([]);
    });
  });

  describe("invariant 5: early / stale / replayed handles fail", () => {
    it("flags a mutation that presents a handle never issued (early execute)", () => {
      const violations = checkWorkflowTrace(replaceMutation(wellFormedTrace(), { planHandle: "handle-unissued" }));
      // The approval is bound to handle-A, so an unissued handle both loses its
      // approval and is not a live credential.
      expect(violations.map(v => v.invariant)).toContain("stale_or_replayed_handle");
    });

    it("flags execute BEFORE the dry run issues the handle", () => {
      const base = wellFormedTrace();
      const issuance = base.find(
        (event): event is Extract<WorkflowTraceEvent, { type: "TOOL_RESULT" }> =>
          event.type === "TOOL_RESULT" && event.issuesPlanHandle !== undefined,
      )!;
      const rest = base.filter(event => event !== issuance);
      // Move the issuance to the very end: the mutation now runs before it exists.
      const violations = checkWorkflowTrace([...rest, issuance]);
      expect(violations.map(v => v.invariant)).toContain("stale_or_replayed_handle");
    });

    it("flags a replayed handle consumed by a second mutation", () => {
      const events = wellFormedTrace();
      const mutation = lastMutation(events);
      const violations = checkWorkflowTrace([...events, { ...mutation }]);
      expect(violations.map(v => v.invariant)).toContain("stale_or_replayed_handle");
    });

    it("flags a mutation on a handle already invalidated (expired/drifted)", () => {
      const events = wellFormedTrace();
      const mutationIndex = events.findIndex(event => event.type === "MUTATION");
      events.splice(mutationIndex, 0, {
        type: "TOOL_RESULT",
        workflow: "camt_import",
        tool: "get_execution_plan_page",
        invalidatesPlanHandle: "handle-A",
      });
      const violations = checkWorkflowTrace(events);
      expect(violations.map(v => v.invariant)).toContain("stale_or_replayed_handle");
    });
  });
});
