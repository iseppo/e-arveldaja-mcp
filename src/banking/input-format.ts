import type { FileInputSnapshot } from "../file-input-snapshot.js";
import { preflightCamt053Xml } from "../camt/parser.js";
import { preflightWiseCsv } from "../wise/preflight.js";
import type { CamtPreflightResult, ImportRejectedField } from "../camt/types.js";
import type { WisePreflightResult } from "../wise/types.js";

// Content-signature bank-input format detector. Runs BOTH parser preflights on
// the SAME immutable captured bytes (never a second file read) and decides the
// format from the validated content, not the filename. Exactly-one preflight ok
// routes; both/neither surface a sandboxed rejection carrying counts only — the
// raw file bytes are never echoed. No MCP / HTTP / fs types appear here; the
// input is an already-captured immutable snapshot and the output is plain data.

type CamtOk = Extract<CamtPreflightResult, { ok: true }>;
type WiseOk = Extract<WisePreflightResult, { ok: true }>;

export type BankInputFormat =
  | { readonly format: "camt"; readonly preflight: CamtOk }
  | { readonly format: "wise"; readonly preflight: WiseOk }
  | {
      readonly format: "ambiguous" | "unsupported";
      readonly camt_rejected_field_count: number;
      readonly wise_rejected_field_count: number;
    };

type PreflightProbe =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejectedFieldCount: number };

/**
 * The structural preflights throw on non-recoverable inputs (XXE/DTD, malformed
 * XML, a Wise CSV with no data rows). A throw simply means "not this format";
 * the thrown messages are fixed strings that never echo file content, but we
 * discard them anyway and reason only over ok/not-ok + rejected-field counts.
 */
function probeCamt(text: string): { probe: PreflightProbe; value?: CamtOk } {
  try {
    const preflight = preflightCamt053Xml(text);
    return preflight.ok
      ? { probe: { ok: true }, value: preflight }
      : { probe: { ok: false, rejectedFieldCount: preflight.rejected_fields.length } };
  } catch {
    return { probe: { ok: false, rejectedFieldCount: 1 } };
  }
}

function probeWise(text: string): { probe: PreflightProbe; value?: WiseOk } {
  try {
    const preflight = preflightWiseCsv(text);
    return preflight.ok
      ? { probe: { ok: true }, value: preflight }
      : { probe: { ok: false, rejectedFieldCount: preflight.rejected_fields.length } };
  } catch {
    return { probe: { ok: false, rejectedFieldCount: 1 } };
  }
}

function rejectedCount(probe: PreflightProbe): number {
  return probe.ok ? 0 : probe.rejectedFieldCount;
}

export function detectBankInputFormat(snapshot: FileInputSnapshot): BankInputFormat {
  const text = snapshot.text();
  const camt = probeCamt(text);
  const wise = probeWise(text);

  if (camt.probe.ok && !wise.probe.ok) return { format: "camt", preflight: camt.value! };
  if (wise.probe.ok && !camt.probe.ok) return { format: "wise", preflight: wise.value! };

  // Both ok is effectively impossible (a valid CAMT XML fails the Wise header
  // set and vice versa) but is surfaced explicitly rather than guessed.
  return {
    format: camt.probe.ok && wise.probe.ok ? "ambiguous" : "unsupported",
    camt_rejected_field_count: rejectedCount(camt.probe),
    wise_rejected_field_count: rejectedCount(wise.probe),
  };
}

export type { ImportRejectedField };
