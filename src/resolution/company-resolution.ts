/**
 * Pure company resolver (plan Step 3). Decides WHICH configured connection
 * (company) a request refers to, returning the shared three-way
 * `Resolution<CompanyRef>`:
 *   - 0 connections            → not_found (setup prompt)
 *   - exactly 1 connection      → resolved (evidence `single_connection`)
 *   - N + unique evidence match → resolved (`file_evidence` / `request_evidence`)
 *   - N, non-unique / no match  → ambiguous (choices = connections, one question)
 *
 * EXTRACTION ONLY — NOT wired into the inbox this task. The inbox keeps using
 * the implicit active-connection `ApiContext` unchanged (multi-connection
 * selection stays in `server-bootstrap.ts` `list_connections`/`switch_connection`).
 * Consumed by the guided façades in Tasks 12-14. Exercised only by
 * `company-resolution.test.ts`.
 *
 * House style: NO MCP / HTTP / fs types — plain connection descriptors in,
 * `Resolution<CompanyRef>` out.
 */
import { ambiguous, notFound, resolved, type Resolution } from "./types.js";

export interface CompanyConnectionDescriptor {
  /** activeIndex-equivalent position in the configured connection list. */
  readonly index: number;
  readonly name: string;
  readonly fingerprint: string;
  readonly verifiedCompanyIdentity: string | null;
}

export interface CompanyRef {
  readonly index: number;
  readonly name: string;
  readonly fingerprint: string;
}

/** Evidence extracted from a file or request that can disambiguate connections. */
export interface CompanyEvidence {
  readonly fingerprint?: string;
  readonly verifiedCompanyIdentity?: string;
}

export interface CompanyResolutionInput {
  readonly connections: readonly CompanyConnectionDescriptor[];
  readonly fileEvidence?: CompanyEvidence;
  readonly requestEvidence?: CompanyEvidence;
}

const SETUP_PROMPT =
  "No company connection is configured. Add an apikey*.txt credential file (or use import_apikey_credentials) and then choose the company.";

const COMPANY_QUESTION = "Which company (connection) should this apply to?";

function toRef(connection: CompanyConnectionDescriptor): CompanyRef {
  return { index: connection.index, name: connection.name, fingerprint: connection.fingerprint };
}

function uniqueMatch(
  connections: readonly CompanyConnectionDescriptor[],
  predicate: (connection: CompanyConnectionDescriptor) => boolean,
): CompanyConnectionDescriptor | undefined {
  const matches = connections.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveCompany(input: CompanyResolutionInput): Resolution<CompanyRef> {
  const { connections } = input;
  if (connections.length === 0) return notFound(SETUP_PROMPT);
  if (connections.length === 1) {
    return resolved(toRef(connections[0]!), [
      { tag: "single_connection", note: `Only one configured connection: ${connections[0]!.name}.` },
    ]);
  }

  // N connections — a unique evidence match resolves; otherwise ambiguous. File
  // evidence is checked before request evidence, and a fingerprint before a
  // verified identity, but a tie or a miss NEVER silently tie-breaks.
  const fileFingerprint = input.fileEvidence?.fingerprint;
  if (fileFingerprint !== undefined) {
    const match = uniqueMatch(connections, c => c.fingerprint === fileFingerprint);
    if (match) return resolved(toRef(match), [{ tag: "file_evidence", note: `File evidence uniquely matched ${match.name}.` }]);
  }
  const fileIdentity = input.fileEvidence?.verifiedCompanyIdentity;
  if (fileIdentity !== undefined) {
    const match = uniqueMatch(connections, c => c.verifiedCompanyIdentity === fileIdentity);
    if (match) return resolved(toRef(match), [{ tag: "file_evidence", note: `File evidence uniquely matched ${match.name}.` }]);
  }
  const requestFingerprint = input.requestEvidence?.fingerprint;
  if (requestFingerprint !== undefined) {
    const match = uniqueMatch(connections, c => c.fingerprint === requestFingerprint);
    if (match) return resolved(toRef(match), [{ tag: "request_evidence", note: `Request evidence uniquely matched ${match.name}.` }]);
  }
  const requestIdentity = input.requestEvidence?.verifiedCompanyIdentity;
  if (requestIdentity !== undefined) {
    const match = uniqueMatch(connections, c => c.verifiedCompanyIdentity === requestIdentity);
    if (match) return resolved(toRef(match), [{ tag: "request_evidence", note: `Request evidence uniquely matched ${match.name}.` }]);
  }

  return ambiguous(
    connections.map(c => ({ id: String(c.index), label: c.name })),
    COMPANY_QUESTION,
  );
}
