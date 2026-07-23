import { describe, expect, it } from "vitest";
import {
  resolveCompany,
  type CompanyConnectionDescriptor,
} from "./company-resolution.js";

function conn(overrides: Partial<CompanyConnectionDescriptor> & { index: number }): CompanyConnectionDescriptor {
  return {
    name: overrides.name ?? `conn-${overrides.index}`,
    fingerprint: overrides.fingerprint ?? `fp-${overrides.index}`,
    verifiedCompanyIdentity: overrides.verifiedCompanyIdentity ?? null,
    ...overrides,
  };
}

describe("resolveCompany", () => {
  it("not_found with a setup prompt when there are zero connections", () => {
    const r = resolveCompany({ connections: [] });
    expect(r.status).toBe("not_found");
    if (r.status === "not_found") expect(r.question.length).toBeGreaterThan(0);
  });

  it("resolves the single connection automatically with single_connection evidence", () => {
    const r = resolveCompany({ connections: [conn({ index: 0, name: "Seppo AI OÜ" })] });
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.value.index).toBe(0);
      expect(r.evidence.map(e => e.tag)).toContain("single_connection");
    }
  });

  it("N connections with no evidence → ambiguous, choices = the connections, one question", () => {
    const r = resolveCompany({ connections: [conn({ index: 0 }), conn({ index: 1 })] });
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") {
      expect(r.choices).toHaveLength(2);
      expect(typeof r.question).toBe("string");
    }
  });

  it("N connections + unique file-evidence fingerprint match → resolved (file_evidence)", () => {
    const r = resolveCompany({
      connections: [conn({ index: 0, fingerprint: "fp-A" }), conn({ index: 1, fingerprint: "fp-B" })],
      fileEvidence: { fingerprint: "fp-B" },
    });
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.value.index).toBe(1);
      expect(r.evidence.map(e => e.tag)).toContain("file_evidence");
    }
  });

  it("N connections + unique request-evidence identity match → resolved (request_evidence)", () => {
    const r = resolveCompany({
      connections: [
        conn({ index: 0, verifiedCompanyIdentity: "seppo ai oü" }),
        conn({ index: 1, verifiedCompanyIdentity: "other oü" }),
      ],
      requestEvidence: { verifiedCompanyIdentity: "seppo ai oü" },
    });
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.value.index).toBe(0);
      expect(r.evidence.map(e => e.tag)).toContain("request_evidence");
    }
  });

  it("N connections + evidence that matches multiple → ambiguous (never tie-break)", () => {
    const r = resolveCompany({
      connections: [conn({ index: 0, fingerprint: "fp-X" }), conn({ index: 1, fingerprint: "fp-X" })],
      fileEvidence: { fingerprint: "fp-X" },
    });
    expect(r.status).toBe("ambiguous");
  });

  it("N connections + evidence that matches none → ambiguous", () => {
    const r = resolveCompany({
      connections: [conn({ index: 0, fingerprint: "fp-A" }), conn({ index: 1, fingerprint: "fp-B" })],
      fileEvidence: { fingerprint: "fp-NONE" },
    });
    expect(r.status).toBe("ambiguous");
  });
});
